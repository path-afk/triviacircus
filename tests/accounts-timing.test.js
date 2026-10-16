'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateUsername,
  validatePassword,
  hashPassword,
  verifyPassword,
} = require('../lib/auth');
const {
  openDb,
  getOrCreateProfile,
  getProfileByToken,
  recordScore,
  registerAccount,
  createSession,
  resolveSession,
  revokeSession,
  mergeGuestIntoAccount,
} = require('../lib/db');
const { calculateTimeBonus, validateAnswer, CFG } = require('../server');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-accounts-timing-'));
  const db = openDb(path.join(dir, 'trivia.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function createGuest(db, token, name) {
  return getOrCreateProfile(db, token, () => name);
}

function registerForTest(db, profileId, username) {
  return registerAccount(
    db,
    profileId,
    username,
    Buffer.alloc(16, 3),
    Buffer.alloc(64, 9),
  );
}

test('username and password validation enforce account input limits', () => {
  assert.equal(validateUsername('  Player_1  '), 'Player_1');
  assert.equal(validateUsername('abc'), 'abc');
  assert.equal(validateUsername('A'.repeat(24)), 'A'.repeat(24));
  for (const invalid of [null, 42, '', 'ab', 'A'.repeat(25), 'two words', 'bad-name']) {
    assert.equal(validateUsername(invalid), null);
  }

  assert.equal(validatePassword('12345678'), '12345678');
  assert.equal(validatePassword(' xxxxxx '), ' xxxxxx ');
  assert.equal(validatePassword('x'.repeat(128)), 'x'.repeat(128));
  for (const invalid of [null, 42, '1234567', 'x'.repeat(129), '€'.repeat(100)]) {
    assert.equal(validatePassword(invalid), null);
  }
});

test('password hashing verifies the password and rejects a wrong password', async () => {
  const password = 'correct horse battery staple';
  const first = await hashPassword(password);
  const second = await hashPassword(password);

  assert.equal(first.salt.length, 16);
  assert.equal(first.hash.length, 64);
  assert.notDeepEqual(first.salt, second.salt, 'each password hash must use a fresh salt');
  assert.equal(await verifyPassword(password, first.salt, first.hash), true);
  assert.equal(await verifyPassword('wrong password', first.salt, first.hash), false);
  await assert.rejects(hashPassword('short'), /Invalid password/);
});

test('database migration creates account and session schema', t => {
  const db = tempDb(t);
  const tables = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map(row => row.name));

  assert.equal(tables.has('accounts'), true);
  assert.equal(tables.has('auth_sessions'), true);
  assert.equal(
    db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    3,
  );
});

test('registerAccount preserves guest score and removes the guest credential', t => {
  const db = tempDb(t);
  const token = 'a'.repeat(64);
  const guest = createGuest(db, token, 'Guest Otter');
  recordScore(db, guest.id, 'guest-round', 175, true);

  const registered = registerForTest(db, guest.id, 'Player_One');
  assert.equal(registered.display_name, 'Player_One');
  assert.equal(registered.lifetime_score, 175);
  assert.equal(registered.correct_answers, 1);
  assert.equal(getProfileByToken(db, token), null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM profile_credentials WHERE profile_id = ?').get(guest.id).count,
    0,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE profile_id = ?').get(guest.id).count,
    1,
  );
});

test('sessions can be created, resolved, and revoked', t => {
  const db = tempDb(t);
  const guest = createGuest(db, 'b'.repeat(64), 'Session Badger');
  registerForTest(db, guest.id, 'SessionUser');
  const rawToken = 'c'.repeat(64);
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  createSession(db, guest.id, rawToken, expiresAt);
  const stored = db.prepare('SELECT token_hash, expires_at FROM auth_sessions').get();
  assert.notEqual(stored.token_hash, rawToken, 'only a token hash may be stored');
  assert.equal(stored.expires_at, expiresAt);
  assert.equal(resolveSession(db, rawToken).id, guest.id);
  assert.equal(resolveSession(db, 'd'.repeat(64)), undefined);
  assert.equal(revokeSession(db, rawToken), true);
  assert.equal(resolveSession(db, rawToken), undefined);
  assert.equal(revokeSession(db, rawToken), false);
});

test('mergeGuestIntoAccount transfers score and events into the account', t => {
  const db = tempDb(t);
  const account = createGuest(db, 'e'.repeat(64), 'Account Eagle');
  registerForTest(db, account.id, 'AccountUser');
  recordScore(db, account.id, 'shared-round', 40, true);

  const guest = createGuest(db, 'f'.repeat(64), 'Guest Falcon');
  recordScore(db, guest.id, 'shared-round', 30, true);
  recordScore(db, guest.id, 'guest-only-round', 0, false);

  mergeGuestIntoAccount(db, guest.id, account.id);

  const merged = db.prepare('SELECT * FROM profiles WHERE id = ?').get(account.id);
  assert.equal(merged.lifetime_score, 70);
  assert.equal(merged.correct_answers, 2);
  assert.equal(db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(guest.id), undefined);

  const events = db.prepare(
    'SELECT round_id, points, correct FROM score_events WHERE profile_id = ? ORDER BY id'
  ).all(account.id);
  assert.equal(events.length, 3);
  assert.deepEqual(
    new Set(events.map(event => event.round_id)),
    new Set([
      'shared-round',
      'merged:' + guest.id + ':shared-round',
      'guest-only-round',
    ]),
  );
  assert.equal(events.reduce((sum, event) => sum + event.points, 0), 70);
});

test('calculateTimeBonus declines from the configured maximum to zero', () => {
  assert.equal(calculateTimeBonus(0), CFG.SPEED_BONUS);
  assert.equal(calculateTimeBonus(-100), CFG.SPEED_BONUS);
  assert.equal(calculateTimeBonus(CFG.QUESTION_MS), 0);
  assert.equal(calculateTimeBonus(CFG.QUESTION_MS + 1000), 0);

  const checkpoints = [0, 0.25, 0.5, 0.75, 1]
    .map(fraction => calculateTimeBonus(CFG.QUESTION_MS * fraction));
  assert.deepEqual(checkpoints, [100, 75, 50, 25, 0]);
  for (let i = 1; i < checkpoints.length; i += 1) {
    assert.ok(checkpoints[i] <= checkpoints[i - 1]);
  }
});

test('validateAnswer requires roundId and rejects oversized or stale-shaped payloads', () => {
  assert.deepEqual(
    validateAnswer({ answer: '  Paris  ', roundId: 'round-current' }),
    { answer: 'Paris', roundId: 'round-current' },
  );

  const invalid = [
    null,
    { answer: 'Paris' },
    { answer: 'Paris', questionId: 'old-client-shape' },
    { choice: 'A', roundId: 'round-current' },
    { answer: '', roundId: 'round-current' },
    { answer: '   ', roundId: 'round-current' },
    { answer: 'x'.repeat(CFG.MAX_ANSWER_LEN + 1), roundId: 'round-current' },
    { answer: 'Paris', roundId: '' },
    { answer: 'Paris', roundId: 'r'.repeat(81) },
    { answer: 'Paris', roundId: { previous: 'round-old' } },
  ];
  for (const payload of invalid) assert.equal(validateAnswer(payload), null);
});
