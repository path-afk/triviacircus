'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const gameHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'game.html'), 'utf8');
const inlineScripts = [...gameHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(Boolean);

test('game page inline JavaScript parses', () => {
  assert.ok(inlineScripts.length > 0);
  for (const source of inlineScripts) new vm.Script(source);
});

test('header uses circus branding without announcing question numbers', () => {
  const dom = new JSDOM(gameHtml);
  assert.equal(dom.window.document.querySelector('.brand-mark').textContent.trim(), '🎪');
  assert.equal(dom.window.document.querySelector('#qctr'), null);
  assert.match(gameHtml, /autoConnect:false/);
  assert.equal(dom.window.document.querySelector('#leaderboardBtn').getAttribute('aria-label'), 'Open all-time leaderboard');
  assert.equal(dom.window.document.querySelector('#accountBtn').getAttribute('aria-label'), 'Open account');
  assert.equal(dom.window.document.querySelector('#answerinput').getAttribute('enterkeyhint'), 'send');
  assert.equal(dom.window.document.querySelector('#answerinput').getAttribute('aria-describedby'), 'answer-hint');
  assert.equal(dom.window.document.querySelector('.human-card').getAttribute('tabindex'), '-1');
  dom.window.close();
});

test('player pseudonyms cannot inject DOM attributes or elements', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html?room=CIRCUS-1234&name=Host'
  });
  dom.window.io = () => ({ emit() {}, on() {} });
  dom.window.eval(inlineScripts.join('\n'));

  const attack = '\" onmouseover=\"window.pwned=1';
  dom.window.updateP([{ name: attack, score: 0, streak: 0 }], 'Host');

  assert.equal(dom.window.document.querySelector('[onmouseover]'), null);
  assert.equal(dom.window.document.querySelector('#plist').textContent.includes(attack), true);
  dom.window.close();
});

test('typed answer is locked and submitted without multiple-choice controls', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html?room=CIRCUS-1234&name=Host'
  });
  const emitted = [];
  dom.window.setTimeout = () => 0;
  dom.window.io = () => ({ emit(event, payload) { emitted.push({ event, payload }); }, on() {} });
  dom.window.eval(inlineScripts.join('\n'));
  dom.window.loadQ({ category: 'Geography', text: 'Capital of France?' }, 22000);
  dom.window.document.getElementById('answerinput').value = 'Paris';
  dom.window.submitAnswer({ preventDefault() {} });

  const submitted = emitted.find(item => item.event === 'submit_answer');
  assert.equal(submitted.payload.answer, 'Paris');
  assert.equal(dom.window.document.querySelectorAll('.opt').length, 0);
  assert.equal(dom.window.document.getElementById('answerinput').disabled, true);
  dom.window.close();
});

test('question event makes the question panel visibly render', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html'
  });
  const handlers = {};
  dom.window.io = () => ({ emit() {}, on(event, fn) { handlers[event] = fn; } });
  dom.window.eval(inlineScripts.join('\n'));

  handlers.question({
    index: 0,
    category: 'Science',
    text: 'Visible question?',
    timerOff: true
  });

  assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById('question')).display, 'none');
  dom.window.close();
});

test('reveal shows canonical typed answer and room result', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html?room=CIRCUS-1234&name=Host'
  });
  const handlers = {};
  dom.window.io = () => ({ emit() {}, on(event, fn) { handlers[event] = fn; } });
  dom.window.eval(inlineScripts.join('\n'));
  handlers.question({ index: 0, total: 1, category: 'Science', text: 'Q', timerOff: true });
  handlers.reveal({ answer: 'Paris', correctCount: 1, totalAnswered: 2 });

  assert.notEqual(dom.window.document.getElementById('reveal').style.display, 'none');
  assert.match(dom.window.document.getElementById('verdict').textContent, /Paris/);
  assert.match(dom.window.document.getElementById('bars').textContent, /1 of 2/);
  dom.window.close();
});
