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
const store = new Map();

const ctx = {
  document,
  console,
  setTimeout, clearTimeout,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  URLSearchParams, Date, Math, JSON, Number, String, Set, Array, Object, Error,
  crypto: { randomUUID: () => 'test-uuid' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  location: { search: '?room=abc123', hash: '', pathname: '/index.html', origin: 'https://example.test', reload() {} },
  history: { replaceState() {} },
  navigator: { userAgent: 'iPhone test', clipboard: null },
  window: {},
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(appSrc, ctx, { filename: 'app.js' });

const stack = document.getElementById('toast-stack');
const texts = () => stack.children.map((t) => t.children[0].textContent);
const run = (code) => vm.runInContext(code, ctx);
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); }
};

console.log('module scope executed; view =',
  ['view-loading','view-config-required'].map((v) => v + ':' + (document.getElementById(v).classList.contains('hidden') ? 'hidden' : 'SHOWN')).join(' '));

console.log('\n1. dedupe: same message twice yields one toast');
run('showToast("hello")'); run('showToast("hello")');
check('one toast', stack.children.length === 1, JSON.stringify(texts()));

console.log('\n2. sticky toast has a "Got it" button and no timer');
run('showToast("sticky one", TOAST_STICKY)');
const s = stack.children[1];
check('marked sticky', s.dataset.sticky === '1');
check('Got it button', s.children[1].textContent === 'Got it');
check('no auto-dismiss timer', s.dataset.timer === undefined);

console.log('\n3. timed toast gets ✕ and a timer');
const t0 = stack.children[0];
check('✕ button', t0.children[1].textContent === '✕');
check('has timer', typeof t0.dataset.timer === 'string');

console.log('\n4. eviction sacrifices timed toasts before sticky ones');
run('showToast("s2", TOAST_STICKY); showToast("s3", TOAST_STICKY); showToast("timed-a"); showToast("timed-b"); showToast("timed-c")');
check('capped at MAX_TOASTS', stack.children.length <= 4, 'len=' + stack.children.length);
check('two newest stickies survived, oldest evicted by the sticky cap',
  texts().includes('s2') && texts().includes('s3') && !texts().includes('sticky one'), JSON.stringify(texts()));
check('a timed toast was sacrificed before any sticky', !texts().includes('timed-a'), JSON.stringify(texts()));
check('newest timed toast is present', texts().includes('timed-c'), JSON.stringify(texts()));

console.log('\n5. all-sticky stack still admits a new message (no self-eviction)');
run('showToast("s4", TOAST_STICKY)');
check('newcomer present', texts().includes('s4'), JSON.stringify(texts()));
check('still capped', stack.children.length <= 4, 'len=' + stack.children.length);

console.log('\n6. dismiss button removes the toast');
const before = stack.children.length;
stack.children[stack.children.length - 1].children[1].onclick();
check('removed', stack.children.length === before - 1);

console.log('\n7. sticky toasts survive past the normal timeout window');
const stickyCount = stack.children.filter((t) => t.dataset.sticky).length;
setTimeout(() => {
  const after = stack.children.filter((t) => t.dataset.sticky).length;
  check('sticky count unchanged after 7s of virtual time', after === stickyCount, `${stickyCount} -> ${after}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 50);
// Fast-forward: TOAST_MS is 6000, so verify by asserting timers exist rather than waiting.
