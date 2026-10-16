'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {io:client}=require('socket.io-client');
const server=require('../server');

function once(socket,event,timeout=2500){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(event+' timeout')),timeout);socket.once(event,data=>{clearTimeout(t);resolve(data)});});}
function noEvent(socket,event,ms=350){return new Promise((resolve,reject)=>{const handler=data=>{clearTimeout(t);reject(new Error('unexpected '+event+': '+JSON.stringify(data)))};const t=setTimeout(()=>{socket.off(event,handler);resolve()},ms);socket.once(event,handler);});}
function emitAck(socket,event,data){return new Promise(resolve=>socket.emit(event,data,resolve));}

let base;
test.before(async()=>{server.setQuestions([{text:'Two plus two?',category:'Science',difficulty:1,correctAnswer:'4',explanation:''}]);await new Promise(resolve=>server.httpServer.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.httpServer.address().port;});
test.after(()=>{server.privateRooms.close();server.io.disconnectSockets(true);server.httpServer.closeAllConnections();server.io.close();});

async function makeRoom(passcode){const response=await fetch(base+'/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({passcode})});assert.equal(response.status,201);return response.json();}
function connect(){return client(base,{transports:['websocket'],forceNew:true,reconnection:false});}

test('invite URL contains only cryptographically random room ID and stored secret is hashed',async()=>{const made=await makeRoom('do-not-leak-77');assert.match(made.roomId,/^[A-Za-z0-9_-]{22}$/);assert.equal(made.inviteUrl,'/game.html?room='+made.roomId);assert.ok(!JSON.stringify(made).includes('do-not-leak-77'));const room=server.privateRooms.rooms.get(made.roomId);assert.ok(Buffer.isBuffer(room.passHash));assert.equal(room.passcode,undefined);assert.ok(!JSON.stringify([...server.privateRooms.rooms.keys()]).includes('do-not-leak-77'));});

test('wrong passcode denied, correct passcode admitted, attempts rate limited',async()=>{const made=await makeRoom('right-pass');const s=connect();await once(s,'connect');let result=await emitAck(s,'join',{roomId:made.roomId,passcode:'wrong-pass'});assert.equal(result.code,'INVALID_ROOM_PASSCODE');result=await emitAck(s,'join',{roomId:made.roomId,passcode:'right-pass'});assert.equal(result.ok,true);s.disconnect();const limited=connect();await once(limited,'connect');for(let i=0;i<5;i++)assert.equal((await emitAck(limited,'join',{roomId:made.roomId,passcode:'bad-'+i})).code,'INVALID_ROOM_PASSCODE');assert.equal((await emitAck(limited,'join',{roomId:made.roomId,passcode:'right-pass'})).code,'ROOM_RATE_LIMITED');limited.disconnect();});

test('rooms and public room isolate presence, reactions, questions and timers',async()=>{const a=await makeRoom('alpha-pass'),b=await makeRoom('bravo-pass');const sa=connect(),sb=connect(),pub=connect();await Promise.all([once(sa,'connect'),once(sb,'connect'),once(pub,'connect')]);const joinedA=once(sa,'joined'),joinedB=once(sb,'joined'),joinedP=once(pub,'joined');sa.emit('join',{roomId:a.roomId,passcode:'alpha-pass'});sb.emit('join',{roomId:b.roomId,passcode:'bravo-pass'});pub.emit('join',{});await Promise.all([joinedA,joinedB,joinedP]);const qa=once(sa,'question'),qb=once(sb,'question'),qp=once(pub,'question');const [aQ,bQ,pQ]=await Promise.all([qa,qb,qp]);assert.notEqual(aQ.roundId,bQ.roundId);assert.notEqual(aQ.roundId,pQ.roundId);
const noB=noEvent(sb,'reaction'),noP=noEvent(pub,'reaction');const gotA=once(sa,'reaction');sa.emit('reaction',{emoji:'Knew It'});assert.equal((await gotA).emoji,'Knew It');await Promise.all([noB,noP]);
const noAPublic=noEvent(sa,'reaction'),noBPublic=noEvent(sb,'reaction');const gotP=once(pub,'reaction');pub.emit('reaction',{emoji:'Rematch'});assert.equal((await gotP).emoji,'Rematch');await Promise.all([noAPublic,noBPublic]);
assert.equal(server.privateRooms.rooms.get(a.roomId).players.size,1);assert.equal(server.privateRooms.rooms.get(b.roomId).players.size,1);sa.disconnect();sb.disconnect();pub.disconnect();});

test('client never places passcode in URL, localStorage, or socket handshake',async()=>{const html=await (await fetch(base+'/game.html?room=safeRoomId')).text();assert.match(html,/ROOM_ID=new URLSearchParams/);assert.doesNotMatch(html,/localStorage|sessionStorage/);assert.ok(html.includes("socket.emit('join'"));assert.ok(html.includes('passcode:roomPasscode'));assert.ok(!html.includes('auth:{passcode'));});
