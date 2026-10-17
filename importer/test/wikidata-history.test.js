'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateWorldHistoryPackage,
  deduplicateWorldHistoryQuestions,
} = require('../src/wikidata-history');

const HANDOFF = path.resolve(__dirname, '../../../../inbox/tc-trivia/world-history-20261017');
function read(name) { return JSON.parse(fs.readFileSync(path.join(HANDOFF, name), 'utf8')); }

test('300-question integration package has the licensed typed-answer schema', () => {
  const value = read('wikidata-world-history-integration-300.json');
  const audit = validateWorldHistoryPackage(value);
  assert.equal(audit.count, 300);
  assert.deepEqual(audit.categories, {
    'Wars & Military History': 167,
    'Dynasties & Royal Houses': 100,
    'Revolutions & Independence': 33,
  });
  for (const question of value.questions) {
    assert.equal(question.source, 'Wikidata');
    assert.equal(question.license, 'CC0 1.0');
    assert.equal(question.qualityStatus, 'screened-user-correctable');
    assert.match(question.sourceUrl, /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/);
  }
});

test('full package validates and deduplicates the integration subset to exactly 1,413', () => {
  const integration = read('wikidata-world-history-integration-300.json');
  const full = read('wikidata-world-history-full-1413.json');
  assert.equal(validateWorldHistoryPackage(full).count, 1413);
  const merged = deduplicateWorldHistoryQuestions(integration.questions, full.questions);
  assert.equal(merged.length, 1413);
  assert.equal(new Set(merged.map(question => question.id)).size, 1413);
});

test('deduplication does not mutate source questions or lose provenance fields', () => {
  const integration = read('wikidata-world-history-integration-300.json');
  const snapshot = JSON.stringify(integration);
  const merged = deduplicateWorldHistoryQuestions(integration.questions, integration.questions);
  assert.equal(merged.length, 300);
  assert.equal(JSON.stringify(integration), snapshot);
  assert.ok(merged.every(question => question.sourceRecordId && question.sourceRevision
    && question.transformation && question.licenseUrl && question.qualityStatus));
});
