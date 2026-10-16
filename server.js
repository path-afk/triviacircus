/**
 * Trivia Circus — Hardened Server (TC security review applied)
 * Fixes: server-side timing, XSS-safe names, payload validation,
 *        Trust Bonus with nonresponders, Oracle semantics, SYG,
 *        disconnect re-evaluation, one-circus-per-socket.
 */
'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs           = require('fs');
const crypto        = require('crypto');
const cookieParser  = require('cookie-parser');
const {
  generateToken, setCookie, clearGuestCookie, getToken, tokenFromCookieHeader,
  setSessionCookie, clearSessionCookie, getSessionToken, sessionTokenFromCookieHeader,
  validateUsername, validatePassword, hashPassword, verifyPassword, SESSION_MAX_AGE,
} = require('./lib/auth');
const {
  getDb, getOrCreateProfile, getProfileByToken, regenerateName, recordScore,
  getLeaderboard, getProfileRank, publicProfile, getAccountByUsername,
  isRegisteredProfile, registerAccount, createSession, resolveSession, revokeSession,
  mergeGuestIntoAccount, ensureOwnerAccount, bootstrapAdmin, isAdminProfile, recordAccountActivity, getAdminAnalytics,
} = require('./lib/db');
const names         = require('./lib/names');
const { categoryBalancedShuffle } = require('./lib/question-order');
const { PLAYER_STATUSES, validatePlayerStatus } = require('./lib/player-status');
const {
  HUMAN_COOKIE, HUMAN_MAX_AGE_MS, getHumanGateConfig, createHumanToken,
  verifyHumanToken, cookieValueFromHeader, verifyTurnstile,
} = require('./lib/human-gate');

const HUMAN_GATE = getHumanGateConfig();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD_SALT = /^[0-9a-f]{32}$/i.test(process.env.ADMIN_PASSWORD_SALT || '') ? Buffer.from(process.env.ADMIN_PASSWORD_SALT, 'hex') : null;
const ADMIN_PASSWORD_HASH = /^[0-9a-f]{128}$/i.test(process.env.ADMIN_PASSWORD_HASH || '') ? Buffer.from(process.env.ADMIN_PASSWORD_HASH, 'hex') : null;

if (ADMIN_EMAIL && ADMIN_PASSWORD_SALT && ADMIN_PASSWORD_HASH) ensureOwnerAccount(getDb(), ADMIN_EMAIL, ADMIN_PASSWORD_SALT, ADMIN_PASSWORD_HASH);

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: process.env.NODE_ENV === 'production' ? false : { origin: true },
  transports: ['websocket', 'polling']
});
app.use(cookieParser());
app.use(express.json({ limit: '4kb', strict: true }));

// ── Guest profile cookie middleware ──────────────────────────────────────────
// Must come BEFORE express.static so Set-Cookie is included on static file responses.
// Creates an opaque 32-byte token on first visit (HttpOnly, SameSite=Lax, 1 year).
// Token hash is stored server-side; raw token is never persisted.
app.use((req, res, next) => {
  let token = getToken(req.cookies);
  const sessionToken = getSessionToken(req.cookies);
  // Registered players do not need a guest credential until they log out.
  if (!token && !sessionToken) {
    token = generateToken();
    setCookie(res, token);
  }
  req._tcToken = token;
  req._tcSessionToken = sessionToken;
  next();
});

function requireAdmin(req, res, next) {
  const db = getDb();
  if (ADMIN_EMAIL) bootstrapAdmin(db, ADMIN_EMAIL);
  const profile = resolveSession(db, req._tcSessionToken);
  if (!profile || !isAdminProfile(db, profile.id)) return res.status(404).send('Not found');
  req._tcAdminProfile = profile;
  next();
}

app.get('/owner.html', (req, res) => res.status(404).send('Not found'));

app.get('/owner', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

app.get('/api/owner/analytics', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const onlineIds = [...circus.profileSockets.entries()].filter(([, sockets]) => sockets.size > 0).map(([id]) => id);
  res.json(getAdminAnalytics(getDb(), onlineIds));
});

app.use(express.static(path.join(__dirname, 'public')));

// Simple in-memory rate limiter for rename endpoint (no external dep)
const _renameTs = new Map();
const RENAME_COOLDOWN_MS = 5000;
function renameRateLimiter(req, res, next) {
  const now = Date.now();
  const last = _renameTs.get(req._tcToken);
  if (last && now - last < RENAME_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Please wait a moment before renaming again.' });
  }
  _renameTs.set(req._tcToken, now);
  if (_renameTs.size > 5000) {
    for (const [k, v] of _renameTs) { if (now - v > RENAME_COOLDOWN_MS * 10) _renameTs.delete(k); }
  }
  next();
}

// ── Persistence / account API ─────────────────────────────────────────────────
function requestIdentity(req, createGuest = true) {
  const db = getDb();
  const accountProfile = resolveSession(db, req._tcSessionToken);
  if (accountProfile) return { db, profile: accountProfile, registered: true };
  const guest = createGuest
    ? getOrCreateProfile(db, req._tcToken || generateToken(), names.generate)
    : getProfileByToken(db, req._tcToken);
  return { db, profile: guest, registered: false };
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked' });
  } catch (_) { return res.status(403).json({ error: 'Cross-origin request blocked' }); }
  next();
}

function isHumanRequest(req) {
  return !HUMAN_GATE.enabled || verifyHumanToken(req.cookies[HUMAN_COOKIE], HUMAN_GATE.signingSecret);
}

function requireHuman(req, res, next) {
  if (isHumanRequest(req)) return next();
  return res.status(403).json({ error: 'Human verification required.', code: 'HUMAN_VERIFICATION_REQUIRED' });
}

const _humanAttempts = new Map();
function humanVerifyRateLimiter(req, res, next) {
  const key = req.get('cf-connecting-ip') || req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (_humanAttempts.get(key) || []).filter(ts => now - ts < 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Please wait before trying again.' });
  recent.push(now);
  _humanAttempts.set(key, recent);
  if (_humanAttempts.size > 5000) {
    for (const [candidate, list] of _humanAttempts) if (!list.some(ts => now - ts < 60 * 1000)) _humanAttempts.delete(candidate);
  }
  next();
}

const _authAttempts = new Map();
function authRateLimited(req, username) {
  const now = Date.now();
  const key = (req.ip || req.socket.remoteAddress || 'unknown') + ':' + String(username || '').toLowerCase();
  const recent = (_authAttempts.get(key) || []).filter(ts => now - ts < 15 * 60 * 1000);
  recent.push(now);
  _authAttempts.set(key, recent);
  if (_authAttempts.size > 5000) {
    for (const [k, list] of _authAttempts) if (!list.some(ts => now - ts < 15 * 60 * 1000)) _authAttempts.delete(k);
  }
  return recent.length > 10;
}

function publicIdentity(db, profile, registered) {
  return publicProfile(profile, getProfileRank(db, profile.id), undefined, registered);
}

app.get('/api/human/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: HUMAN_GATE.enabled,
    siteKey: HUMAN_GATE.enabled ? HUMAN_GATE.siteKey : '',
    verified: isHumanRequest(req),
  });
});

app.post('/api/human/verify', requireSameOrigin, humanVerifyRateLimiter, async (req, res) => {
  if (!HUMAN_GATE.enabled) return res.json({ ok: true });
  const verified = await verifyTurnstile({
    response: req.body && req.body.token,
    remoteip: req.get('cf-connecting-ip') || req.ip,
    config: HUMAN_GATE,
  });
  if (!verified) return res.status(403).json({ error: 'Verification failed. Please try again.' });
  res.cookie(HUMAN_COOKIE, createHumanToken(HUMAN_GATE.signingSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: HUMAN_MAX_AGE_MS,
  });
  res.json({ ok: true });
});

// GET /api/profile — return the current persistent guest or registered profile
app.get('/api/profile', (req, res) => {
  try {
    const { db, profile, registered } = requestIdentity(req);
    res.json(publicIdentity(db, profile, registered));
  } catch (e) { res.status(500).json({ error: 'Profile unavailable' }); }
});

// POST /api/profile/rename — regenerate display name (rate-limited, 5 s cooldown)
app.post('/api/profile/rename', requireSameOrigin, renameRateLimiter, (req, res) => {
  try {
    const { db, profile: raw, registered } = requestIdentity(req);
    if (registered) return res.status(409).json({ error: 'Registered usernames cannot be regenerated.' });
    regenerateName(db, raw.id, names.generate, raw.display_name);
    const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(raw.id);
    res.json(publicIdentity(db, updated, false));
  } catch (e) { res.status(500).json({ error: 'Rename failed' }); }
});

app.post('/api/auth/register', requireSameOrigin, requireHuman, async (req, res) => {
  const username = validateUsername(req.body && req.body.username);
  const password = validatePassword(req.body && req.body.password);
  if (!username || !password) return res.status(400).json({ error: 'Use 3–24 letters, numbers, or underscores and a password of at least 8 characters.' });
  if (authRateLimited(req, username)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  try {
    const { db, profile, registered } = requestIdentity(req);
    if (registered) return res.status(409).json({ error: 'This profile already has an account.' });
    if (getAccountByUsername(db, username)) return res.status(409).json({ error: 'That username is already taken.' });
    const { salt, hash } = await hashPassword(password);
    const updated = registerAccount(db, profile.id, username, salt, hash);
    const sessionToken = generateToken();
    createSession(db, updated.id, sessionToken, Math.floor(Date.now() / 1000) + SESSION_MAX_AGE);
    recordAccountActivity(db, updated.id, 'login');
    setSessionCookie(res, sessionToken);
    clearGuestCookie(res);
    const player = circus.players.get(updated.id);
    if (player) player.name = updated.display_name;
    broadcast('presence', { players: presencePayload() });
    res.status(201).json({ profile: publicIdentity(db, updated, true) });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'That username is already taken.' });
    console.error('[auth] register:', e.message);
    res.status(500).json({ error: 'Account could not be created.' });
  }
});

const _fakeSalt = Buffer.alloc(16, 7);
const _fakeHash = Buffer.alloc(64, 11);
app.post('/api/auth/login', requireSameOrigin, async (req, res) => {
  const rawIdentifier = String((req.body && (req.body.email || req.body.username)) || '').trim();
  const username = rawIdentifier.includes('@') ? rawIdentifier.toLowerCase() : validateUsername(rawIdentifier);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (authRateLimited(req, username || 'invalid')) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  try {
    const db = getDb();
    const account = username ? getAccountByUsername(db, username) : null;
    const valid = await verifyPassword(password, account ? account.password_salt : _fakeSalt, account ? account.password_hash : _fakeHash);
    if (!account || !valid) return res.status(401).json({ error: 'Invalid username or password.' });

    const guest = getProfileByToken(db, req._tcToken);
    if (guest && guest.id !== account.id) {
      if (circus.phase === 'question' && circus.eligibleProfileIds.has(guest.id)) {
        return res.status(409).json({ error: 'Finish this question, then log in during the answer reveal.' });
      }
      disconnectProfile(guest.id);
      mergeGuestIntoAccount(db, guest.id, account.id);
    }
    const merged = db.prepare('SELECT * FROM profiles WHERE id = ?').get(account.id);
    const sessionToken = generateToken();
    createSession(db, account.id, sessionToken, Math.floor(Date.now() / 1000) + SESSION_MAX_AGE);
    recordAccountActivity(db, account.id, 'login');
    setSessionCookie(res, sessionToken);
    clearGuestCookie(res);
    res.json({ profile: publicIdentity(db, merged, true) });
  } catch (e) {
    console.error('[auth] login:', e.message);
    res.status(500).json({ error: 'Login unavailable.' });
  }
});

app.post('/api/auth/logout', requireSameOrigin, (req, res) => {
  try {
    if (req._tcSessionToken) {
      const db = getDb();
      const profile = resolveSession(db, req._tcSessionToken);
      if (profile) recordAccountActivity(db, profile.id, 'logout');
      revokeSession(db, req._tcSessionToken);
    }
  } catch (_) {}
  clearSessionCookie(res);
  clearGuestCookie(res);
  res.status(204).end();
});

// GET /api/leaderboard?limit=N — all-time top N (scored players only, safe fields)
app.get('/api/leaderboard', (req, res) => {
  try {
    const { db, profile: myRaw } = requestIdentity(req);
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
    const entries = getLeaderboard(db, limit, myRaw?.id);
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: 'Leaderboard unavailable' }); }
});


// ── Question loader (production cache: OpenTriviaQA CC BY-SA 4.0) ──────────────
// Reads from importer/cache/open-trivia-qa.json (prompt/choices/correctIndex schema).
// Falls back to questions/bank.json (A/B/C/D schema) if cache unavailable.

function loadQuestionsFromCache() {
  const cachePath = path.join(__dirname, 'importer', 'cache', 'open-trivia-qa.json');
  if (!fs.existsSync(cachePath)) return null;
  const data  = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const items = data.questions || [];
  const KEYS  = ['A', 'B', 'C', 'D'];
  return items.map(q => {
    // Rotate choices so correctIndex lands on a random position (runtime shuffle)
    const choices = [...q.choices];
    const correct = choices[q.correctIndex];
    // Fisher-Yates with Math.random — not crypto but fine for gameplay
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    const newCorrectIdx = choices.indexOf(correct);
    const options = {};
    KEYS.forEach((k, i) => { options[k] = choices[i]; });
    return {
      id:          q.id,
      category:    q.category,
      difficulty:  q.difficulty === 'hard' ? 3 : q.difficulty === 'medium' ? 2 : 1,
      text:        q.prompt,               // cache field 'prompt' → gameplay field 'text'
      options,
      answer:      KEYS[newCorrectIdx],    // A/B/C/D
      correctAnswer: correct,
      explanation: '',
      // Attribution/license metadata preserved (not shown mid-game)
      _source:     q.source,
      _license:    q.license,
      _sourceUrl:  q.sourceUrl,
    };
  });
}

function loadQuestionsFromFallback() {
  const bankPath = path.join(__dirname, 'questions', 'bank.json');
  if (!fs.existsSync(bankPath)) return [];
  return JSON.parse(fs.readFileSync(bankPath, 'utf8')).map(q => ({
    ...q,
    correctAnswer: q.correctAnswer || q.options?.[q.answer] || '',
  }));
}

function loadQuestions() {
  const cache = loadQuestionsFromCache();
  if (cache && cache.length >= 100) {
    console.log('Questions loaded from cache:', cache.length, '(OpenTriviaQA CC BY-SA 4.0)');
    return cache;
  }
  const fb = loadQuestionsFromFallback();
  console.log('Questions loaded from fallback bank:', fb.length);
  return fb;
}

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  QUESTION_MS:   45000,
  REVEAL_MS:     5500,
  SYG_MS:        6000,   // Stand Your Ground window
  NEXT_DELAY_MS: 2000,
  IDLE_PAUSE_MS: 30000,
  GRACE_MS:      7000,   // retained for title compatibility
  BASE_PTS:      100,
  SPEED_BONUS:   100,    // maximum; decreases smoothly to 0 at the deadline
  FIRST_CORRECT_BONUS: 50,
  STREAK_PER:    20,
  STREAK_CAP:    100,
  TRUST_BONUS:   50,
  ORACLE_BONUS:  80,
  DD_STAKE:      50,
  MAX_PLAYERS:   40,
  MAX_NAME_LEN:  24,
  MAX_ANSWER_LEN: 160,
};

// ── Profanity filter ──────────────────────────────────────────────────────────
const BLOCKED = new Set([
  'fuck','shit','bitch','cunt','dick','cock','pussy','nigger','faggot'
]);
function clean(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim().slice(0, CFG.MAX_NAME_LEN);
  const lower = s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  for (const w of BLOCKED) if (lower.includes(w)) return '';
  return s;
}

const ADJ = ['Cosmic','Neural','Quantum','Solar','Arctic','Velvet','Crimson','Neon','Atomic','Lunar','Vivid','Rapid','Prism','Delta','Cobalt'];
const NON = ['Panda','Falcon','Oracle','Cipher','Sphinx','Nomad','Comet','Vortex','Phantom','Nexus','Glitch','Titan','Raven','Ember'];
function genName() {
  return ADJ[Math.floor(Math.random() * ADJ.length)] +
         NON[Math.floor(Math.random() * NON.length)];
}

// ── Payload validation ────────────────────────────────────────────────────────
const VALID_CHOICES  = new Set(['A', 'B', 'C', 'D']);
const ALLOWED_EMOJIS = new Set(['Knew It', 'Lucky Guess', 'No Way', 'Rematch']);

function validateJoin(data) {
  if (!data || typeof data !== 'object') return null;
  return { name: typeof data.name === 'string' ? data.name : '' };
}
function validateAnswer(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.answer !== 'string' || data.answer.length > CFG.MAX_ANSWER_LEN) return null;
  if (typeof data.roundId !== 'string' || data.roundId.length < 1 || data.roundId.length > 80) return null;
  const answer = data.answer.trim();
  if (!answer) return null;
  return { answer, roundId: data.roundId };
}
function normalizeAnswer(answer) {
  return String(answer || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}
function calculateTimeBonus(elapsedMs) {
  const elapsed = Math.min(Math.max(0, Number(elapsedMs) || 0), CFG.QUESTION_MS);
  return Math.max(0, Math.ceil(CFG.SPEED_BONUS * (CFG.QUESTION_MS - elapsed) / CFG.QUESTION_MS));
}
function validateReaction(data) {
  if (!data || typeof data !== 'object') return null;
  if (!ALLOWED_EMOJIS.has(data.emoji)) return null;
  return { emoji: data.emoji };
}

// ── Earned titles ─────────────────────────────────────────────────────────────
function earnedTitle(stats) {
  const { correct = 0, wrong = 0, oracle = 0, fast = 0, catWins = {} } = stats;
  const total = correct + wrong;
  if (total === 0) return { title: 'Newcomer', emoji: '🌱' };
  const acc = correct / total;
  if (oracle >= 2)            return { title: 'The Oracle', emoji: '🔮' };
  if (acc === 1 && total >= 8) return { title: 'The Perfectionist', emoji: '💎' };
  if (acc >= 0.9 && total >= 6) return { title: 'Brain Trust Elite', emoji: '🧠' };
  if (fast > correct * 0.7 && correct > 3) return { title: 'The Reflex', emoji: '⚡' };
  const top = Object.entries(catWins).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 3) {
    const m = { History: ['The Historian','📜'], Science: ['The Scientist','🔬'],
      Geography: ['The Explorer','🌍'], Culture: ['The Critic','🎭'],
      Sports: ['The Champion','🏆'], 'Wild Card': ['The Wildcard','🃏'] };
    if (m[top[0]]) return { title: m[top[0]][0], emoji: m[top[0]][1] };
  }
  if (acc < 0.35) return { title: 'Brave Soul', emoji: '🫡' };
  return { title: 'The Analyst', emoji: '📊' };
}

let QUESTIONS = [];
// ── Global circus state ───────────────────────────────────────────────────────
const circus = {
  // phase: idle | question | reveal | syg
  phase: 'idle',
  players: new Map(),     // sid → PlayerState
  qIndex: -1,
  currentQ: null,
  questionSentAt: 0,      // wall clock for reconnect countdown
  questionStartedMono: 0, // monotonic server clock for scoring/deadline
  answerSeq: 0,           // deterministic order for first-correct bonus
  // Players who were connected when this question was sent — used for unanimity
  eligibleProfileIds: new Set(),
  answers: new Map(),     // sid → { choice, elapsedMs }
  sygChoices: new Map(),  // sid → 'stay' | 'switch'
  // Players who answered correctly before reveal (for Oracle detection)
  initialCorrect: new Set(),
  timer: null,
  idleTimer: null,
  pool: [],
  poolIdx: 0,
  roundId: null,    // UUID per question — idempotency key for lifetime score events
  roundEarned: new Map(),   // profileId → { points, correct } — accumulated until endRound
  profileSocketMap: new Map(), // profileId → socketId (current active socket)
  profileSockets:   new Map(), // profileId → Set<socketId> (for same-cookie tab tracking)
};

function nextQuestion() {
  circus.poolIdx++;
  if (circus.poolIdx >= circus.pool.length) {
    circus.pool = categoryBalancedShuffle(QUESTIONS);
    circus.poolIdx = 0;
  }
  return circus.pool[circus.poolIdx];
}

function connectedPlayers() {
  return [...circus.players.values()].filter(p => p.connected);
}

function presencePayload() {
  return connectedPlayers().map(p => ({
    name: p.name,
    score: p.score,
    status: p.status || PLAYER_STATUSES[0],
    streak: p.streak,
    answered: circus.answers.has(p.profileId || p.id),
  }));
}

function leaderboard() {
  return connectedPlayers()
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score, streak: p.streak, ...earnedTitle(p.stats) }));
}

function broadcast(event, data) { io.emit(event, data); }

function disconnectProfile(profileId) {
  const ids = [...(circus.profileSockets.get(profileId) || [])];
  for (const socketId of ids) {
    const active = io.sockets.sockets.get(socketId);
    if (active) active.disconnect(true);
  }
  circus.profileSockets.delete(profileId);
  circus.profileSocketMap.delete(profileId);
  circus.players.delete(profileId);
}

function cleanupDisconnectedPlayers() {
  for (const [profileId, player] of circus.players) {
    const hasSockets = (circus.profileSockets.get(profileId)?.size || 0) > 0;
    const roundStillNeedsPlayer =
      (circus.phase === 'question' && circus.eligibleProfileIds.has(profileId)) ||
      (circus.phase === 'reveal' && circus.roundEarned.has(profileId));
    if (!player.connected && !hasSockets && !roundStillNeedsPlayer) circus.players.delete(profileId);
  }
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function clearTimers() {
  clearTimeout(circus.timer);
  clearTimeout(circus.idleTimer);
}

function startQuestion() {
  clearTimers();
  if (connectedPlayers().length === 0) {
    circus.phase = 'idle';
    broadcast('circus_idle', { msg: 'The Circus is resting — walk in to wake it up' });
    return;
  }
  const q = nextQuestion();
  circus.currentQ = q;
  circus.roundId = crypto.randomUUID();
  circus.questionSentAt = Date.now();
  circus.questionStartedMono = performance.now();
  circus.answerSeq = 0;
  circus.answers.clear();
  circus.sygChoices.clear();
  circus.initialCorrect.clear();
  // Lock in eligible players at question start (keyed by profileId, not socketId)
  circus.eligibleProfileIds = new Set(connectedPlayers().map(p => p.profileId || p.id));
  circus.roundEarned = new Map(); // reset per question
  circus.phase = 'question';

  // Never expose the canonical answer or old multiple-choice options mid-round.
  broadcast('question', {
    index: ++circus.qIndex,
    text:  q.text,
    category: q.category,
    difficulty: q.difficulty,
    roundId: circus.roundId,
    timeMs: CFG.QUESTION_MS,
    presence: presencePayload(),
  });

  circus.timer = setTimeout(() => revealRound(), CFG.QUESTION_MS);
}

function checkAllAnswered() {
  // If every eligible still-connected player has answered, advance early
  const eligibleConnected = [...circus.eligibleProfileIds].filter(pid => {
    const p = circus.players.get(pid);
    return p && p.connected;
  });
  if (eligibleConnected.length === 0) return;
  if (eligibleConnected.every(pid => circus.answers.has(pid))) {
    clearTimeout(circus.timer);
    revealRound();
  }
}

function revealRound() {
  clearTimers();
  if (circus.phase !== 'question') return;
  circus.phase = 'reveal';

  const q   = circus.currentQ;
  const now = Date.now();
  const correctAnswer = q.correctAnswer || q.options?.[q.answer] || '';
  const normalizedCorrect = normalizeAnswer(correctAnswer);

  const totalAnswered  = circus.answers.size;
  const totalEligible  = circus.eligibleProfileIds.size; // all eligible (incl. disconnected)
  let correctCount = 0;
  let firstCorrectProfileId = null;
  let firstCorrectSeq = Infinity;
  circus.answers.forEach((a, profileId) => {
    if (normalizeAnswer(a.answer) === normalizedCorrect) {
      correctCount += 1;
      if (a.acceptedSeq < firstCorrectSeq) {
        firstCorrectSeq = a.acceptedSeq;
        firstCorrectProfileId = profileId;
      }
    }
  });

  // Trust Bonus: ALL eligible connected players answered AND all correct
  const isUnanimous = totalEligible > 1
    && totalAnswered === totalEligible
    && correctCount === totalAnswered;

  // Score all eligible players (keyed by profileId — includes disconnected players with accepted answers)
  const _roundEarned = circus.roundEarned; // shared with resolveSYG for Oracle accumulation
  _roundEarned.clear();
  circus.eligibleProfileIds.forEach(profileId => {
    const player = circus.players.get(profileId);
    const a = circus.answers.get(profileId);
    if (!player) return;
    if (!a) {
      // Eligible but did not answer — score 0, counts against unanimity
      _roundEarned.set(profileId, { points: 0, correct: false });
      return;
    }
    const correct = normalizeAnswer(a.answer) === normalizedCorrect;
    player.stats.correct = (player.stats.correct || 0) + (correct ? 1 : 0);
    player.stats.wrong   = (player.stats.wrong   || 0) + (correct ? 0 : 1);

    if (correct) {
      const speed  = calculateTimeBonus(a.elapsedMs);
      const firstBonus = profileId === firstCorrectProfileId ? CFG.FIRST_CORRECT_BONUS : 0;
      const streak = Math.min((player.streak || 0) * CFG.STREAK_PER, CFG.STREAK_CAP);
      const trust  = isUnanimous ? CFG.TRUST_BONUS : 0;
      const dd     = player.doubleDown ? CFG.DD_STAKE : 0;
      const earned = CFG.BASE_PTS + speed + firstBonus + streak + trust + dd;
      player.score = (player.score || 0) + earned;
      player.streak = (player.streak || 0) + 1;
      if (speed >= Math.ceil(CFG.SPEED_BONUS / 2)) player.stats.fast = (player.stats.fast || 0) + 1;
      if (!player.stats.catWins) player.stats.catWins = {};
      player.stats.catWins[q.category] = (player.stats.catWins[q.category] || 0) + 1;
      circus.initialCorrect.add(profileId);
      _roundEarned.set(profileId, { points: earned, correct: true });
      const _sid = (player && player.socketId) || profileId;
      io.to(_sid).emit('answer_result', {
        correct: true, earned, speed, firstBonus, streak, trust, dd, elapsedMs: Math.round(a.elapsedMs),
      });
    } else {
      const _ddPenalty = player.doubleDown ? -CFG.DD_STAKE : 0;
      if (player.doubleDown) player.score = Math.max(0, (player.score || 0) - CFG.DD_STAKE);
      player.streak = 0;
      _roundEarned.set(profileId, { points: _ddPenalty, correct: false });
      const _sid2 = (player && player.socketId) || profileId;
      io.to(_sid2).emit('answer_result', { correct: false, earned: 0 });
    }
    player.doubleDown = false;
  });

  broadcast('reveal', {
    answer: correctAnswer,
    explanation: q.explanation,
    isUnanimous, correctCount, totalAnswered, totalEligible,
    firstCorrectName: firstCorrectProfileId ? circus.players.get(firstCorrectProfileId)?.name || null : null,
    leaderboard: leaderboard(),
    presence: presencePayload(),
  });

  // ── Lifetime persistence is deferred to endRound() so Oracle/DD are included ──

  // Typed answers are final. There is no post-reveal answer switching.
  circus.timer = setTimeout(() => endRound(), CFG.REVEAL_MS);
}

function resolveSYG() {
  clearTimers();
  if (circus.phase !== 'syg') return;
  const q = circus.currentQ;

  // Oracle: a player who was initially correct AND explicitly chose to Stand
  // (i.e., kept their answer) AND is the lone correct dissenter in the room.
  // Wrong players who switch to the correct answer after seeing it do NOT qualify.
  const initialCorrectCount = circus.initialCorrect.size;

  circus.sygChoices.forEach((decision, profileId) => {
    const player = circus.players.get(profileId);
    if (!player) return;
    if (decision === 'stay' && circus.initialCorrect.has(profileId)) {
      if (initialCorrectCount === 1) {
        player.score = (player.score || 0) + CFG.ORACLE_BONUS;
        player.stats.oracle = (player.stats.oracle || 0) + 1;
        // Blocker 10: accumulate Oracle bonus into roundEarned (persisted in endRound)
        const existing = circus.roundEarned.get(profileId);
        if (existing) existing.points += CFG.ORACLE_BONUS;
        else circus.roundEarned.set(profileId, { points: CFG.ORACLE_BONUS, correct: true });
        const _sockId = circus.profileSocketMap.get(profileId);
        if (_sockId) io.to(_sockId).emit('oracle_moment', { bonus: CFG.ORACLE_BONUS });
      }
    }
  });

  endRound();
}

function endRound() {
  clearTimers();

  // ── Persist lifetime scores (blocker 10: complete delta including Oracle + DD) ──
  if (circus.roundId && circus.roundEarned.size > 0) {
    try {
      const _db = getDb();
      for (const [_pid, { points: _pts, correct: _cor }] of circus.roundEarned) {
        try {
          const _answer = circus.answers.get(_pid);
          const _new = recordScore(_db, _pid, circus.roundId, _pts, _cor, {
            elapsedMs: _answer && _answer.elapsedMs,
            category: circus.currentQ && circus.currentQ.category,
          });
          if (_new) {
            // Refresh cached profile on socket
            const _sockId = circus.profileSocketMap.get(_pid);
            const _sock = _sockId ? io.sockets.sockets.get(_sockId) : null;
            if (_sock && _sock._tcProfile) {
              _sock._tcProfile = _db.prepare('SELECT * FROM profiles WHERE id = ?').get(_pid);
            }
          }
        } catch (_e) { console.error('[persist] score error for', _pid, _e.message); }
      }
      // Broadcast updated all-time leaderboard
      const _board = getLeaderboard(_db, 10, null);
      broadcast('circus_leaderboard', { entries: _board });
    } catch (_err) { console.error('[persist] endRound error:', _err.message); }
    circus.roundEarned.clear();
  }

  cleanupDisconnectedPlayers();
  broadcast('round_end', { leaderboard: leaderboard() });
  if (connectedPlayers().length === 0) {
    circus.phase = 'idle';
    broadcast('circus_idle', { msg: 'The Circus is resting' });
  } else {
    circus.timer = setTimeout(() => startQuestion(), CFG.NEXT_DELAY_MS);
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────

// Socket.IO middleware — registered session first, then persistent guest cookie.
io.use((socket, next) => {
  try {
    const header = socket.handshake.headers.cookie || '';
    const humanToken = cookieValueFromHeader(header, HUMAN_COOKIE);
    socket.data.humanVerified = !HUMAN_GATE.enabled || verifyHumanToken(humanToken, HUMAN_GATE.signingSecret);
    socket.data.joined = false;
    const db = getDb();
    const sessionToken = sessionTokenFromCookieHeader(header);
    const sessionProfile = resolveSession(db, sessionToken);
    if (sessionProfile) {
      socket._tcProfile = sessionProfile;
      socket._tcRegistered = true;
    } else {
      const token = tokenFromCookieHeader(header) || generateToken();
      socket._tcProfile = getOrCreateProfile(db, token, names.generate);
      socket._tcRegistered = false;
    }
    socket.data.profileId = socket._tcProfile ? socket._tcProfile.id : null;
  } catch (e) {
    console.error('[persist] socket middleware error:', e.message);
    socket._tcProfile = null;
    socket.data.profileId = null;
  }
  next();
});

io.on('connection', socket => {

  // Lightweight presence peek — no player created
  socket.on('peek', () => {
    socket.emit('presence', { players: presencePayload() });
  });

  socket.on('join', (rawData, ack) => {
    if (socket._tcRegistered && isAdminProfile(getDb(), socket.data.profileId)) {
      const denial = { ok: false, code: 'OWNER_ACCOUNT', error: 'Owner accounts do not join gameplay.' };
      if (typeof ack === 'function') ack(denial);
      return;
    }
    if (!socket.data.humanVerified) {
      const denial = { ok: false, code: 'HUMAN_VERIFICATION_REQUIRED', error: 'Human verification required.' };
      socket.emit('join_denied', denial);
      if (typeof ack === 'function') ack(denial);
      return;
    }
    // Name from client is IGNORED — identity comes from the authenticated cookie profile
    if (circus.players.size >= CFG.MAX_PLAYERS) {
      socket.emit('error', { msg: 'The circus is full' });
      return;
    }

    const profileId = socket.data.profileId;
    const profile   = socket._tcProfile;
    const serverName = profile ? profile.display_name : genName();

    // Same-cookie tab dedup: update socketId on existing player (blocker 5)
    const existing = profileId ? circus.players.get(profileId) : null;
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      // If this profile already has an accepted answer in this round, lock it in
      socket.emit('answer_locked', circus.answers.get(profileId) || null);
    } else {
      const player = {
        profileId: profileId || socket.id,
        id: profileId || socket.id,
        socketId: socket.id,
        name: serverName,
        score: 0, status: PLAYER_STATUSES[0], streak: 0, doubleDown: false, connected: true,
        stats: { correct: 0, wrong: 0, oracle: 0, fast: 0, catWins: {} },
      };
      circus.players.set(profileId || socket.id, player);
    }
    if (profileId) {
      circus.profileSocketMap.set(profileId, socket.id);
      // Track all sockets per profile for same-cookie tab safety (B3)
      const _pSocks = circus.profileSockets.get(profileId) || new Set();
      _pSocks.add(socket.id);
      circus.profileSockets.set(profileId, _pSocks);
    }
    socket.data.name = serverName;
    socket.data.joined = true;
    if (socket._tcRegistered) recordAccountActivity(getDb(), profileId, 'join');

    // Build join response with current state (blocker 2: no name from URL)
    const state = {
      name: serverName, phase: circus.phase, presence: presencePayload(), leaderboard: leaderboard(),
      profile: profile ? publicProfile(profile, getProfileRank(getDb(), profile.id), undefined, !!socket._tcRegistered) : null,
    };
    if (circus.phase === 'question' && circus.currentQ) {
      const elapsed  = Date.now() - circus.questionSentAt;
      const remaining = Math.max(0, CFG.QUESTION_MS - elapsed);
      state.currentQuestion = {
        text: circus.currentQ.text,
        category: circus.currentQ.category,
        difficulty: circus.currentQ.difficulty,
        roundId: circus.roundId,
        timeRemaining: remaining,
      };
    }
    socket.emit('joined', state);
    broadcast('presence', { players: presencePayload() });

    // Emit persistent profile and all-time leaderboard to this client
    if (socket._tcProfile) {
      const _db = getDb();
      socket.emit('circus_profile', publicProfile(socket._tcProfile, getProfileRank(_db, socket._tcProfile.id), undefined, !!socket._tcRegistered));
      try {
        const board = getLeaderboard(_db, 10);
        socket.emit('circus_leaderboard', { entries: getLeaderboard(_db, 10, socket._tcProfile?.id) });
      } catch (_) {}
    }

    // Wake idle circus
    if (circus.phase === 'idle') {
      clearTimers();
      circus.timer = setTimeout(() => startQuestion(), 1500);
    }
  });

  socket.on('submit_answer', (rawData, ack) => {
    const respond = payload => { if (typeof ack === 'function') ack(payload); };
    if (!socket.data.joined) return respond({ ok: false, error: 'Join the circus first.' });
    const data = validateAnswer(rawData);
    if (!data) return respond({ ok: false, error: 'Invalid answer.' });
    if (circus.phase !== 'question') return respond({ ok: false, error: 'That round has ended.' });
    if (data.roundId !== circus.roundId) return respond({ ok: false, error: 'That question is no longer active.' });
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player) return respond({ ok: false, error: 'Join the circus first.' });
    if (!circus.eligibleProfileIds.has(profileId)) return respond({ ok: false, error: 'You can answer the next question.' });
    if (circus.answers.has(profileId)) return respond({ ok: true, duplicate: true });

    // Monotonic server time controls both deadline and scoring; client timing is ignored.
    const elapsedMs = performance.now() - circus.questionStartedMono;
    if (elapsedMs < 0 || elapsedMs > CFG.QUESTION_MS) return respond({ ok: false, error: 'Time is up.' });
    circus.answers.set(profileId, { answer: data.answer, elapsedMs, acceptedSeq: ++circus.answerSeq });

    socket.emit('answer_locked', { answer: data.answer, roundId: circus.roundId });
    respond({ ok: true });
    broadcast('presence', { players: presencePayload() });

    // Count for the bar display
    io.emit('answer_count', {
      count: [...circus.answers.keys()].filter(pid => circus.eligibleProfileIds.has(pid)).length,
      total: circus.eligibleProfileIds.size,
    });

    checkAllAnswered();
  });

  socket.on('double_down', () => {
    if (!socket.data.joined) return;
    if (circus.phase !== 'question') return;
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player || player.doubleDown) return;
    player.doubleDown = true;
    socket.emit('doubled_down');
  });

  socket.on('stand_ground', (rawData) => {
    if (!socket.data.joined) return;
    if (circus.phase !== 'syg') return;
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player) return;
    if (!rawData || typeof rawData !== 'object') return;
    let finalChoice;
    if (rawData.decision === 'stay') {
      const orig = circus.answers.get(profileId);
      finalChoice = orig ? orig.choice : null;
      if (!finalChoice) return;
      circus.sygChoices.set(profileId, 'stay');
    } else if (VALID_CHOICES.has(rawData.choice)) {
      // Explicit switch to a specific answer
      finalChoice = rawData.choice;
      circus.sygChoices.set(socket.id, 'switch');
    } else {
      return; // invalid
    }
    circus.sygSwitchChoices = circus.sygSwitchChoices || new Map();
    circus.sygSwitchChoices.set(socket.id, finalChoice);
    socket.emit('syg_locked', { decision: rawData.decision || 'switch', choice: finalChoice });
  });

  
  // regenerate_name socket event — rate-limited name regeneration via socket ack
  socket.on('regenerate_name', (data, ack) => {
    try {
      if (typeof ack !== 'function') return;
      const profileId = socket.data.profileId;
      if (!profileId) return ack({ error: 'No authenticated profile' });
      const profile = socket._tcProfile;
      if (!profile) return ack({ error: 'Profile not loaded' });
      if (socket._tcRegistered || isRegisteredProfile(getDb(), profileId)) return ack({ error: 'Registered usernames cannot be regenerated' });
      // Rate limit (reuse HTTP rate limiter timestamps map)
      const now = Date.now();
      const last = _renameTs.get(profileId);
      if (last && now - last < RENAME_COOLDOWN_MS) return ack({ error: 'Please wait before renaming' });
      _renameTs.set(profileId, now);
      const db = getDb();
      const newName = regenerateName(db, profileId, names.generate, profile.display_name);
      socket._tcProfile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
      const rank = getProfileRank(db, profileId);
      ack({ profile: publicProfile(socket._tcProfile, rank) });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: 'Rename failed' });
    }
  });
  socket.on('set_status', (rawData, ack) => {
    const data = validatePlayerStatus(rawData);
    const respond = payload => { if (typeof ack === 'function') ack(payload); };
    if (!socket.data.joined) return respond({ ok: false, error: 'Join first.' });
    if (!data) return respond({ ok: false, error: 'Invalid status.' });
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player || !player.connected) return respond({ ok: false, error: 'Join first.' });
    player.status = data.status;
    respond({ ok: true, status: data.status });
    broadcast('presence', { players: presencePayload() });
  });

  socket.on('reaction', (rawData) => {
    if (!socket.data.joined) return;
    const data = validateReaction(rawData);
    if (!data) return;
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player || !player.connected) return;
    broadcast('reaction', { name: player.name, emoji: data.emoji });
  });

  socket.on('disconnect', () => {
    const profileId = socket.data.profileId || socket.id;

    // B3: remove this socket from the profile's active socket set
    const _pSocks = circus.profileSockets.get(profileId);
    if (_pSocks) {
      _pSocks.delete(socket.id);
      if (_pSocks.size === 0) circus.profileSockets.delete(profileId);
    }
    // B3: if another socket for this profile is still open, stay live
    const _stillOpen = (circus.profileSockets.get(profileId)?.size || 0) > 0;
    if (_stillOpen) return;
    if (socket._tcRegistered && socket.data.joined) recordAccountActivity(getDb(), profileId, 'disconnect');

    const player = circus.players.get(profileId);
    if (!player) return;
    player.connected = false;
    if (circus.profileSocketMap.get(profileId) === socket.id) {
      circus.profileSocketMap.delete(profileId);
    }

    broadcast('presence', { players: presencePayload() });

    if (circus.phase === 'question') {
      checkAllAnswered();
      // B2: last player disconnected — score accepted answers if any exist
      const _ec = [...circus.eligibleProfileIds].filter(pid => {
        const p = circus.players.get(pid); return p && p.connected;
      });
      if (_ec.length === 0) {
        clearTimers();
        // Score if there are accepted answers; otherwise end cleanly
        if (circus.answers.size > 0) {
          revealRound();
        } else {
          endRound();
        }
      }
    }

    // Never delete an eligible player before the round has been scored.
    setTimeout(() => cleanupDisconnectedPlayers(), 15000);
  });
});

// ── Exports (for unit tests) ──────────────────────────────────────────────────
module.exports = { clean, genName, earnedTitle, normalizeAnswer, validateAnswer, calculateTimeBonus, CFG, ALLOWED_EMOJIS, VALID_CHOICES };

// ── Server startup ────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  const HOST = process.env.HOST || '0.0.0.0';
  QUESTIONS = loadQuestions();
  if (QUESTIONS.length === 0) { console.error('No questions available — aborting'); process.exit(1); }
  circus.pool = categoryBalancedShuffle(QUESTIONS);
  circus.poolIdx = -1;
  httpServer.listen(PORT, HOST, () => {
    console.log('Trivia Circus server: http://' + HOST + ':' + PORT);
    console.log('Questions:', QUESTIONS.length, '| Starting circus loop on join.');
  });
}
