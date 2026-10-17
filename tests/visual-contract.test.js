'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lobby = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const arena = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');

test('lobby preserves the approved blue-and-gold Trivia Circus visual identity', () => {
  assert.match(lobby, /<meta name="theme-color" content="#031945">/);
  assert.match(lobby, /--page:#031945/);
  assert.match(lobby, /--royal:#0a45b8/);
  assert.match(lobby, /--gold:#ffc928/);
  assert.ok(lobby.includes('radial-gradient(circle at 50% -15%'));
  assert.ok(lobby.includes('linear-gradient(145deg,#ffe56b,var(--gold))'));
  assert.doesNotMatch(lobby, /--page:#f7f4ee/);
});

test('lobby and arena remain on the same approved core palette', () => {
  for (const token of ['--page:#031945', '--royal:#0a45b8', '--gold:#ffc928']) {
    assert.ok(lobby.includes(token), `lobby missing ${token}`);
    assert.ok(arena.includes(token), `arena missing ${token}`);
  }
});
