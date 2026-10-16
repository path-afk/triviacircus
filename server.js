/**
 * Trivia Circus — Continuous Always-On Game Server
 * Architecture: One global loop. Questions run forever.
 * Players drop in/out. Loop pauses when empty, resumes on first join.
 */
'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' }, transports: ['websocket','polling'] });
app.use(express.static(path.join(__dirname, 'public')));

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions/bank.json')));

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  QUESTION_MS:   22000,   // how long a question stays open
  REVEAL_MS:     5000,    // how long the reveal shows
  IDLE_PAUSE_MS: 30000,   // pause loop if no players for this long
  GRACE_MS:      7000,    // speed bonus window
  BASE_PTS:      100,
  SPEED_BONUS:   10,
  STREAK_PER:    20,
  STREAK_CAP:    100,
  TRUST_BONUS:   50,
  ORACLE_BONUS:  80,
  DD_STAKE:      50,
};

// ── Profanity filter ──────────────────────────────────────────────────────────
const BLOCKED = new Set(['fuck','shit','ass','bitch','cunt','dick','cock','pussy','nigger','faggot']);
function clean(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim().slice(0, 24);
  if ([...BLOCKED].some(w => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').includes(w))) return '';
  return s;
}
const ADJ = ['Cosmic','Neural','Quantum','Solar','Arctic','Velvet','Crimson','Neon','Atomic','Lunar','Vivid','Rapid','Prism','Delta','Cobalt'];
const NON = ['Panda','Falcon','Oracle','Cipher','Sphinx','Nomad','Comet','Vortex','Phantom','Nexus','Glitch','Prism','Titan','Raven','Ember'];
function genName() { return ADJ[Math.floor(Math.random()*ADJ.length)]+NON[Math.floor(Math.random()*NON.length)]; }

// ── Earned titles ─────────────────────────────────────────────────────────────
function earnedTitle(stats) {
  const { correct=0, wrong=0, oracle=0, fast=0, catWins={} } = stats;
  const total = correct + wrong;
  if (total === 0) return { title:'Newcomer', emoji:'🌱' };
  const acc = correct / total;
  if (oracle >= 2) return { title:'The Oracle', emoji:'🔮' };
  if (acc === 1 && total >= 8) return { title:'The Perfectionist', emoji:'💎' };
  if (acc >= 0.9 && total >= 6) return { title:'Brain Trust Elite', emoji:'🧠' };
  if (fast > correct * 0.7 && correct > 3) return { title:'The Reflex', emoji:'⚡' };
  if (oracle === 1) return { title:'Moment of Oracle', emoji:'✨' };
  const top = Object.entries(catWins).sort((a,b)=>b[1]-a[1])[0];
  if (top && top[1] >= 3) {
    const m = {History:'The Historian 📜',Science:'The Scientist 🔬',Geography:'The Explorer 🌍',Culture:'The Critic 🎭',Sports:'The Champion 🏆','Wild Card':'The Wildcard 🃏'};
    const t = m[top[0]]; if(t) { const p=t.split(' '); return {title:p.slice(0,-1).join(' '),emoji:p[p.length-1]}; }
  }
  if (acc < 0.35) return { title:'Brave Soul', emoji:'🫡' };
  return { title:'The Analyst', emoji:'📊' };
}

// ── Global circus state ───────────────────────────────────────────────────────
const circus = {
  phase: 'idle',        // idle | question | reveal
  players: new Map(),   // sid → { name, score, streak, doubleDown, stats, lastSeen }
  qIndex: -1,
  currentQ: null,
  answers: new Map(),   // sid → { choice, timeMs }
  timer: null,
  idleTimer: null,
  questionPool: shuffle([...QUESTIONS]),
  poolIndex: 0,
};

function shuffle(arr) { return [...arr].sort(()=>Math.random()-0.5); }

function nextQuestion() {
  // Rotate through all questions before repeating
  circus.poolIndex++;
  if (circus.poolIndex >= circus.questionPool.length) {
    circus.questionPool = shuffle([...QUESTIONS]);
    circus.poolIndex = 0;
  }
  return circus.questionPool[circus.poolIndex];
}

function activePlayers() {
  return [...circus.players.values()].filter(p => p.connected);
}

function broadcast(event, data) {
  io.emit(event, data);
}

function presencePayload() {
  return activePlayers().map(p => ({
    name: p.name, score: p.score, streak: p.streak,
    answered: circus.answers.has(p.id)
  }));
}

// ── Game loop ─────────────────────────────────────────────────────────────────
function startQuestion() {
  clearTimeout(circus.timer);
  clearTimeout(circus.idleTimer);

  if (activePlayers().length === 0) {
    circus.phase = 'idle';
    broadcast('circus_idle', { msg: 'The Circus is resting... walk in to wake it up 🎪' });
    return;
  }

  const q = nextQuestion();
  circus.currentQ = q;
  circus.answers.clear();
  circus.phase = 'question';
  const sentAt = Date.now();

  broadcast('question', {
    index: ++circus.qIndex,
    text: q.text,
    options: q.options,
    category: q.category,
    difficulty: q.difficulty,
    timeMs: CFG.QUESTION_MS,
    sentAt,
    presence: presencePayload(),
  });

  circus.timer = setTimeout(() => revealQuestion(sentAt), CFG.QUESTION_MS);
}

function revealQuestion(sentAt) {
  clearTimeout(circus.timer);
  circus.phase = 'reveal';

  const q = circus.currentQ;
  const tally = { A:0, B:0, C:0, D:0 };
  circus.answers.forEach(a => { tally[a.choice] = (tally[a.choice]||0)+1; });
  const totalAnswered = circus.answers.size;
  const pct = {};
  ['A','B','C','D'].forEach(k => { pct[k] = totalAnswered ? Math.round((tally[k]||0)/totalAnswered*100) : 0; });
  const isUnanimous = totalAnswered > 1 && Object.values(tally).filter(v=>v>0).length === 1 && (tally[q.answer]||0) === totalAnswered;

  // Score everyone who answered
  const results = {};
  circus.answers.forEach((a, sid) => {
    const player = circus.players.get(sid);
    if (!player) return;
    const correct = a.choice === q.answer;
    player.stats.correct = (player.stats.correct||0) + (correct?1:0);
    player.stats.wrong = (player.stats.wrong||0) + (correct?0:1);
    if (correct) {
      const speed  = a.timeMs <= CFG.GRACE_MS ? CFG.SPEED_BONUS : 0;
      const streak = Math.min((player.streak||0) * CFG.STREAK_PER, CFG.STREAK_CAP);
      const trust  = isUnanimous ? CFG.TRUST_BONUS : 0;
      const dd     = player.doubleDown ? CFG.DD_STAKE : 0;
      const earned = CFG.BASE_PTS + speed + streak + trust + dd;
      player.score = (player.score||0) + earned;
      player.streak = (player.streak||0) + 1;
      if (!player.stats.catWins) player.stats.catWins = {};
      player.stats.catWins[q.category] = (player.stats.catWins[q.category]||0)+1;
      results[sid] = { correct:true, earned, speed, streak, trust, dd };
    } else {
      if (player.doubleDown) player.score = Math.max(0, (player.score||0) - CFG.DD_STAKE);
      player.streak = 0;
      results[sid] = { correct:false, earned:0 };
    }
    player.doubleDown = false;
  });

  // Send individual results
  Object.entries(results).forEach(([sid, r]) => io.to(sid).emit('answer_result', r));

  // Leaderboard: all connected players sorted by score
  const lb = [...circus.players.values()]
    .filter(p => p.connected)
    .sort((a,b)=>(b.score||0)-(a.score||0))
    .map(p => ({ name:p.name, score:p.score||0, streak:p.streak||0, ...earnedTitle(p.stats||{}) }));

  broadcast('reveal', {
    answer: q.answer,
    explanation: q.explanation,
    tally, pct,
    isUnanimous,
    leaderboard: lb,
    presence: presencePayload(),
  });

  // Schedule next question or idle check
  circus.timer = setTimeout(() => {
    if (activePlayers().length === 0) {
      circus.phase = 'idle';
      broadcast('circus_idle', { msg: 'The Circus is resting... walk in to wake it up 🎪' });
      startIdleCheck();
    } else {
      startQuestion();
    }
  }, CFG.REVEAL_MS);
}

function startIdleCheck() {
  clearTimeout(circus.idleTimer);
  circus.idleTimer = setTimeout(() => {
    // Still idle after timeout — just wait for join event to trigger
  }, CFG.IDLE_PAUSE_MS);
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join', ({ name }) => {
    const cleanName = clean(name) || genName();
    const player = {
      id: socket.id, name: cleanName,
      score: 0, streak: 0, doubleDown: false,
      connected: true,
      stats: { correct:0, wrong:0, oracle:0, fast:0, catWins:{} }
    };
    circus.players.set(socket.id, player);
    socket.data.name = cleanName;

    // Tell the joining player what's happening right now
    const state = {
      name: cleanName,
      phase: circus.phase,
      presence: presencePayload(),
      leaderboard: [...circus.players.values()]
        .filter(p=>p.connected)
        .sort((a,b)=>(b.score||0)-(a.score||0))
        .map(p=>({name:p.name,score:p.score||0,streak:p.streak||0,...earnedTitle(p.stats||{})}))
    };

    if (circus.phase === 'question' && circus.currentQ) {
      const elapsed = Date.now() - (circus.currentQ._sentAt || Date.now());
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

    // Broadcast new presence
    broadcast('presence', { players: presencePayload() });

    // If circus was idle, wake it up
    if (circus.phase === 'idle') {
      clearTimeout(circus.idleTimer);
      setTimeout(() => startQuestion(), 1500);
    }
  });

  socket.on('submit_answer', ({ choice, timeMs }) => {
    if (circus.phase !== 'question') return;
    if (circus.answers.has(socket.id)) return;
    if (!['A','B','C','D'].includes(choice)) return;
    circus.answers.set(socket.id, { choice, timeMs: Math.max(0, timeMs) });
    socket.emit('answer_locked', { choice });
    broadcast('presence', { players: presencePayload() });
    // If ALL connected players have answered, advance early
    const connected = activePlayers().map(p=>p.id);
    if (connected.every(sid => circus.answers.has(sid)) && connected.length > 0) {
      clearTimeout(circus.timer);
      revealQuestion(null);
    }
  });

  socket.on('double_down', () => {
    if (circus.phase !== 'question') return;
    const p = circus.players.get(socket.id);
    if (p && !p.doubleDown) { p.doubleDown = true; socket.emit('doubled_down'); }
  });

  socket.on('reaction', ({ emoji }) => {
    const ALLOWED = ['😤 Knew It','🍀 Lucky Guess','😱 No Way','🔄 Rematch'];
    if (!ALLOWED.includes(emoji)) return;
    const p = circus.players.get(socket.id);
    if (p) broadcast('reaction', { name: p.name, emoji });
  });

  socket.on('disconnect', () => {
    const p = circus.players.get(socket.id);
    if (p) p.connected = false;
    // Clean up disconnected players after a grace period
    setTimeout(() => {
      const pp = circus.players.get(socket.id);
      if (pp && !pp.connected) circus.players.delete(socket.id);
      broadcast('presence', { players: presencePayload() });
    }, 10000);
  });
});

// ── Exports for tests ─────────────────────────────────────────────────────────
module.exports = { clean, genName, earnedTitle, CFG };

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log('Trivia Circus 🎪 always-on server: http://127.0.0.1:'+PORT);
    // Start the first question after a short warm-up if someone joins within idle timeout
    circus.phase = 'idle';
  });
}
