/**
 * Trivia Circus — Unit Tests
 * Run: node tests/unit.test.js
 */
'use strict';
const assert = require('assert');
const { clean, genName, earnedTitle, normalizeAnswer, validateAnswer, calculateTimeBonus, CFG, ALLOWED_EMOJIS, VALID_CHOICES } = require('../server');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch(e) { console.error('  ❌ ' + name + ': ' + e.message); fail++; }
}

console.log('\n[clean() — profanity filter]');
test('allows normal name',         () => assert.strictEqual(clean('CosmicPanda'), 'CosmicPanda'));
test('trims whitespace',           () => assert.strictEqual(clean('  Jay  '), 'Jay'));
test('blocks profanity → empty',   () => assert.strictEqual(clean('fuck'), ''));
test('blocks embedded profanity',  () => assert.strictEqual(clean('bigshitname'), ''));
test('truncates to MAX_NAME_LEN',  () => assert.ok(clean('A'.repeat(30)).length <= CFG.MAX_NAME_LEN));
test('empty string → empty',       () => assert.strictEqual(clean(''), ''));
test('null → empty',               () => assert.strictEqual(clean(null), ''));
test('number → empty',             () => assert.strictEqual(clean(42), ''));

console.log('\n[genName()]');
test('returns non-empty string',          () => assert.ok(genName().length > 0));
test('returns different names (prob.)',    () => assert.ok(new Set(Array.from({length:20},genName)).size > 1));

console.log('\n[earnedTitle()]');
test('Oracle after 2+ oracle moments',    () => assert.strictEqual(earnedTitle({correct:5,wrong:2,oracle:2,fast:1,catWins:{}}).title,'The Oracle'));
test('Perfectionist 100% in 8+',          () => assert.strictEqual(earnedTitle({correct:10,wrong:0,oracle:0,fast:5,catWins:{}}).title,'The Perfectionist'));
test('Brave Soul for low accuracy',        () => assert.strictEqual(earnedTitle({correct:1,wrong:8,oracle:0,fast:0,catWins:{}}).title,'Brave Soul'));
test('Newcomer for zero answers',          () => assert.strictEqual(earnedTitle({correct:0,wrong:0,oracle:0,fast:0,catWins:{}}).title,'Newcomer'));
test('Category specialist (History 4)',    () => assert.ok(earnedTitle({correct:5,wrong:2,oracle:0,fast:0,catWins:{History:4}}).title.includes('Historian')));
test('Reflex for fast answerer',           () => {
  const t = earnedTitle({correct:6,wrong:1,oracle:0,fast:5,catWins:{}});
  assert.ok(['The Reflex','Brain Trust Elite','The Perfectionist'].includes(t.title));
});

console.log('\n[Config — accuracy-first scoring]');
test('QUESTION_MS = 45000',                  () => assert.strictEqual(CFG.QUESTION_MS, 45000));
test('BASE_PTS = 100',                    () => assert.strictEqual(CFG.BASE_PTS, 100));
test('TRUST_BONUS = 50',                  () => assert.strictEqual(CFG.TRUST_BONUS, 50));
test('ORACLE_BONUS = 80',                 () => assert.strictEqual(CFG.ORACLE_BONUS, 80));
test('DD_STAKE = 50',                     () => assert.strictEqual(CFG.DD_STAKE, 50));
test('GRACE_MS = 7000 (one-handed ok)',   () => assert.strictEqual(CFG.GRACE_MS, 7000));
test('FIRST_CORRECT_BONUS = 50',          () => assert.strictEqual(CFG.FIRST_CORRECT_BONUS, 50));
test('Speed bonus is progressive up to configured maximum', () => {
  assert.strictEqual(calculateTimeBonus(0), CFG.SPEED_BONUS);
  assert.ok(calculateTimeBonus(CFG.QUESTION_MS / 3) > calculateTimeBonus(2 * CFG.QUESTION_MS / 3));
  assert.strictEqual(calculateTimeBonus(CFG.QUESTION_MS), 0);
});

console.log('\n[No free-text chat]');
test('Exactly 4 allowed reactions',       () => assert.strictEqual(ALLOWED_EMOJIS.size, 4));
test('Free text not in allowed list',     () => assert.ok(!ALLOWED_EMOJIS.has('great job!')));
test('Correct emojis in list',            () => {
  assert.ok(ALLOWED_EMOJIS.has('Knew It'));
  assert.ok(ALLOWED_EMOJIS.has('Lucky Guess'));
  assert.ok(ALLOWED_EMOJIS.has('No Way'));
  assert.ok(ALLOWED_EMOJIS.has('Rematch'));
});

console.log('\n[Valid choices]');
test('Exactly 4 choices A-D',             () => assert.strictEqual(VALID_CHOICES.size, 4));
test('A/B/C/D all valid',                 () => ['A','B','C','D'].forEach(k => assert.ok(VALID_CHOICES.has(k))));
test('E not valid',                       () => assert.ok(!VALID_CHOICES.has('E')));
test('lowercase a not valid',             () => assert.ok(!VALID_CHOICES.has('a')));

console.log('\n[Typed answers]');
test('normalization ignores case and extra spaces', () => assert.strictEqual(normalizeAnswer('  THE   Beatles '), 'the beatles'));
test('normalization preserves misspellings', () => assert.notStrictEqual(normalizeAnswer('Beatels'), normalizeAnswer('Beatles')));
test('typed answer payload with round id is accepted', () => {
  assert.deepStrictEqual(
    validateAnswer({answer:' Paris ', roundId:'round-123', timeMs:1}),
    {answer:'Paris', roundId:'round-123'}
  );
});
test('client timeMs is ignored', () => {
  assert.deepStrictEqual(
    validateAnswer({answer:'Paris', roundId:'round-123', timeMs:CFG.QUESTION_MS}),
    validateAnswer({answer:'Paris', roundId:'round-123', timeMs:0})
  );
});
test('missing round id is rejected', () => assert.strictEqual(validateAnswer({answer:'Paris'}), null));
test('legacy choice payload is rejected', () => assert.strictEqual(validateAnswer({choice:'A'}), null));

console.log('\n[Question bank]');
const bank = require('../questions/bank.json');
test('At least 60 questions',             () => assert.ok(bank.length >= 60));
test('All 6 categories present',          () => {
  const cats = new Set(bank.map(q => q.category));
  ['History','Science','Geography','Culture','Sports','Wild Card'].forEach(c => assert.ok(cats.has(c), 'Missing: '+c));
});
test('All questions have required fields', () => {
  bank.forEach(q => {
    assert.ok(q.id, 'Missing id'); assert.ok(q.text, 'Missing text on '+q.id);
    assert.ok(q.options, 'Missing options on '+q.id); assert.ok(q.explanation, 'Missing explanation on '+q.id);
    assert.ok(['A','B','C','D'].includes(q.answer), 'Bad answer on '+q.id);
  });
});
test('All options A/B/C/D present',       () => {
  bank.forEach(q => ['A','B','C','D'].forEach(k => assert.ok(q.options[k], q.id+' missing '+k)));
});
test('No duplicate IDs',                  () => {
  const ids = bank.map(q => q.id);
  assert.strictEqual(ids.length, new Set(ids).size);
});

console.log('\n' + '─'.repeat(50));
console.log('Unit tests: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
