'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateWorldHistoryPackage,
  deduplicateWorldHistoryQuestions,
} = require('../src/wikidata-history');

const FULL = require('../cache/wikidata-world-history.json');
const EXPECTED_CATEGORIES = {
  'Wars & Military History': 1149,
  'Dynasties & Royal Houses': 231,
  'Revolutions & Independence': 33,
};

function integrationSubset() {
  const take = {
    'Wars & Military History': 167,
    'Dynasties & Royal Houses': 100,
    'Revolutions & Independence': 33,
  };
  return {
    questions: FULL.questions.filter(question => {
      if (!take[question.category]) return false;
      take[question.category] -= 1;
      return true;
    }),
  };
}

test('committed full package has the exact licensed typed-answer schema', () => {
  const audit = validateWorldHistoryPackage(FULL);
  assert.equal(audit.count, 1413);
  assert.deepEqual(audit.categories, EXPECTED_CATEGORIES);
  for (const question of FULL.questions) {
    assert.equal(question.source, 'Wikidata');
    assert.equal(question.license, 'CC0 1.0');
    assert.equal(question.qualityStatus, 'screened-user-correctable');
    assert.match(question.sourceUrl, new RegExp('^https://www[.]wikidata[.]org/wiki/Q[0-9]+$'));
    assert.ok(question.sourceRecordId && question.sourceRevision
      && question.transformation && question.licenseUrl);
  }
});

test('deterministic 300-question subset validates and deduplicates into the full package', () => {
  const integration = integrationSubset();
  const audit = validateWorldHistoryPackage(integration);
  assert.equal(audit.count, 300);
  assert.deepEqual(audit.categories, {
    'Wars & Military History': 167,
    'Dynasties & Royal Houses': 100,
    'Revolutions & Independence': 33,
  });
  const merged = deduplicateWorldHistoryQuestions(integration.questions, FULL.questions);
  assert.equal(merged.length, 1413);
  assert.equal(new Set(merged.map(question => question.id)).size, 1413);
  assert.equal(new Set(merged.map(question => question.prompt.normalize('NFKC').toLowerCase().trim())).size, 1413);
});

test('validation rejects duplicates and deduplication is non-mutating', () => {
  const integration = integrationSubset();
  const duplicateId = {
    questions: [...integration.questions, {
      ...integration.questions[0],
      prompt: integration.questions[0].prompt + ' duplicate id',
    }],
  };
  const duplicatePrompt = {
    questions: [...integration.questions, {
      ...integration.questions[0],
      id: integration.questions[0].id + ':duplicate-prompt',
    }],
  };
  assert.throws(() => validateWorldHistoryPackage(duplicateId), /duplicate id/);
  assert.throws(() => validateWorldHistoryPackage(duplicatePrompt), /duplicate prompt/);

  const snapshot = JSON.stringify(integration);
  const merged = deduplicateWorldHistoryQuestions(integration.questions, integration.questions);
  assert.equal(merged.length, 300);
  assert.equal(JSON.stringify(integration), snapshot);
  assert.ok(merged.every(question => question.sourceRecordId && question.sourceRevision
    && question.transformation && question.licenseUrl && question.qualityStatus));
});
