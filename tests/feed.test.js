'use strict';
// Exercises the transcript feed shared by both views: the three display modes, the speaker's
// copy of them, lazy vs eager translation, and the per-role persistence of the choice.
//
// Worth knowing while reading this: until the DOM shim gained a real parser, none of this
// was testable. setupDisplayToggle and updateToggleStyles both iterate
// querySelectorAll('button'), the shim returned [] unconditionally, and the toggle's buttons
// carry no ids (they are addressed by data-mode) — so every loop body here ran zero times
// and any assertion about the toggle would have passed without testing anything.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { makeDoc } = require('./domshim.js');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const CONFIG = JSON.stringify({ databaseURL: 'https://x.firebaseio.com' });

// speakerId 'test-uuid' matches crypto.randomUUID below, so the room reads as claimed by us
// and the router lands on the speaker view. Anything else lands on the listener view.
function boot({ recent = null, speakerId = 'test-uuid', seed = {} } = {}) {
  const document = makeDoc(html);
  const store = new Map([['rtt_firebase_config', CONFIG]]);
  if (recent !== null) store.set('rtt_recent_rooms', recent);
  for (const [k, v] of Object.entries(seed)) store.set(k, v);

  // Every ref knows its own path, so a test can tell a write to the transcript from a
  // listener attached to the shared translation cache — which is the whole point here.
  const calls = { on: [], off: [], set: [] };
  let pushCounter = 0;
  const makeRef = (refPath) => {
    const ref = {
      path: refPath,
      key: String(refPath).split('/').pop(),
      once: () => Promise.resolve({ val: () => ({ isLive: true, speakerId }) }),
      on(ev, handler) { calls.on.push({ path: refPath, ev, handler }); },
      off(ev, handler) { calls.off.push({ path: refPath, ev, handler }); },
      set(v) { calls.set.push({ path: refPath, v }); },
      update() {},
      push() { pushCounter += 1; return makeRef(`${refPath}/seg${pushCounter}`); },
      child: (k) => makeRef(`${refPath}/${k}`),
      limitToLast() { return ref; },
      // Never committed, so no test ever reaches translateWithGemini (which would want a
      // real fetch). Attaching the listener is the observable act we care about.
      transaction: () => Promise.resolve({ committed: false }),
      onDisconnect: () => ({ update() {}, cancel() {} }),
    };
    return ref;
  };

  const firebase = {
    initializeApp() {},
    database: Object.assign(() => ({ ref: makeRef }), { ServerValue: { TIMESTAMP: 0 } }),
  };

  const recognizers = [];
  const ctx = {
    document, console, setTimeout, clearTimeout, firebase,
    SpeechRecognition: class { constructor() { recognizers.push(this); } start() {} stop() {} },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    URLSearchParams, Date, Math, JSON, Number, String, Set, Map, Array, Object, Error, Promise,
    crypto: { randomUUID: () => 'test-uuid' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    },
    location: { search: '?room=abc123', hash: '', pathname: '/index.html', origin: 'https://e.test', href: '', reload() {} },
    history: { replaceState() {} },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) Safari/604.1', clipboard: null },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(appSrc, ctx, { filename: 'app.js' });

  const g = (id) => document.getElementById(id);
  // A final result whose text ends a sentence flushes immediately, so one call to say()
  // produces exactly one transcript segment.
  const say = (text) => {
    const rec = recognizers[recognizers.length - 1];
    rec.onresult({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true, length: 1 }] });
  };
  const translationCalls = () => calls.on.filter((c) => c.path.includes('/translations/'));
  return { ctx, document, store, calls, g, say, recognizers, translationCalls };
}

let pass = 0, fail = 0;
const check = (n, c, x = '') => {
  if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' :: ' + x); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hidden = (el) => !!el && el.classList.contains('hidden');

// A rendered entry is <wrap><row><originalCol/><translatedCol/></row></wrap>, with an
// optional meta row before the columns. Accessors keep that shape in one place.
const entries = (container) => container.children;
const rowOf = (wrap) => wrap.children[wrap.children.length - 1];
const originalCol = (wrap) => rowOf(wrap).children[0];
const translatedCol = (wrap) => rowOf(wrap).children[1];
const textOf = (col) => col.children[1].textContent;
const classOf = (col) => col.children[1].className;
const modeBtn = (doc, toggleId, mode) =>
  doc.getElementById(toggleId).querySelectorAll('button').find((b) => b.dataset.mode === mode);
const isActive = (btn) => btn.classList.contains('bg-indigo-600') && btn.classList.contains('text-white');

async function main() {
  console.log('1. the speaker gets the same three display controls as a listener');
  {
    const t = boot();
    await wait(0);
    check('speaker view is showing', !hidden(t.g('view-speaker')), t.g('view-speaker').className);
    const toggle = t.g('speaker-display-toggle');
    check('the toggle exists', !!toggle);
    const btns = toggle.querySelectorAll('button');
    check('it offers exactly three modes', btns.length === 3, `n=${btns.length}`);
    check('the modes match the listener\'s', btns.map((b) => b.dataset.mode).join(',') === 'translated,original,dual', btns.map((b) => b.dataset.mode).join(','));
    const sel = t.g('speaker-target-lang-select');
    check('there is a "Show in" picker', !!sel);
    check('it is populated with every language', sel.children.length === 13, `n=${sel.children.length}`);
    check('defaulting to the stored target language', sel.value === 'en-US', sel.value);

    console.log('\n2. and it opens on Original, not Translated');
    check('Original is the active mode', isActive(modeBtn(t.document, 'speaker-display-toggle', 'original')));
    check('Translated is not', !isActive(modeBtn(t.document, 'speaker-display-toggle', 'translated')));
    check('Dual is not', !isActive(modeBtn(t.document, 'speaker-display-toggle', 'dual')));
  }

  console.log('\n3. speaking renders one entry showing the speaker\'s own words');
  {
    const t = boot();
    await wait(0);
    t.say('Dobar dan.');
    const captions = t.g('speaker-captions');
    check('the empty-state hint is gone', !t.g('speaker-empty-hint'));
    check('exactly one entry rendered', entries(captions).length === 1, `n=${entries(captions).length}`);
    const wrap = entries(captions)[0];
    check('the transcript was written to Firebase', t.calls.set.some((c) => c.path.includes('/transcript/') && c.v.originalText === 'Dobar dan.'));
    check('the original column shows what was said', textOf(originalCol(wrap)) === 'Dobar dan.', textOf(originalCol(wrap)));
    check('the original column is visible', !hidden(originalCol(wrap)));
    check('the translated column is hidden in Original mode', hidden(translatedCol(wrap)));
    // The speaker's pane carries no timestamp row: on a phone it costs a line of height per
    // utterance in the one pane they read while talking.
    check('no timestamp row for the speaker', wrap.children.length === 1, `children=${wrap.children.length}`);
    // Regression guard for the emphasis rule. Rendering the only visible column in the
    // small grey italic style meant for a *secondary* column made the speaker's default
    // view a wall of unreadable text.
    check('the sole visible column is styled as primary', classOf(originalCol(wrap)).includes('text-slate-900'), classOf(originalCol(wrap)));
    check('and not as a secondary column', !classOf(originalCol(wrap)).includes('italic'), classOf(originalCol(wrap)));

    console.log('\n4. showing originals costs no Gemini quota');
    check('no translation was requested', t.translationCalls().length === 0, JSON.stringify(t.translationCalls().map((c) => c.path)));

    console.log('\n5. switching to Translated backfills what was never translated');
    modeBtn(t.document, 'speaker-display-toggle', 'translated').onclick();
    check('the translated column is now visible', !hidden(translatedCol(wrap)));
    check('the original column is hidden', hidden(originalCol(wrap)));
    // Without the backfill this column would sit on "…" forever: the entry was rendered
    // while lazy, so nothing had ever claimed a translation for it.
    check('a translation is now requested for the earlier line', t.translationCalls().length === 1, `n=${t.translationCalls().length}`);
    check('under the same key the transcript used', t.translationCalls()[0].path === 'rooms/abc123/translations/seg1/en-US', t.translationCalls()[0].path);
    check('Translated is now the active mode', isActive(modeBtn(t.document, 'speaker-display-toggle', 'translated')));
    check('Original is no longer active', !isActive(modeBtn(t.document, 'speaker-display-toggle', 'original')));

    console.log('\n6. Dual shows both columns with a divider');
    modeBtn(t.document, 'speaker-display-toggle', 'dual').onclick();
    check('both columns visible', !hidden(originalCol(wrap)) && !hidden(translatedCol(wrap)));
    check('a divider separates them', translatedCol(wrap).classList.contains('border-l'));
    check('the original is de-emphasised beside the translation', classOf(originalCol(wrap)).includes('italic'), classOf(originalCol(wrap)));

    console.log('\n7. the choice is remembered per role, not globally');
    check('the speaker\'s mode was stored', t.store.get('rtt_speaker_mode') === 'dual', String(t.store.get('rtt_speaker_mode')));
    check('the listener\'s mode was left alone', !t.store.has('rtt_listener_mode'), String(t.store.get('rtt_listener_mode')));

    console.log('\n8. tearing the speaker view down releases its translation listeners');
    t.g('btn-close-room').onclick(); // arms
    t.g('btn-close-room').onclick(); // ends the session
    // closeRoom() only writes; the teardown happens when the resulting state change routes
    // us off the speaker view. Firebase would fire that from its local cache before the
    // write reached the network, so drive it here rather than asserting on the write alone.
    const stateHandler = t.calls.on.find((c) => c.path.endsWith('/state') && c.ev === 'value');
    check('the router is watching room state', !!stateHandler);
    stateHandler.handler({ val: () => ({ isLive: false, speakerId: null }) });
    check('we left the speaker view', hidden(t.g('view-speaker')));
    check('the translation listener was detached', t.calls.off.some((c) => c.path.includes('/translations/')), JSON.stringify(t.calls.off.map((c) => c.path)));
  }

  console.log('\n9. a stored speaker mode is honoured on the next visit');
  {
    const t = boot({ seed: { rtt_speaker_mode: 'dual' } });
    await wait(0);
    check('opens in Dual', isActive(modeBtn(t.document, 'speaker-display-toggle', 'dual')));
    check('not in the default Original', !isActive(modeBtn(t.document, 'speaker-display-toggle', 'original')));
    t.say('Dobar dan.');
    check('a mode that shows translations translates on arrival', t.translationCalls().length === 1, `n=${t.translationCalls().length}`);
  }

  console.log('\n10. an unrecognised stored mode falls back instead of highlighting nothing');
  {
    const t = boot({ seed: { rtt_speaker_mode: 'sideways' } });
    await wait(0);
    check('falls back to Original', isActive(modeBtn(t.document, 'speaker-display-toggle', 'original')));
    const active = t.g('speaker-display-toggle').querySelectorAll('button').filter(isActive);
    check('exactly one mode is highlighted', active.length === 1, `n=${active.length}`);
  }

  console.log('\n11. changing "Show in" keeps the transcript and re-labels it');
  {
    const t = boot();
    await wait(0);
    t.say('Dobar dan.');
    t.say('Kako ste.');
    const captions = t.g('speaker-captions');
    check('two entries rendered', entries(captions).length === 2, `n=${entries(captions).length}`);
    const sel = t.g('speaker-target-lang-select');
    sel.value = 'es-ES';
    sel.onchange();
    check('both entries survive the switch', entries(captions).length === 2, `n=${entries(captions).length}`);
    check('in their original order', textOf(originalCol(entries(captions)[0])) === 'Dobar dan.', textOf(originalCol(entries(captions)[0])));
    check('the translated column is relabelled', translatedCol(entries(captions)[0]).children[0].textContent === 'Spanish', translatedCol(entries(captions)[0]).children[0].textContent);
    check('the new target language is persisted', t.store.get('rtt_target_lang') === 'es-ES', String(t.store.get('rtt_target_lang')));

    console.log('\n12. picking the language being spoken explains itself');
    check('no hint while the languages differ', hidden(t.g('speaker-samelang-hint')));
    sel.value = 'bs-BA'; // the default speaking language
    sel.onchange();
    check('the hint appears', !hidden(t.g('speaker-samelang-hint')));
    // With nothing to translate every mode renders one column, so the toggle would
    // otherwise look broken.
    check('entries collapse to a single column', hidden(originalCol(entries(captions)[0])) && !hidden(translatedCol(entries(captions)[0])));
  }

  console.log('\n13. the listener still defaults to Translated and translates eagerly');
  {
    const t = boot({ speakerId: 'someone-else' });
    await wait(0);
    check('listener view is showing', !hidden(t.g('view-listener')));
    check('Translated is the active mode', isActive(modeBtn(t.document, 'listener-display-toggle', 'translated')));
    // Eager is the listener's defining difference from the speaker: it keeps translating
    // even while showing originals, so toggling back is instant.
    modeBtn(t.document, 'listener-display-toggle', 'original').onclick();
    const childAdded = t.calls.on.find((c) => c.ev === 'child_added');
    check('the feed is subscribed to the transcript', !!childAdded);
    childAdded.handler({ key: 'seg9', val: () => ({ originalText: 'Dobar dan.', sourceLang: 'bs-BA', timestamp: 1 }) });
    const feed = t.g('listener-feed');
    check('the entry rendered', entries(feed).length === 1, `n=${entries(feed).length}`);
    check('translated even though Original is showing', t.translationCalls().length === 1, `n=${t.translationCalls().length}`);
    check('the listener\'s mode was stored under its own key', t.store.get('rtt_listener_mode') === 'original', String(t.store.get('rtt_listener_mode')));
    check('the speaker\'s key was left alone', !t.store.has('rtt_speaker_mode'));
    check('a listener entry does carry a timestamp row', entries(feed)[0].children.length === 2, `children=${entries(feed)[0].children.length}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
