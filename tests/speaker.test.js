'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { makeDoc } = require('./domshim.js');

// Resolved against this file, not the shell's cwd, so the suite runs from anywhere.
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const document = makeDoc(html);
const store = new Map([['rtt_firebase_config', JSON.stringify({ databaseURL: 'https://x.firebaseio.com' })]]);

// --- fake SpeechRecognition: records every instance so the test can fire events ---
const recognizers = [];
class FakeRecognition {
  constructor() { this.started = 0; this.stopped = 0; recognizers.push(this); }
  start() { this.started++; }
  stop() { this.stopped++; }
}
// --- fake Firebase: just enough for the speaker route ---
const makeRef = () => ({
  once: () => Promise.resolve({ val: () => ({ isLive: true, speakerId: 'test-uuid' }) }),
  on() {}, off() {}, set() {}, update() {},
  push: () => makeRef(),
  child: () => makeRef(),
  limitToLast() { return this; },
  transaction: () => Promise.resolve({ committed: true }),
  onDisconnect: () => ({ update() {}, cancel() {} }),
});
const firebase = { initializeApp() {}, database: Object.assign(() => ({ ref: makeRef }), { ServerValue: { TIMESTAMP: 0 } }) };

const ctx = {
  document, console, setTimeout, clearTimeout, firebase,
  SpeechRecognition: FakeRecognition,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  URLSearchParams, Date, Math, JSON, Number, String, Set, Array, Object, Error, Promise,
  crypto: { randomUUID: () => 'test-uuid' },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  location: { search: '?room=abc123', hash: '', pathname: '/index.html', origin: 'https://e.test', reload() {} },
  history: { replaceState() {} },
  navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1', clipboard: null },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(appSrc, ctx, { filename: 'app.js' });

const g = (id) => document.getElementById(id);
const label = () => g('speaker-status-label').textContent;
const detail = () => g('speaker-status-detail').textContent;
const btn = () => g('btn-toggle-mic').textContent;
const bar = () => g('speaker-status-bar').className;
const stack = g('toast-stack');
const toastTexts = () => stack.children.map((t) => t.children[0].textContent);
let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' :: ' + x); } };

setTimeout(() => {
  console.log('1. speaker view starts recognition automatically');
  check('a recognizer was created and started', recognizers.length === 1 && recognizers[0].started === 1, `n=${recognizers.length}`);
  check('lang is the default bs-BA', recognizers[0].lang === 'bs-BA', recognizers[0].lang);
  check('status shows Starting', label() === 'Starting', label());
  check('button offers Pause', btn() === 'Pause', btn());

  console.log('\n2. audio actually flowing flips it to LIVE');
  recognizers[0].onaudiostart();
  check('label Live', label() === 'Live', label());
  check('bar is emerald', bar().includes('emerald'), bar());
  check('dot pulses', g('speaker-status-dot').className.includes('live-dot'));

  console.log('\n3. speech detected gives immediate mic feedback');
  recognizers[0].onspeechstart();
  check('detail says Hearing you', detail() === 'Hearing you…', detail());

  console.log('\n4. Pause stops the mic without ending the room');
  g('btn-toggle-mic').onclick();
  check('label Paused', label() === 'Paused', label());
  check('recognizer was stopped', recognizers[0].stopped >= 1);
  check('button now offers Resume', btn() === 'Resume', btn());
  check('bar is amber', bar().includes('amber'), bar());
  check('detail says room still open', detail().includes('room is still open'), detail());
  check('no new recognizer started while paused', recognizers.length === 1, `n=${recognizers.length}`);

  console.log('\n5. changing language while paused stays paused');
  g('speaker-lang-select').value = 'en-US';
  g('speaker-lang-select').onchange();
  check('still Paused', label() === 'Paused', label());
  check('still no new recognizer', recognizers.length === 1, `n=${recognizers.length}`);

  console.log('\n6. Resume restarts recognition with the language chosen while paused');
  g('btn-toggle-mic').onclick();
  check('new recognizer created', recognizers.length === 2, `n=${recognizers.length}`);
  check('uses en-US picked during pause', recognizers[1].lang === 'en-US', recognizers[1].lang);
  check('back to Starting', label() === 'Starting', label());

  console.log('\n7. unsupported locale falls back and says so, stickily');
  g('speaker-lang-select').value = 'bs-BA';
  g('speaker-lang-select').onchange();
  const bs = recognizers[recognizers.length - 1];
  check('recognizing as bs-BA', bs.lang === 'bs-BA', bs.lang);
  bs.onerror({ error: 'service-not-allowed', message: 'Speech recognition service is not available' });
  const hr = recognizers[recognizers.length - 1];
  check('retried under Croatian', hr.lang === 'hr-HR', hr.lang);
  const fb = toastTexts().find((t) => t.includes('Croatian is being used instead'));
  check('explained the substitution', !!fb, JSON.stringify(toastTexts()));
  check('that toast is sticky', !!stack.children.find((t) => t.dataset.sticky && t.children[0].textContent === fb));

  console.log('\n8. a language with no fallback surfaces a dismiss-required error');
  g('speaker-lang-select').value = 'sr-RS';
  g('speaker-lang-select').onchange();
  const sr = recognizers[recognizers.length - 1];
  sr.onerror({ error: 'service-not-allowed' });
  check('status is error', label() === 'Mic unavailable', label());
  check('button offers Try again', btn() === 'Try again', btn());
  check('bar is red', bar().includes('red'), bar());
  const dict = toastTexts().find((t) => t.includes('Dictation'));
  check('names the Dictation setting', !!dict, JSON.stringify(toastTexts()));
  check('instructions are sticky', !!stack.children.find((t) => t.dataset.sticky && t.children[0].textContent === dict));
  const n = recognizers.length;
  check('no silent restart loop', recognizers.length === n);

  console.log('\n9. Try again re-attempts from the error state');
  g('btn-toggle-mic').onclick();
  check('a fresh recognizer was started', recognizers.length === n + 1, `n=${recognizers.length}`);
  check('status left the error state', label() === 'Starting', label());

  console.log('\n10. diagnostics log is populated and reachable from Settings');
  vm.runInContext('renderDebugPanel()', ctx);
  check('build stamp shown', g('debug-build-stamp').textContent.startsWith('build '), g('debug-build-stamp').textContent);
  const log = g('debug-log').textContent;
  check('log recorded the pause', log.includes('paused by speaker'));
  check('log recorded the fallback', log.includes('retrying recognition as hr-HR'), log.slice(-200));


  console.log('\n11. steady-state iOS restart cycle must NOT flicker out of Live');
  // Reproduces a normal breath between sentences: audio stops, session ends, the 250ms
  // restart fires, audio resumes. The bar must stay green throughout.
  recognizers.length = 0;
  vm.runInContext('0', ctx);
  g('speaker-lang-select').value = 'en-US';
  g('speaker-lang-select').onchange();
  const r = recognizers[recognizers.length - 1];
  r.onaudiostart();
  check('live before the cycle', label() === 'Live', label());
  r.onaudioend();
  check('still Live right after onaudioend', label() === 'Live', label());
  r.onend();
  check('still Live right after onend', label() === 'Live', label());
  setTimeout(() => {
    const r2 = recognizers[recognizers.length - 1];
    check('recognizer restarted', r2.started >= 1);
    r2.onstart();
    check('still Live after onstart', label() === 'Live', label());
    r2.onaudiostart();
    check('still Live after audio resumes', label() === 'Live', label());
    check('detail never said reconnecting', !detail().includes('econnect'), detail());

    console.log('\n12. a genuine stall does eventually demote');
    r2.onaudioend();
    setTimeout(() => {
      check('demoted after the grace window', label() === 'Starting', label());
      check('detail explains why', detail().includes('econnect'), detail());

      console.log('\n13. at most 2 dismiss-required toasts coexist');
      vm.runInContext('showToast("k1", TOAST_STICKY); showToast("k2", TOAST_STICKY); showToast("k3", TOAST_STICKY)', ctx);
      const st = stack.children.filter((t) => t.dataset.sticky);
      check('sticky count capped at 2', st.length === 2, 'n=' + st.length);
      check('newest sticky kept', st.map((t) => t.children[0].textContent).includes('k3'));

      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }, 2400);
  }, 400);
}, 30);
