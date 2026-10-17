'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { io: createClient } = require('socket.io-client');
const {
  acceptedAnswersForQuestion,
  answerMatchesQuestion,
  revealAnswer,
} = require('../lib/question-answer');

const CACHE = path.join(__dirname, '../importer/cache/wikidata-world-history.json');

test('committed world-history cache preserves exactly 1,413 audited questions', () => {
  const value = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  assert.equal(value.questions.length, 1413);
  assert.equal(new Set(value.questions.map(question => question.id)).size, 1413);
  assert.equal(new Set(value.questions.map(question => question.prompt.normalize('NFKC').toLowerCase().trim())).size, 1413);
  assert.ok(value.questions.every(question => question.source === 'Wikidata'
    && question.license === 'CC0 1.0'
    && question.qualityStatus === 'screened-user-correctable'
    && question.sourceRecordId && question.sourceUrl && question.transformation));
});

test('production loader adds the 1,413 records exactly once', () => {
  process.env.HUMAN_GATE_ENABLED = 'false';
  const server = require('../server');
  const questions = server.loadQuestions();
  const imported = questions.filter(question => question.source === 'Wikidata');
  assert.equal(imported.length, 1413);
  assert.equal(new Set(imported.map(question => question.id)).size, 1413);
  assert.ok(imported.every(question => question.acceptedAnswers.length > 0));
});

test('all accepted answer variants score and an incorrect answer fails', () => {
  const value = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const question = value.questions.find(item => item.acceptedAnswers.length > 1);
  assert.ok(question, 'expected a multiple-answer audited question');
  for (const answer of question.acceptedAnswers) assert.equal(answerMatchesQuestion(question, answer), true);
  assert.equal(answerMatchesQuestion(question, 'definitely incorrect'), false);
  assert.deepEqual(acceptedAnswersForQuestion(question), question.acceptedAnswers);
  assert.equal(revealAnswer(question), question.acceptedAnswers[0]);
});

test('production question event keeps every accepted answer server-side until reveal', { timeout: 12000 }, async () => {
  process.env.HUMAN_GATE_ENABLED = 'false';
  const server = require('../server');
  const value = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  const audited = value.questions.find(item => item.acceptedAnswers.length > 1);
  server.setQuestions([{
    ...audited,
    text: audited.prompt,
    correctAnswer: audited.acceptedAnswers[0],
  }]);
  await new Promise(resolve => server.httpServer.listen(0, '127.0.0.1', resolve));
  const port = server.httpServer.address().port;
  const cookie = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + port + '/', response => {
      response.resume();
      response.on('end', () => resolve(response.headers['set-cookie'][0].split(';')[0]));
    }).on('error', reject);
  });
  const client = createClient('http://127.0.0.1:' + port, {
    transports: ['websocket'], forceNew: true, extraHeaders: { Cookie: cookie },
  });
  try {
    await new Promise(resolve => client.once('connect', resolve));
    const questionPromise = new Promise(resolve => client.once('question', resolve));
    client.emit('join', {});
    const payload = await questionPromise;
    assert.equal(payload.text, audited.prompt);
    assert.equal('answer' in payload, false);
    assert.equal('correctAnswer' in payload, false);
    assert.equal('acceptedAnswers' in payload, false);
    assert.equal('options' in payload, false);

    const resultPromise = new Promise(resolve => client.once('answer_result', resolve));
    const revealPromise = new Promise(resolve => client.once('reveal', resolve));
    client.emit('submit_answer', { answer: audited.acceptedAnswers[1], roundId: payload.roundId });
    assert.equal((await resultPromise).correct, true);
    assert.equal((await revealPromise).answer, audited.acceptedAnswers[0]);
  } finally {
    client.disconnect();
    server.privateRooms.close();
    await new Promise(resolve => server.io.close(resolve));
  }
});
