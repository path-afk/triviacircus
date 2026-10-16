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

test('switching in Stand Your Ground requires an explicit alternate answer', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html?room=CIRCUS-1234&name=Host'
  });
  const emitted = [];
  const scheduled = [];
  dom.window.setTimeout = (fn, ms) => { scheduled.push(ms); };
  dom.window.io = () => ({ emit(event, payload) { emitted.push({ event, payload }); }, on() {} });
  dom.window.eval(inlineScripts.join('\n'));
  dom.window.myChoice = 'B';

  dom.window.chooseStand('switch');

  assert.equal(emitted.some(item => item.event === 'stand_ground'), false);
  const buttons = [...dom.window.document.querySelectorAll('#syg-panel button')];
  const choices = buttons.map(button => button.dataset.choice);
  assert.deepEqual(choices, ['A', 'C', 'D']);
  buttons[0].click();
  assert.equal(emitted.find(item => item.event === 'stand_ground').payload.choice, 'A');
  assert.equal(dom.window.myChoice, 'A');
  assert.deepEqual(scheduled, []);
  dom.window.close();
});

test('final reveal does not reopen Stand Your Ground', () => {
  const dom = new JSDOM(gameHtml, {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1/game.html?room=CIRCUS-1234&name=Host'
  });
  const handlers = {};
  dom.window.io = () => ({ emit() {}, on(event, fn) { handlers[event] = fn; } });
  dom.window.eval(inlineScripts.join('\n'));
  const options = { A: 'A', B: 'B', C: 'C', D: 'D' };
  handlers.question({ index: 0, total: 1, category: 'Science', text: 'Q', options, timerOff: true });
  handlers.stand_your_ground({ tally: { A: 1, B: 1, C: 0, D: 0 } });
  handlers.reveal({ answer: 'A', pct: { A: 50, B: 50, C: 0, D: 0 }, divided: true, correctCount: 1 });

  assert.notEqual(dom.window.document.getElementById('reveal').style.display, 'none');
  assert.equal(dom.window.document.getElementById('syg').style.display, 'none');
  dom.window.close();
});
