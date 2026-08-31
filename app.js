'use strict';

/* ---------- Config ---------- */

// `speechFallback` is a locale to run *recognition* under when the device has no
// model for the chosen one. Transcripts stay tagged with the language the speaker
// actually picked, so translation is unaffected — only the recognizer changes.
// Only set this where the two are close enough to be near-lossless AND share a
// script: Bosnian and Croatian are both Latin, so Croatian recognition of Bosnian
// speech is effectively identical. Serbian deliberately has no fallback — it is
// written in Cyrillic, and a Croatian recognizer would emit the wrong alphabet.
const LANGUAGES = [
  { code: 'bs-BA', name: 'Bosnian', speechFallback: 'hr-HR' },
  { code: 'zh-CN', name: 'Chinese' },
  { code: 'hr-HR', name: 'Croatian' },
  { code: 'nl-NL', name: 'Dutch' },
  { code: 'en-US', name: 'English' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'pl-PL', name: 'Polish' },
  { code: 'sr-RS', name: 'Serbian' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'uk-UA', name: 'Ukrainian' },
  { code: 'ur-PK', name: 'Urdu' },
];

const STORAGE = {
  clientId: 'rtt_client_uuid',
  firebaseConfig: 'rtt_firebase_config',
  geminiKey: 'rtt_gemini_key',
  targetLang: 'rtt_target_lang',
  recentRooms: 'rtt_recent_rooms',
  // One key per role, not one shared "display mode". The two want opposite defaults — a
  // listener wants the translation, a speaker wants their own words — so a single key would
  // mean each role silently overwrote the other's preference every time you switched.
  listenerMode: 'rtt_listener_mode',
  speakerMode: 'rtt_speaker_mode',
};

const PAUSE_MS = 3500;
const SENTENCE_END_RE = /[.!?…]["')\]]?\s*$/;
const STALE_PENDING_MS = 8000;
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
// iOS Safari's continuous SpeechRecognition can silently stop delivering onresult
// without ever firing onend/onerror, so the normal restart-on-end logic never
// kicks in. This watchdog force-restarts if nothing comes through for too long.
// Scoped to iOS since Chrome/desktop don't exhibit this failure mode.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent);
const RECOGNITION_WATCHDOG_MS = 20000;
// Bumped by hand, together with the ?v= on the <script> tag in index.html, whenever
// app.js changes in a way a tester needs to confirm reached their device. GitHub Pages +
// iOS Safari cache aggressively enough that "did the new code actually load?" is
// otherwise unanswerable from a phone.
const BUILD_STAMP = 'build 2026-08-31 v9';
// A recognition session ending sooner than this without any result is treated as a
// failure to start rather than a silence, so we stop retrying and surface the error.
const FAILED_SESSION_MS = 1500;
const MAX_FAILED_RESTARTS = 8;

function speechFallbackFor(code) {
  const lang = LANGUAGES.find((l) => l.code === code);
  return (lang && lang.speechFallback) || null;
}

function langName(code) {
  const lang = LANGUAGES.find((l) => l.code === code);
  return lang ? lang.name : code;
}

/* ---------- Identity & room ---------- */

function getClientId() {
  let id = localStorage.getItem(STORAGE.clientId);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(STORAGE.clientId, id);
  }
  return id;
}

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

// Null when the URL carries no ?room=. "No room yet" is a real destination now — the lobby —
// rather than a cue to invent an id on the spot, so arriving at the bare URL offers a choice
// instead of silently dropping the visitor into an empty room they never asked for.
function resolveRoomId() {
  return new URLSearchParams(location.search).get('room');
}

// Internal navigations rebuild the URL from the *current* query rather than from
// location.pathname alone. Whatever else is already in there has to survive — in particular
// the ?cb= cache-buster used to force iOS Safari past a stale copy of the app. Navigating to
// a bare pathname would hand the phone back exactly the cached build the tester appended
// that parameter to escape, and the resulting "my fix didn't deploy" is near-impossible to
// diagnose from a device with no console.
function urlForRoom(id) {
  const params = new URLSearchParams(location.search);
  if (id) params.set('room', id);
  else params.delete('room');
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ''}`;
}

// Unlike urlForRoom above, this builds a *fresh* parameter list rather than inheriting the
// current one: a shared link should carry the room and nothing else, not a cache-buster or
// whatever else happened to be in the sharer's address bar.
function shareUrl(roomId, includeCreds) {
  const params = new URLSearchParams();
  params.set('room', roomId);
  let url = `${location.origin}${location.pathname}?${params.toString()}`;
  if (includeCreds) {
    const payload = encodeCredsPayload();
    if (payload) url += `#setup=${payload}`;
  }
  return url;
}

/* ---------- Recent rooms ---------- */

// A room id exists nowhere but the URL, so leaving one used to destroy the only reference to
// it. This is the visitor's own history of where they've been, kept in their browser — not a
// directory of rooms, and never published anywhere.
const MAX_RECENT_ROOMS = 5;

function loadRecentRooms() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.recentRooms) || '[]');
    if (!Array.isArray(parsed)) return [];
    // Entries are filtered rather than trusted: this is parsed from storage that a previous
    // version (or a hand-edited devtools session) may have written in another shape.
    return parsed.filter((r) => r && typeof r.id === 'string');
  } catch {
    return [];
  }
}

function saveRecentRooms(rooms) {
  try {
    localStorage.setItem(STORAGE.recentRooms, JSON.stringify(rooms.slice(0, MAX_RECENT_ROOMS)));
  } catch {
    // Safari in private mode can refuse writes. Losing the list is survivable; throwing here
    // would take down whichever view was mid-render over a convenience feature.
  }
}

function recordRecentRoom(id, role) {
  if (!id) return;
  const rooms = loadRecentRooms().filter((r) => r.id !== id);
  rooms.unshift({ id, role, at: Date.now() });
  saveRecentRooms(rooms);
}

function forgetRecentRoom(id) {
  saveRecentRooms(loadRecentRooms().filter((r) => r.id !== id));
}

// Past tense and about *this visitor* on purpose: whether they spoke or listened is a fact
// about their own visit that stays true, whereas who is speaking in that room now is not
// something this list has any way to know.
function describeVisit(entry) {
  const verb = entry.role === 'speaker' ? 'Spoke' : 'Listened';
  return `${verb} · ${relativeTime(entry.at)}`;
}

function relativeTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Packs the current browser's saved Firebase config + Gemini key into the URL hash (never
// sent to any server, unlike a query param) so a QR/link can carry them for someone who
// hasn't configured Settings yet. Kept as an opt-in per the security tradeoffs in the README.
function encodeCredsPayload() {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  return btoa(JSON.stringify({ fb: cfg, gk: loadGeminiKey() }));
}

function importCredsFromHash() {
  const match = /^#setup=(.+)$/.exec(location.hash);
  if (!match) return;
  try {
    const payload = JSON.parse(atob(match[1]));
    if (!payload || !payload.fb || !payload.fb.databaseURL) throw new Error('invalid payload');
    localStorage.setItem(STORAGE.firebaseConfig, JSON.stringify(payload.fb));
    localStorage.setItem(STORAGE.geminiKey, payload.gk || '');
    showToast('Credentials loaded from link.');
  } catch (err) {
    console.error('Failed to import credentials from link', err);
    showToast('Could not read credentials from this link — open Settings and enter them manually.', TOAST_STICKY);
  } finally {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/* ---------- Toast ---------- */

// Pass as the duration for anything the reader may need to act on while it's still on
// screen — device settings to change, a warning to weigh, an error to report. Those
// toasts stay put until dismissed, because once one times out there's no way to get it
// back and the instructions are gone.
const TOAST_STICKY = 0;
const TOAST_MS = 6000;
// Older messages are dropped past this, so a burst can't cover the whole screen.
const MAX_TOASTS = 4;
// Dismiss-required toasts are wordy and sit there until tapped, so allow fewer at once
// than timed ones: three stacked instruction blocks would bury the caption area on a
// phone and demand three separate taps to clear.
const MAX_STICKY_TOASTS = 2;

function showToast(msg, ms = TOAST_MS) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const sticky = ms === TOAST_STICKY;

  // Repeats of a message already on screen (retrying a failing action, say) restart its
  // timer instead of stacking identical copies.
  for (const existing of stack.children) {
    if (existing.dataset.msg === msg) {
      if (!sticky) {
        clearTimeout(Number(existing.dataset.timer));
        existing.dataset.timer = String(setTimeout(() => existing.remove(), ms));
      }
      return;
    }
  }

  const toast = document.createElement('div');
  toast.dataset.msg = msg;
  if (sticky) toast.dataset.sticky = '1';
  toast.className =
    'pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg bg-slate-900 text-white text-sm shadow-lg';

  const text = document.createElement('span');
  text.className = 'flex-1 min-w-0';
  text.textContent = msg;

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  // A sticky toast needs an obvious way out, since nothing else will remove it; a
  // timed one just gets a quiet ✕ for anyone who wants the screen back sooner.
  dismiss.className = sticky
    ? 'shrink-0 px-2 py-0.5 -my-0.5 rounded bg-white/15 hover:bg-white/25 text-xs font-semibold'
    : 'shrink-0 px-1.5 rounded hover:bg-white/15 leading-none';
  dismiss.textContent = sticky ? 'Got it' : '✕';
  dismiss.setAttribute('aria-label', 'Dismiss');

  const remove = () => {
    clearTimeout(Number(toast.dataset.timer));
    toast.remove();
  };
  dismiss.onclick = remove;

  toast.appendChild(text);
  toast.appendChild(dismiss);

  // Make room *before* appending, so the incoming toast can never be chosen as its own
  // victim. Stickies are capped separately and against each other, oldest out first.
  if (sticky) {
    const stickies = [...stack.children].filter((t) => t.dataset.sticky);
    while (stickies.length >= MAX_STICKY_TOASTS) stickies.shift().remove();
  }
  // Then the overall cap. Timed toasts are sacrificed ahead of sticky ones — a message
  // the reader was told to act on shouldn't be evicted by a "Link copied." arriving
  // behind it. Only when the whole stack is sticky does the oldest sticky go.
  while (stack.children.length >= MAX_TOASTS) {
    const victim = [...stack.children].find((t) => !t.dataset.sticky) || stack.firstElementChild;
    clearTimeout(Number(victim.dataset.timer));
    victim.remove();
  }

  stack.appendChild(toast);
  if (!sticky) toast.dataset.timer = String(setTimeout(remove, ms));
}

/* ---------- Diagnostics log ---------- */

// Module-scoped rather than living with the speaker code, because the panel that shows it
// now sits in the Settings modal, which is reachable from every view.
const debugLines = [];

function debugLog(message) {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp}  ${message}`;
  debugLines.push(line);
  if (debugLines.length > 200) debugLines.shift();
  console.info('[rtt]', line);
  const el = document.getElementById('debug-log');
  if (el) {
    el.textContent = debugLines.join('\n');
    el.scrollTop = el.scrollHeight;
  }
}

// Runs after showToast is defined, since a successful or failed import both report through
// it, and before anything reads the room — the credentials in the hash have to be in place
// before a view that needs them renders.
importCredsFromHash();

const clientId = getClientId();
const roomId = resolveRoomId();

/* ---------- View switching ---------- */

const VIEW_IDS = ['view-loading', 'view-config-required', 'view-lobby', 'view-chooser', 'view-speaker', 'view-listener'];
function showView(id) {
  for (const vid of VIEW_IDS) {
    // Guarded because index.html and app.js are cached independently: a device holding an
    // older page against a newer script would otherwise throw here on a view that doesn't
    // exist yet, breaking every view rather than just the missing one.
    const el = document.getElementById(vid);
    if (el) el.classList.toggle('hidden', vid !== id);
  }
}

/* ---------- Settings modal ---------- */

function loadFirebaseConfig() {
  const raw = localStorage.getItem(STORAGE.firebaseConfig);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadGeminiKey() {
  return localStorage.getItem(STORAGE.geminiKey) || '';
}

function openSettingsModal() {
  const cfg = loadFirebaseConfig();
  document.getElementById('input-firebase-config').value = cfg ? JSON.stringify(cfg, null, 2) : '';
  document.getElementById('input-gemini-key').value = loadGeminiKey();
  document.getElementById('settings-error').classList.add('hidden');
  document.getElementById('btn-settings-cancel').classList.toggle('hidden', !cfg);
  document.getElementById('modal-settings').classList.remove('hidden');
  renderDebugPanel();
}

function closeSettingsModal() {
  document.getElementById('modal-settings').classList.add('hidden');
}

function saveSettings() {
  const errEl = document.getElementById('settings-error');
  const rawConfig = document.getElementById('input-firebase-config').value.trim();
  const geminiKey = document.getElementById('input-gemini-key').value.trim();
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    errEl.textContent = 'Firebase config is not valid JSON.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!parsed.databaseURL) {
    errEl.textContent = 'Firebase config must include "databaseURL" (enable Realtime Database in your project).';
    errEl.classList.remove('hidden');
    return;
  }
  localStorage.setItem(STORAGE.firebaseConfig, JSON.stringify(parsed));
  localStorage.setItem(STORAGE.geminiKey, geminiKey);
  location.reload();
}

document.getElementById('btn-open-settings').addEventListener('click', openSettingsModal);
document.getElementById('btn-config-open-settings').addEventListener('click', openSettingsModal);
document.getElementById('btn-settings-save').addEventListener('click', saveSettings);
document.getElementById('btn-settings-cancel').addEventListener('click', closeSettingsModal);

/* ---------- Diagnostics panel (inside Settings) ---------- */

function renderDebugPanel() {
  const stamp = document.getElementById('debug-build-stamp');
  if (stamp) stamp.textContent = BUILD_STAMP;
  const log = document.getElementById('debug-log');
  if (log) {
    log.textContent = debugLines.join('\n');
    log.scrollTop = log.scrollHeight;
  }
}

// Every lookup is guarded: a device can be holding a cached index.html while loading a
// fresh app.js, and an unguarded null here would abort the rest of this script — taking
// the app down over a panel nobody was looking at.
(function wireDebugPanel() {
  const toggleBtn = document.getElementById('btn-toggle-debug');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      const panel = document.getElementById('settings-debug-panel');
      if (!panel) return;
      const nowHidden = panel.classList.toggle('hidden');
      const caret = document.getElementById('debug-toggle-caret');
      if (caret) caret.textContent = nowHidden ? '▸' : '▾';
      if (!nowHidden) renderDebugPanel();
    };
  }

  const clearBtn = document.getElementById('btn-clear-debug');
  if (clearBtn) {
    clearBtn.onclick = () => {
      debugLines.length = 0;
      renderDebugPanel();
    };
  }

  const copyBtn = document.getElementById('btn-copy-debug');
  if (copyBtn) {
    copyBtn.onclick = () => {
      const text = `${BUILD_STAMP}\n${navigator.userAgent}\n\n${debugLines.join('\n')}`;
      navigator.clipboard?.writeText(text).then(
        () => showToast('Diagnostics copied.'),
        () => showToast('Could not copy — select the text manually.')
      );
    };
  }
})();

/* ---------- Copy-link buttons (delegated) ---------- */

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-copy-link');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.target);
  if (!input) return;
  navigator.clipboard
    ?.writeText(input.value)
    .then(() => showToast('Link copied.'))
    .catch(() => {
      input.select();
      showToast('Press Ctrl/Cmd+C to copy.', 8000);
    });
});

/* ---------- QR codes ---------- */

function renderQr(containerId, url) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  if (typeof QRCode === 'undefined') return;
  // eslint-disable-next-line no-new
  new QRCode(el, { text: url, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
}

/* ---------- Lobby view ---------- */

// Deliberately outside startApp(): with no room there is nothing to subscribe to, so the
// lobby needs no Firebase connection to render.
function renderLobbyView() {
  const newBtn = document.getElementById('btn-new-room');
  if (!newBtn) {
    // Stale cached index.html against a fresh app.js — the lobby markup isn't there to show.
    // Fall back to the old behaviour of minting a room and carrying on, so the app still
    // works rather than presenting a blank screen with nothing to tap.
    location.href = urlForRoom(generateRoomId());
    return;
  }

  showView('view-lobby');
  const rooms = loadRecentRooms();

  newBtn.onclick = () => {
    location.href = urlForRoom(generateRoomId());
  };

  // Previously rooms[0] was pulled out into its own "Rejoin <id>" button and only rooms[1..]
  // were listed. The button and the rows led to the same place, so the split read as two
  // controls for one action — and because the ✕ lived only on the rows, the room you were in
  // most recently was the one room you could not forget. One list now: newest first, tinted
  // so it still reads as "where you just were", and dismissible like every other row.
  // Hidden rather than ignored because a device may hold a cached index.html that still has it.
  const rejoin = document.getElementById('btn-rejoin-last');
  if (rejoin) rejoin.classList.add('hidden');

  const wrap = document.getElementById('lobby-recent-wrap');
  const list = document.getElementById('lobby-recent-list');
  if (wrap) wrap.classList.toggle('hidden', rooms.length === 0);
  if (!list) return;
  list.innerHTML = '';

  rooms.forEach((entry, i) => {
    const row = document.createElement('li');
    // Tint only the newest. A translucent hover works over both that tint and plain white,
    // which a fixed hover:bg-slate-50 would not.
    row.className = 'flex items-center gap-2 rounded-lg' + (i === 0 ? ' bg-indigo-50 border border-indigo-200' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'flex-1 min-w-0 text-left px-2 py-2 rounded-lg hover:bg-black/5';
    const name = document.createElement('span');
    name.className = 'block font-mono text-sm';
    name.textContent = entry.id;
    const when = document.createElement('span');
    when.className = 'block text-xs text-slate-400';
    when.textContent = describeVisit(entry);
    open.appendChild(name);
    open.appendChild(when);
    open.onclick = () => {
      location.href = urlForRoom(entry.id);
    };

    // Per-row removal, because the alternative is a list that silently accumulates every
    // mistyped or one-off room forever with no way to tidy it.
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'shrink-0 px-2 py-1 text-slate-300 hover:text-slate-600';
    drop.textContent = '✕';
    drop.setAttribute('aria-label', `Forget room ${entry.id}`);
    drop.onclick = () => {
      forgetRecentRoom(entry.id);
      renderLobbyView();
    };

    row.appendChild(open);
    row.appendChild(drop);
    list.appendChild(row);
  });
}

/* ---------- Bootstrap ---------- */

showView('view-loading');

const firebaseConfig = loadFirebaseConfig();
if (!firebaseConfig) {
  // Credentials come first even with a room in hand: every view past this point needs a
  // database connection, so asking for setup here beats letting someone pick a room and
  // only then discover the app can't connect.
  showView('view-config-required');
} else if (!roomId) {
  renderLobbyView();
} else {
  try {
    firebase.initializeApp(firebaseConfig);
    startApp();
  } catch (err) {
    console.error(err);
    showView('view-config-required');
    showToast('Could not connect to Firebase — check your config in Settings.', TOAST_STICKY);
  }
}

/* ---------- Main app (only runs once Firebase config exists) ---------- */

function startApp() {
  const db = firebase.database();
  const stateRef = db.ref(`rooms/${roomId}/state`);
  const transcriptRef = db.ref(`rooms/${roomId}/transcript`);
  const translationsRef = db.ref(`rooms/${roomId}/translations`);
  const connectedRef = db.ref('.info/connected');

  let currentRoute = null; // 'chooser' | 'speaker' | 'listener'
  let latestState = null;

  function computeRoute(state) {
    if (state && state.isLive && state.speakerId === clientId) return 'speaker';
    if (state && state.isLive) return 'listener';
    return 'chooser';
  }

  function teardownCurrentView() {
    if (currentRoute === 'speaker') teardownSpeakerView();
    if (currentRoute === 'listener') teardownListenerView();
  }

  function goToRoute(route) {
    teardownCurrentView();
    currentRoute = route;
    if (route === 'speaker') renderSpeakerView();
    else if (route === 'listener') renderListenerView();
    else renderChooserView();
  }

  // Initial one-time read decides the very first view.
  stateRef.once('value').then((snap) => {
    latestState = snap.val();
    goToRoute(computeRoute(latestState));

    // Ongoing subscription only reacts to *changes* from here on.
    stateRef.on('value', (s) => {
      const state = s.val();
      const wasLive = !!(latestState && latestState.isLive);
      latestState = state;
      const nextRoute = computeRoute(state);
      if (nextRoute !== currentRoute) {
        if (currentRoute === 'listener' && wasLive && !state?.isLive) {
          showToast('The speaker ended this session.');
        }
        goToRoute(nextRoute);
      }
    });
  });

  /* ----- Chooser view ----- */

  function renderChooserView() {
    showView('view-chooser');
    document.getElementById('chooser-room-id').textContent = roomId;
    document.getElementById('chooser-waiting-banner').classList.add('hidden');

    const includeCreds = document.getElementById('chooser-include-creds');
    includeCreds.checked = false;
    const updateChooserShare = () => {
      const url = shareUrl(roomId, includeCreds.checked);
      document.getElementById('chooser-share-link').value = url;
      renderQr('chooser-qrcode', url);
    };
    includeCreds.onchange = () => {
      if (includeCreds.checked) showToast('This link/QR carries your credentials — anyone who has it can use your Gemini quota.', 10000);
      updateChooserShare();
    };
    updateChooserShare();

    document.getElementById('btn-start-speaker').onclick = claimSpeaker;
    document.getElementById('btn-join-listener').onclick = () => {
      currentRoute = 'listener';
      renderListenerView();
    };

    // Every route that isn't 'speaker' or 'listener' funnels here, including the two that
    // arrive involuntarily: ending your own session, and having a speaker end one you were
    // listening to. The listener's own Leave button is in a view that just got hidden, so
    // without this the chooser is a screen you can only leave via the browser's Back button.
    const leave = document.getElementById('btn-chooser-leave');
    if (leave) {
      leave.onclick = () => {
        location.href = urlForRoom(null);
      };
    }
  }

  function requestMicPermission() {
    // iOS/Safari (and WebKit generally) will only show the mic permission prompt
    // when the request happens synchronously within a user gesture. The actual
    // recognizer.start() call below happens later, inside a Firebase 'value'
    // callback, which no longer counts as a user gesture — so we grab (and
    // immediately release) the mic here, right in the click handler, to get the
    // permission prompt to appear. getUserMedia and SpeechRecognition share the
    // same underlying microphone permission, so recognizer.start() succeeds
    // silently afterward.
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.resolve(true); // let SpeechRecognition itself report unsupported/denied later
    }
    return navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return true;
      })
      .catch(() => {
        showToast('Microphone access denied — allow it in your browser/device settings, then tap “Start as Speaker” again.', TOAST_STICKY);
        return false;
      });
  }

  function claimSpeaker() {
    requestMicPermission().then((granted) => {
      if (!granted) return;
      stateRef
        .transaction((current) => {
          if (current && current.isLive) return; // abort: someone already live
          return { isLive: true, speakerId: clientId, updatedAt: firebase.database.ServerValue.TIMESTAMP };
        })
        .then(({ committed }) => {
          if (!committed) {
            showToast('Someone else just started speaking — joining as a listener.');
            return;
          }
          // Router's `on('value')` subscription will detect speakerId === clientId
          // and switch to the speaker view; nothing else to do here.
        })
        .catch((err) => {
          console.error(err);
          showToast('Could not start the room. Check your Firebase config in Settings.', TOAST_STICKY);
        });
    });
  }

  /* ----- Speaker view ----- */

  let recognizer = null;
  let isSpeakingActive = false;
  let restartTimer = null;
  let pauseTimer = null;
  let watchdogTimer = null;
  let failedRestarts = 0;
  let sessionStartedAt = 0;
  let finalBuffer = '';
  let currentSourceLang = LANGUAGES[0].code; // bs-BA default
  let wakeLock = null;
  let disconnectHandlerAttached = false;
  let isPaused = false;
  let micState = 'starting'; // key into MIC_STATUS below
  let speechCueTimer = null;
  let demoteTimer = null;

  // iOS Safari only half-honours `continuous`: sessions end and restart constantly — every
  // breath between sentences, plus every watchdog tick — and each cycle runs
  // onaudioend → onend → start() → onaudiostart within a few hundred milliseconds. Painting
  // the bar grey on each of those would strobe it between "Live" and "Reconnecting" all
  // through a talk, which reads as broken on exactly the platform this bar exists to
  // reassure. So dropping *out* of Live is deferred by this much: a healthy restart
  // completes well inside the window and the bar never moves, while a genuine stall still
  // surfaces. Errors and the give-up cap keep painting immediately — nothing honest is lost.
  const MIC_DEMOTE_GRACE_MS = 2000;

  // Drives the status bar. `className` is assigned wholesale per state rather than
  // toggled, so no colour from a previous state can survive into the next one.
  const MIC_STATUS = {
    starting: {
      label: 'Starting',
      detail: 'Connecting to the microphone…',
      bar: 'bg-slate-100 border-slate-200 text-slate-600',
      dot: 'bg-slate-400 live-dot',
      button: 'Pause',
      btnClass: 'bg-slate-200 text-slate-700 hover:bg-slate-300',
    },
    live: {
      label: 'Live',
      detail: 'Listening — what you say is going to listeners.',
      bar: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      dot: 'bg-emerald-500 live-dot',
      button: 'Pause',
      btnClass: 'bg-emerald-600 text-white hover:bg-emerald-700',
    },
    paused: {
      label: 'Paused',
      detail: 'Your mic is off. Nothing is being sent — the room is still open.',
      bar: 'bg-amber-50 border-amber-200 text-amber-900',
      dot: 'bg-amber-500',
      button: 'Resume',
      btnClass: 'bg-amber-600 text-white hover:bg-amber-700',
    },
    error: {
      label: 'Mic unavailable',
      detail: 'Speech recognition could not start on this device.',
      bar: 'bg-red-50 border-red-200 text-red-800',
      dot: 'bg-red-500',
      button: 'Try again',
      btnClass: 'bg-red-600 text-white hover:bg-red-700',
    },
  };

  function setMicStatus(state, detailOverride) {
    micState = state;
    clearTimeout(speechCueTimer);
    clearTimeout(demoteTimer);
    const s = MIC_STATUS[state];
    const bar = document.getElementById('speaker-status-bar');
    if (!bar || !s) return;
    bar.className = `flex items-center gap-3 px-4 py-3 border-b ${s.bar}`;
    document.getElementById('speaker-status-dot').className = `w-3.5 h-3.5 rounded-full shrink-0 ${s.dot}`;
    document.getElementById('speaker-status-label').textContent = s.label;
    document.getElementById('speaker-status-detail').textContent = detailOverride || s.detail;
    const btn = document.getElementById('btn-toggle-mic');
    btn.className = `shrink-0 px-4 py-2 rounded-lg text-sm font-semibold ${s.btnClass}`;
    btn.textContent = s.button;
  }

  // Deferred drop out of "Live" — see MIC_DEMOTE_GRACE_MS. Only Live is demoted:
  // 'starting' is already grey, and 'paused'/'error' are states we were put in on purpose.
  function scheduleMicDemotion(detail) {
    if (micState !== 'live') return;
    clearTimeout(demoteTimer);
    demoteTimer = setTimeout(() => {
      if (micState === 'live') setMicStatus('starting', detail);
    }, MIC_DEMOTE_GRACE_MS);
  }

  // Momentary "we are hearing audio right now" feedback. The pulsing dot only proves the
  // session is open; this proves sound is actually reaching the recognizer, which is the
  // thing a speaker is really asking when they glance at the screen.
  function flashSpeechCue() {
    // Speech or a transcript is stronger evidence of a working mic than onaudiostart,
    // which not every engine reliably fires. Without this promotion, an engine that
    // skips onaudiostart would leave the bar reading "Starting" while transcription was
    // visibly working — the exact false alarm this bar exists to prevent. Only
    // 'starting' is promoted: 'paused' and 'error' are deliberate states to stay in.
    if (micState === 'starting') setMicStatus('live');
    if (micState !== 'live') return;
    // Audio is demonstrably arriving, so cancel any pending drop out of Live.
    clearTimeout(demoteTimer);
    const detail = document.getElementById('speaker-status-detail');
    if (!detail) return;
    detail.textContent = 'Hearing you…';
    clearTimeout(speechCueTimer);
    speechCueTimer = setTimeout(() => {
      if (micState === 'live') setMicStatus('live');
    }, 1500);
  }

  function pauseSpeaking() {
    isPaused = true;
    debugLog('paused by speaker');
    stopRecognition(); // flushes any trailing sentence, then tears the recognizer down
    const interim = document.getElementById('speaker-interim');
    if (interim) interim.textContent = '';
    setMicStatus('paused');
  }

  function resumeSpeaking() {
    isPaused = false;
    debugLog('resumed by speaker');
    startRecognition(currentSourceLang);
  }

  function renderSpeakerView() {
    showView('view-speaker');
    recordRecentRoom(roomId, 'speaker');
    document.getElementById('speaker-share-panel').classList.add('hidden');
    document.getElementById('speaker-interim').textContent = '';

    const select = document.getElementById('speaker-lang-select');
    select.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      select.appendChild(opt);
    }
    select.value = currentSourceLang;
    select.onchange = () => changeSpeakingLanguage(select.value);

    // The speaker's own view of the transcript. Same three modes the listener has, so a
    // single person sitting next to the speaker can read the translation off this screen
    // instead of opening the room on a device of their own.
    detachFeedTranslations(speakerFeed);
    resetFeed(speakerFeed); // clears the pane, so the empty-state hint is restored after it
    document.getElementById('speaker-captions').innerHTML =
      '<p class="text-slate-400 text-sm" id="speaker-empty-hint">Start talking — your speech will appear here and be sent to listeners.</p>';

    const targetSelect = document.getElementById('speaker-target-lang-select');
    if (targetSelect) {
      targetSelect.innerHTML = '';
      for (const lang of LANGUAGES) {
        const opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.name;
        targetSelect.appendChild(opt);
      }
      targetSelect.value = targetLang;
      targetSelect.onchange = () => {
        targetLang = targetSelect.value;
        try {
          localStorage.setItem(STORAGE.targetLang, targetLang);
        } catch {
          /* Safari private mode refuses writes; the choice just won't outlive the session */
        }
        // Re-renders what's already on screen in the new language rather than clearing it.
        // Everything needed is in feed.segments, so this costs no network and cannot race
        // speech that arrives while it runs.
        rebuildFeed(speakerFeed);
        refreshSameLangHint();
      };
    }
    setupDisplayToggle(speakerFeed);
    refreshSameLangHint();

    const speakerIncludeCreds = document.getElementById('speaker-include-creds');
    speakerIncludeCreds.checked = false;
    const updateSpeakerShare = () => {
      const url = shareUrl(roomId, speakerIncludeCreds.checked);
      document.getElementById('speaker-share-link').value = url;
      renderQr('speaker-qrcode', url);
    };
    speakerIncludeCreds.onchange = () => {
      if (speakerIncludeCreds.checked) showToast('This link/QR carries your credentials — anyone who has it can use your Gemini quota.', 10000);
      updateSpeakerShare();
    };
    updateSpeakerShare();
    document.getElementById('btn-toggle-share').onclick = () => {
      document.getElementById('speaker-share-panel').classList.toggle('hidden');
    };

    const micBtn = document.getElementById('btn-toggle-mic');
    if (micBtn) {
      micBtn.onclick = () => {
        // 'error' shares the resume path deliberately: the button reads "Try again"
        // there, and retrying is exactly starting the recognizer over again.
        if (micState === 'paused' || micState === 'error') resumeSpeaking();
        else pauseSpeaking();
      };
    } else {
      // The status bar is part of this release's index.html, so its absence means the
      // device is holding a cached older page against a fresh app.js. Say that plainly
      // rather than letting it surface later as an inexplicable mic failure.
      showToast('Stale page cached — close this tab entirely and reopen the link to get the current version.', TOAST_STICKY);
    }

    isPaused = false;
    setMicStatus('starting');

    debugLog(`speaker view ready — ${BUILD_STAMP}`);
    debugLog(`iOS=${IS_IOS} ctor=${getSpeechRecognitionCtor() ? 'present' : 'MISSING'}`);

    // Reset here, not only in the handler: this function is re-entered on every route change
    // back into the speaker role, and a button left reading "End for everyone?" from a
    // previous stint would be armed to fire on the first tap of the next one.
    resetCloseButton();
    document.getElementById('btn-close-room').onclick = closeRoom;

    // Re-arm the onDisconnect cleanup every time our connection (re)establishes,
    // since a prior registration is dropped by the server once the socket drops.
    connectedRef.on('value', handleConnectedChange);

    startRecognition(currentSourceLang);
  }

  function handleConnectedChange(snap) {
    if (snap.val() === true && currentRoute === 'speaker') {
      stateRef.onDisconnect().update({ isLive: false, speakerId: null });
      disconnectHandlerAttached = true;
    }
  }

  function teardownSpeakerView() {
    clearTimeout(closeArmTimer); // no stray disarm firing against a view that's gone
    closeArmed = false;
    // The speaker's feed holds Firebase 'value' listeners of its own now. This runs from the
    // local-cache callback inside closeRoom(), so without it those listeners outlive the
    // view and keep firing against elements that are no longer on the page.
    detachFeedTranslations(speakerFeed);
    connectedRef.off('value', handleConnectedChange);
    // Cancel our onDisconnect registration whenever we leave the speaker role for any
    // reason (not just an explicit close) — otherwise it can outlive us and fire later
    // against a room a *different* speaker has since claimed.
    if (disconnectHandlerAttached) {
      stateRef.onDisconnect().cancel();
      disconnectHandlerAttached = false;
    }
    stopRecognition();
  }

  // Ending a session is the only speaker action other people feel — every listener is
  // disconnected — and its button sits in a crowded header a thumb's width from the language
  // picker. So it asks once. Inline rather than confirm(), which on iOS is a modal that
  // blocks the page (and the recognizer) until someone dismisses it.
  let closeArmed = false;
  let closeArmTimer = null;

  // Both states share this box. The armed label is kept short and the width pinned so the
  // button doesn't change size when it arms: the speaker header wraps on a narrow phone, and a
  // growing button would reflow the row and shift the target out from under the thumb between
  // tap one and tap two — a confirm that moves itself is worse than no confirm at all.
  const CLOSE_BTN_BOX = 'px-3 py-1.5 rounded-lg text-white text-sm min-w-[7.5rem] text-center';

  // Rewrites the classes rather than toggling one, so the armed state can't be left behind
  // by a partial reset. Keep in step with the markup for #btn-close-room in index.html.
  function resetCloseButton() {
    closeArmed = false;
    clearTimeout(closeArmTimer);
    const btn = document.getElementById('btn-close-room');
    if (!btn) return;
    btn.textContent = 'End session';
    btn.className = `${CLOSE_BTN_BOX} bg-red-600 font-medium hover:bg-red-700`;
  }

  function closeRoom() {
    if (!closeArmed) {
      closeArmed = true;
      const btn = document.getElementById('btn-close-room');
      if (btn) {
        // "for all" rather than "for everyone": it names the blast radius while still fitting
        // the resting width, so arming darkens the button instead of resizing it.
        btn.textContent = 'End for all?';
        btn.className = `${CLOSE_BTN_BOX} bg-red-700 font-bold ring-2 ring-red-300`;
      }
      // Disarms itself, so a header caught by accident doesn't sit in a half-pressed state
      // for the rest of the session waiting to fire on the next stray tap.
      closeArmTimer = setTimeout(resetCloseButton, 5000);
      return;
    }
    resetCloseButton();
    flushBuffer(); // send any trailing sentence while the room is still marked live
    // Deliberately does not navigate. The local 'value' listener fires first and runs
    // teardownSpeakerView, which cancels the onDisconnect backstop; unloading the page here
    // could then beat the network write and strand the room isLive with an absent speaker —
    // a state that routes every later arrival to the listener view and makes the room
    // unclaimable. Ending drops to the chooser, which now has its own way out.
    stateRef.set({ isLive: false, speakerId: null });
  }

  function changeSpeakingLanguage(newLang) {
    flushBuffer();
    currentSourceLang = newLang;
    debugLog(`language changed to ${newLang}`);
    // Already-rendered lines keep the language they were actually spoken in, so there is
    // nothing to re-render — but whether "Show in" now matches can have changed.
    refreshSameLangHint();
    // A deliberate pause outranks a language change: picking a language while paused
    // sets up the next session rather than starting one.
    if (isPaused) {
      setMicStatus('paused');
      return;
    }
    // Otherwise restart unconditionally rather than only when already active. A fatal
    // error (e.g. service-not-allowed for an unsupported locale) clears isSpeakingActive,
    // and gating on it meant picking a different language silently did nothing —
    // exactly when retrying matters most. This also runs inside a real user gesture,
    // which is the most permissive context iOS offers for start().
    startRecognition(newLang);
  }

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }

  function startRecognition(langCode) {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      isSpeakingActive = false;
      setMicStatus('error', 'This browser has no speech recognition.');
      showToast('Speech recognition is not supported in this browser. Try Chrome, or Safari on iOS/macOS.', TOAST_STICKY);
      return;
    }
    stopRecognitionInternal();

    recognizer = new Ctor();
    recognizer.lang = langCode;
    recognizer.continuous = true;
    recognizer.interimResults = true;

    recognizer.onresult = (event) => {
      armWatchdog();
      flashSpeechCue();
      if (failedRestarts) debugLog('onresult — recovered');
      else if (!debugLines.some((l) => l.includes('onresult'))) debugLog('onresult — FIRST RESULT received');
      failedRestarts = 0; // proof the pipeline works; don't count earlier stumbles against it
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalBuffer += piece;
          resetPauseTimer();
          if (SENTENCE_END_RE.test(finalBuffer.trim())) flushBuffer();
        } else {
          interim += piece;
        }
      }
      document.getElementById('speaker-interim').textContent = interim;
    };

    recognizer.onerror = (event) => {
      // Always log verbatim: several error codes (notably 'language-not-supported')
      // used to fall through silently into onend's restart loop, which made a fatal
      // error look identical to "nothing is happening".
      debugLog(`ONERROR: ${event.error}${event.message ? ' — ' + event.message : ''}`);
      if (event.error === 'not-allowed') {
        isSpeakingActive = false;
        setMicStatus('error', 'Microphone permission was denied for this site.');
        showToast(
          'Microphone access denied — check this site’s microphone permission in your browser settings, then tap Try again.',
          TOAST_STICKY
        );
      } else if (event.error === 'service-not-allowed' || event.error === 'language-not-supported') {
        // Apple reports a missing locale model as service-not-allowed (see the
        // comment below), so both codes land here. If the chosen language has a
        // close-enough sibling, retry under that rather than failing outright.
        const fallback = speechFallbackFor(currentSourceLang);
        if (fallback && langCode !== fallback) {
          debugLog(`${langCode} unsupported here — retrying recognition as ${fallback}`);
          // Never silent: the speaker picked one language and is getting another
          // recogniser, and they should know that without reading the debug panel.
          showToast(
            `${langName(currentSourceLang)} speech recognition isn’t available on this device, so ${langName(fallback)} is being used instead — the two are nearly identical. Your text is still sent to listeners as ${langName(currentSourceLang)}.`,
            TOAST_STICKY
          );
          // The failed attempt died in milliseconds; don't let it count toward the
          // give-up cap and starve the fallback of its own retries.
          failedRestarts = 0;
          startRecognition(fallback);
          return;
        }
        isSpeakingActive = false;
        setMicStatus('error', `${langName(currentSourceLang)} speech isn’t available on this device.`);
        // WebKit reports several distinct conditions through this one code (see
        // bugs.webkit.org/show_bug.cgi?id=225298): Dictation/Siri disabled system-wide,
        // running as a Home Screen web app or in an in-app browser, and — because
        // SFSpeechRecognizer(locale:) returns nil for locales Apple doesn't support —
        // an unsupported language. So name the likely causes rather than just one.
        // Sticky: this asks the reader to leave the app and change a device setting,
        // which they can't do if the instructions vanish while they're doing it.
        showToast(
          `Speech unavailable on this device for ${langName(currentSourceLang)}. On iPhone/iPad: enable Settings → General → Keyboard → Dictation, try another language (Apple supports fewer than Chrome — Bosnian and Serbian in particular are missing), and open the link in Safari itself rather than a Home Screen icon or in-app browser.`,
          TOAST_STICKY
        );
      } else if (event.error === 'audio-capture') {
        isSpeakingActive = false;
        setMicStatus('error', 'No microphone could be opened.');
        showToast('No microphone available — check that nothing else is using it, then tap Try again.', TOAST_STICKY);
      }
      // Remaining errors ('no-speech', 'network', 'aborted') are transient and
      // recovered by onend's restart.
    };

    recognizer.onend = () => {
      debugLog(`onend — session lasted ${Date.now() - sessionStartedAt}ms, active=${isSpeakingActive}`);
      if (!isSpeakingActive) return;
      // A session that ends almost immediately without ever producing a result is a
      // failure, not a silence — restarting it forever just hides the real error.
      // A genuine quiet stretch still runs for a while before ending, so it doesn't
      // trip this counter.
      if (Date.now() - sessionStartedAt < FAILED_SESSION_MS) {
        failedRestarts++;
        if (failedRestarts >= MAX_FAILED_RESTARTS) {
          isSpeakingActive = false;
          debugLog(`GIVING UP after ${failedRestarts} immediate failed restarts`);
          setMicStatus('error', 'Recognition kept dropping as soon as it started.');
          showToast(
            'Speech recognition keeps failing to start on this device — try a different language, or Chrome on desktop. Settings → Diagnostics has the full log.',
            TOAST_STICKY
          );
          return;
        }
      } else {
        failedRestarts = 0;
      }
      scheduleMicDemotion('Reconnecting to the microphone…');
      restartTimer = setTimeout(() => {
        if (isSpeakingActive) {
          try {
            recognizer.start();
            sessionStartedAt = Date.now();
            armWatchdog();
          } catch (err) {
            console.error('restart failed', err);
          }
        }
      }, 250);
    };

    // Lifecycle logging: on iOS these are often the only way to tell "never started"
    // apart from "started but heard nothing". They double as the status-bar's source of
    // truth — onstart alone means the session opened, which isn't the same as audio
    // actually reaching it, so the reassuring "Live" only lands on onaudiostart.
    recognizer.onstart = () => {
      debugLog('onstart — session opened');
      // Silent when already live: this fires on every restart cycle, and repainting here
      // would strobe the bar exactly as onaudioend would (see MIC_DEMOTE_GRACE_MS).
      if (micState !== 'live') setMicStatus('starting', 'Session open, waiting for mic audio…');
    };
    recognizer.onaudiostart = () => {
      debugLog('onaudiostart — mic audio flowing');
      setMicStatus('live');
    };
    recognizer.onspeechstart = () => {
      debugLog('onspeechstart — speech detected');
      flashSpeechCue();
    };
    recognizer.onaudioend = () => {
      debugLog('onaudioend — mic audio stopped');
      if (isSpeakingActive) scheduleMicDemotion('Mic went quiet, reconnecting…');
    };
    recognizer.onnomatch = () => debugLog('onnomatch');

    isSpeakingActive = true;
    failedRestarts = 0;
    setMicStatus('starting');
    try {
      debugLog(`calling start() lang=${langCode}`);
      recognizer.start();
      sessionStartedAt = Date.now();
      armWatchdog();
      debugLog('start() returned without throwing');
    } catch (err) {
      debugLog(`start() THREW: ${err && err.name}: ${err && err.message}`);
      isSpeakingActive = false;
      setMicStatus('error', 'The browser refused to start speech recognition.');
      showToast(`Could not start speech recognition: ${err && err.message}. Tap Try again.`, TOAST_STICKY);
    }
    acquireWakeLock();
  }

  function armWatchdog() {
    if (!IS_IOS) return;
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (!isSpeakingActive || !recognizer) return;
      debugLog(`watchdog: no results in ${RECOGNITION_WATCHDOG_MS}ms — forcing restart`);
      try {
        recognizer.stop(); // triggers onend, which already handles restarting
      } catch {
        /* already stopped */
      }
    }, RECOGNITION_WATCHDOG_MS);
  }

  function stopRecognitionInternal() {
    clearTimeout(restartTimer);
    clearTimeout(watchdogTimer);
    clearTimeout(speechCueTimer);
    clearTimeout(demoteTimer);
    if (recognizer) {
      const r = recognizer;
      // Detach *every* handler, not just the ones that restart: a stray onaudioend from
      // the session we're killing would otherwise repaint the status bar as
      // "reconnecting" moments after the speaker deliberately paused.
      r.onend = null;
      r.onerror = null;
      r.onresult = null;
      r.onstart = null;
      r.onaudiostart = null;
      r.onspeechstart = null;
      r.onaudioend = null;
      r.onnomatch = null;
      try {
        r.stop();
      } catch {
        /* already stopped */
      }
      recognizer = null;
    }
  }

  function stopRecognition() {
    isSpeakingActive = false;
    clearTimeout(pauseTimer);
    flushBuffer();
    stopRecognitionInternal();
    releaseWakeLock();
  }

  function resetPauseTimer() {
    clearTimeout(pauseTimer);
    pauseTimer = setTimeout(flushBuffer, PAUSE_MS);
  }

  function flushBuffer() {
    clearTimeout(pauseTimer);
    const text = finalBuffer.trim();
    finalBuffer = '';
    if (!text) return;
    pushTranscriptSegment(text, currentSourceLang);
  }

  function pushTranscriptSegment(text, sourceLang) {
    const ref = transcriptRef.push();
    const ts = Date.now();
    const data = { id: ts, originalText: text, sourceLang, timestamp: ts };
    ref.set(data);

    const hint = document.getElementById('speaker-empty-hint');
    if (hint) hint.remove();
    // Rendered from the local push rather than by subscribing to the transcript. Firebase
    // fires child_added from its local cache for our own write, so a speaker-side
    // subscription would render every segment twice — and dropping this call in favour of
    // one would make the speaker's own captions depend on the listener's subscription
    // lifecycle. The key is the real push key so translations land in the shared cache
    // under the same id every other client uses.
    addFeedEntry(speakerFeed, ref.key || String(ts), data);
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* e.g. document not visible; ignore */
    }
  }

  function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSpeakingActive) acquireWakeLock();
  });

  /* ----- Transcript feeds (shared by both views) ----- */

  // Both views show the same thing — a running list of utterances, each available as spoken
  // and as translated — so they share one renderer. Everything that differs between them is
  // data on a feed object rather than a branch inside the renderer.
  //
  // The speaker's feed is why this is shared at all: it lets one person sitting next to the
  // speaker read a translation off the speaker's screen without opening the room on a device
  // of their own.
  //
  // "Which language do I want to read" is one preference per person, not per role, so
  // targetLang stays shared. The display mode is not: see STORAGE.
  let targetLang = localStorage.getItem(STORAGE.targetLang) || 'en-US';
  let feedGeneration = 0;
  let currentTranscriptHandler = null;

  const DISPLAY_MODES = ['translated', 'original', 'dual'];

  function makeFeed(opts) {
    // Anything unrecognised (an older build's value, a hand-edited localStorage) falls back
    // to the role's default rather than leaving every mode button unhighlighted.
    const stored = localStorage.getItem(opts.storageKey);
    return {
      mode: DISPLAY_MODES.includes(stored) ? stored : opts.defaultMode,
      // transcriptKey -> { wrapEl, originalCol, originalEl, translatedCol, translatedEl,
      //                    sameLang, sourceLang, originalText, translationStarted }
      entries: new Map(),
      // transcriptKey -> { ref, handler }. Per feed, so tearing one view down can never
      // detach a listener belonging to the other.
      translationListeners: new Map(),
      // Everything rendered so far, in order. Switching "Show in" rebuilds the pane from
      // this rather than refetching, which keeps the speaker's history across a language
      // change without racing fresh speech into the middle of a reload.
      segments: [],
      stickToBottom: true,
      ...opts,
    };
  }

  // The listener translates every segment as it arrives regardless of mode: toggling should
  // be instant, and someone in the room as a listener is there to read a translation.
  const listenerFeed = makeFeed({
    containerId: 'listener-feed',
    toggleId: 'listener-display-toggle',
    storageKey: STORAGE.listenerMode,
    defaultMode: 'translated',
    eager: true,
    showMeta: true,
    wrapClass: 'bg-white border border-slate-200 rounded-lg px-3 py-2',
  });

  // The speaker translates lazily. Its default mode shows originals, and a speaker with no
  // listeners would otherwise spend Gemini quota translating every sentence they say for an
  // audience of nobody. backfillTranslations() catches up when a mode that shows
  // translations is selected.
  const speakerFeed = makeFeed({
    containerId: 'speaker-captions',
    toggleId: 'speaker-display-toggle',
    storageKey: STORAGE.speakerMode,
    // The speaker's first use for this pane is confirming their own words were heard
    // correctly, so it opens showing what was actually recognised.
    defaultMode: 'original',
    eager: false,
    // No timestamp row. The speaker is watching their own words appear live, and on a phone
    // that row costs a line of height per utterance in the one pane they read while talking.
    showMeta: false,
    wrapClass: '',
  });

  // Emphasis follows the mode, not the column. In 'dual' the translation is the point and
  // the original is reference, so the original stays small and grey — but in 'original' that
  // column is the only thing on screen, and styling the sole content as a secondary column
  // turned the speaker's default view into a wall of small grey italics.
  const PRIMARY_TEXT = 'text-slate-900 text-base break-words';
  const SECONDARY_TEXT = 'text-slate-500 text-sm italic break-words';

  function resetFeed(feed) {
    const container = document.getElementById(feed.containerId);
    if (container) container.innerHTML = '';
    feed.entries.clear();
    feed.segments = [];
    feed.stickToBottom = true;
  }

  function detachFeedTranslations(feed) {
    for (const { ref, handler } of feed.translationListeners.values()) ref.off('value', handler);
    feed.translationListeners.clear();
  }

  function setupDisplayToggle(feed) {
    const group = document.getElementById(feed.toggleId);
    // Guarded like every other lookup here: a device holding a cached older index.html
    // against this app.js has no speaker toggle, and the speaker view has to keep working
    // without it rather than throwing on the way in and taking the recognizer with it.
    if (!group) return;
    for (const btn of group.querySelectorAll('button')) {
      btn.onclick = () => {
        feed.mode = btn.dataset.mode;
        try {
          localStorage.setItem(feed.storageKey, feed.mode);
        } catch {
          /* Safari private mode refuses writes; the choice just won't outlive the session */
        }
        updateToggleStyles(feed);
        for (const entry of feed.entries.values()) applyDisplayMode(feed, entry);
        backfillTranslations(feed);
      };
    }
    updateToggleStyles(feed);
  }

  function updateToggleStyles(feed) {
    const group = document.getElementById(feed.toggleId);
    if (!group) return;
    for (const btn of group.querySelectorAll('button')) {
      const active = btn.dataset.mode === feed.mode;
      btn.classList.toggle('bg-indigo-600', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('bg-white', !active);
      btn.classList.toggle('text-slate-600', !active);
    }
  }

  // A lazy feed skips translation while it is showing originals, so switching to a mode that
  // shows translations has to catch up whatever never started one. Without this, the
  // speaker's first tap on Translated reveals a column of "…" that never resolves — the
  // feature would look broken precisely when it was first tried.
  function backfillTranslations(feed) {
    if (feed.mode === 'original') return;
    for (const [key, entry] of feed.entries) {
      if (entry.sameLang || entry.translationStarted) continue;
      entry.translationStarted = true;
      ensureTranslation(feed, key, entry.sourceLang, targetLang, entry.originalText, entry.translatedEl);
    }
  }

  // Re-renders from feed.segments against the current targetLang. No network and no
  // subscription, so it cannot duplicate or reorder anything that arrives while it runs.
  function rebuildFeed(feed) {
    // Nothing rendered yet means nothing to re-render, and returning here leaves whatever
    // empty-state message the pane is showing in place instead of blanking it.
    if (feed.segments.length === 0) return;
    const segments = feed.segments;
    detachFeedTranslations(feed);
    resetFeed(feed);
    for (const { key, data } of segments) addFeedEntry(feed, key, data);
  }

  function addFeedEntry(feed, key, data) {
    const container = document.getElementById(feed.containerId);
    if (!container) return;
    const sameLang = data.sourceLang === targetLang;

    const wrap = document.createElement('div');
    wrap.className = feed.wrapClass;

    if (feed.showMeta) {
      const meta = document.createElement('div');
      meta.className = 'text-[11px] text-slate-400 mb-1';
      meta.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString();
      wrap.appendChild(meta);
    }

    const row = document.createElement('div');
    row.className = 'flex gap-3';

    const originalCol = document.createElement('div');
    originalCol.className = 'flex-1 min-w-0';
    const originalLabel = document.createElement('div');
    originalLabel.className = 'text-[10px] uppercase tracking-wide text-slate-400 mb-0.5';
    originalLabel.textContent = langName(data.sourceLang);
    const originalEl = document.createElement('p');
    originalEl.className = SECONDARY_TEXT;
    originalEl.textContent = data.originalText;
    originalCol.appendChild(originalLabel);
    originalCol.appendChild(originalEl);

    const translatedCol = document.createElement('div');
    translatedCol.className = 'flex-1 min-w-0';
    const translatedLabel = document.createElement('div');
    translatedLabel.className = 'text-[10px] uppercase tracking-wide text-slate-400 mb-0.5';
    translatedLabel.textContent = langName(targetLang);
    const translatedEl = document.createElement('p');
    translatedEl.className = PRIMARY_TEXT;
    translatedEl.textContent = sameLang ? data.originalText : '…';
    if (!sameLang) translatedEl.classList.add('animate-pulse');
    translatedCol.appendChild(translatedLabel);
    translatedCol.appendChild(translatedEl);

    row.appendChild(originalCol);
    row.appendChild(translatedCol);
    wrap.appendChild(row);

    container.appendChild(wrap);
    if (feed.stickToBottom) container.scrollTop = container.scrollHeight;

    const entry = {
      wrapEl: wrap,
      originalCol,
      originalEl,
      translatedCol,
      translatedEl,
      sameLang,
      sourceLang: data.sourceLang,
      originalText: data.originalText,
      translationStarted: false,
    };
    feed.entries.set(key, entry);
    feed.segments.push({ key, data });
    applyDisplayMode(feed, entry);

    if (!sameLang && (feed.eager || feed.mode !== 'original')) {
      entry.translationStarted = true;
      ensureTranslation(feed, key, data.sourceLang, targetLang, data.originalText, translatedEl);
    }
  }

  function applyDisplayMode(feed, entry) {
    if (entry.sameLang) {
      entry.originalCol.classList.add('hidden');
      entry.translatedCol.classList.remove('hidden', 'border-l', 'border-slate-100', 'pl-3');
      return;
    }
    const dual = feed.mode === 'dual';
    entry.originalCol.classList.toggle('hidden', feed.mode === 'translated');
    entry.translatedCol.classList.toggle('hidden', feed.mode === 'original');
    entry.originalEl.className = feed.mode === 'original' ? PRIMARY_TEXT : SECONDARY_TEXT;
    // Only show the divider between columns when both are visible side by side.
    entry.translatedCol.classList.toggle('border-l', dual);
    entry.translatedCol.classList.toggle('border-slate-100', dual);
    entry.translatedCol.classList.toggle('pl-3', dual);
  }

  // Shown when "Show in" matches what is being spoken: every mode then renders the same
  // single column, so the toggle looks broken unless something says why.
  function refreshSameLangHint() {
    const hint = document.getElementById('speaker-samelang-hint');
    if (hint) hint.classList.toggle('hidden', targetLang !== currentSourceLang);
  }

  /* ----- Listener view ----- */

  // Wraps handleTranscriptChildAdded so any child_added events still in flight from a
  // subscription we just tore down (e.g. mid target-language switch) get dropped instead
  // of repopulating a feed we already cleared.
  function attachTranscriptSubscription() {
    feedGeneration++;
    const myGeneration = feedGeneration;
    currentTranscriptHandler = (snap) => {
      if (myGeneration !== feedGeneration) return;
      handleTranscriptChildAdded(snap);
    };
    transcriptRef.limitToLast(300).on('child_added', currentTranscriptHandler);
  }

  function detachTranscriptSubscription() {
    if (currentTranscriptHandler) {
      transcriptRef.off('child_added', currentTranscriptHandler);
      currentTranscriptHandler = null;
    }
  }

  function renderListenerView() {
    showView('view-listener');
    // Recorded on arrival rather than on leaving, so the room is already in the list no
    // matter how the visitor departs — Leave button, closed tab, or a dropped connection.
    recordRecentRoom(roomId, 'listener');
    resetFeed(listenerFeed);

    const select = document.getElementById('listener-lang-select');
    select.innerHTML = '';
    for (const lang of LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      select.appendChild(opt);
    }
    select.value = targetLang;
    select.onchange = () => {
      targetLang = select.value;
      localStorage.setItem(STORAGE.targetLang, targetLang);
      rebuildFeedForNewTargetLang();
    };

    setupDisplayToggle(listenerFeed);

    const feedEl = document.getElementById('listener-feed');
    feedEl.onscroll = () => {
      const threshold = 40;
      listenerFeed.stickToBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < threshold;
    };

    document.getElementById('btn-leave-room').onclick = () => {
      // To the lobby, not straight into a freshly minted room. Leaving used to discard the
      // only copy of the room id — the one in the URL — so a listener who tapped this by
      // mistake had no way back that didn't involve knowing to press the browser's Back
      // button. The lobby offers the room they just left as a labelled button instead.
      location.href = urlForRoom(null);
    };

    stateRef.on('value', listenerStateHandler);
    attachTranscriptSubscription();
  }

  function listenerStateHandler(snap) {
    const isLive = !!(snap.val() && snap.val().isLive);
    document.getElementById('listener-waiting-banner').classList.toggle('hidden', isLive);
  }

  function teardownListenerView() {
    stateRef.off('value', listenerStateHandler);
    detachTranscriptSubscription();
    detachFeedTranslations(listenerFeed);
  }

  function handleTranscriptChildAdded(snap) {
    const key = snap.key;
    const data = snap.val();
    if (!data) return;
    addFeedEntry(listenerFeed, key, data);
  }

  // The listener repopulates from Firebase rather than from feed.segments: it has a live
  // subscription and up to 300 segments of room history behind it, so a re-subscribe brings
  // back more than this client happened to have rendered.
  function rebuildFeedForNewTargetLang() {
    teardownListenerView();
    resetFeed(listenerFeed);
    stateRef.on('value', listenerStateHandler);
    attachTranscriptSubscription();
  }

  // Shared translation cache: claim-by-transaction so only one client per language calls
  // Gemini for a given segment; everyone else just watches. The speaker's own feed goes
  // through here too, so a speaker reading along in the same language a listener chose adds
  // no extra Gemini calls — it watches the value the listener already paid for.
  function ensureTranslation(feed, transcriptKey, sourceLang, target, originalText, translatedEl) {
    const tRef = translationsRef.child(transcriptKey).child(target);
    let attempted = false;

    const handler = (snap) => {
      const val = snap.val();
      if (typeof val === 'string') {
        translatedEl.textContent = val;
        translatedEl.classList.remove('animate-pulse');
        return;
      }
      if (val && val.status === 'pending') {
        if (!attempted) scheduleStaleCheck();
        return;
      }
      attemptClaim();
    };
    tRef.on('value', handler);
    feed.translationListeners.set(transcriptKey, { ref: tRef, handler });

    function scheduleStaleCheck() {
      attempted = true;
      setTimeout(() => {
        tRef.once('value').then((snap) => {
          const val = snap.val();
          if (val && val.status === 'pending' && Date.now() - val.ts > STALE_PENDING_MS) {
            attemptClaim(true);
          }
        });
      }, STALE_PENDING_MS + 250);
    }

    function attemptClaim(isTakeover) {
      tRef
        .transaction((current) => {
          if (current == null) return { status: 'pending', ts: Date.now() };
          if (isTakeover && current.status === 'pending' && Date.now() - current.ts > STALE_PENDING_MS) {
            return { status: 'pending', ts: Date.now() };
          }
          return; // abort: already claimed (fresh) or already translated
        })
        .then(({ committed }) => {
          if (!committed) return;
          translateWithGemini(originalText, sourceLang, target)
            .then((translated) => tRef.set(translated))
            .catch((err) => {
              console.error('translation failed', err);
              translatedEl.textContent = originalText; // local fallback so this listener isn't stuck on "…"
              translatedEl.classList.remove('animate-pulse');
              // Back-date the pending marker instead of clearing it, so a persistent failure
              // (e.g. bad API key) waits for the staleness window before any retry, rather
              // than this same listener re-claiming and re-failing in a tight loop.
              tRef.set({ status: 'pending', ts: Date.now() - STALE_PENDING_MS });
            });
        })
        .catch((err) => console.error(err));
    }
  }
}

/* ---------- Gemini translation ---------- */

async function translateWithGemini(text, sourceLang, targetLang) {
  const apiKey = loadGeminiKey();
  if (!apiKey) throw new Error('No Gemini API key configured.');

  const prompt = `Translate this text from ${langName(sourceLang)} to ${langName(targetLang)}. Return ONLY the translated text, with no quotation marks or extra commentary.\n\nText: ${text}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Key goes in a header, not the URL, so it doesn't end up in browser history,
      // proxy access logs, or anywhere else that only records request URLs.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`Gemini ${res.status}`), { retryable: true });
      }
      if (!res.ok) {
        const errText = await res.text();
        throw Object.assign(new Error(`Gemini error ${res.status}: ${errText}`), { retryable: false });
      }
      const data = await res.json();
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!out) throw Object.assign(new Error('Empty Gemini response'), { retryable: true });
      return out.trim();
    } catch (err) {
      if (attempt >= maxAttempts || err.retryable === false) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Gemini translation failed after retries.');
}
