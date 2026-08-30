'use strict';

/* ---------- Config ---------- */

const LANGUAGES = [
  { code: 'bs-BA', name: 'Bosnian' },
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
// Bumped by hand whenever app.js changes in a way a tester needs to confirm reached
// their device. GitHub Pages + iOS Safari cache aggressively enough that "did the new
// code actually load?" is otherwise unanswerable from a phone.
const BUILD_STAMP = 'build 2026-08-30 diag-2';
// A recognition session ending sooner than this without any result is treated as a
// failure to start rather than a silence, so we stop retrying and surface the error.
const FAILED_SESSION_MS = 1500;
const MAX_FAILED_RESTARTS = 8;

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

function resolveRoomId() {
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room');
  if (!roomId) {
    roomId = generateRoomId();
    params.set('room', roomId);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
  }
  return roomId;
}

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
    showToast('Could not read credentials from this link.');
  } finally {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

/* ---------- Toast ---------- */

let toastTimer = null;
function showToast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// Runs after showToast's own state (toastTimer) is initialized (a successful or failed
// import both report through showToast), but before resolveRoomId() below, since that also
// calls history.replaceState and would otherwise be able to strip our hash first.
importCredsFromHash();

const clientId = getClientId();
const roomId = resolveRoomId();

/* ---------- View switching ---------- */

const VIEW_IDS = ['view-loading', 'view-config-required', 'view-chooser', 'view-speaker', 'view-listener'];
function showView(id) {
  for (const vid of VIEW_IDS) {
    document.getElementById(vid).classList.toggle('hidden', vid !== id);
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
      showToast('Press Ctrl/Cmd+C to copy.');
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

/* ---------- Bootstrap ---------- */

showView('view-loading');

const firebaseConfig = loadFirebaseConfig();
if (!firebaseConfig) {
  showView('view-config-required');
} else {
  try {
    firebase.initializeApp(firebaseConfig);
    startApp();
  } catch (err) {
    console.error(err);
    showView('view-config-required');
    showToast('Could not connect to Firebase — check your config in Settings.');
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
      if (includeCreds.checked) showToast("This link/QR carries your credentials — anyone who has it can use your Gemini quota.", 5000);
      updateChooserShare();
    };
    updateChooserShare();

    document.getElementById('btn-start-speaker').onclick = claimSpeaker;
    document.getElementById('btn-join-listener').onclick = () => {
      currentRoute = 'listener';
      renderListenerView();
    };
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
        showToast('Microphone access denied — allow it in your browser/device settings to speak.');
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
          showToast('Could not start the room. Check your Firebase config.');
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

  function renderSpeakerView() {
    showView('view-speaker');
    document.getElementById('speaker-share-panel').classList.add('hidden');
    document.getElementById('speaker-captions').innerHTML = '<p class="text-slate-400 text-sm" id="speaker-empty-hint">Start talking — your speech will appear here and be sent to listeners.</p>';
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

    const speakerIncludeCreds = document.getElementById('speaker-include-creds');
    speakerIncludeCreds.checked = false;
    const updateSpeakerShare = () => {
      const url = shareUrl(roomId, speakerIncludeCreds.checked);
      document.getElementById('speaker-share-link').value = url;
      renderQr('speaker-qrcode', url);
    };
    speakerIncludeCreds.onchange = () => {
      if (speakerIncludeCreds.checked) showToast("This link/QR carries your credentials — anyone who has it can use your Gemini quota.", 5000);
      updateSpeakerShare();
    };
    updateSpeakerShare();
    document.getElementById('btn-toggle-share').onclick = () => {
      document.getElementById('speaker-share-panel').classList.toggle('hidden');
    };

    // Defensive: a device can hold cached index.html while loading fresh app.js, so
    // these elements may not exist. Letting that throw here would abort the rest of
    // renderSpeakerView — including startRecognition() below — and the resulting
    // silence would look exactly like the recognition bug this panel exists to find.
    try {
      const stamp = document.getElementById('debug-build-stamp');
      if (stamp) stamp.textContent = BUILD_STAMP;
      const toggleBtn = document.getElementById('btn-toggle-debug');
      if (!toggleBtn) {
        // No Debug button in the DOM means this device is running an older index.html
        // than app.js — say so, rather than letting it masquerade as a mic failure.
        showToast('Stale page cached — close this tab entirely and reopen the link to get the current version.', 8000);
      }
      if (toggleBtn) {
        toggleBtn.onclick = () => {
          document.getElementById('speaker-debug-panel')?.classList.toggle('hidden');
          const log = document.getElementById('speaker-debug-log');
          if (log) log.textContent = debugLines.join('\n');
        };
      }
      const clearBtn = document.getElementById('btn-clear-debug');
      if (clearBtn) {
        clearBtn.onclick = () => {
          debugLines.length = 0;
          const log = document.getElementById('speaker-debug-log');
          if (log) log.textContent = '';
        };
      }
      const copyBtn = document.getElementById('btn-copy-debug');
      if (copyBtn) {
        copyBtn.onclick = () => {
          const text = `${BUILD_STAMP}\n${navigator.userAgent}\n\n${debugLines.join('\n')}`;
          navigator.clipboard?.writeText(text).then(
            () => showToast('Debug log copied.'),
            () => showToast('Could not copy — select the text manually.')
          );
        };
      }
    } catch (err) {
      console.error('debug panel wiring failed', err);
    }

    debugLog(`speaker view ready — ${BUILD_STAMP}`);
    debugLog(`iOS=${IS_IOS} ctor=${getSpeechRecognitionCtor() ? 'present' : 'MISSING'}`);

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

  function closeRoom() {
    flushBuffer(); // send any trailing sentence while the room is still marked live
    stateRef.set({ isLive: false, speakerId: null });
  }

  function changeSpeakingLanguage(newLang) {
    flushBuffer();
    currentSourceLang = newLang;
    if (isSpeakingActive) startRecognition(newLang);
  }

  const debugLines = [];

  function debugLog(message) {
    const stamp = new Date().toISOString().slice(11, 23);
    const line = `${stamp}  ${message}`;
    debugLines.push(line);
    if (debugLines.length > 200) debugLines.shift();
    console.info('[rtt]', line);
    const el = document.getElementById('speaker-debug-log');
    if (el) {
      el.textContent = debugLines.join('\n');
      el.scrollTop = el.scrollHeight;
    }
  }

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition;
  }

  function startRecognition(langCode) {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      showToast('Speech recognition is not supported in this browser. Try Chrome.');
      return;
    }
    stopRecognitionInternal();

    recognizer = new Ctor();
    recognizer.lang = langCode;
    recognizer.continuous = true;
    recognizer.interimResults = true;

    recognizer.onresult = (event) => {
      armWatchdog();
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
        showToast('Microphone access denied — check this site’s microphone permission in your browser settings.');
      } else if (event.error === 'service-not-allowed') {
        isSpeakingActive = false;
        // On iOS this fires when Dictation is off system-wide, even if mic permission is granted.
        showToast('Speech recognition service blocked — on iPhone/iPad check Settings → General → Keyboard → Enable Dictation.');
      } else if (event.error === 'language-not-supported') {
        isSpeakingActive = false;
        // Apple's recognizer supports far fewer locales than Google's, so a language
        // that works in desktop Chrome can be fatal on iOS.
        showToast(`“${langName(langCode)}” isn’t supported for speech on this device — pick another language.`, 6000);
      } else if (event.error === 'audio-capture') {
        isSpeakingActive = false;
        showToast('No microphone available — check that nothing else is using it.');
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
          showToast('Speech recognition keeps failing to start on this device — try a different language, or Chrome on desktop.', 6000);
          return;
        }
      } else {
        failedRestarts = 0;
      }
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
    // apart from "started but heard nothing".
    recognizer.onstart = () => debugLog('onstart — session opened');
    recognizer.onaudiostart = () => debugLog('onaudiostart — mic audio flowing');
    recognizer.onspeechstart = () => debugLog('onspeechstart — speech detected');
    recognizer.onaudioend = () => debugLog('onaudioend — mic audio stopped');
    recognizer.onnomatch = () => debugLog('onnomatch');

    isSpeakingActive = true;
    failedRestarts = 0;
    try {
      debugLog(`calling start() lang=${langCode}`);
      recognizer.start();
      sessionStartedAt = Date.now();
      armWatchdog();
      debugLog('start() returned without throwing');
    } catch (err) {
      debugLog(`start() THREW: ${err && err.name}: ${err && err.message}`);
    }
    acquireWakeLock();
  }

  function armWatchdog() {
    if (!IS_IOS) return;
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (!isSpeakingActive || !recognizer) return;
      console.warn('speech recognition watchdog: no results in', RECOGNITION_WATCHDOG_MS, 'ms — forcing restart');
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
    if (recognizer) {
      const r = recognizer;
      r.onend = null;
      r.onerror = null;
      r.onresult = null;
      r.onstart = null;
      r.onaudiostart = null;
      r.onspeechstart = null;
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
    ref.set({ id: ts, originalText: text, sourceLang, timestamp: ts });

    const hint = document.getElementById('speaker-empty-hint');
    if (hint) hint.remove();
    const captions = document.getElementById('speaker-captions');
    const line = document.createElement('p');
    line.className = 'text-sm text-slate-700';
    line.textContent = text;
    captions.appendChild(line);
    captions.scrollTop = captions.scrollHeight;
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

  /* ----- Listener view ----- */

  let displayMode = 'translated'; // 'translated' | 'original' | 'dual'
  let targetLang = localStorage.getItem(STORAGE.targetLang) || 'en-US';
  let stickToBottom = true;
  let feedGeneration = 0;
  let currentTranscriptHandler = null;
  const activeTranslationListeners = new Map(); // transcriptKey -> { ref, handler }
  const entryElements = new Map(); // transcriptKey -> { wrapEl, originalCol, translatedCol, translatedEl, sameLang }

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
    document.getElementById('listener-feed').innerHTML = '';
    entryElements.clear();
    stickToBottom = true;

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

    setupDisplayToggle();

    const feedEl = document.getElementById('listener-feed');
    feedEl.onscroll = () => {
      const threshold = 40;
      stickToBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < threshold;
    };

    document.getElementById('btn-leave-room').onclick = () => {
      location.href = location.pathname; // fresh room, drops ?room= so we land on a new one
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
    for (const { ref, handler } of activeTranslationListeners.values()) {
      ref.off('value', handler);
    }
    activeTranslationListeners.clear();
  }

  function setupDisplayToggle() {
    const group = document.getElementById('listener-display-toggle');
    for (const btn of group.querySelectorAll('button')) {
      btn.onclick = () => {
        displayMode = btn.dataset.mode;
        updateToggleStyles();
        for (const el of entryElements.values()) applyDisplayMode(el);
      };
    }
    updateToggleStyles();
  }

  function updateToggleStyles() {
    const group = document.getElementById('listener-display-toggle');
    for (const btn of group.querySelectorAll('button')) {
      const active = btn.dataset.mode === displayMode;
      btn.classList.toggle('bg-indigo-600', active);
      btn.classList.toggle('text-white', active);
      btn.classList.toggle('bg-white', !active);
      btn.classList.toggle('text-slate-600', !active);
    }
  }

  function handleTranscriptChildAdded(snap) {
    const key = snap.key;
    const data = snap.val();
    if (!data) return;
    addFeedEntry(key, data);
  }

  function addFeedEntry(key, data) {
    const sameLang = data.sourceLang === targetLang;

    const wrap = document.createElement('div');
    wrap.className = 'bg-white border border-slate-200 rounded-lg px-3 py-2';

    const meta = document.createElement('div');
    meta.className = 'text-[11px] text-slate-400 mb-1';
    meta.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString();

    const row = document.createElement('div');
    row.className = 'flex gap-3';

    const originalCol = document.createElement('div');
    originalCol.className = 'flex-1 min-w-0';
    const originalLabel = document.createElement('div');
    originalLabel.className = 'text-[10px] uppercase tracking-wide text-slate-400 mb-0.5';
    originalLabel.textContent = langName(data.sourceLang);
    const originalEl = document.createElement('p');
    originalEl.className = 'text-slate-500 text-sm italic break-words';
    originalEl.textContent = data.originalText;
    originalCol.appendChild(originalLabel);
    originalCol.appendChild(originalEl);

    const translatedCol = document.createElement('div');
    translatedCol.className = 'flex-1 min-w-0';
    const translatedLabel = document.createElement('div');
    translatedLabel.className = 'text-[10px] uppercase tracking-wide text-slate-400 mb-0.5';
    translatedLabel.textContent = langName(targetLang);
    const translatedEl = document.createElement('p');
    translatedEl.className = 'text-slate-900 text-base break-words';
    translatedEl.textContent = sameLang ? data.originalText : '…';
    if (!sameLang) translatedEl.classList.add('animate-pulse');
    translatedCol.appendChild(translatedLabel);
    translatedCol.appendChild(translatedEl);

    row.appendChild(originalCol);
    row.appendChild(translatedCol);

    wrap.appendChild(meta);
    wrap.appendChild(row);

    const feedEl = document.getElementById('listener-feed');
    feedEl.appendChild(wrap);
    if (stickToBottom) feedEl.scrollTop = feedEl.scrollHeight;

    const entry = { wrapEl: wrap, originalCol, translatedCol, translatedEl, sameLang };
    entryElements.set(key, entry);
    applyDisplayMode(entry);

    if (!sameLang) {
      ensureTranslation(key, data.sourceLang, targetLang, data.originalText, translatedEl);
    }
  }

  function applyDisplayMode(entry) {
    if (entry.sameLang) {
      entry.originalCol.classList.add('hidden');
      entry.translatedCol.classList.remove('hidden', 'border-l', 'border-slate-100', 'pl-3');
      return;
    }
    const dual = displayMode === 'dual';
    entry.originalCol.classList.toggle('hidden', displayMode === 'translated');
    entry.translatedCol.classList.toggle('hidden', displayMode === 'original');
    // Only show the divider between columns when both are visible side by side.
    entry.translatedCol.classList.toggle('border-l', dual);
    entry.translatedCol.classList.toggle('border-slate-100', dual);
    entry.translatedCol.classList.toggle('pl-3', dual);
  }

  function rebuildFeedForNewTargetLang() {
    teardownListenerView();
    document.getElementById('listener-feed').innerHTML = '';
    entryElements.clear();
    stateRef.on('value', listenerStateHandler);
    attachTranscriptSubscription();
  }

  // Shared translation cache: claim-by-transaction so only one listener per
  // language calls Gemini for a given segment; everyone else just watches.
  function ensureTranslation(transcriptKey, sourceLang, target, originalText, translatedEl) {
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
    activeTranslationListeners.set(transcriptKey, { ref: tRef, handler });

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
