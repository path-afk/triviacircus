'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryBalancedShuffle } = require('../lib/question-order');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function questionsFor(counts) {
  const questions = [];
  for (const [category, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      questions.push(Object.freeze({ id: category + '-' + i, category }));
    }
  }
  return questions;
}

function longestCategoryRun(questions) {
  let longest = 0;
  let current = 0;
  let previous;
  for (const question of questions) {
    if (question.category === previous) current += 1;
    else current = 1;
    previous = question.category;
    longest = Math.max(longest, current);
  }
  return longest;
}

function optimalRunLimit(questions) {
  if (questions.length === 0) return 0;
  const counts = new Map();
  for (const question of questions) {
    counts.set(question.category, (counts.get(question.category) || 0) + 1);
  }
  let limit = 1;
  for (const count of counts.values()) {
    limit = Math.max(limit, Math.ceil(count / (questions.length - count + 1)));
  }
  return limit;
}

function assertSameReferences(input, output) {
  assert.equal(output.length, input.length);
  const positions = new Map(output.map((question, index) => [question, index]));
  assert.equal(positions.size, input.length, 'each unique object appears once');
  for (const question of input) assert.ok(positions.has(question));
}

test('returns a new array without mutating questions or their input order', () => {
  const input = questionsFor({ Science: 4, History: 3, Sports: 2 });
  const snapshot = input.slice();
  const output = categoryBalancedShuffle(input, seededRandom(17));

  assert.notStrictEqual(output, input);
  assert.deepEqual(input, snapshot);
  assertSameReferences(input, output);
});

test('large balanced sets never place the same category together', () => {
  const input = questionsFor({ A: 250, B: 250, C: 250, D: 250, E: 250, F: 250 });
  const output = categoryBalancedShuffle(input, seededRandom(123456));

  assertSameReferences(input, output);
  for (let i = 1; i < output.length; i += 1) {
    assert.notEqual(output[i].category, output[i - 1].category);
  }
});

test('heavily skewed sets attain the mathematically minimal longest streak', () => {
  const input = questionsFor({ Dominant: 101, Red: 5, Blue: 4, Green: 3, Gold: 2 });
  const output = categoryBalancedShuffle(input, seededRandom(90210));

  assertSameReferences(input, output);
  assert.equal(longestCategoryRun(output), optimalRunLimit(input));
});

test('small skewed sets distribute unavoidable repeats instead of leaving a long tail', () => {
  const input = questionsFor({ A: 5, B: 2 });
  const output = categoryBalancedShuffle(input, seededRandom(4));

  assert.equal(longestCategoryRun(output), 2);
  assert.equal(output.filter((question, index) =>
    index > 0 && question.category === output[index - 1].category).length, 2);
});

test('many category distributions achieve their optimal run limit', () => {
  let seed = 1;
  for (let a = 1; a <= 10; a += 1) {
    for (let b = 1; b <= 7; b += 1) {
      for (let c = 1; c <= 4; c += 1) {
        const input = questionsFor({ A: a, B: b, C: c });
        const output = categoryBalancedShuffle(input, seededRandom(seed++));
        assert.equal(longestCategoryRun(output), optimalRunLimit(input),
          'failed counts ' + [a, b, c].join(','));
      }
    }
  }
});

test('an injected RNG makes the complete order reproducible', () => {
  const input = questionsFor({ A: 12, B: 12, C: 12, D: 12 });
  const first = categoryBalancedShuffle(input, seededRandom(777)).map(q => q.id);
  const second = categoryBalancedShuffle(input, seededRandom(777)).map(q => q.id);
  const differentSeed = categoryBalancedShuffle(input, seededRandom(778)).map(q => q.id);

  assert.deepEqual(first, second);
  assert.notDeepEqual(first, differentSeed);
});

test('randomizes both category order and order within categories', () => {
  const input = questionsFor({ A: 10, B: 10, C: 10 });
  const first = categoryBalancedShuffle(input, seededRandom(10));
  const second = categoryBalancedShuffle(input, seededRandom(20));

  assert.notDeepEqual(first.map(q => q.category), second.map(q => q.category));
  assert.notDeepEqual(
    first.filter(q => q.category === 'A').map(q => q.id),
    second.filter(q => q.category === 'A').map(q => q.id));
});

test('handles empty, singleton, and single-category inputs', () => {
  assert.deepEqual(categoryBalancedShuffle([], seededRandom(1)), []);

  const singleton = questionsFor({ Solo: 1 });
  assert.deepEqual(categoryBalancedShuffle(singleton, seededRandom(1)), singleton);
  assert.notStrictEqual(categoryBalancedShuffle(singleton, seededRandom(1)), singleton);

  const oneCategory = questionsFor({ Solo: 40 });
  const output = categoryBalancedShuffle(oneCategory, seededRandom(44));
  assertSameReferences(oneCategory, output);
  assert.notDeepEqual(output.map(q => q.id), oneCategory.map(q => q.id));
});

test('rejects invalid inputs and invalid RNG output', () => {
  assert.throws(() => categoryBalancedShuffle(null), /questions must be an array/);
  assert.throws(() => categoryBalancedShuffle([], 1), /random must be a function/);
  assert.throws(() => categoryBalancedShuffle(questionsFor({ A: 2 }), () => 1),
    /random must return a number/);
});
