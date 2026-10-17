'use strict';

function normalizeAnswer(answer) {
  return String(answer || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

function acceptedAnswersForQuestion(question) {
  const explicit = Array.isArray(question && question.acceptedAnswers)
    ? question.acceptedAnswers.filter(answer => normalizeAnswer(answer))
    : [];
  if (explicit.length > 0) return explicit.slice();
  const canonical = question && (question.correctAnswer
    || (question.options && question.options[question.answer]));
  return canonical === undefined || canonical === null || canonical === '' ? [] : [canonical];
}

function answerMatchesQuestion(question, answer) {
  const normalized = normalizeAnswer(answer);
  return normalized.length > 0 && acceptedAnswersForQuestion(question)
    .some(candidate => normalizeAnswer(candidate) === normalized);
}

function revealAnswer(question) {
  return acceptedAnswersForQuestion(question)[0] || '';
}

module.exports = { normalizeAnswer, acceptedAnswersForQuestion, answerMatchesQuestion, revealAnswer };
