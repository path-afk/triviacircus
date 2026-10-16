const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  decodeSourceBuffer,
  importOpenTriviaDirectory,
  normalizeRecord,
  parseOpenTriviaText,
  writeOfflineCache,
} = require('../src/importer');

const SAMPLE = '#Q Capital of France?\n^ Paris\nA London\nB Paris\nC Rome\n';

test('decodes mixed UTF-8 and Windows-1252 source bytes without replacement characters', () => {
  const source = Buffer.concat([
    Buffer.from('Caf'),
    Buffer.from([0xe9]),
    Buffer.from(' and “quoted”', 'utf8'),
  ]);
  assert.equal(decodeSourceBuffer(source), 'Café and “quoted”');
});

test('parses OpenTriviaQA blocks with source line metadata', () => {
  assert.deepEqual(parseOpenTriviaText(SAMPLE, 'geography'), [{
    prompt: 'Capital of France?',
    answer: 'Paris',
    choices: ['London', 'Paris', 'Rome'],
    sourceCategory: 'geography',
    sourceLine: 1,
  }]);
});

test('normalizes and sanitizes a record into the licensed schema', () => {
  const raw = parseOpenTriviaText(
    '#Q Who wrote <i>Hamlet</i>?<script>bad()</script>\n^ William &amp; Mary\nA Other\nB William &amp; Mary\n',
    'literature',
  )[0];
  const result = normalizeRecord(raw, {
    modifiedAt: '2026-01-02T03:04:05.000Z',
    revision: 'abc123',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.question, {
    id: 'otqa:literature:L1',
    prompt: 'Who wrote Hamlet?',
    choices: ['Other', 'William & Mary'],
    correctIndex: 1,
    category: 'Literature',
    difficulty: 'medium',
    source: 'OpenTriviaQA',
    sourceUrl: 'https://github.com/uberspot/OpenTriviaQA/blob/abc123/categories/literature#L1',
    license: 'CC BY-SA 4.0',
    attribution: 'OpenTriviaQA contributors; normalized by Trivia Circus',
    modifiedAt: '2026-01-02T03:04:05.000Z',
    qualityStatus: 'accepted',
  });
});

test('rejects missing, unmatched, and ambiguous answers', () => {
  const base = { prompt: 'Question?', sourceCategory: 'general', sourceLine: 9 };
  const cases = [
    [{ ...base, answer: null, choices: ['A', 'B'] }, 'missing-answer'],
    [{ ...base, answer: 'C', choices: ['A', 'B'] }, 'answer-not-in-choices'],
    [{ ...base, answer: 'Blue', choices: ['Blue', ' blue '] }, 'duplicate-choices'],
  ];

  for (const [raw, reason] of cases) {
    assert.deepEqual(normalizeRecord(raw, { modifiedAt: '2026-01-01T00:00:00.000Z' }), {
      ok: false,
      reason,
    });
  }
});

test('bulk import rejects malformed records, deduplicates prompts, and reports statistics', async () => {
  const result = await importOpenTriviaDirectory(path.join(__dirname, 'fixtures'), {
    modifiedAt: '2026-01-02T03:04:05.000Z',
    revision: 'abc123',
  });

  assert.equal(result.questions.length, 4);
  assert.deepEqual(result.stats, {
    imported: 4,
    rejected: 3,
    deduped: 2,
    categories: { 'Science & Technology': 4 },
    rejectionReasons: {
      'answer-not-in-choices': 1,
      'duplicate-choices': 1,
      'missing-answer': 1,
    },
  });
  assert.deepEqual(result.rejections.map(({ reason }) => reason).sort(), [
    'answer-not-in-choices',
    'duplicate-choices',
    'missing-answer',
  ]);
  assert.equal(result.questions[0].prompt, 'Which planet is known as the Red Planet & why?');
});

test('choice shuffle is seeded, deterministic, and preserves the correct answer', () => {
  const raw = parseOpenTriviaText(SAMPLE, 'geography')[0];
  const options = {
    modifiedAt: '2026-01-01T00:00:00.000Z',
    revision: 'abc123',
    shuffleSeed: 'circus',
  };
  const first = normalizeRecord(raw, options).question;
  const second = normalizeRecord(raw, options).question;

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.choices, raw.choices);
  assert.equal(first.choices[first.correctIndex], 'Paris');
  assert.deepEqual([...first.choices].sort(), [...raw.choices].sort());
});

test('writes a self-describing offline cache and rejection report', async () => {
  const directory = path.join(__dirname, '.tmp-cache');
  await fs.rm(directory, { force: true, recursive: true });
  const result = await importOpenTriviaDirectory(path.join(__dirname, 'fixtures'), {
    modifiedAt: '2026-01-02T03:04:05.000Z',
    revision: 'abc123',
  });
  const cachePath = path.join(directory, 'questions.json');
  const rejectionPath = path.join(directory, 'rejections.json');

  await writeOfflineCache(cachePath, rejectionPath, result, {
    generatedAt: '2026-01-02T03:04:05.000Z',
    revision: 'abc123',
  });

  const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
  const rejectionReport = JSON.parse(await fs.readFile(rejectionPath, 'utf8'));
  assert.equal(cache.schemaVersion, 1);
  assert.equal(cache.sourceRevision, 'abc123');
  assert.equal(cache.license, 'CC BY-SA 4.0');
  assert.equal(cache.questions.length, 4);
  assert.deepEqual(cache.stats, result.stats);
  assert.deepEqual(rejectionReport.rejections, result.rejections);
  await fs.rm(directory, { force: true, recursive: true });
});

test('CLI builds the offline cache and prints machine-readable statistics', async () => {
  const directory = path.join(__dirname, '.tmp-cli');
  await fs.rm(directory, { force: true, recursive: true });
  const cachePath = path.join(directory, 'questions.json');
  const rejectionPath = path.join(directory, 'rejections.json');
  const execution = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'src', 'cli.js'),
    '--input', path.join(__dirname, 'fixtures'),
    '--output', cachePath,
    '--rejections', rejectionPath,
    '--revision', 'abc123',
    '--modified-at', '2026-01-02T03:04:05.000Z',
  ], { encoding: 'utf8' });

  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout).imported, 4);
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).questions.length, 4);
  await fs.rm(directory, { force: true, recursive: true });
});
