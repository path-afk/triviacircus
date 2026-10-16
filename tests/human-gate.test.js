'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const {
  HUMAN_COOKIE, TURNSTILE_VERIFY_URL, getHumanGateConfig, createHumanToken,
  verifyHumanToken, cookieValueFromHeader, verifyTurnstile,
} = require('../lib/human-gate');

test('human gate is disabled when no credentials are configured', () => {
  assert.equal(getHumanGateConfig({}).enabled, false);
});

test('partial human-gate configuration fails closed', () => {
  assert.throws(() => getHumanGateConfig({ TURNSTILE_SITE_KEY: 'site-only' }), /configured together/);
});

test('signed human token validates before expiry and rejects tampering or expiry', () => {
  const now = Date.UTC(2026, 9, 16);
  const token = createHumanToken('strong-test-secret', now, 60_000);
  assert.equal(verifyHumanToken(token, 'strong-test-secret', now + 30_000), true);
  assert.equal(verifyHumanToken(token + 'x', 'strong-test-secret', now + 30_000), false);
  assert.equal(verifyHumanToken(token, 'strong-test-secret', now + 60_000), false);
});

test('human cookie is read from a Socket.IO Cookie header', () => {
  assert.equal(cookieValueFromHeader('other=1; ' + HUMAN_COOKIE + '=ticket%2Evalue; final=2'), 'ticket.value');
});

test('Turnstile verification validates endpoint, hostname, and action', async () => {
  const config = getHumanGateConfig({
    TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret', HUMAN_GATE_SECRET: 'signing',
    TURNSTILE_HOSTNAME: 'triviacircus.com',
  });
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return { success: true, hostname: 'triviacircus.com', action: 'trivia-join' }; } };
  };
  assert.equal(await verifyTurnstile({ response: 'browser-token', remoteip: '203.0.113.8', config, fetchImpl }), true);
  assert.equal(request.url, TURNSTILE_VERIFY_URL);
  assert.match(String(request.options.body), /response=browser-token/);

  const wrongHostFetch = async () => ({ ok: true, async json() { return { success: true, hostname: 'example.com', action: 'trivia-join' }; } });
  assert.equal(await verifyTurnstile({ response: 'browser-token', config, fetchImpl: wrongHostFetch }), false);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', err => err ? reject(err) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('enabled gate leaves the landing profile usable but blocks protected APIs and Socket.IO', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivia-human-gate-'));
  const signingSecret = 'integration-signing-secret-that-is-long-enough';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production',
      TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET_KEY: 'test-secret', HUMAN_GATE_SECRET: signingSecret,
      TURNSTILE_HOSTNAME: 'triviacircus.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 8000);
    child.once('exit', code => reject(new Error('server exited early: ' + code)));
    child.stdout.on('data', chunk => { if (String(chunk).includes('Trivia Circus server:')) { clearTimeout(timer); resolve(); } });
  });

  const base = 'http://127.0.0.1:' + port;
  const configResponse = await fetch(base + '/api/human/config');
  assert.deepEqual(await configResponse.json(), { enabled: true, siteKey: 'test-site', verified: false });
  assert.equal((await fetch(base + '/api/profile')).status, 200);
  const protectedResponse = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'player', password: 'not-a-real-password' }),
  });
  assert.equal(protectedResponse.status, 403);

  const blockedSocket = io(base, { transports: ['websocket'], reconnection: false, timeout: 3000 });
  const blockedError = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket was not rejected')), 5000);
    blockedSocket.once('connect_error', error => { clearTimeout(timer); resolve(error); });
  });
  blockedSocket.close();
  assert.equal(blockedError.data && blockedError.data.code, 'HUMAN_VERIFICATION_REQUIRED');

  const ticket = createHumanToken(signingSecret);
  const allowedProfile = await fetch(base + '/api/profile', { headers: { Cookie: HUMAN_COOKIE + '=' + encodeURIComponent(ticket) } });
  assert.equal(allowedProfile.status, 200);
  const allowedSocket = io(base, {
    transports: ['websocket'], reconnection: false, timeout: 3000,
    extraHeaders: { Cookie: HUMAN_COOKIE + '=' + encodeURIComponent(ticket) },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('verified socket did not connect')), 5000);
    allowedSocket.once('connect', () => { clearTimeout(timer); resolve(); });
    allowedSocket.once('connect_error', reject);
  });
  allowedSocket.close();
});
