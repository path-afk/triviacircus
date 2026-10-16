/**
 * Trivia Circus — Game Server
 * Stack: Node.js + Express + Socket.io
 * Architecture: single-process in-memory rooms; swap rooms map for Redis in prod
 */
'use strict';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions/bank.json')));

// ── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  ROUND_MS: 20000,      // question window
  GRACE_MS: 7000,       // speed bonus if answered within this
  REVEAL_MS: 5500,      // reveal display time (no stand-your-ground)
  SYG_MS: 7000,         // stand-your-ground window
  NEXT_DELAY_MS: 2200,  // pause before next question
  SPEED_BONUS: 10,      // pts for answering within grace
  BASE_PTS: 100,        // correct answer base
  STREAK_PER: 20,       // pts per consecutive correct (capped)
  STREAK_CAP: 100,
  TRUST_BONUS: 50,      // unanimous + correct
  ORACLE_BONUS: 80,     // correct lone dissenter after SYG
  DD_STAKE: 50,         // double-down wager
  MAX_PLAYERS: 12,
  Q_PER_GAME: 10,
};

// ── Profanity filter (minimal; extend as needed) ─────────────────────────────
const BLOCKED = new Set(['fuck','shit','ass','bitch','cunt','dick','cock','pussy','nigger','faggot']);
function clean(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim().slice(0, 24);
  const lower = s.toLowerCase().replace(/[^a-z0-9 ]/g,'');
  for (const w of BLOCKED) if (lower.includes(w)) return '';
  return s;
}

// ── Generated pseudonym bank ──────────────────────────────────────────────────
const ADJ = ['Cosmic','Neural','Quantum','Solar','Arctic','Velvet','Crimson','Neon','Atomic','Lunar','Vivid','Rapid','Prism','Delta','Cobalt'];
const NON = ['Panda','Falcon','Oracle','Cipher','Sphinx','Nomad','Comet','Vortex','Phantom','Nexus','Glitch','Prism','Titan','Raven','Ember'];
function genName() { return ADJ[Math.floor(Math.random()*ADJ.length)] + NON[Math.floor(Math.random()*NON.length)]; }

// ── Earned titles ─────────────────────────────────────────────────────────────
function earnedTitle(stats) {
  const { correct, wrong, oracle, fast, catWins } = stats;
  const total = correct + wrong;
  if (total === 0) return { title: 'Newcomer', emoji: '🌱' };
  const acc = correct / total;
  if (oracle >= 2) return { title: 'The Oracle', emoji: '🔮' };
  if (acc === 1 && total >= 8) return { title: 'The Perfectionist', emoji: '💎' };
  if (acc >= 0.9 && total >= 6) return { title: 'Brain Trust Elite', emoji: '🧠' };
  if (fast > correct * 0.7 && correct > 3) return { title: 'The Reflex', emoji: '⚡' };
  if (oracle === 1) return { title: 'Moment of Oracle', emoji: '✨' };
  const topCat = Object.entries(catWins||{}).sort((a,b)=>b[1]-a[1])[0];
  if (topCat && topCat[1] >= 3) {
    const map = {
      History: { title: 'The Historian', emoji: '📜' },
      Science: { title: 'The Scientist', emoji: '🔬' },
      Geography: { title: 'The Explorer', emoji: '🌍' },
      Culture: { title: 'The Critic', emoji: '🎭' },
      Sports: { title: 'The Champion', emoji: '🏆' },
      'Wild Card': { title: 'The Wildcard', emoji: '🃏' }
    };
    return map[topCat[0]] || { title: 'The Specialist', emoji: '🎯' };
  }
  if (acc < 0.35) return { title: 'Brave Soul', emoji: '🫡' };
  return { title: 'The Analyst', emoji: '📊' };
}

// ── Room management ───────────────────────────────────────────────────────────
const rooms = new Map(); // roomId → Room

function makeRoom() {
  return {
    players: new Map(),   // sid → PlayerState
    phase: 'lobby',       // lobby|answering|reveal|syg|gameover
    questions: [],
    currentQ: -1,
    answers: new Map(),   // sid → {choice, timeMs}
    sygChoices: new Map(),// sid → choice (stand-your-ground)
    timer: null,
    host: null,
    settings: {
      standYourGround: true,
      timerOff: false,
      reactionsMuted: false,
      locked: false,
    }
  };
}

function makePlayer(name, sid) {
  return {
    id: sid, name,
    score: 0, streak: 0, doubleDown: false,
    stats: { correct: 0, wrong: 0, oracle: 0, fast: 0, catWins: {} }
  };
}

function roomLeaderboard(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map(p => ({ name: p.name, score: p.score, streak: p.streak, ...earnedTitle(p.stats) }));
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function pickQuestions(n) {
  // Balanced across categories
  const byCat = {};
  QUESTIONS.forEach(q => { (byCat[q.category] = byCat[q.category]||[]).push(q); });
  const cats = Object.keys(byCat);
  const perCat = Math.ceil(n / cats.length);
  const picked = [];
  cats.forEach(c => picked.push(...shuffle(byCat[c]).slice(0, perCat)));
  return shuffle(picked).slice(0, n);
}

// ── Timer helpers ─────────────────────────────────────────────────────────────
function clearRoomTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

// ── Scoring ───────────────────────────────────────────────────────────────────
function scoreRound(room, answerKey, isSYG) {
  const q = room.questions[room.currentQ];
  const totalAnswered = room.answers.size;
  const tally = { A: 0, B: 0, C: 0, D: 0 };
  room.answers.forEach(a => { tally[a.choice] = (tally[a.choice] || 0) + 1; });
  const correctCount = tally[answerKey] || 0;
  const isUnanimous = totalAnswered > 1 && correctCount === totalAnswered;
  const isSolo = totalAnswered > 1 && correctCount === 1;

  room.answers.forEach((a, sid) => {
    const player = room.players.get(sid);
    if (!player) return;
    const correct = a.choice === answerKey;
    player.stats.correct += correct ? 1 : 0;
    player.stats.wrong += correct ? 0 : 1;
    if (correct) player.stats.fast += a.timeMs <= CFG.GRACE_MS ? 1 : 0;
    if (correct) player.stats.catWins[q.category] = (player.stats.catWins[q.category]||0)+1;

    if (correct) {
      const speed   = (!room.settings.timerOff && a.timeMs <= CFG.GRACE_MS) ? CFG.SPEED_BONUS : 0;
      const streak  = Math.min(player.streak * CFG.STREAK_PER, CFG.STREAK_CAP);
      const trust   = isUnanimous ? CFG.TRUST_BONUS : 0;
      const dd      = player.doubleDown ? CFG.DD_STAKE : 0;
      const earned  = CFG.BASE_PTS + speed + streak + trust + dd;
      player.score += earned;
      player.streak++;
      if (isSolo && isUnanimous === false) player.stats.oracle++;
      io.to(sid).emit('answer_result', { correct: true, earned, speed, streak, trust, dd, oracle: isSolo });
    } else {
      if (player.doubleDown) player.score = Math.max(0, player.score - CFG.DD_STAKE);
      player.streak = 0;
      io.to(sid).emit('answer_result', { correct: false, earned: 0, oracle: false });
    }
    player.doubleDown = false;
  });

  return { tally, isUnanimous, isSolo, correctCount };
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function advanceQuestion(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(room);
  room.currentQ++;
  room.answers.clear();
  room.sygChoices.clear();

  if (room.currentQ >= room.questions.length) {
    room.phase = 'gameover';
    io.to(roomId).emit('game_over', { leaderboard: roomLeaderboard(room) });
    return;
  }

  const q = room.questions[room.currentQ];
  room.phase = 'answering';
  const sentAt = Date.now();
  io.to(roomId).emit('question', {
    index: room.currentQ, total: room.questions.length,
    text: q.text, options: q.options, category: q.category,
    difficulty: q.difficulty, timeMs: CFG.ROUND_MS,
    timerOff: room.settings.timerOff, sentAt
  });

  if (!room.settings.timerOff) {
    room.timer = setTimeout(() => revealRound(roomId), CFG.ROUND_MS);
  }
}

function revealRound(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== 'answering') return;
  clearRoomTimer(room);
  room.phase = 'reveal';

  const q = room.questions[room.currentQ];
  const { tally, isUnanimous, isSolo } = scoreRound(room, q.answer);

  const totalAnswered = room.answers.size;
  const pct = {};
  ['A','B','C','D'].forEach(k => {
    pct[k] = totalAnswered ? Math.round((tally[k]||0)/totalAnswered*100) : 0;
  });
  const divided = !isUnanimous && totalAnswered > 1 && Object.values(tally).filter(v=>v>0).length > 1;

  io.to(roomId).emit('reveal', {
    answer: q.answer, explanation: q.explanation,
    tally, pct, isUnanimous, divided,
    leaderboard: roomLeaderboard(room)
  });

  if (divided && room.settings.standYourGround) {
    room.phase = 'syg';
    io.to(roomId).emit('stand_your_ground', { timeMs: CFG.SYG_MS });
    room.timer = setTimeout(() => resolveSYG(roomId), CFG.SYG_MS);
  } else {
    room.timer = setTimeout(() => endRound(roomId), CFG.REVEAL_MS);
  }
}

function resolveSYG(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(room);
  const q = room.questions[room.currentQ];
  // Award Oracle bonus to correct SYG switchers-to-correct or stayers-who-were-right
  room.sygChoices.forEach((choice, sid) => {
    if (choice === q.answer) {
      const player = room.players.get(sid);
      if (player) {
        player.score += CFG.ORACLE_BONUS;
        player.stats.oracle++;
        io.to(sid).emit('oracle_moment', { bonus: CFG.ORACLE_BONUS });
      }
    }
  });
  endRound(roomId);
}

function endRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearRoomTimer(room);
  io.to(roomId).emit('round_end', { leaderboard: roomLeaderboard(room) });
  room.timer = setTimeout(() => advanceQuestion(roomId), CFG.NEXT_DELAY_MS);
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('join_room', ({ roomId, name }) => {
    const cleanName = clean(name) || genName();
    if (!rooms.has(roomId)) rooms.set(roomId, makeRoom());
    const room = rooms.get(roomId);
    if (room.settings.locked) { socket.emit('error', { msg: 'Room is locked' }); return; }
    if (room.phase !== 'lobby') { socket.emit('error', { msg: 'Game in progress' }); return; }
    if (room.players.size >= CFG.MAX_PLAYERS) { socket.emit('error', { msg: 'Room full' }); return; }
    if (!room.host) room.host = socket.id;
    room.players.set(socket.id, makePlayer(cleanName, socket.id));
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = cleanName;
    io.to(roomId).emit('player_list', { players: playerList(room), host: room.players.get(room.host)?.name });
    socket.emit('joined', { roomId, name: cleanName, isHost: socket.id === room.host, settings: room.settings });
  });

  socket.on('start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.host || room.phase !== 'lobby') return;
    room.questions = pickQuestions(CFG.Q_PER_GAME);
    room.phase = 'playing';
    io.to(roomId).emit('game_starting', { questionCount: room.questions.length });
    setTimeout(() => advanceQuestion(roomId), 1500);
  });

  socket.on('submit_answer', ({ roomId, choice, timeMs }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'answering') return;
    if (room.answers.has(socket.id)) return;
    if (!['A','B','C','D'].includes(choice)) return;
    room.answers.set(socket.id, { choice, timeMs: Math.max(0, timeMs) });
    io.to(socket.id).emit('answer_locked', { choice });
    io.to(roomId).emit('answer_count', { count: room.answers.size, total: room.players.size });
    if (room.answers.size === room.players.size) {
      clearRoomTimer(room);
      revealRound(roomId);
    }
  });

  socket.on('double_down', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'answering') return;
    const p = room.players.get(socket.id);
    if (p && !p.doubleDown) { p.doubleDown = true; socket.emit('doubled_down'); }
  });

  socket.on('stand_ground', ({ roomId, choice }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'syg') return;
    if (['A','B','C','D'].includes(choice)) room.sygChoices.set(socket.id, choice);
  });

  socket.on('reaction', ({ roomId, emoji }) => {
    const room = rooms.get(roomId);
    if (!room || room.settings.reactionsMuted) return;
    const ALLOWED = ['😤 Knew It','🍀 Lucky Guess','😱 No Way','🔄 Rematch'];
    if (!ALLOWED.includes(emoji)) return;
    io.to(roomId).emit('reaction', { name: socket.data.name, emoji });
  });

  // Host controls
  socket.on('host_setting', ({ roomId, key, value }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.host) return;
    if (['standYourGround','timerOff','reactionsMuted','locked'].includes(key)) {
      room.settings[key] = !!value;
      io.to(roomId).emit('settings_updated', { settings: room.settings });
    }
  });

  socket.on('host_remove', ({ roomId, targetName }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.host) return;
    const entry = [...room.players.entries()].find(([,p]) => p.name === targetName);
    if (!entry) return;
    const [sid] = entry;
    io.to(sid).emit('removed');
    io.sockets.sockets.get(sid)?.leave(roomId);
    room.players.delete(sid);
    io.to(roomId).emit('player_list', { players: playerList(room), host: room.players.get(room.host)?.name });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { clearRoomTimer(room); rooms.delete(roomId); return; }
    if (room.host === socket.id) room.host = [...room.players.keys()][0];
    io.to(roomId).emit('player_list', { players: playerList(room), host: room.players.get(room.host)?.name });
  });
});

function playerList(room) {
  return [...room.players.values()].map(p => ({ name: p.name, score: p.score, streak: p.streak }));
}

// ── Export for tests ──────────────────────────────────────────────────────────
module.exports = { scoreRound, earnedTitle, clean, genName, pickQuestions, CFG };

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  httpServer.listen(PORT, '127.0.0.1', () => console.log('Trivia Circus server: http://127.0.0.1:'+PORT));
}
