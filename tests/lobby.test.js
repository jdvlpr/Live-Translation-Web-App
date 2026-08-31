'use strict';
// Exercises the real app.js lobby and the exits out of a room: routing when ?room= is absent,
// the recent-rooms store, the chooser's way out, the two-tap End session confirm, and the
// cache-buster preservation on every internal navigation.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { makeDoc } = require('./domshim.js');

// Resolved against this file, not the shell's cwd, so the suite runs from anywhere.
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const CONFIG = JSON.stringify({ databaseURL: 'https://x.firebaseio.com' });

// speakerId defaults to someone else, so the router lands on the listener view.
// Pass speakerId:'test-uuid' to land on the speaker view instead — that is what
// crypto.randomUUID resolves to below, so the room reads as claimed by us.
function boot({ search = '', recent = null, config = CONFIG, speakerId = 'other-person', isLive = true } = {}) {
  const document = makeDoc(html);
  const store = new Map();
  const writes = [];
  if (config) store.set('rtt_firebase_config', config);
  if (recent !== null) store.set('rtt_recent_rooms', recent);

  const makeRef = () => ({
    once: () => Promise.resolve({ val: () => ({ isLive, speakerId }) }),
    on() {}, off() {}, update() {},
    set(v) { writes.push(v); },
    push: () => makeRef(),
    child: () => makeRef(),
    limitToLast() { return this; },
    transaction: () => Promise.resolve({ committed: true }),
    onDisconnect: () => ({ update() {}, cancel() {} }),
  });
  const firebase = {
    initializeApp() {},
    database: Object.assign(() => ({ ref: makeRef }), { ServerValue: { TIMESTAMP: 0 } }),
  };

  const ctx = {
    document, console, setTimeout, clearTimeout, firebase,
    SpeechRecognition: class { start() {} stop() {} },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    URLSearchParams, Date, Math, JSON, Number, String, Set, Array, Object, Error, Promise,
    crypto: { randomUUID: () => 'test-uuid' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { search, hash: '', pathname: '/index.html', origin: 'https://e.test', href: '', reload() {} },
    history: { replaceState() {} },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1', clipboard: null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(appSrc, ctx, { filename: 'app.js' });
  return { ctx, document, store, writes, g: (id) => document.getElementById(id) };
}

let pass = 0, fail = 0;
const check = (n, c, x = '') => {
  if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' :: ' + x); }
};
// Null-guarded: an id removed from index.html should fail the assertion that depends on it,
// not throw from inside this helper and point the stack at the wrong place.
const visible = (doc, id) => {
  const el = doc.getElementById(id);
  return !!el && !el.classList.contains('hidden');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Row accessors, so the shape of a list row lives in one place.
const rowName = (row) => row.children[0].children[0].textContent;
const rowWhen = (row) => row.children[0].children[1].textContent;
const rowOpen = (row) => row.children[0];
const rowForget = (row) => row.children[1];

async function main() {
  console.log('1. a bare URL shows the lobby instead of minting a room');
  {
    const { g, document, ctx } = boot({ search: '' });
    check('lobby is visible', visible(document, 'view-lobby'));
    check('chooser is hidden', !visible(document, 'view-chooser'));
    check('no navigation happened', ctx.location.href === '', ctx.location.href);
    check('URL was not rewritten with a room', ctx.location.search === '', ctx.location.search);
    check('recent-rooms panel hidden with no history', !visible(document, 'lobby-recent-wrap'));
    check('no rows rendered', g('lobby-recent-list').children.length === 0);
    check('new-room button is wired', typeof g('btn-new-room').onclick === 'function');
  }

  console.log('\n2. Start a new room navigates to a generated room, keeping ?cb=');
  {
    const { g, ctx } = boot({ search: '?cb=8' });
    g('btn-new-room').onclick();
    const href = ctx.location.href;
    check('navigated somewhere', href.startsWith('/index.html?'), href);
    check('cache-buster survived', /(\?|&)cb=8(&|$)/.test(href), href);
    check('a room id was assigned', /(\?|&)room=[a-z0-9]{1,6}(&|$)/.test(href), href);
  }

  console.log('\n3. every room is one uniform list, newest first');
  {
    const recent = JSON.stringify([
      { id: 'aaa111', role: 'listener', at: Date.now() - 60000 },
      { id: 'bbb222', role: 'speaker', at: Date.now() - 7200000 },
      { id: 'ccc333', role: 'listener', at: Date.now() - 172800000 },
    ]);
    const { g, document, ctx } = boot({ search: '?cb=8', recent });

    // The old separate "Rejoin <id>" button is gone from the markup entirely.
    check('no separate rejoin button in the page', document.getElementById('btn-rejoin-last') === null);
    check('recent panel visible', visible(document, 'lobby-recent-wrap'));

    const rows = g('lobby-recent-list').children;
    check('lists every room, not all-but-the-first', rows.length === 3, `n=${rows.length}`);
    check('newest is row 0', rowName(rows[0]) === 'aaa111', rowName(rows[0]));
    check('newest row is tinted', rows[0].className.includes('bg-indigo-50'), rows[0].className);
    check('later rows are not tinted', !rows[1].className.includes('bg-indigo-50'), rows[1].className);
    check('row 1 is bbb222', rowName(rows[1]) === 'bbb222', rowName(rows[1]));
    check('row 2 is ccc333', rowName(rows[2]) === 'ccc333', rowName(rows[2]));

    check('row 0 says Listened', rowWhen(rows[0]).startsWith('Listened'), rowWhen(rows[0]));
    check('row 1 says Spoke', rowWhen(rows[1]).startsWith('Spoke'), rowWhen(rows[1]));
    check('row 1 shows hours', rowWhen(rows[1]).includes('2 hrs ago'), rowWhen(rows[1]));
    check('row 2 shows days', rowWhen(rows[2]).includes('2 days ago'), rowWhen(rows[2]));

    // Every row carries a forget control now — including the newest, which under the old
    // split layout lived on a button that had none.
    check('every row has a forget control', rows.every((r) => r.children.length === 2));

    rowOpen(rows[0]).onclick();
    check('tapping the newest opens it', /room=aaa111/.test(ctx.location.href), ctx.location.href);
    check('and keeps the cache-buster', /cb=8/.test(ctx.location.href), ctx.location.href);
  }

  console.log('\n4. tapping an older listed room opens it');
  {
    const recent = JSON.stringify([
      { id: 'aaa111', role: 'listener', at: Date.now() },
      { id: 'bbb222', role: 'speaker', at: Date.now() - 60000 },
    ]);
    const { g, ctx } = boot({ search: '?cb=8', recent });
    rowOpen(g('lobby-recent-list').children[1]).onclick();
    check('opened bbb222', /room=bbb222/.test(ctx.location.href), ctx.location.href);
    check('kept the cache-buster', /cb=8/.test(ctx.location.href), ctx.location.href);
  }

  console.log('\n5. any room can be forgotten, the newest one included');
  {
    const recent = JSON.stringify([
      { id: 'aaa111', role: 'listener', at: Date.now() },
      { id: 'bbb222', role: 'speaker', at: Date.now() - 60000 },
      { id: 'ccc333', role: 'listener', at: Date.now() - 120000 },
    ]);
    const { g, store } = boot({ search: '', recent });
    const list = () => g('lobby-recent-list').children;
    check('three rows to start', list().length === 3, `n=${list().length}`);

    rowForget(list()[0]).onclick(); // ✕ on the newest — impossible before this change
    check('two rows left', list().length === 2, `n=${list().length}`);
    check('bbb222 promoted to newest', rowName(list()[0]) === 'bbb222', rowName(list()[0]));
    check('promoted row picked up the tint', list()[0].className.includes('bg-indigo-50'));
    let saved = JSON.parse(store.get('rtt_recent_rooms'));
    check('aaa111 gone from storage', !saved.some((r) => r.id === 'aaa111'), store.get('rtt_recent_rooms'));

    rowForget(list()[1]).onclick(); // ✕ on an older one still works
    check('one row left', list().length === 1, `n=${list().length}`);
    saved = JSON.parse(store.get('rtt_recent_rooms'));
    check('only bbb222 survives', saved.length === 1 && saved[0].id === 'bbb222', store.get('rtt_recent_rooms'));
  }

  console.log('\n6. corrupt or foreign stored data degrades to an empty list');
  {
    const { document } = boot({ search: '', recent: 'not json at all' });
    check('lobby still renders', visible(document, 'view-lobby'));
    check('no rooms shown', !visible(document, 'lobby-recent-wrap'));
  }
  {
    const { document, g } = boot({ search: '', recent: JSON.stringify([{ nope: 1 }, 'junk', null, { id: 'ok1234', at: Date.now() }]) });
    const rows = g('lobby-recent-list').children;
    check('unusable entries dropped', rows.length === 1 && rowName(rows[0]) === 'ok1234',
      `n=${rows.length}`);
    check('panel shown for the one good entry', visible(document, 'lobby-recent-wrap'));
  }

  console.log('\n7. a ?room= deep link bypasses the lobby entirely');
  {
    const { document } = boot({ search: '?room=deep01' });
    check('lobby not shown', !visible(document, 'view-lobby'));
    check('loading view while Firebase resolves', visible(document, 'view-loading'));
  }

  console.log('\n8. missing credentials still outrank the lobby');
  {
    const { document } = boot({ search: '', config: null });
    check('config-required wins', visible(document, 'view-config-required'));
    check('lobby not shown', !visible(document, 'view-lobby'));
  }

  console.log('\n9. entering a room records it; Leave returns to the lobby');
  {
    const { g, ctx, store, document } = boot({ search: '?room=live99&cb=8' });
    await wait(30);
    check('listener view rendered', visible(document, 'view-listener'));
    const saved = JSON.parse(store.get('rtt_recent_rooms') || '[]');
    check('the room was recorded on arrival', saved.length === 1 && saved[0].id === 'live99',
      store.get('rtt_recent_rooms'));
    check('recorded with the listener role', saved[0].role === 'listener', saved[0].role);

    g('btn-leave-room').onclick();
    check('Leave drops ?room=', !/room=/.test(ctx.location.href), ctx.location.href);
    check('Leave keeps ?cb=', /cb=8/.test(ctx.location.href), ctx.location.href);
    check('Leave lands on the same page', ctx.location.href.startsWith('/index.html?'), ctx.location.href);
  }

  console.log('\n10. the store dedupes and caps at 5');
  {
    const { ctx } = boot({ search: '' });
    const record = vm.runInContext('recordRecentRoom', ctx);
    const load = vm.runInContext('loadRecentRooms', ctx);
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) record(id, 'listener');
    check('capped at 5', load().length === 5, String(load().length));
    check('newest first', load()[0].id === 'r6', load()[0].id);
    check('oldest evicted', !load().some((r) => r.id === 'r1'));
    record('r3', 'speaker');
    check('revisit moves to front', load()[0].id === 'r3', load()[0].id);
    check('revisit does not duplicate', load().filter((r) => r.id === 'r3').length === 1);
    check('revisit updates the role', load()[0].role === 'speaker', load()[0].role);
    check('still capped', load().length === 5, String(load().length));
    check('no navigation from recording', ctx.location.href === '', ctx.location.href);
  }

  console.log('\n11. a shared link carries the room but not the cache-buster');
  {
    const { ctx } = boot({ search: '?room=share1&cb=8' });
    const share = vm.runInContext('shareUrl', ctx);
    const url = share('share1', false);
    check('includes the room', /room=share1/.test(url), url);
    check('excludes cb', !/cb=/.test(url), url);
    check('is absolute', url.startsWith('https://e.test/'), url);
  }

  console.log('\n12. the chooser has a way out that is not the browser Back button');
  {
    const { g, store, document, ctx } = boot({ search: '?room=quiet1&cb=8', isLive: false });
    await wait(30);
    check('chooser shown while the room is idle', visible(document, 'view-chooser'));
    check('nothing recorded from the chooser alone', !store.get('rtt_recent_rooms'),
      store.get('rtt_recent_rooms'));
    check('the leave control exists', !!g('btn-chooser-leave'));
    check('and is wired', typeof g('btn-chooser-leave').onclick === 'function');

    g('btn-chooser-leave').onclick();
    check('leaving the chooser drops ?room=', !/room=/.test(ctx.location.href), ctx.location.href);
    check('and keeps the cache-buster', /cb=8/.test(ctx.location.href), ctx.location.href);
  }

  console.log('\n13. joining a not-yet-live room from the chooser records it');
  {
    const { g, store, document, ctx } = boot({ search: '?room=quiet2&cb=8', isLive: false });
    await wait(30);
    g('btn-join-listener').onclick();
    check('listener view rendered', visible(document, 'view-listener'));
    const saved = JSON.parse(store.get('rtt_recent_rooms') || '[]');
    check('joining recorded the room', saved.length === 1 && saved[0].id === 'quiet2',
      store.get('rtt_recent_rooms'));

    g('btn-leave-room').onclick();
    check('Leave returns to the lobby', !/room=/.test(ctx.location.href), ctx.location.href);
    check('Leave keeps the cache-buster', /cb=8/.test(ctx.location.href), ctx.location.href);
  }

  console.log('\n14. End session takes two taps and never navigates');
  {
    const { g, writes, ctx, document } = boot({ search: '?room=mine01&cb=8', speakerId: 'test-uuid' });
    await wait(30);
    check('speaker view rendered', visible(document, 'view-speaker'));
    const btn = g('btn-close-room');
    check('starts labelled End session', btn.textContent === 'End session', btn.textContent);

    const restingBox = btn.className;
    btn.onclick();
    check('first tap arms instead of ending', btn.textContent === 'End for all?', btn.textContent);
    check('first tap names who it affects', /all/i.test(btn.textContent), btn.textContent);
    // The DOM shim has no layout, so this is the only reachable proxy for "the button does not
    // change size when it arms". A confirm whose target moves between taps is worse than none.
    const box = (c) => c.split(/\s+/).filter((x) => /^(min-w-|text-center$|px-|py-)/.test(x)).sort().join(' ');
    check('armed state keeps the same box', box(btn.className) === box(restingBox),
      `${box(restingBox)} -> ${box(btn.className)}`);
    check('the pinned width is actually present', /min-w-/.test(btn.className), btn.className);
    // resetCloseButton overwrites className wholesale, so the markup's own classes only govern
    // the first paint before the speaker view renders. They still have to agree, or the button
    // visibly resizes once on arrival.
    const markupClass = /id="btn-close-room"[^>]*class="([^"]+)"/.exec(html);
    check('markup and JS agree on the box', !!markupClass && box(markupClass[1]) === box(restingBox),
      markupClass ? `${box(markupClass[1])} vs ${box(restingBox)}` : 'class attribute not found');
    const closes = () => writes.filter((w) => w && w.isLive === false).length;
    check('first tap wrote nothing', closes() === 0, `writes=${JSON.stringify(writes)}`);

    btn.onclick();
    check('second tap ends the session', closes() === 1, `writes=${JSON.stringify(writes)}`);
    check('and clears the speaker slot', writes.some((w) => w && w.isLive === false && w.speakerId === null));
    check('button returns to its resting label', btn.textContent === 'End session', btn.textContent);
    // The load-bearing one: navigating here would race the write against teardown cancelling
    // the onDisconnect backstop, and could strand the room live with no speaker.
    check('ending never navigates', ctx.location.href === '', ctx.location.href);
  }

  console.log('\n15. an armed End session disarms itself after a pause');
  {
    const { g, writes } = boot({ search: '?room=mine02&cb=8', speakerId: 'test-uuid' });
    await wait(30);
    const btn = g('btn-close-room');
    btn.onclick();
    check('armed', btn.textContent === 'End for all?', btn.textContent);
    await wait(5100);
    check('disarmed on its own', btn.textContent === 'End session', btn.textContent);
    btn.onclick();
    check('a later tap only re-arms, it does not end', btn.textContent === 'End for all?', btn.textContent);
    check('still nothing written', writes.filter((w) => w && w.isLive === false).length === 0,
      JSON.stringify(writes));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
