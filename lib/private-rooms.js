'use strict';
const crypto = require('crypto');

const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const EMPTY_TTL_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_PLAYERS = 12;

function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').trim().replace(/\s+/g, ' ');
}

function createPrivateRoomManager(io, options = {}) {
  const rooms = new Map();
  const attempts = new Map();
  const cfg = {
    questionMs: options.questionMs || 45000,
    revealMs: options.revealMs || 5500,
    nextDelayMs: options.nextDelayMs || 2000,
  };
  let questions = options.questions || [];

  function setQuestions(next) { questions = Array.isArray(next) ? next : []; }
  function publicId() { return crypto.randomBytes(16).toString('base64url'); }
  function hashPasscode(passcode, salt) { return crypto.scryptSync(passcode, salt, 32); }
  function validPasscode(value) { return typeof value === 'string' && value.length >= 4 && value.length <= 128; }
  function create(passcode) {
    if (!validPasscode(passcode)) return null;
    let id; do { id = publicId(); } while (rooms.has(id));
    const salt = crypto.randomBytes(16);
    const room = {
      id, salt, passHash: hashPasscode(passcode, salt), createdAt: Date.now(), emptySince: Date.now(),
      phase: 'idle', players: new Map(), sockets: new Map(), answers: new Map(), eligible: new Set(),
      qIndex: -1, currentQ: null, roundId: null, questionSentAt: 0, timer: null,
    };
    rooms.set(id, room);
    return { id };
  }
  function safeEqual(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }
  function attemptKey(socket, roomId) {
    const ip = socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address || 'unknown';
    return roomId + ':' + ip;
  }
  function admitted(room, socket, passcode) {
    const key = attemptKey(socket, room.id), now = Date.now();
    const recent = (attempts.get(key) || []).filter(ts => now - ts < ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) return { ok: false, code: 'ROOM_RATE_LIMITED', error: 'Too many attempts. Please wait and try again.' };
    let candidate;
    try { candidate = validPasscode(passcode) ? hashPasscode(passcode, room.salt) : Buffer.alloc(32); }
    catch (_) { candidate = Buffer.alloc(32); }
    if (!safeEqual(candidate, room.passHash)) {
      recent.push(now); attempts.set(key, recent);
      return { ok: false, code: 'INVALID_ROOM_PASSCODE', error: 'That room passcode is incorrect.' };
    }
    attempts.delete(key);
    return { ok: true };
  }
  function channel(room) { return 'private:' + room.id; }
  function connected(room) { return [...room.players.values()].filter(p => p.connected); }
  function presence(room) { return connected(room).map(p => ({ name:p.name, score:p.score, streak:p.streak, status:p.status, answered:room.answers.has(p.id) })); }
  function leaderboard(room) { return connected(room).sort((a,b)=>b.score-a.score).map(p=>({name:p.name,score:p.score,streak:p.streak})); }
  function emit(room, event, data) { io.to(channel(room)).emit(event, data); }
  function clearRoomTimer(room) { clearTimeout(room.timer); room.timer = null; }
  function nextQuestion(room) {
    if (!questions.length) return null;
    room.qIndex = (room.qIndex + 1) % questions.length;
    return questions[room.qIndex];
  }
  function startQuestion(room) {
    clearRoomTimer(room);
    if (!connected(room).length) { room.phase='idle'; room.emptySince=Date.now(); emit(room,'circus_idle',{msg:'The private room is resting'}); return; }
    const q=nextQuestion(room); if(!q) return;
    room.currentQ=q; room.roundId=crypto.randomUUID(); room.questionSentAt=Date.now(); room.answers.clear();
    room.eligible=new Set(connected(room).map(p=>p.id)); room.phase='question';
    emit(room,'question',{index:room.qIndex,text:q.text,category:q.category,difficulty:q.difficulty,roundId:room.roundId,timeMs:cfg.questionMs,presence:presence(room)});
    room.timer=setTimeout(()=>reveal(room),cfg.questionMs);
  }
  function reveal(room) {
    clearRoomTimer(room); if(room.phase!=='question') return; room.phase='reveal';
    const answer=room.currentQ.correctAnswer || (room.currentQ.options && room.currentQ.options[room.currentQ.answer]) || '';
    let correctCount=0, first=null;
    for(const [id,a] of room.answers){ if(normalizeAnswer(a.answer)===normalizeAnswer(answer)){ correctCount++; if(!first||a.seq<first.seq) first={id,seq:a.seq}; } }
    for(const id of room.eligible){ const p=room.players.get(id), a=room.answers.get(id); if(!p||!a) continue; const correct=normalizeAnswer(a.answer)===normalizeAnswer(answer); const earned=correct?100:0; p.score+=earned; p.streak=correct?p.streak+1:0; const sid=room.sockets.get(id); if(sid) io.to(sid).emit('answer_result',{correct,earned,speed:0,firstBonus:0,streak:0,trust:0,dd:0,elapsedMs:a.elapsedMs}); }
    emit(room,'reveal',{answer,explanation:room.currentQ.explanation||'',isUnanimous:room.eligible.size>1&&correctCount===room.eligible.size,correctCount,totalAnswered:room.answers.size,totalEligible:room.eligible.size,firstCorrectName:first&&room.players.get(first.id)?.name||null,leaderboard:leaderboard(room),presence:presence(room)});
    room.timer=setTimeout(()=>endRound(room),cfg.revealMs);
  }
  function endRound(room){ clearRoomTimer(room); emit(room,'round_end',{leaderboard:leaderboard(room)}); if(connected(room).length) room.timer=setTimeout(()=>startQuestion(room),cfg.nextDelayMs); else { room.phase='idle'; room.emptySince=Date.now(); } }
  function allAnswered(room){ const live=[...room.eligible].filter(id=>room.players.get(id)?.connected); if(live.length&&live.every(id=>room.answers.has(id))) reveal(room); }

  function join(socket, data, identity) {
    const roomId = data && typeof data.roomId === 'string' ? data.roomId : '';
    const room = rooms.get(roomId);
    if (!room) return { ok:false, code:'ROOM_NOT_FOUND', error:'That private room is unavailable.' };
    const auth = admitted(room, socket, data && data.passcode); if(!auth.ok) return auth;
    if(connected(room).length >= MAX_PLAYERS) return {ok:false,code:'ROOM_FULL',error:'That private room is full.'};
    const id=identity.profileId||socket.id, existing=room.players.get(id);
    const p=existing||{id,name:identity.name,score:0,streak:0,status:'🎪 Here to Play',connected:true};
    p.connected=true;p.socketId=socket.id;room.players.set(id,p);room.sockets.set(id,socket.id);room.emptySince=null;
    socket.leave('public');socket.join(channel(room));socket.data.privateRoomId=room.id;socket.data.privatePlayerId=id;socket.data.joined=true;
    const state={name:p.name,phase:room.phase,presence:presence(room),leaderboard:leaderboard(room),privateRoom:true,roomId:room.id,profile:identity.profile||null};
    if(room.phase==='question'&&room.currentQ) state.currentQuestion={text:room.currentQ.text,category:room.currentQ.category,difficulty:room.currentQ.difficulty,roundId:room.roundId,timeRemaining:Math.max(0,cfg.questionMs-(Date.now()-room.questionSentAt))};
    socket.emit('joined',state);emit(room,'presence',{players:presence(room)});
    if(room.phase==='idle'){clearRoomTimer(room);room.timer=setTimeout(()=>startQuestion(room),1500);}
    return {ok:true};
  }
  function forSocket(socket){ const room=rooms.get(socket.data.privateRoomId); return room&&room.players.has(socket.data.privatePlayerId)?room:null; }
  function attachSocket(socket){
    socket.on('submit_answer',(data,ack)=>{const room=forSocket(socket);if(!room)return;const respond=x=>typeof ack==='function'&&ack(x);if(room.phase!=='question'||!data||data.roundId!==room.roundId||typeof data.answer!=='string'||!data.answer.trim()||data.answer.length>160)return respond({ok:false,error:'Answer not accepted.'});const id=socket.data.privatePlayerId;if(!room.eligible.has(id))return respond({ok:false,error:'You can answer the next question.'});if(room.answers.has(id))return respond({ok:true,duplicate:true});room.answers.set(id,{answer:data.answer.trim(),elapsedMs:Date.now()-room.questionSentAt,seq:room.answers.size+1});socket.emit('answer_locked',{answer:data.answer.trim(),roundId:room.roundId});respond({ok:true});emit(room,'presence',{players:presence(room)});emit(room,'answer_count',{count:room.answers.size,total:room.eligible.size});allAnswered(room);});
    socket.on('set_status',(data,ack)=>{const room=forSocket(socket);if(!room)return;const allowed=['🎯 Ready','🔥 On Fire','🤔 Thinking','😎 Confident','🍀 Feeling Lucky','🎪 Here to Play'];if(!data||!allowed.includes(data.status))return typeof ack==='function'&&ack({ok:false});room.players.get(socket.data.privatePlayerId).status=data.status;typeof ack==='function'&&ack({ok:true,status:data.status});emit(room,'presence',{players:presence(room)});});
    socket.on('reaction',data=>{const room=forSocket(socket);if(!room)return;const allowed=new Set(['Knew It','Lucky Guess','No Way','Rematch']);if(!data||!allowed.has(data.emoji))return;emit(room,'reaction',{name:room.players.get(socket.data.privatePlayerId).name,emoji:data.emoji});});
    socket.on('disconnect',()=>{const room=forSocket(socket);if(!room)return;const p=room.players.get(socket.data.privatePlayerId);if(p&&p.socketId===socket.id){p.connected=false;room.sockets.delete(p.id);}emit(room,'presence',{players:presence(room)});if(!connected(room).length){clearRoomTimer(room);room.phase='idle';room.emptySince=Date.now();}else if(room.phase==='question')allAnswered(room);});
  }
  function cleanup(now=Date.now()){for(const [id,room] of rooms){if(now-room.createdAt>ROOM_TTL_MS||(room.emptySince&&now-room.emptySince>EMPTY_TTL_MS)){clearRoomTimer(room);rooms.delete(id);}}for(const [key,list] of attempts){if(!list.some(ts=>now-ts<ATTEMPT_WINDOW_MS))attempts.delete(key);}}
  const cleanupTimer=setInterval(cleanup,60000);cleanupTimer.unref?.();
  function close(){clearInterval(cleanupTimer);for(const room of rooms.values())clearRoomTimer(room);rooms.clear();}
  return {create,join,attachSocket,setQuestions,cleanup,close,rooms,constants:{MAX_PLAYERS,MAX_ATTEMPTS}};
}
module.exports={createPrivateRoomManager};
