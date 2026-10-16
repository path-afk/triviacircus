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
const { generateToken, setCookie, getToken, tokenFromCookieHeader } = require('./lib/auth');
const { getDb, getOrCreateProfile, regenerateName, recordScore, getLeaderboard, getProfileRank, publicProfile } = require('./lib/db');
const names         = require('./lib/names');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: process.env.NODE_ENV === 'production' ? false : { origin: true },
  transports: ['websocket', 'polling']
});
app.use(cookieParser());
app.use(express.json());

// ── Guest profile cookie middleware ──────────────────────────────────────────
// Must come BEFORE express.static so Set-Cookie is included on static file responses.
// Creates an opaque 32-byte token on first visit (HttpOnly, SameSite=Lax, 1 year).
// Token hash is stored server-side; raw token is never persisted.
app.use((req, res, next) => {
  let token = getToken(req.cookies);
  if (!token) {
    token = generateToken();
    setCookie(res, token);
  }
  req._tcToken = token;
  next();
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

// ── Persistence API ───────────────────────────────────────────────────────────
// GET /api/profile — return this guest's persistent profile
app.get('/api/profile', (req, res) => {
  try {
    const db = getDb();
    const raw = getOrCreateProfile(db, req._tcToken, names.generate);
    const rank = getProfileRank(db, raw.id);
    res.json(publicProfile(raw, rank));
  } catch (e) { res.status(500).json({ error: 'Profile unavailable' }); }
});

// POST /api/profile/rename — regenerate display name (rate-limited, 5 s cooldown)
app.post('/api/profile/rename', renameRateLimiter, (req, res) => {
  try {
    const db = getDb();
    const raw = getOrCreateProfile(db, req._tcToken, names.generate);
    const newName = regenerateName(db, raw.id, names.generate, raw.display_name);
    const updated = db.prepare('SELECT * FROM profiles WHERE id = ?').get(raw.id);
    res.json(publicProfile(updated, getProfileRank(db, updated.id)));
  } catch (e) { res.status(500).json({ error: 'Rename failed' }); }
});

// GET /api/leaderboard?limit=N — all-time top N (scored players only, safe fields)
app.get('/api/leaderboard', (req, res) => {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 25), 100);
    const myRaw = req._tcToken ? getOrCreateProfile(db, req._tcToken, names.generate) : null;
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
  return JSON.parse(fs.readFileSync(bankPath, 'utf8'));
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
  QUESTION_MS:   22000,
  REVEAL_MS:     5500,
  SYG_MS:        6000,   // Stand Your Ground window
  NEXT_DELAY_MS: 2000,
  IDLE_PAUSE_MS: 30000,
  GRACE_MS:      7000,   // speed bonus cutoff (server-computed)
  BASE_PTS:      100,
  SPEED_BONUS:   10,
  STREAK_PER:    20,
  STREAK_CAP:    100,
  TRUST_BONUS:   50,
  ORACLE_BONUS:  80,
  DD_STAKE:      50,
  MAX_PLAYERS:   40,
  MAX_NAME_LEN:  24,
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
  if (!VALID_CHOICES.has(data.choice)) return null;
  // Ignore client timeMs — server computes elapsed
  return { choice: data.choice };
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
  questionSentAt: 0,      // server-recorded, used for speed calc
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

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function nextQuestion() {
  circus.poolIdx++;
  if (circus.poolIdx >= circus.pool.length) {
    circus.pool = shuffle([...QUESTIONS]);
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
  circus.answers.clear();
  circus.sygChoices.clear();
  circus.initialCorrect.clear();
  // Lock in eligible players at question start (keyed by profileId, not socketId)
  circus.eligibleProfileIds = new Set(connectedPlayers().map(p => p.profileId || p.id));
  circus.roundEarned = new Map(); // reset per question
  circus.phase = 'question';

  // Strip answer from broadcast
  const { answer: _a, explanation: _e, ...qPublic } = q;
  broadcast('question', {
    index: ++circus.qIndex,
    text:  q.text,
    options: q.options,
    category: q.category,
    difficulty: q.difficulty,
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
  const tally = { A: 0, B: 0, C: 0, D: 0 };
  circus.answers.forEach(a => { tally[a.choice] = (tally[a.choice] || 0) + 1; });

  const totalAnswered  = circus.answers.size;
  const totalEligible  = circus.eligibleProfileIds.size; // all eligible (incl. disconnected)
  const correctCount   = tally[q.answer] || 0;

  const pct = {};
  ['A','B','C','D'].forEach(k => {
    pct[k] = totalAnswered ? Math.round((tally[k] || 0) / totalAnswered * 100) : 0;
  });

  // Trust Bonus: ALL eligible connected players answered AND all correct
  const isUnanimous = totalEligible > 1
    && totalAnswered === totalEligible
    && correctCount === totalAnswered;

  const divided = !isUnanimous && totalAnswered > 1
    && Object.values(tally).filter(v => v > 0).length > 1;

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
    const correct = a.choice === q.answer;
    player.stats.correct = (player.stats.correct || 0) + (correct ? 1 : 0);
    player.stats.wrong   = (player.stats.wrong   || 0) + (correct ? 0 : 1);

    if (correct) {
      const speed  = a.elapsedMs <= CFG.GRACE_MS ? CFG.SPEED_BONUS : 0;
      const streak = Math.min((player.streak || 0) * CFG.STREAK_PER, CFG.STREAK_CAP);
      const trust  = isUnanimous ? CFG.TRUST_BONUS : 0;
      const dd     = player.doubleDown ? CFG.DD_STAKE : 0;
      const earned = CFG.BASE_PTS + speed + streak + trust + dd;
      player.score = (player.score || 0) + earned;
      player.streak = (player.streak || 0) + 1;
      if (!player.stats.catWins) player.stats.catWins = {};
      player.stats.catWins[q.category] = (player.stats.catWins[q.category] || 0) + 1;
      circus.initialCorrect.add(profileId);
      _roundEarned.set(profileId, { points: earned, correct: true });
      const _sid = (player && player.socketId) || profileId;
      io.to(_sid).emit('answer_result', { correct: true, earned, speed, streak, trust, dd });
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
    answer: q.answer,
    explanation: q.explanation,
    tally, pct, isUnanimous, divided, correctCount,
    leaderboard: leaderboard(),
    presence: presencePayload(),
  });

  // ── Lifetime persistence is deferred to endRound() so Oracle/DD are included ──

  if (divided) {
    circus.phase = 'syg';
    broadcast('stand_your_ground', { timeMs: CFG.SYG_MS });
    circus.timer = setTimeout(() => resolveSYG(), CFG.SYG_MS);
  } else {
    circus.timer = setTimeout(() => endRound(), CFG.REVEAL_MS);
  }
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
          const _new = recordScore(_db, _pid, circus.roundId, _pts, _cor);
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

  broadcast('round_end', { leaderboard: leaderboard() });
  if (connectedPlayers().length === 0) {
    circus.phase = 'idle';
    broadcast('circus_idle', { msg: 'The Circus is resting' });
  } else {
    circus.timer = setTimeout(() => startQuestion(), CFG.NEXT_DELAY_MS);
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────

// Socket.IO middleware — resolve or create guest profile from cookie
io.use((socket, next) => {
  try {
    const header = socket.handshake.headers.cookie || '';
    const token  = tokenFromCookieHeader(header) || generateToken();
    const db     = getDb();
    socket._tcProfile = getOrCreateProfile(db, token, names.generate);
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

  socket.on('join', (rawData) => {
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
        score: 0, streak: 0, doubleDown: false, connected: true,
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

    // Build join response with current state (blocker 2: no name from URL)
    const state = {
      name: serverName, phase: circus.phase, presence: presencePayload(), leaderboard: leaderboard(),
      profile: profile ? publicProfile(profile, getProfileRank(getDb(), profile.id)) : null,
    };
    if (circus.phase === 'question' && circus.currentQ) {
      const elapsed  = Date.now() - circus.questionSentAt;
      const remaining = Math.max(0, CFG.QUESTION_MS - elapsed);
      state.currentQuestion = {
        text: circus.currentQ.text,
        options: circus.currentQ.options,
        category: circus.currentQ.category,
        difficulty: circus.currentQ.difficulty,
        timeRemaining: remaining,
      };
    }
    socket.emit('joined', state);
    broadcast('presence', { players: presencePayload() });

    // Emit persistent profile and all-time leaderboard to this client
    if (socket._tcProfile) {
      const _db = getDb();
      socket.emit('circus_profile', publicProfile(socket._tcProfile, getProfileRank(_db, socket._tcProfile.id)));
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

  socket.on('submit_answer', (rawData) => {
    const data = validateAnswer(rawData);
    if (!data) return;
    if (circus.phase !== 'question') return;
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player) return;
    // Check eligibility (must have been in circus at question start — blocker 5)
    if (!circus.eligibleProfileIds.has(profileId)) return;
    // One answer per profile per round (blocker 5)
    if (circus.answers.has(profileId)) return;

    // Server-side elapsed time — ignore client timeMs
    const elapsedMs = Date.now() - circus.questionSentAt;
    circus.answers.set(profileId, { choice: data.choice, elapsedMs });

    socket.emit('answer_locked', { choice: data.choice });
    broadcast('presence', { players: presencePayload() });

    // Count for the bar display
    io.emit('answer_count', {
      count: [...circus.answers.keys()].filter(pid => circus.eligibleProfileIds.has(pid)).length,
      total: circus.eligibleProfileIds.size,
    });

    checkAllAnswered();
  });

  socket.on('double_down', () => {
    if (circus.phase !== 'question') return;
    const profileId = socket.data.profileId || socket.id;
    const player = circus.players.get(profileId);
    if (!player || player.doubleDown) return;
    player.doubleDown = true;
    socket.emit('doubled_down');
  });

  socket.on('stand_ground', (rawData) => {
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
socket.on('reaction', (rawData) => {
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

    // Garbage-collect after grace period (only when no sockets remain)
    setTimeout(() => {
      const _pp = circus.players.get(profileId);
      const _s  = (circus.profileSockets.get(profileId)?.size || 0) > 0;
      if (_pp && !_pp.connected && !_s) circus.players.delete(profileId);
    }, 15000);
  });
});

// ── Exports (for unit tests) ──────────────────────────────────────────────────
module.exports = { clean, genName, earnedTitle, CFG, ALLOWED_EMOJIS, VALID_CHOICES };

// ── Server startup ────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  const HOST = process.env.HOST || '127.0.0.1';
  QUESTIONS = loadQuestions();
  if (QUESTIONS.length === 0) { console.error('No questions available — aborting'); process.exit(1); }
  circus.pool = shuffle([...QUESTIONS]);
  circus.poolIdx = -1;
  httpServer.listen(PORT, HOST, () => {
    console.log('Trivia Circus server: http://' + HOST + ':' + PORT);
    console.log('Questions:', QUESTIONS.length, '| Starting circus loop on join.');
  });
}
