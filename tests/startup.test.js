'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('production entrypoint starts and serves the licensed cache', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '3107' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (output.includes('Trivia Circus server: http://127.0.0.1:3107')) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
      child.once('exit', code => {
        clearInterval(timer);
        reject(new Error(`server exited with code ${code}\n${output}`));
      });
    });
    assert.match(output, /Questions loaded from cache: 50575/);
  } finally {
    child.kill('SIGTERM');
  }
});
