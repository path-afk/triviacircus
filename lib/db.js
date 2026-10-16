'use strict';
/**
 * Trivia Circus persistence layer.
 * Uses node:sqlite (built-in, Node ≥ 22.5.0, stable in Node 24+).
 * WAL mode for concurrent reads. All writes are synchronous/transactional.
 * Schema versioning via schema_migrations table.
 */

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error(
    'node:sqlite is required (Node.js v22.5.0+). ' +
    'Current version: ' + process.version + '. ' + e.message
  );
}

const DATA_DIR = process.env.TC_DATA_DIR
  ? path.resolve(process.env.TC_DATA_DIR)
  : path.join(__dirname, '..', 'data');

const DB_PATH = path.join(DATA_DIR, 'trivia.db');

// Module-scoped singleton — close() resets it for tests.
let _db   = null;
let _path = null;

function openDb(dbPath) {
  const resolved = dbPath || DB_PATH;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=NORMAL');
  migrate(db);
  return db;
}

/** Return the module-scoped singleton; open if needed. */
function getDb(dbPath) {
  if (_db && (!dbPath || dbPath === _path)) return _db;
  _db   = openDb(dbPath || DB_PATH);
  _path = dbPath || DB_PATH;
  return _db;
}

/** Close and reset the singleton (used in tests). */
function closeDb() {
  if (_db) { try { _db.close(); } catch (_) {} _db = null; _path = null; }
}

// ─── Migrations ────────────────────────────────────────────────────────────

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  const current = row && row.v != null ? Number(row.v) : 0;

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        token_hash      TEXT    UNIQUE NOT NULL,
        display_name    TEXT    NOT NULL,
        custom_name     TEXT,
        lifetime_score  INTEGER NOT NULL DEFAULT 0,
        correct_answers INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS score_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        round_id   TEXT    NOT NULL,
        points     INTEGER NOT NULL DEFAULT 0,
        correct    INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(profile_id, round_id)
      );

      CREATE INDEX IF NOT EXISTS idx_profiles_token_hash
        ON profiles(token_hash);
      CREATE INDEX IF NOT EXISTS idx_profiles_leaderboard
        ON profiles(lifetime_score DESC, correct_answers DESC, created_at ASC, id ASC);
    `);
    db.prepare('INSERT INTO schema_migrations (version) VALUES (1)').run();
  }
  // future migrations: if (current < 2) { ... }
}

// ─── Token hashing ─────────────────────────────────────────────────────────

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── Profile operations ────────────────────────────────────────────────────

/**
 * Look up profile by token; create with a generated name if absent.
 * @param {object} db
 * @param {string} token  Raw opaque token (32 bytes hex)
 * @param {function} generateName  () => string
 * @returns {object} profile row
 */
function getOrCreateProfile(db, token, generateName) {
  const hash = hashToken(token);
  let profile = db.prepare('SELECT * FROM profiles WHERE token_hash = ?').get(hash);
  if (!profile) {
    const name = generateName();
    db.prepare(
      'INSERT INTO profiles (token_hash, display_name) VALUES (?, ?)'
    ).run(hash, name);
    profile = db.prepare('SELECT * FROM profiles WHERE token_hash = ?').get(hash);
  }
  return profile;
}

/**
 * Re-generate the display_name for a profile, preserving all score totals.
 * Custom name is NOT affected.
 * @returns {string} new display_name
 */
function regenerateName(db, profileId, generateName) {
  const name = generateName();
  db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(name, profileId);
  return name;
}

/**
 * Set a custom name on the profile (profanity/sanitization is the caller's responsibility).
 * Pass null to clear.
 */
function setCustomName(db, profileId, name) {
  db.prepare('UPDATE profiles SET custom_name = ? WHERE id = ?').run(name, profileId);
}

/**
 * Record a scoring event idempotently.
 * Returns true if the event was new (points applied), false if duplicate (ignored).
 */
function recordScore(db, profileId, roundId, points, correct) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO score_events (profile_id, round_id, points, correct)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(profileId, roundId, points, correct ? 1 : 0);
  if (result.changes > 0) {
    db.prepare(`
      UPDATE profiles
      SET lifetime_score  = lifetime_score + ?,
          correct_answers = correct_answers + ?
      WHERE id = ?
    `).run(points, correct ? 1 : 0, profileId);
    return true;
  }
  return false; // duplicate — no change
}

/**
 * Return top-N profiles ordered by lifetime_score DESC, correct_answers DESC,
 * created_at ASC (older accounts win ties), then id ASC (fully deterministic).
 */
function getLeaderboard(db, limit) {
  const n = Number.isFinite(limit) && limit > 0 ? limit : 25;
  return db.prepare(`
    SELECT id, display_name, custom_name, lifetime_score, correct_answers, created_at
    FROM profiles
    ORDER BY lifetime_score DESC, correct_answers DESC, created_at ASC, id ASC
    LIMIT ?
  `).all(n);
}

/**
 * Return the 1-based rank of a profile in the global leaderboard.
 */
function getProfileRank(db, profileId) {
  const p = db.prepare(
    'SELECT lifetime_score, correct_answers, created_at, id FROM profiles WHERE id = ?'
  ).get(profileId);
  if (!p) return null;
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM profiles WHERE
      lifetime_score > ?
      OR (lifetime_score = ? AND correct_answers > ?)
      OR (lifetime_score = ? AND correct_answers = ? AND created_at < ?)
      OR (lifetime_score = ? AND correct_answers = ? AND created_at = ? AND id < ?)
  `).get(
    p.lifetime_score,
    p.lifetime_score, p.correct_answers,
    p.lifetime_score, p.correct_answers, p.created_at,
    p.lifetime_score, p.correct_answers, p.created_at, p.id
  );
  return row ? Number(row.rank) : 1;
}

/** Return the effective display label: custom_name takes precedence over display_name. */
function effectiveName(profile) {
  return (profile.custom_name && profile.custom_name.trim()) || profile.display_name;
}

module.exports = {
  getDb, closeDb, openDb, hashToken,
  getOrCreateProfile, regenerateName, setCustomName,
  recordScore, getLeaderboard, getProfileRank, effectiveName,
  DATA_DIR, DB_PATH,
};
