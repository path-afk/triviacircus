'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const CATEGORY_MAP = {
  'brain-teasers': 'Brain Teasers',
  'for-kids': 'Kids',
  'religion-faith': 'Religion & Faith',
  'science-technology': 'Science & Technology',
  'video-games': 'Video Games',
  newest: 'General',
  rated: 'General',
};

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return decodeHtmlEntities(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapCategory(sourceCategory) {
  return CATEGORY_MAP[sourceCategory]
    || sourceCategory.split('-').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function canonicalText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function deterministicShuffle(choices, correctIndex, seed, recordId) {
  if (seed === undefined || seed === null) return { choices, correctIndex };
  const ranked = choices.map((choice, index) => ({
    choice,
    index,
    rank: crypto.createHash('sha256')
      .update(`${seed}\0${recordId}\0${index}\0${choice}`)
      .digest('hex'),
  })).sort((a, b) => a.rank.localeCompare(b.rank));
  return {
    choices: ranked.map(({ choice }) => choice),
    correctIndex: ranked.findIndex(({ index }) => index === correctIndex),
  };
}

function normalizeRecord(raw, options = {}) {
  const prompt = sanitizeText(raw.prompt);
  const answer = sanitizeText(raw.answer);
  const sourceChoices = raw.choices.map(sanitizeText);
  if (!prompt) return { ok: false, reason: 'missing-prompt' };
  if (!answer) return { ok: false, reason: 'missing-answer' };
  if (sourceChoices.length < 2 || sourceChoices.some((choice) => !choice)) {
    return { ok: false, reason: 'invalid-choices' };
  }
  const canonicalChoices = sourceChoices.map(canonicalText);
  if (new Set(canonicalChoices).size !== canonicalChoices.length) {
    return { ok: false, reason: 'duplicate-choices' };
  }
  const sourceCorrectIndex = canonicalChoices.indexOf(canonicalText(answer));
  if (sourceCorrectIndex < 0) return { ok: false, reason: 'answer-not-in-choices' };
  const id = `otqa:${raw.sourceCategory}:L${raw.sourceLine}`;
  const { choices, correctIndex } = deterministicShuffle(
    sourceChoices,
    sourceCorrectIndex,
    options.shuffleSeed,
    id,
  );

  return {
    ok: true,
    question: {
      id,
      prompt,
      choices,
      correctIndex,
      category: mapCategory(raw.sourceCategory),
      difficulty: 'medium',
      source: 'OpenTriviaQA',
      sourceUrl: `https://github.com/uberspot/OpenTriviaQA/blob/${options.revision || 'master'}/categories/${raw.sourceCategory}#L${raw.sourceLine}`,
      license: 'CC BY-SA 4.0',
      attribution: 'OpenTriviaQA contributors; normalized by Trivia Circus',
      modifiedAt: options.modifiedAt,
      qualityStatus: 'accepted',
    },
  };
}

function decodeSourceBuffer(buffer) {
  const windows1252 = new TextDecoder('windows-1252');
  let output = '';
  for (let index = 0; index < buffer.length;) {
    const byte = buffer[index];
    let length = 0;
    if (byte <= 0x7f) length = 1;
    else if (byte >= 0xc2 && byte <= 0xdf
      && index + 1 < buffer.length && buffer[index + 1] >= 0x80 && buffer[index + 1] <= 0xbf) length = 2;
    else if (byte >= 0xe0 && byte <= 0xef && index + 2 < buffer.length
      && buffer[index + 2] >= 0x80 && buffer[index + 2] <= 0xbf
      && ((byte === 0xe0 && buffer[index + 1] >= 0xa0 && buffer[index + 1] <= 0xbf)
        || (byte === 0xed && buffer[index + 1] >= 0x80 && buffer[index + 1] <= 0x9f)
        || ((byte >= 0xe1 && byte <= 0xec) || (byte >= 0xee && byte <= 0xef))
          && buffer[index + 1] >= 0x80 && buffer[index + 1] <= 0xbf)) length = 3;
    else if (byte >= 0xf0 && byte <= 0xf4 && index + 3 < buffer.length
      && buffer[index + 2] >= 0x80 && buffer[index + 2] <= 0xbf
      && buffer[index + 3] >= 0x80 && buffer[index + 3] <= 0xbf
      && ((byte === 0xf0 && buffer[index + 1] >= 0x90 && buffer[index + 1] <= 0xbf)
        || (byte === 0xf4 && buffer[index + 1] >= 0x80 && buffer[index + 1] <= 0x8f)
        || (byte >= 0xf1 && byte <= 0xf3)
          && buffer[index + 1] >= 0x80 && buffer[index + 1] <= 0xbf)) length = 4;

    if (length > 0) {
      output += buffer.subarray(index, index + length).toString('utf8');
      index += length;
    } else {
      output += windows1252.decode(buffer.subarray(index, index + 1));
      index += 1;
    }
  }
  return output;
}

function parseOpenTriviaText(text, sourceCategory) {
  const records = [];
  let current = null;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  function finish() {
    if (current) records.push(current);
    current = null;
  }

  lines.forEach((line, index) => {
    if (line.startsWith('#Q')) {
      finish();
      current = {
        prompt: line.slice(2).trim(),
        answer: null,
        choices: [],
        sourceCategory,
        sourceLine: index + 1,
      };
    } else if (current && line.startsWith('^')) {
      current.answer = line.slice(1).trim();
    } else if (current && /^[A-Z]\s/.test(line)) {
      current.choices.push(line.slice(2).trim());
    }
  });
  finish();
  return records;
}

async function importOpenTriviaDirectory(inputDirectory, options = {}) {
  const aggregateFiles = new Set(['newest', 'rated']);
  const entries = (await fs.readdir(inputDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .sort((a, b) => {
      const priorityDifference = Number(aggregateFiles.has(a.name)) - Number(aggregateFiles.has(b.name));
      return priorityDifference || a.name.localeCompare(b.name);
    });
  const questions = [];
  const rejections = [];
  const seenPrompts = new Set();
  let deduped = 0;

  for (const entry of entries) {
    const buffer = await fs.readFile(path.join(inputDirectory, entry.name));
    const records = parseOpenTriviaText(decodeSourceBuffer(buffer), entry.name);
    for (const raw of records) {
      const normalized = normalizeRecord(raw, options);
      if (!normalized.ok) {
        rejections.push({
          id: `otqa:${raw.sourceCategory}:L${raw.sourceLine}`,
          prompt: sanitizeText(raw.prompt),
          reason: normalized.reason,
        });
        continue;
      }
      const promptKey = canonicalText(normalized.question.prompt);
      if (seenPrompts.has(promptKey)) {
        deduped += 1;
        continue;
      }
      seenPrompts.add(promptKey);
      questions.push(normalized.question);
    }
  }

  const categories = {};
  for (const question of questions) {
    categories[question.category] = (categories[question.category] || 0) + 1;
  }
  const rejectionReasons = {};
  for (const rejection of rejections) {
    rejectionReasons[rejection.reason] = (rejectionReasons[rejection.reason] || 0) + 1;
  }

  return {
    questions,
    rejections,
    stats: {
      imported: questions.length,
      rejected: rejections.length,
      deduped,
      categories,
      rejectionReasons,
    },
  };
}

async function writeJsonAtomically(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeOfflineCache(cachePath, rejectionPath, result, metadata = {}) {
  const common = {
    schemaVersion: 1,
    generatedAt: metadata.generatedAt,
    source: 'OpenTriviaQA',
    sourceUrl: 'https://github.com/uberspot/OpenTriviaQA',
    sourceRevision: metadata.revision,
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    attribution: 'OpenTriviaQA contributors; normalized by Trivia Circus',
  };
  await writeJsonAtomically(cachePath, {
    ...common,
    stats: result.stats,
    questions: result.questions,
  });
  await writeJsonAtomically(rejectionPath, {
    ...common,
    stats: {
      rejected: result.stats.rejected,
      deduped: result.stats.deduped,
      rejectionReasons: result.stats.rejectionReasons,
    },
    rejections: result.rejections,
  });
}

module.exports = {
  decodeSourceBuffer,
  importOpenTriviaDirectory,
  normalizeRecord,
  parseOpenTriviaText,
  sanitizeText,
  writeOfflineCache,
};
