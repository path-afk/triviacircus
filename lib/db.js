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

  if (current < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        profile_id       TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
        password_salt    BLOB NOT NULL,
        password_hash    BLOB NOT NULL,
        password_version INTEGER NOT NULL DEFAULT 1,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES accounts(profile_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_profile ON auth_sessions(profile_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (3)').run();
  }

  if (current < 4) {
    db.exec(`
      ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1));
      ALTER TABLE accounts ADD COLUMN last_login_at INTEGER;
      ALTER TABLE accounts ADD COLUMN last_logout_at INTEGER;
      ALTER TABLE accounts ADD COLUMN last_seen_at INTEGER;
      ALTER TABLE score_events ADD COLUMN elapsed_ms INTEGER;
      ALTER TABLE score_events ADD COLUMN category TEXT;
      CREATE TABLE IF NOT EXISTS account_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        event TEXT NOT NULL CHECK (event IN ('login','logout','join','disconnect')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_account_activity_profile_time ON account_activity(profile_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_score_events_created ON score_events(created_at DESC);
    `);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (4)').run();
  }

  if (current < 5) {
    db.exec(`ALTER TABLE accounts ADD COLUMN email TEXT COLLATE NOCASE; CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email COLLATE NOCASE) WHERE email IS NOT NULL;`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (5)').run();
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

function getProfileByToken(db, token) {
  if (!token) return null;
  const cred = db.prepare('SELECT profile_id FROM profile_credentials WHERE token_hash = ?').get(hashToken(token));
  return cred ? db.prepare('SELECT * FROM profiles WHERE id = ?').get(cred.profile_id) : null;
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
function recordScore(db, profileId, roundId, points, correct, details) {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const ins = db.prepare(`
      INSERT OR IGNORE INTO score_events (profile_id, round_id, points, correct, elapsed_ms, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const elapsedMs = details && Number.isFinite(details.elapsedMs) ? Math.max(0, Math.round(details.elapsedMs)) : null;
    const category = details && typeof details.category === 'string' ? details.category.slice(0, 80) : null;
    const r = ins.run(profileId, roundId, points, correct ? 1 : 0, elapsedMs, category);

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

// ─── Registered accounts / sessions ───────────────────────────────────────

function getAccountByUsername(db, identifier) {
  return db.prepare(`
    SELECT p.*, a.password_salt, a.password_hash, a.password_version, a.email, a.is_admin
    FROM accounts a JOIN profiles p ON p.id = a.profile_id
    WHERE a.email = ? COLLATE NOCASE OR p.display_name = ? COLLATE NOCASE
  `).get(identifier, identifier);
}

function isRegisteredProfile(db, profileId) {
  return !!db.prepare('SELECT 1 AS ok FROM accounts WHERE profile_id = ?').get(profileId);
}

function registerAccount(db, profileId, username, passwordSalt, passwordHash, email) {
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    if (isRegisteredProfile(db, profileId)) throw new Error('Profile already registered');
    db.prepare('UPDATE profiles SET display_name = ? WHERE id = ?').run(username, profileId);
    db.prepare(`
      INSERT INTO accounts (profile_id, password_salt, password_hash, email) VALUES (?,?,?,?)
    `).run(profileId, passwordSalt, passwordHash, email || null);
    // Once upgraded, the old long-lived guest token must not authenticate this account.
    db.prepare('DELETE FROM profile_credentials WHERE profile_id = ?').run(profileId);
    db.prepare('COMMIT').run();
    return db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch (_) {}
    throw e;
  }
}

function createSession(db, profileId, rawToken, expiresAt) {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= unixepoch()').run();
  db.prepare(`
    INSERT INTO auth_sessions (token_hash, profile_id, expires_at) VALUES (?,?,?)
  `).run(hashToken(rawToken), profileId, expiresAt);
}

function resolveSession(db, rawToken) {
  if (!rawToken) return null;
  return db.prepare(`
    SELECT p.* FROM auth_sessions s
    JOIN profiles p ON p.id = s.profile_id
    WHERE s.token_hash = ? AND s.expires_at > unixepoch()
  `).get(hashToken(rawToken));
}

function revokeSession(db, rawToken) {
  if (!rawToken) return false;
  return db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(rawToken)).changes > 0;
}

function ensureOwnerAccount(db, email, passwordSalt, passwordHash) {
  if (!email || !passwordSalt || !passwordHash) return null;
  let account = getAccountByUsername(db, email);
  if (account) {
    db.prepare('UPDATE accounts SET is_admin = 1 WHERE profile_id = ?').run(account.id);
    return account;
  }
  const profileId = crypto.randomUUID();
  let displayName = 'CircusOwner';
  if (db.prepare('SELECT 1 FROM profiles WHERE display_name = ? COLLATE NOCASE').get(displayName)) displayName = 'CircusOwner_' + crypto.randomBytes(3).toString('hex');
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    db.prepare('INSERT INTO profiles (id, display_name, score_reached_at) VALUES (?,?,unixepoch())').run(profileId, displayName);
    db.prepare('INSERT INTO accounts (profile_id,password_salt,password_hash,email,is_admin) VALUES (?,?,?,?,1)').run(profileId,passwordSalt,passwordHash,email);
    db.prepare('COMMIT').run();
    return getAccountByUsername(db, email);
  } catch (e) { try { db.prepare('ROLLBACK').run(); } catch (_) {} throw e; }
}

function bootstrapAdmin(db, email) {
  if (!email) return false;
  return db.prepare(`UPDATE accounts SET is_admin = 1 WHERE email = ? COLLATE NOCASE`).run(email).changes > 0;
}

function isAdminProfile(db, profileId) {
  return !!profileId && !!db.prepare('SELECT 1 AS ok FROM accounts WHERE profile_id = ? AND is_admin = 1').get(profileId);
}

function recordAccountActivity(db, profileId, event) {
  if (!profileId || !['login','logout','join','disconnect'].includes(event)) return;
  db.prepare('INSERT INTO account_activity (profile_id, event) VALUES (?,?)').run(profileId, event);
  const column = event === 'login' ? 'last_login_at' : event === 'logout' ? 'last_logout_at' : 'last_seen_at';
  db.prepare(`UPDATE accounts SET ${column} = unixepoch() WHERE profile_id = ?`).run(profileId);
}

function getAdminAnalytics(db, onlineProfileIds) {
  const online = new Set(onlineProfileIds || []);
  const users = db.prepare(`SELECT p.id, p.display_name AS username, p.lifetime_score AS score, p.correct_answers AS correctAnswers, p.created_at AS createdAt, a.last_login_at AS lastLoginAt, a.last_logout_at AS lastLogoutAt, a.last_seen_at AS lastSeenAt, COUNT(se.id) AS answers, COALESCE(SUM(se.correct),0) AS correct, ROUND(AVG(se.elapsed_ms)) AS avgAnswerMs, MIN(CASE WHEN se.correct=1 THEN se.elapsed_ms END) AS fastestCorrectMs FROM accounts a JOIN profiles p ON p.id=a.profile_id LEFT JOIN score_events se ON se.profile_id=p.id WHERE a.is_admin=0 GROUP BY p.id ORDER BY a.last_seen_at DESC, p.created_at DESC`).all().map(row => { const {id, ...safe}=row; return {...safe, online:online.has(id)}; });
  const totals = db.prepare(`SELECT (SELECT COUNT(*) FROM accounts WHERE is_admin = 0) AS registeredUsers, (SELECT COUNT(*) FROM profiles) AS allProfiles, COUNT(*) AS answers, COALESCE(SUM(correct),0) AS correctAnswers, ROUND(AVG(elapsed_ms)) AS avgAnswerMs, MIN(CASE WHEN correct=1 THEN elapsed_ms END) AS fastestCorrectMs, COALESCE(SUM(points),0) AS pointsAwarded FROM score_events`).get();
  const categories = db.prepare(`SELECT category, COUNT(*) AS answers, COALESCE(SUM(correct),0) AS correct, ROUND(AVG(elapsed_ms)) AS avgAnswerMs FROM score_events WHERE category IS NOT NULL GROUP BY category ORDER BY answers DESC LIMIT 20`).all();
  const activity = db.prepare(`SELECT p.display_name AS username, aa.event, aa.created_at AS createdAt FROM account_activity aa JOIN profiles p ON p.id=aa.profile_id ORDER BY aa.id DESC LIMIT 100`).all();
  return {totals:{...totals,onlineUsers:online.size},users,categories,activity};
}

function mergeGuestIntoAccount(db, sourceProfileId, targetProfileId) {
  if (!sourceProfileId || sourceProfileId === targetProfileId) return;
  db.prepare('BEGIN IMMEDIATE').run();
  try {
    const source = db.prepare('SELECT * FROM profiles WHERE id = ?').get(sourceProfileId);
    const target = db.prepare('SELECT * FROM profiles WHERE id = ?').get(targetProfileId);
    if (!source || !target) throw new Error('Profile unavailable for merge');

    const events = db.prepare('SELECT round_id, points, correct, created_at FROM score_events WHERE profile_id = ?').all(sourceProfileId);
    for (const event of events) {
      let roundId = event.round_id;
      const clash = db.prepare('SELECT 1 AS ok FROM score_events WHERE profile_id = ? AND round_id = ?').get(targetProfileId, roundId);
      if (clash) roundId = 'merged:' + sourceProfileId + ':' + roundId;
      db.prepare(`
        INSERT OR IGNORE INTO score_events (profile_id, round_id, points, correct, created_at)
        VALUES (?,?,?,?,?)
      `).run(targetProfileId, roundId, event.points, event.correct, event.created_at);
    }
    db.prepare('DELETE FROM score_events WHERE profile_id = ?').run(sourceProfileId);
    db.prepare(`
      UPDATE profiles SET lifetime_score = lifetime_score + ?,
        correct_answers = correct_answers + ?, score_reached_at = unixepoch()
      WHERE id = ?
    `).run(source.lifetime_score, source.correct_answers, targetProfileId);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(sourceProfileId);
    db.prepare('COMMIT').run();
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch (_) {}
    throw e;
  }
}

/** Safe public profile summary.
 * No DB UUID, token_hash, or timestamps are exposed. isYou is for the current viewer only.
 */
function publicProfile(profile, rank, isYou, registered) {
  const out = {
    name:          profile.display_name,
    lifetimeScore: profile.lifetime_score,
    correctCount:  profile.correct_answers,
    rank:          rank !== undefined && rank !== null ? rank : null,
    ranked:        profile.lifetime_score > 0,
    registered:    !!registered,
  };
  if (isYou) out.isYou = true;
  return out;
}

module.exports = {
  openDb, getDb, closeDb,
  hashToken, generateUniqueName, ensureCredentialsTable,
  getOrCreateProfile, getProfileByToken, regenerateName, recordScore,
  getLeaderboard, getProfileRank, publicProfile,
  getAccountByUsername, isRegisteredProfile, registerAccount,
  createSession, resolveSession, revokeSession, mergeGuestIntoAccount,
  ensureOwnerAccount, bootstrapAdmin, isAdminProfile, recordAccountActivity, getAdminAnalytics,
  DATA_DIR, DB_PATH,
};
