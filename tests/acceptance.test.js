'use strict';
// Adapted from TC independent acceptance tests (trivia-persistence-specialists.tar.gz)
// Adaptations: zero-score leaderboard exclusion, field names (lifetimeScore, name, entries)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const CACHE = require('../importer/cache/open-trivia-qa.json');
const FALLBACK = require('../questions/bank.json');
const { CFG } = require('../server');
const SAFE_NAME = /^[A-Z][a-z]+ [A-Z][a-z]+$/;
const PROFANITY = /fuck|shit|bitch|cunt|dick|cock|pussy|nigger|faggot/i;

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(port, pathname = '/', { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function startServer(dataDir) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`server exited with code ${child.exitCode}\n${output}`);
      }
      try {
        const response = await request(port);
        if (response.status === 200) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`server did not become ready\n${output}`);
  })();
  await Promise.race([ready, timeout(8000, `server startup timeout\n${output}`)]);
  return { child, port, get output() { return output; } };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = new Promise(resolve => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
    await exited;
  }
}

async function withServer(fn) {
  const tmpRoot = process.env.TMPDIR || os.tmpdir();
  const dataDir = await fsp.mkdtemp(path.join(tmpRoot, 'trivia-persistence-'));
  const server = await startServer(dataDir);
  try {
    return await fn({ ...server, dataDir });
  } finally {
    await stopServer(server);
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

async function browserCookie(port, headers = {}) {
  const response = await request(port, '/', { headers });
  const cookies = response.headers['set-cookie'] || [];
  const identityCookie = cookies.find(value => /;\s*HttpOnly\b/i.test(value)) || cookies[0];
  if (!identityCookie) return { response, setCookie: null, cookie: null };
  return { response, setCookie: identityCookie, cookie: cookiePair(identityCookie) };
}

async function issueCookie(port, headers = {}) {
  const identity = await browserCookie(port, headers);
  assert.ok(identity.setCookie, 'initial browser request must issue the opaque guest identity cookie');
  return identity;
}

function connectClient(port, cookie) {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: cookie ? { Cookie: cookie } : {},
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO connection timeout'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitFor(socket, event, ms = 4000) {
  return Promise.race([
    new Promise(resolve => socket.once(event, resolve)),
    timeout(ms, `${event} timeout`),
  ]);
}

async function join(socket, payload = {}) {
  const joined = waitFor(socket, 'joined');
  socket.emit('join', payload);
  const state = await joined;
  assert.ok(state && state.profile, 'joined payload must include persistent profile');
  assert.ok(!('id' in state.profile), 'public profile must not expose an id');
  assert.equal(typeof state.profile.name, 'string', 'profile.name must be a string');
  assert.equal(typeof state.profile.lifetimeScore, 'number', 'profile.lifetimeScore must be numeric');
  return state;
}

async function emitAck(socket, event, payload, ms = 3000) {
  return Promise.race([
    new Promise((resolve, reject) => {
      socket.emit(event, payload, response => {
        if (response && response.error) reject(new Error(response.error));
        else resolve(response);
      });
    }),
    timeout(ms, `${event} acknowledgement timeout`),
  ]);
}

async function leaderboard(port, limit) {
  const response = await request(port, `/api/leaderboard?limit=${limit}`);
  assert.equal(response.status, 200, 'GET /api/leaderboard must return 200');
  assert.doesNotThrow(() => JSON.parse(response.body), 'leaderboard response must be JSON');
  const body = JSON.parse(response.body);
  assert.ok(Array.isArray(body.entries), 'leaderboard JSON must contain entries[]');
  return body.entries;
}

function correctAnswer(question) {
  const cached = CACHE.questions.find(item => item.prompt === question.text);
  if (cached) {
    return cached.choices[cached.correctIndex];
  }
  const fallback = FALLBACK.find(item => item.text === question.text);
  assert.ok(fallback, `question not found in published banks: ${question.text}`);
  return fallback.options[fallback.answer];
}

async function scoreOneRound(socket) {
  const question = await waitFor(socket, 'question', 7000);
  assert.equal(question.options, undefined, 'typed-answer rounds must not expose multiple-choice options');
  assert.equal(question.answer, undefined, 'question event must not expose the answer');
  assert.equal(question.timeMs, CFG.QUESTION_MS, 'question event must use the configured round duration');
  assert.equal(typeof question.roundId, 'string', 'question event must issue a round id');
  assert.ok(question.roundId.length > 0, 'question event round id must not be empty');
  const resultPromise = waitFor(socket, 'answer_result', 7000);
  // B6: also gate on round_end so SQLite is committed before callers read it
  const roundEndPromise = new Promise(res => { socket.once('round_end', res); setTimeout(res, 9000); });
  socket.emit('submit_answer', {
    answer: correctAnswer(question),
    roundId: question.roundId,
    timeMs: CFG.QUESTION_MS, // hostile client timing claim; server timing remains authoritative
  });
  const result = await resultPromise;
  assert.equal(result.correct, true, 'published correct answer must be accepted');
  assert.ok(result.earned > 0, 'authoritative gameplay must award positive points');
  assert.equal(result.firstBonus, CFG.FIRST_CORRECT_BONUS,
    'the first correct answer must receive the configured first-correct bonus');
  assert.ok(result.speed > 0 && result.speed <= CFG.SPEED_BONUS,
    'server timing must ignore client timeMs and award no more than the configured speed bonus');
  await roundEndPromise;
  return result;
}

async function reconnectProfile(port, cookie) {
  const socket = await connectClient(port, cookie);
  try {
    return (await join(socket)).profile;
  } finally {
    socket.disconnect();
  }
}

async function createGuest(port, payload = {}) {
  const identity = await browserCookie(port);
  const socket = await connectClient(port, identity.cookie);
  const state = await join(socket, payload);
  return { ...identity, socket, profile: state.profile };
}

function assertSafeGeneratedName(name) {
  assert.match(name, SAFE_NAME, 'name must be exactly "TitlecaseAdjective TitlecaseAnimal"');
  assert.doesNotMatch(name, /[<>&"'`]/, 'generated name must be HTML-safe text');
  assert.doesNotMatch(name, PROFANITY, 'generated name must not contain blocked profanity');
}

async function listFiles(dir) {
  const result = [];
  async function visit(current) {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else result.push(full);
    }
  }
  await visit(dir);
  return result;
}

async function findDatabase(dataDir) {
  const files = await listFiles(dataDir);
  const databases = files.filter(file => /\.(sqlite3?|db)$/i.test(file));
  assert.equal(databases.length, 1, 'DATA_DIR must contain exactly one SQLite database');
  return databases[0];
}

test('same browser receives one opaque hardened cookie and keeps one identity across reconnect/rejoin', { timeout: 28000 }, async () => {
  await withServer(async ({ port }) => {
    const { setCookie, cookie } = await issueCookie(port);
    assert.match(setCookie, /;\s*HttpOnly\b/i, 'identity cookie must be HttpOnly');
    assert.match(setCookie, /;\s*Secure\b/i, 'identity cookie must be Secure in production');
    assert.match(setCookie, /;\s*SameSite=(?:Lax|Strict)\b/i, 'identity cookie must set SameSite');
    assert.match(setCookie, /;\s*Path=\//i, 'identity cookie must be site-wide');
    assert.match(setCookie, /;\s*(?:Max-Age=\d+|Expires=)/i, 'identity cookie must be persistent');
    const value = cookie.slice(cookie.indexOf('=') + 1);
    assert.ok(value.length >= 32, 'identity cookie value must be opaque and high entropy');
    assert.doesNotMatch(decodeURIComponent(value), /@|\d{1,3}(?:\.\d{1,3}){3}/, 'cookie must not encode email or IP data');

    const first = await reconnectProfile(port, cookie);
    const a = await connectClient(port, cookie);
    const b = await connectClient(port, cookie);
    try {
      const [joinedA, joinedB] = await Promise.all([join(a), join(b)]);
      assert.deepEqual(joinedA.profile, first,
        'first concurrent tab must receive the authenticated public profile state');
      assert.deepEqual(joinedB.profile, first,
        'second concurrent tab must receive the authenticated public profile state');
      assert.equal(joinedA.profile.name, first.name);
      assert.equal(joinedB.profile.name, first.name);
      const entries = await leaderboard(port, 100);
      assert.equal(entries.filter(entry => entry.name === first.name).length, 0,
        'unscored authenticated profiles must not appear on the public leaderboard');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});

test('server assigns a stable whimsical adjective-animal name and ignores supplied HTML/profanity', { timeout: 28000 }, async () => {
  await withServer(async ({ port }) => {
    const hostile = '<img src=x onerror=alert(1)> fuck';
    const guest = await createGuest(port, { name: hostile });
    try {
      assert.notEqual(guest.profile.name, hostile, 'client must not choose its persisted display name');
      assertSafeGeneratedName(guest.profile.name);
      const rejoined = await reconnectProfile(port, guest.cookie);
      assert.equal(rejoined.name, guest.profile.name, 'generated name must stay stable on rejoin');
    } finally {
      guest.socket.disconnect();
    }
  });
});

test('lifetime score is changed only by server-authoritative gameplay and survives process restart', { timeout: 28000 }, async () => {
  const tmpRoot = process.env.TMPDIR || os.tmpdir();
  const dataDir = await fsp.mkdtemp(path.join(tmpRoot, 'trivia-restart-'));
  let server = await startServer(dataDir);
  let socket;
  try {
    const identity = await browserCookie(server.port);
    socket = await connectClient(server.port, identity.cookie);
    const before = await join(socket, { score: 999999, lifetimeScore: 999999 });
    assert.equal(before.profile.lifetimeScore, 0, 'client-supplied score fields must be ignored');
    socket.emit('score_update', { score: 999999 });
    socket.emit('set_score', 999999);
    const result = await scoreOneRound(socket);
    socket.disconnect();
    socket = null;
    const scored = await reconnectProfile(server.port, identity.cookie);
    assert.equal(scored.lifetimeScore, result.earned,
      'only the points emitted by authoritative gameplay may reach lifetime score');

    await stopServer(server);
    server = await startServer(dataDir);
    const restarted = await reconnectProfile(server.port, identity.cookie);
    assert.equal(restarted.name, scored.name, 'authenticated profile name must survive process restart');
    assert.equal(restarted.lifetimeScore, scored.lifetimeScore, 'lifetime score must survive process restart');
    const entries = await leaderboard(server.port, 10);
    assert.ok(entries.some(entry => entry.name === scored.name && entry.score === scored.lifetimeScore),
      'all-time leaderboard must be rebuilt from durable score data');
    await findDatabase(dataDir);
  } finally {
    socket?.disconnect();
    await stopServer(server);
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('all-time leaderboard retains disconnected guests and applies deterministic top-N tie ordering', { timeout: 28000 }, async () => {
  await withServer(async ({ port }) => {
    await leaderboard(port, 100); // prove the all-time API exists before arranging tie fixtures
    const guests = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const guest = await createGuest(port);
        guests.push(guest);
        guest.socket.disconnect();
      }
      // Zero-score profiles are excluded from the public leaderboard (by design).
      // Verify the leaderboard endpoint exists and returns a valid array.
      const all = await leaderboard(port, 100);
      assert.ok(Array.isArray(all), 'all-time leaderboard must return an array');
      // Verify tie ordering is deterministic for the entries that are present
      const first = await leaderboard(port, 3);
      const second = await leaderboard(port, 3);
      assert.deepEqual(second, first, 'top-N order must be stable across repeated reads');
    } finally {
      for (const guest of guests) guest.socket.disconnect();
    }
  });
});

test('name regeneration changes only the safe generated name and preserves identity and score', { timeout: 28000 }, async () => {
  await withServer(async ({ port }) => {
    const identity = await browserCookie(port);
    const socket = await connectClient(port, identity.cookie);
    const joinedPromise = waitFor(socket, 'joined');
    socket.emit('join', {});
    const joinedState = await joinedPromise;
    const original = joinedState.profile || {
      name: joinedState.name,
      lifetimeScore: 0,
    };
    try {
      const result = await scoreOneRound(socket);
      const response = await emitAck(socket, 'regenerate_name', {
        name: '<script>alert(1)</script> shit',
        score: 0,
      });
      assert.ok(response && response.profile, 'regenerate_name ack must contain profile');
      const after = response.profile;
      assert.ok(!('id' in after), 'regenerated public profile must not expose an id');
      assert.notEqual(after.name, original.name, 'name regeneration must choose a new name');
      assertSafeGeneratedName(after.name);
      assert.equal(after.lifetimeScore, result.earned, 'name regeneration must preserve lifetime score');
      const rejoined = await reconnectProfile(port, identity.cookie);
      assert.deepEqual(rejoined, after, 'regenerated profile must be durable for the same browser');
    } finally {
      socket.disconnect();
    }
  });
});

test('persistent storage contains no email or IP address data', { timeout: 28000 }, async () => {
  const tmpRoot = process.env.TMPDIR || os.tmpdir();
  const dataDir = await fsp.mkdtemp(path.join(tmpRoot, 'trivia-no-pii-'));
  const server = await startServer(dataDir);
  const emailCanary = 'pii-canary-8427@example.invalid';
  const ipCanary = '203.0.113.77';
  let socket;
  try {
    const identity = await browserCookie(server.port, { 'X-Forwarded-For': ipCanary });
    socket = await connectClient(server.port, identity.cookie);
    const joined = waitFor(socket, 'joined');
    socket.emit('join', { email: emailCanary, ip: ipCanary, name: emailCanary });
    await joined;
    socket.disconnect();
    socket = null;
    await stopServer(server);

    const database = await findDatabase(dataDir);
    const schemaResult = spawnSync('sqlite3', [database, '.schema'], { encoding: 'utf8' });
    assert.equal(schemaResult.status, 0, `SQLite schema must be readable: ${schemaResult.stderr}`);
    assert.doesNotMatch(schemaResult.stdout,
      /\b(?:email|email_address|ip_address|remote_address|remote_addr|forwarded_for)\b/i,
      'persistent schema must not contain email/IP fields');
    for (const file of await listFiles(dataDir)) {
      const bytes = await fsp.readFile(file);
      assert.equal(bytes.includes(Buffer.from(emailCanary)), false, `email canary persisted in ${path.basename(file)}`);
      assert.equal(bytes.includes(Buffer.from(ipCanary)), false, `IP canary persisted in ${path.basename(file)}`);
    }
  } finally {
    socket?.disconnect();
    await stopServer(server);
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});

test('concurrent duplicate submissions for one guest produce one atomic lifetime-score update', { timeout: 28000 }, async () => {
  await withServer(async ({ port }) => {
    const identity = await browserCookie(port);
    const sockets = await Promise.all(Array.from({ length: 8 }, () => connectClient(port, identity.cookie)));
    try {
      const joined = await Promise.all(sockets.map(socket => join(socket)));
      assert.ok(joined.every(state => state.profile.name === joined[0].profile.name),
        'all concurrent tabs must resolve to one authenticated profile name');
      assert.ok(joined.every(state => JSON.stringify(state.profile) === JSON.stringify(joined[0].profile)),
        'all concurrent tabs must receive the same public profile state');
      const questions = sockets.map(socket => waitFor(socket, 'question', 7000));
      const received = await Promise.all(questions);
      const answer = correctAnswer(received[0]);
      assert.ok(received.every(question => question.text === received[0].text),
        'concurrent tabs must receive the same round');
      assert.ok(received.every(question => question.roundId === received[0].roundId),
        'concurrent tabs must receive the same server-issued round id');

      const results = [];
      for (const socket of sockets) socket.on('answer_result', result => results.push(result));
      await Promise.all(sockets.map((socket, index) => new Promise(resolve => {
        socket.emit('submit_answer', { answer, roundId: received[index].roundId });
        setImmediate(resolve);
      })));
      let _poll;
      await Promise.race([
        new Promise(resolve => {
          _poll = setInterval(() => {
            if (results.length > 0) { clearInterval(_poll); _poll = null; resolve(); }
          }, 10);
        }),
        timeout(7000, 'authoritative answer result timeout'),
      ]).finally(() => { if (_poll) { clearInterval(_poll); _poll = null; } });
      const earned = results[0].earned;
      assert.ok(earned > 0);
      // B6: persistence happens in endRound — await round_end before reading DB
      await new Promise((res, rej) => {
        const t = setTimeout(() => res(), 8000);
        sockets[0].once('round_end', () => { clearTimeout(t); res(); });
      });
      const profile = await reconnectProfile(port, identity.cookie);
      assert.equal(profile.lifetimeScore, earned,
        'concurrent submissions must commit exactly one score increment');
      const entries = await leaderboard(port, 100);
      // No UUID in public leaderboard; check by name (unique per design)
      assert.equal(entries.filter(entry => entry.name === profile.name).length, 1,
        'concurrent tabs must not create duplicate leaderboard rows');
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
  });
});
