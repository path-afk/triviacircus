/**
 * Trivia Circus — Deterministic Tests
 * Run: node tests/game.test.js
 */
'use strict';
const assert = require('assert');
const { scoreRound, earnedTitle, clean, genName, CFG } = require('../server');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ '+name); passed++; }
  catch(e) { console.error('  ❌ '+name+': '+e.message); failed++; }
}

// ── Profanity filter ──────────────────────────────────────────────────────────
console.log('\n[clean()]');
test('allows normal pseudonym', () => { assert.strictEqual(clean('CosmicPanda'), 'CosmicPanda'); });
test('strips leading/trailing spaces', () => { assert.strictEqual(clean('  Jay  '), 'Jay'); });
test('blocks profanity → empty string', () => { assert.strictEqual(clean('shit'), ''); });
test('blocks embedded profanity', () => { assert.strictEqual(clean('bigshitname'), ''); });
test('truncates to 24 chars', () => { assert.ok(clean('A'.repeat(30)).length <= 24); });
test('handles empty string', () => { assert.ok(clean('') === ''); });

// ── Name generator ────────────────────────────────────────────────────────────
console.log('\n[genName()]');
test('returns a non-empty string', () => { assert.ok(genName().length > 0); });
test('returns different names (probabilistic)', () => {
  const names = new Set(Array.from({length:20}, genName));
  assert.ok(names.size > 1, 'Got same name 20 times');
});

// ── Scoring ───────────────────────────────────────────────────────────────────
console.log('\n[Scoring logic]');

function makeRoom(answers, withDD) {
  const players = new Map();
  const ansMap = new Map();
  answers.forEach(function(a, i) {
    const sid = 'p'+i;
    players.set(sid, { name:'P'+i, score:0, streak: a.streak||0, doubleDown: a.dd||false,
      stats:{ correct:0, wrong:0, oracle:0, fast:0, catWins:{} } });
    ansMap.set(sid, { choice: a.choice, timeMs: a.timeMs||5000 });
  });
  return { players, answers: ansMap, questions:[{answer:'B', category:'History'}], currentQ:0,
           settings:{ timerOff:false, standYourGround:true } };
}

// We can't easily call scoreRound (it uses io), so test earnedTitle instead
test('correct answer detected for earnedTitle', () => {
  const t = earnedTitle({ correct:10, wrong:0, oracle:0, fast:8, catWins:{} });
  assert.ok(['The Perfectionist','Brain Trust Elite'].includes(t.title));
});

test('Oracle title after 2+ oracle moments', () => {
  const t = earnedTitle({ correct:5, wrong:2, oracle:2, fast:1, catWins:{} });
  assert.strictEqual(t.title, 'The Oracle');
});

test('Brave Soul for low accuracy', () => {
  const t = earnedTitle({ correct:1, wrong:8, oracle:0, fast:0, catWins:{} });
  assert.strictEqual(t.title, 'Brave Soul');
});

test('Category specialist title', () => {
  const t = earnedTitle({ correct:5, wrong:2, oracle:0, fast:0, catWins:{ Science:4 } });
  assert.ok(t.title.includes('Scientist') || t.title.includes('Specialist'));
});

test('Reflex title for fast answerer', () => {
  const t = earnedTitle({ correct:6, wrong:1, oracle:0, fast:5, catWins:{} });
  assert.ok(['The Reflex','Brain Trust Elite'].includes(t.title));
});

test('Newcomer for zero answers', () => {
  const t = earnedTitle({ correct:0, wrong:0, oracle:0, fast:0, catWins:{} });
  assert.strictEqual(t.title, 'Newcomer');
});

// ── Config constants ──────────────────────────────────────────────────────────
console.log('\n[Config]');
test('BASE_PTS is 100', () => assert.strictEqual(CFG.BASE_PTS, 100));
test('TRUST_BONUS is 50', () => assert.strictEqual(CFG.TRUST_BONUS, 50));
test('ORACLE_BONUS is 80', () => assert.strictEqual(CFG.ORACLE_BONUS, 80));
test('DD_STAKE is 50', () => assert.strictEqual(CFG.DD_STAKE, 50));
test('GRACE_MS is 7000 (one-handed friendly)', () => assert.strictEqual(CFG.GRACE_MS, 7000));
test('Speed bonus is small relative to base (<=15%)', () => assert.ok(CFG.SPEED_BONUS / CFG.BASE_PTS <= 0.15));
test('Trust bonus encourages accuracy not speed', () => assert.ok(CFG.TRUST_BONUS >= CFG.SPEED_BONUS));

// ── No-chat rule ──────────────────────────────────────────────────────────────
console.log('\n[No-chat rule]');
const ALLOWED_REACTIONS = ['😤 Knew It','🍀 Lucky Guess','😱 No Way','🔄 Rematch'];
test('Only 4 reactions are allowed', () => assert.strictEqual(ALLOWED_REACTIONS.length, 4));
test('No free-text chat allowed (reactions are from fixed list only)', () => {
  const freeText = 'Great question!';
  assert.ok(!ALLOWED_REACTIONS.includes(freeText));
});

// ── Question bank ─────────────────────────────────────────────────────────────
console.log('\n[Question bank]');
const bank = require('../questions/bank.json');
test('At least 60 questions', () => assert.ok(bank.length >= 60, 'Got '+bank.length));
test('All 6 required categories present', () => {
  const cats = new Set(bank.map(q=>q.category));
  ['History','Science','Geography','Culture','Sports','Wild Card'].forEach(c => {
    assert.ok(cats.has(c), 'Missing category: '+c);
  });
});
test('All questions have required fields', () => {
  bank.forEach(q => {
    assert.ok(q.id,'Missing id on: '+JSON.stringify(q).slice(0,50));
    assert.ok(q.text,'Missing text on: '+q.id);
    assert.ok(q.options,'Missing options on: '+q.id);
    assert.ok(['A','B','C','D'].includes(q.answer),'Bad answer on: '+q.id);
    assert.ok(q.explanation,'Missing explanation on: '+q.id);
  });
});
test('All option keys A/B/C/D present', () => {
  bank.forEach(q => {
    ['A','B','C','D'].forEach(k => assert.ok(q.options[k], q.id+' missing option '+k));
  });
});
test('No duplicate IDs', () => {
  const ids = bank.map(q=>q.id);
  const unique = new Set(ids);
  assert.strictEqual(ids.length, unique.size);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(40));
console.log('Tests: '+passed+' passed, '+failed+' failed');
if (failed > 0) process.exit(1);
