'use strict';
/**
 * Trivia Circus persistence layer.
 * node:sqlite (built-in, Node ≥22.5).
 * WAL mode. ALL score mutations are in explicit BEGIN IMMEDIATE transactions.
 * Schema v2: UUID string PK, UNIQUE COLLATE NOCASE display_name, no custom_name.
 */
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error('node:sqlite required (Node ≥22.5). ' + e.message);
}

// DATA_DIR (preferred) or TC_DATA_DIR (legacy) or project-local data/
const DATA_DIR = process.env.DATA_DIR || process.env.TC_DATA_DIR
  || path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'trivia.db');

let _db = null, _path = null;

// ─── Open / singleton ──────────────────────────────────────────────────────

function openDb(dbPath) {
  const resolved = dbPath || DB_PATH;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');
  migrate(db);
  return db;
}

function getDb(dbPath) {
  if (_db && (!dbPath || dbPath === _path)) return _db;
  _db = openDb(dbPath || DB_PATH);
  _path = dbPath || DB_PATH;
  return _db;
}

function closeDb() {
  if (_db) { try { _db.close(); } catch (_) {} _db = null; _path = null; }
}

// ─── Migrations ───────────────────────────────────────────────────────────

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const current = row && row.v != null ? Number(row.v) : 0;

  if (current < 2) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id              TEXT    PRIMARY KEY,
        display_name    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        lifetime_score  INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_score >= 0),
        correct_answers INTEGER NOT NULL DEFAULT 0 CHECK (correct_answers >= 0),
        score_reached_at INTEGER NOT NULL DEFAULT (unixepoch()),
        created_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS profile_credentials (
        token_hash  TEXT PRIMARY KEY,
        profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS score_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id  TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        round_id    TEXT    NOT NULL,
        points      INTEGER NOT NULL DEFAULT 0,
        correct     INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0,1)),
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(profile_id, round_id)
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_leaderboard
        ON profiles(lifetime_score DESC, score_reached_at ASC, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_score_events_profile
        ON score_events(profile_id, round_id);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (2)').run();
  }
}

// ─── Token / hash ─────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Name generation with UNIQUE retry ────────────────────────────────────

function generateUniqueName(db, generate, currentName, maxAttempts) {
  const limit = maxAttempts || 20;
  for (let i = 0; i < limit; i++) {
    const name = generate();
    // Skip if same as current (regeneration must produce a different name)
    if (name === currentName) continue;
    // Check uniqueness
    const existing = db.prepare(
      'SELECT id FROM profiles WHERE display_name = ? COLLATE NOCASE'
    ).get(name);
    if (!existing) return name;
  }
  throw new Error('Name generation exhausted: too many collisions');
}

// ─── Profile operations ───────────────────────────────────────────────────

function getOrCreateProfile(db, token, generate) {
  const hash = hashToken(token);
  // Look up by credential hash (profile_credentials table created in migration)
  const cred = db.prepare('SELECT profile_id FROM profile_credentials WHERE token_hash = ?').get(hash);
  if (cred) {
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(cred.profile_id);
  }

  // No credential found — create new profile + credential in one transaction
  const profileId = crypto.randomUUID();
  const name = generateUniqueName(db, generate, null);
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    db.prepare('INSERT INTO profiles (id, display_name, score_reached_at) VALUES (?,?,unixepoch())').run(profileId, name);
    db.prepare('INSERT INTO profile_credentials (token_hash, profile_id) VALUES (?,?)').run(hash, profileId);
    db.prepare('COMMIT').run();
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  } catch(e) {
    try { db.prepare('ROLLBACK').run(); } catch(_) {}
    throw e;
  }
}

function ensureCredentialsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profile_credentials (
      token_hash  TEXT PRIMARY KEY,
      profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

/**
 * Regenerate a profile's display name.
 * Must produce a DIFFERENT name. Preserves all score totals.
 */
function regenerateName(db, profileId, generate, currentName) {
  const name = generateUniqueName(db, generate, currentName, 30);
  db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(name, profileId);
  return name;
}

/**
 * Record a scoring event atomically.
 * One explicit BEGIN IMMEDIATE transaction for both INSERT and UPDATE.
 * Returns true if new, false if duplicate (replay idempotent).
 */
function recordScore(db, profileId, roundId, points, correct) {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO score_events (profile_id, round_id, points, correct)
      VALUES (?, ?, ?, ?)
    `);
    const r = ins.run(profileId, roundId, points, correct ? 1 : 0);

    if (r.changes === 0) {
      db.prepare('COMMIT').run();
      return false; // duplicate — no change
    }

    // Compute new score (floor at 0)
    const prof = db.prepare('SELECT lifetime_score FROM profiles WHERE id = ?').get(profileId);
    const oldScore = prof ? Number(prof.lifetime_score) : 0;
    const newScore = Math.max(0, oldScore + points);
    const scoreChanged = newScore !== oldScore;

    db.prepare(`
      UPDATE profiles SET
        lifetime_score  = ?,
        correct_answers = correct_answers + ?,
        score_reached_at = CASE WHEN ? THEN unixepoch() ELSE score_reached_at END
      WHERE id = ?
    `).run(newScore, correct ? 1 : 0, scoreChanged ? 1 : 0, profileId);

    db.prepare('COMMIT').run();
    return true;
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch (_) {}
    throw e;
  }
}

/**
 * Public leaderboard — safe fields only, scored players only.
 * No internal IDs, no timestamps, no token data.
 * Returns [{rank, name, score, correctCount}]
 */
function getLeaderboard(db, limit, currentProfileId) {
  const n = Math.min(Math.max(1, Number.isFinite(limit) ? limit : 25), 100);
  // id used internally only for isYou computation — never returned to client
  return db.prepare(`
    SELECT id, display_name AS name, lifetime_score AS score,
           correct_answers AS correctCount
    FROM profiles
    WHERE lifetime_score > 0
    ORDER BY lifetime_score DESC, score_reached_at ASC, created_at ASC, id ASC
    LIMIT ?
  `).all(n).map((row, i) => {
    const entry = { rank: i + 1, name: row.name, score: row.score, correctCount: row.correctCount };
    if (currentProfileId && row.id === currentProfileId) entry.isYou = true;
    return entry;
  });
}

/**
 * Return 1-based rank for a profile (among scored players).
 * Returns null if the profile has no score.
 */
function getProfileRank(db, profileId) {
  const p = db.prepare('SELECT lifetime_score, score_reached_at, created_at FROM profiles WHERE id = ?').get(profileId);
  if (!p || p.lifetime_score === 0) return null;
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM profiles
    WHERE lifetime_score > 0 AND (
      lifetime_score > ?
      OR (lifetime_score = ? AND score_reached_at < ?)
      OR (lifetime_score = ? AND score_reached_at = ? AND created_at < ?)
    )
  `).get(
    p.lifetime_score,
    p.lifetime_score, p.score_reached_at,
    p.lifetime_score, p.score_reached_at, p.created_at
  );
  return row ? Number(row.rank) : 1;
}

/** Safe public profile summary.
 * No DB UUID, token_hash, or timestamps are exposed. isYou is for the current viewer only.
 */
function publicProfile(profile, rank, isYou) {
  const out = {
    name:          profile.display_name,
    lifetimeScore: profile.lifetime_score,
    correctCount:  profile.correct_answers,
    rank:          rank !== undefined && rank !== null ? rank : null,
    ranked:        profile.lifetime_score > 0,
  };
  if (isYou) out.isYou = true;
  return out;
}

module.exports = {
  openDb, getDb, closeDb,
  hashToken, generateUniqueName, ensureCredentialsTable,
  getOrCreateProfile, regenerateName, recordScore,
  getLeaderboard, getProfileRank, publicProfile,
  DATA_DIR, DB_PATH,
};
