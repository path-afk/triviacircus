'use strict';

const REQUIRED_QUESTION_FIELDS = [
  'id', 'prompt', 'acceptedAnswers', 'category', 'difficulty', 'source',
  'sourceRecordId', 'sourceUrl', 'license', 'licenseUrl', 'qualityStatus',
];

function canonicalText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ').trim();
}

function validateWorldHistoryPackage(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.questions)) {
    throw new TypeError('world-history package must contain a questions array');
  }
  const ids = new Set();
  const prompts = new Set();
  for (const question of value.questions) {
    for (const field of REQUIRED_QUESTION_FIELDS) {
      if (question[field] === undefined || question[field] === null || question[field] === '') {
        throw new Error('missing ' + field + ' on ' + (question.id || 'unknown question'));
      }
    }
    if (!Array.isArray(question.acceptedAnswers) || question.acceptedAnswers.length === 0
      || question.acceptedAnswers.some(answer => !canonicalText(answer))) {
      throw new Error('invalid acceptedAnswers on ' + question.id);
    }
    if (ids.has(question.id)) throw new Error('duplicate id: ' + question.id);
    const promptKey = canonicalText(question.prompt);
    if (prompts.has(promptKey)) throw new Error('duplicate prompt: ' + question.prompt);
    ids.add(question.id);
    prompts.add(promptKey);
  }
  return {
    count: value.questions.length,
    ids,
    prompts,
    categories: value.questions.reduce((counts, question) => {
      counts[question.category] = (counts[question.category] || 0) + 1;
      return counts;
    }, {}),
  };
}

function deduplicateWorldHistoryQuestions(primary, additional) {
  const result = [];
  const ids = new Set();
  const prompts = new Set();
  for (const question of [...primary, ...additional]) {
    const promptKey = canonicalText(question.prompt);
    if (ids.has(question.id) || prompts.has(promptKey)) continue;
    ids.add(question.id);
    prompts.add(promptKey);
    result.push(question);
  }
  return result;
}

module.exports = { canonicalText, validateWorldHistoryPackage, deduplicateWorldHistoryQuestions };
