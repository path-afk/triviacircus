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
const fs      = require('fs');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});
app.use(express.static(path.join(__dirname, 'public')));

const QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions/bank.json'))
);

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

// ── Global circus state ───────────────────────────────────────────────────────
const circus = {
  // phase: idle | question | reveal | syg
  phase: 'idle',
  players: new Map(),     // sid → PlayerState
  qIndex: -1,
  currentQ: null,
  questionSentAt: 0,      // server-recorded, used for speed calc
  // Players who were connected when this question was sent — used for unanimity
  eligibleSids: new Set(),
  answers: new Map(),     // sid → { choice, elapsedMs }
  sygChoices: new Map(),  // sid → 'stay' | 'switch'
  // Players who answered correctly before reveal (for Oracle detection)
  initialCorrect: new Set(),
  timer: null,
  idleTimer: null,
  pool: [],
  poolIdx: 0,
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
    answered: circus.answers.has(p.id),
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
  circus.questionSentAt = Date.now();
  circus.answers.clear();
  circus.sygChoices.clear();
  circus.initialCorrect.clear();
  // Lock in eligible players at question start
  circus.eligibleSids = new Set(connectedPlayers().map(p => p.id));
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
  const eligibleConnected = [...circus.eligibleSids].filter(sid => {
    const p = circus.players.get(sid);
    return p && p.connected;
  });
  if (eligibleConnected.length === 0) return;
  if (eligibleConnected.every(sid => circus.answers.has(sid))) {
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
  const totalEligible  = [...circus.eligibleSids].filter(sid => {
    const p = circus.players.get(sid);
    return p && p.connected;
  }).length;
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

  // Score all answerers
  circus.answers.forEach((a, sid) => {
    const player = circus.players.get(sid);
    if (!player || !player.connected) return;
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
      circus.initialCorrect.add(sid);
      io.to(sid).emit('answer_result', { correct: true, earned, speed, streak, trust, dd });
    } else {
      if (player.doubleDown) player.score = Math.max(0, (player.score || 0) - CFG.DD_STAKE);
      player.streak = 0;
      io.to(sid).emit('answer_result', { correct: false, earned: 0 });
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

  circus.sygChoices.forEach((decision, sid) => {
    const player = circus.players.get(sid);
    if (!player || !player.connected) return;
    // Only initially-correct players who explicitly "stood" are eligible for Oracle
    if (decision === 'stay' && circus.initialCorrect.has(sid)) {
      // Oracle only if they were the lone initially-correct player
      if (initialCorrectCount === 1) {
        player.score = (player.score || 0) + CFG.ORACLE_BONUS;
        player.stats.oracle = (player.stats.oracle || 0) + 1;
        io.to(sid).emit('oracle_moment', { bonus: CFG.ORACLE_BONUS });
      }
    }
  });

  endRound();
}

function endRound() {
  clearTimers();
  broadcast('round_end', { leaderboard: leaderboard() });
  if (connectedPlayers().length === 0) {
    circus.phase = 'idle';
    broadcast('circus_idle', { msg: 'The Circus is resting' });
  } else {
    circus.timer = setTimeout(() => startQuestion(), CFG.NEXT_DELAY_MS);
  }
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {

  // Lightweight presence peek — no player created
  socket.on('peek', () => {
    socket.emit('presence', { players: presencePayload() });
  });

  socket.on('join', (rawData) => {
    const data = validateJoin(rawData);
    if (!data) return;
    if (circus.players.size >= CFG.MAX_PLAYERS) {
      socket.emit('error', { msg: 'The circus is full' });
      return;
    }

    // Remove prior membership if this socket rejoins
    const existing = circus.players.get(socket.id);
    if (existing) {
      circus.answers.delete(socket.id);
      circus.eligibleSids.delete(socket.id);
    }

    const name = clean(data.name) || genName();
    const player = {
      id: socket.id, name,
      score: 0, streak: 0, doubleDown: false, connected: true,
      stats: { correct: 0, wrong: 0, oracle: 0, fast: 0, catWins: {} },
    };
    circus.players.set(socket.id, player);
    socket.data.name = name;

    // Build join response with current state
    const state = {
      name, phase: circus.phase, presence: presencePayload(), leaderboard: leaderboard(),
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
    const player = circus.players.get(socket.id);
    if (!player || !player.connected) return;
    if (circus.answers.has(socket.id)) return; // already answered

    // Server-side elapsed time — ignore client timeMs
    const elapsedMs = Date.now() - circus.questionSentAt;
    circus.answers.set(socket.id, { choice: data.choice, elapsedMs });

    socket.emit('answer_locked', { choice: data.choice });
    broadcast('presence', { players: presencePayload() });

    // Count for the bar display
    const eligibleConnected = [...circus.eligibleSids].filter(sid => {
      const p = circus.players.get(sid); return p && p.connected;
    });
    io.emit('answer_count', {
      count: [...circus.answers.keys()].filter(sid => circus.eligibleSids.has(sid)).length,
      total: eligibleConnected.length,
    });

    checkAllAnswered();
  });

  socket.on('double_down', () => {
    if (circus.phase !== 'question') return;
    const player = circus.players.get(socket.id);
    if (!player || !player.connected || player.doubleDown) return;
    player.doubleDown = true;
    socket.emit('doubled_down');
  });

  socket.on('stand_ground', (rawData) => {
    if (circus.phase !== 'syg') return;
    const player = circus.players.get(socket.id);
    if (!player || !player.connected) return;
    if (!rawData || typeof rawData !== 'object') return;
    const decision = rawData.decision;
    if (decision !== 'stay' && decision !== 'switch') return;
    circus.sygChoices.set(socket.id, decision);
    socket.emit('syg_locked', { decision });
  });

  socket.on('reaction', (rawData) => {
    const data = validateReaction(rawData);
    if (!data) return;
    const player = circus.players.get(socket.id);
    if (!player || !player.connected) return;
    broadcast('reaction', { name: player.name, emoji: data.emoji });
  });

  socket.on('disconnect', () => {
    const player = circus.players.get(socket.id);
    if (!player) return;
    player.connected = false;

    // Remove from eligible set so unanimity isn't blocked by disconnected player
    circus.eligibleSids.delete(socket.id);
    // Remove any pending answer from disconnected player in case they hadn't answered
    circus.answers.delete(socket.id);

    // Broadcast updated presence
    broadcast('presence', { players: presencePayload() });

    // If in answering phase, check if remaining eligible players have all answered
    if (circus.phase === 'question') {
      checkAllAnswered();
      // Also check if nobody left (timer-off safety: if 0 eligible, advance)
      const eligibleConnected = [...circus.eligibleSids].filter(sid => {
        const p = circus.players.get(sid); return p && p.connected;
      });
      if (eligibleConnected.length === 0) {
        clearTimeout(circus.timer);
        endRound();
      }
    }

    // Garbage-collect fully disconnected players after grace period
    setTimeout(() => {
      const p = circus.players.get(socket.id);
      if (p && !p.connected) circus.players.delete(socket.id);
    }, 15000);
  });
});

// ── Exports (for unit tests) ──────────────────────────────────────────────────
module.exports = { clean, genName, earnedTitle, CFG, ALLOWED_EMOJIS, VALID_CHOICES };

// ── Server startup ────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  circus.pool = shuffle([...QUESTIONS]);
  circus.poolIdx = -1;
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log('Trivia Circus server: http://127.0.0.1:' + PORT);
  });
}
