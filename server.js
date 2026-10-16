const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions/bank.json')));
const ROUND_MS = 20000;
const GRACE_MS = 7000;
const REVEAL_MS = 5000;
const STANDGROUND_MS = 6000;

const rooms = new Map();

function makeRoom() {
  return { players: new Map(), phase: 'lobby', questions: [], currentQ: -1,
           answers: new Map(), standAnswers: new Map(), timer: null, host: null };
}

function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function pickQuestions(n=10) { return shuffle(QUESTIONS).slice(0,n); }

function titles(player) {
  const { correct, wrong, fast, categories } = player.stats;
  const total = correct + wrong;
  if (total === 0) return 'Newcomer';
  const acc = correct / total;
  if (acc === 1 && total >= 8) return 'The Oracle 🔮';
  if (acc >= 0.9) return 'Brain Trust Elite 🧠';
  if (fast > correct * 0.7) return 'The Guesser ⚡';
  const topCat = Object.entries(categories||{}).sort((a,b)=>b[1]-a[1])[0];
  if (topCat && topCat[1] >= 3) {
    const map = {Geopolitics:'The Diplomat 🌍', 'Markets & Finance':'The Trader 📈',
      Technology:'The Engineer ⚙️', Science:'The Scientist 🔬',
      History:'The Historian 📜', 'Culture & Ideas':'The Thinker 💡'};
    return map[topCat[0]] || 'The Expert';
  }
  if (acc < 0.4) return 'Brave Soul 🫡';
  return 'The Analyst';
}

function leaderboard(room) {
  return [...room.players.values()]
    .sort((a,b) => b.score - a.score)
    .map(p => ({name:p.name, score:p.score, streak:p.streak, title:titles(p)}));
}

function advanceQuestion(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timer);
  room.currentQ++;
  room.answers.clear();
  room.standAnswers.clear();

  if (room.currentQ >= room.questions.length) {
    room.phase = 'gameover';
    io.to(roomId).emit('game_over', { leaderboard: leaderboard(room) });
    return;
  }

  const q = room.questions[room.currentQ];
  room.phase = 'answering';
  const sentAt = Date.now();
  io.to(roomId).emit('question', {
    index: room.currentQ, total: room.questions.length,
    text: q.text, options: q.options, category: q.category,
    difficulty: q.difficulty, timeMs: ROUND_MS, sentAt
  });

  room.timer = setTimeout(() => revealRound(roomId, sentAt), ROUND_MS);
}

function revealRound(roomId, sentAt) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timer);
  room.phase = 'reveal';
  const q = room.questions[room.currentQ];
  const total = room.players.size;
  const tally = { A:0, B:0, C:0, D:0 };
  room.answers.forEach(a => { if (tally[a.choice] !== undefined) tally[a.choice]++; });
  const answered = room.answers.size;
  const pct = {};
  ['A','B','C','D'].forEach(k => pct[k] = answered ? Math.round(tally[k]/answered*100) : 0);
  const unanimous = answered > 1 && Object.values(tally).filter(v=>v>0).length === 1;
  const divided = !unanimous && answered > 1;

  // Score correct answerers
  room.answers.forEach((a, sid) => {
    const player = room.players.get(sid);
    if (!player) return;
    const correct = a.choice === q.answer;
    player.stats.correct += correct ? 1 : 0;
    player.stats.wrong += correct ? 0 : 1;
    player.stats.fast += (a.timeMs <= GRACE_MS && correct) ? 1 : 0;
    if (!player.stats.categories) player.stats.categories = {};
    if (correct) player.stats.categories[q.category] = (player.stats.categories[q.category]||0)+1;

    if (correct) {
      const base = 100;
      const speed = a.timeMs <= GRACE_MS ? 10 : 0;
      const streak = Math.min(player.streak * 20, 80);
      const dd = player.doubleDown ? 50 : 0;
      const trust = (unanimous && correct) ? 50 : 0;
      const earned = base + speed + streak + dd + trust;
      player.score += earned;
      player.streak++;
      io.to(sid).emit('answer_result', {correct:true, earned, speed, streak, dd, trust});
    } else {
      if (player.doubleDown) player.score = Math.max(0, player.score - 50);
      player.streak = 0;
      io.to(sid).emit('answer_result', {correct:false, earned:0});
    }
    player.doubleDown = false;
  });

  io.to(roomId).emit('reveal', {
    answer: q.answer, explanation: q.explanation, tally, pct,
    unanimous, divided, leaderboard: leaderboard(room)
  });

  if (divided) {
    room.phase = 'standground';
    io.to(roomId).emit('stand_your_ground', { timeMs: STANDGROUND_MS });
    room.timer = setTimeout(() => endRound(roomId), STANDGROUND_MS);
  } else {
    room.timer = setTimeout(() => endRound(roomId), REVEAL_MS);
  }
}

function endRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  // Award stand-your-ground correct switchers bonus
  const q = room.questions[room.currentQ];
  room.standAnswers.forEach((choice, sid) => {
    if (choice === q.answer) {
      const player = room.players.get(sid);
      if (player) { player.score += 30; io.to(sid).emit('oracle_moment', {bonus:30}); }
    }
  });
  io.to(roomId).emit('round_end', { leaderboard: leaderboard(room) });
  setTimeout(() => advanceQuestion(roomId), 2000);
}

io.on('connection', socket => {
  socket.on('join_room', ({ roomId, name }) => {
    if (!rooms.has(roomId)) rooms.set(roomId, makeRoom());
    const room = rooms.get(roomId);
    if (room.phase !== 'lobby') { socket.emit('error', {msg:'Game already started'}); return; }
    if (!room.host) room.host = socket.id;
    room.players.set(socket.id, {
      name, score:0, streak:0, doubleDown:false,
      stats:{correct:0,wrong:0,fast:0,categories:{}}
    });
    socket.join(roomId);
    socket.data.roomId = roomId;
    io.to(roomId).emit('player_list', {
      players:[...room.players.values()].map(p=>({name:p.name,score:p.score,streak:p.streak})),
      host: room.players.get(room.host)?.name
    });
    socket.emit('joined', { roomId, isHost: socket.id === room.host });
  });

  socket.on('start_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.host) return;
    room.questions = pickQuestions(10);
    room.phase = 'playing';
    io.to(roomId).emit('game_starting');
    setTimeout(() => advanceQuestion(roomId), 1500);
  });

  socket.on('submit_answer', ({ roomId, choice, timeMs }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'answering' || room.answers.has(socket.id)) return;
    room.answers.set(socket.id, { choice, timeMs });
    socket.emit('answer_locked', { choice });
    io.to(roomId).emit('answer_count', { count: room.answers.size, total: room.players.size });
    if (room.answers.size === room.players.size) {
      clearTimeout(room.timer);
      revealRound(roomId, null);
    }
  });

  socket.on('double_down', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'answering') return;
    const player = room.players.get(socket.id);
    if (player) player.doubleDown = true;
    socket.emit('doubled_down');
  });

  socket.on('stand_ground', ({ roomId, choice }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'standground') return;
    room.standAnswers.set(socket.id, choice);
  });

  socket.on('reaction', ({ roomId, emoji }) => {
    const player = rooms.get(roomId)?.players.get(socket.id);
    if (player) io.to(roomId).emit('reaction', { name: player.name, emoji });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { rooms.delete(roomId); return; }
    if (room.host === socket.id) room.host = [...room.players.keys()][0];
    io.to(roomId).emit('player_list', {
      players:[...room.players.values()].map(p=>({name:p.name,score:p.score,streak:p.streak})),
      host: room.players.get(room.host)?.name
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log('Brain Trust server on :'+PORT));
