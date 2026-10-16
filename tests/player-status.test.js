'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PLAYER_STATUSES, validatePlayerStatus } = require('../lib/player-status');

const EXPECTED_STATUSES = [
  '🎯 Ready',
  '🔥 On Fire',
  '🤔 Thinking',
  '😎 Confident',
  '🍀 Feeling Lucky',
  '🎪 Here to Play',
];

test('exports only the exact player status presets in display order', () => {
  assert.deepEqual(PLAYER_STATUSES, EXPECTED_STATUSES);
  assert.ok(Object.isFrozen(PLAYER_STATUSES));
});

test('accepts every exact preset and returns a minimal validated payload', () => {
  for (const status of EXPECTED_STATUSES) {
    assert.deepEqual(validatePlayerStatus({ status }), { status });
    assert.deepEqual(validatePlayerStatus({ status, ignored: 'extra input' }), { status });
  }
});

test('rejects free text and near-matches', () => {
  for (const status of [
    'Ready',
    '🎯 ready',
    ' 🎯 Ready',
    '🎯 Ready ',
    '🎯  Ready',
    '🎯 Ready!',
    '🎯️ Ready',
    '🔥 Custom status',
  ]) {
    assert.equal(validatePlayerStatus({ status }), null);
  }
  assert.equal(validatePlayerStatus('🎯 Ready'), null);
});

test('rejects wrong payload and status types', () => {
  for (const payload of [
    undefined,
    null,
    true,
    1,
    Symbol('status'),
    [],
    new Date(),
    {},
    { status: null },
    { status: 1 },
    { status: true },
    { status: ['🎯 Ready'] },
    { status: { value: '🎯 Ready' } },
  ]) {
    assert.equal(validatePlayerStatus(payload), null);
  }
});

test('rejects extra-long and malformed status values', () => {
  assert.equal(validatePlayerStatus({ status: '🎯 ' + 'x'.repeat(10_000) }), null);
  assert.equal(validatePlayerStatus({ status: '🎯\u0000Ready' }), null);
  assert.equal(validatePlayerStatus({ status: '🎯 Ready\u200B' }), null);
  assert.equal(validatePlayerStatus({ status: '\uD83C Ready' }), null);
});

test('requires an own data property and does not execute accessors', () => {
  assert.equal(validatePlayerStatus(Object.create({ status: '🎯 Ready' })), null);

  let getterCalled = false;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'status', {
    enumerable: true,
    get() {
      getterCalled = true;
      return '🎯 Ready';
    },
  });

  assert.equal(validatePlayerStatus(accessorPayload), null);
  assert.equal(getterCalled, false);
});
