# Live Translate

Real-time, multi-language live transcription and translation for a speaker-to-many-listeners
session (talks, sermons, meetings, classes). Runs 100% client-side — no custom backend — so it
can be hosted for free on GitHub Pages. Firebase Realtime Database handles pub/sub between the
speaker and listeners, and the Gemini API handles translation.

## How it works

- **Lobby.** Opening the app with no `?room=` in the URL shows a lobby: **Start a new room**, plus
  a single list of up to five rooms you've been in, newest first and tinted (tap to reopen, ✕ to
  forget). A room id exists nowhere but the URL, so this list is the only thing that makes leaving
  a room reversible — the alternative is remembering to press the browser's Back button. The list
  lives in this browser's `localStorage` only: it's your own history of where you've been, not a
  directory of rooms, and it's never uploaded anywhere. Rooms are recorded when you actually enter
  one as speaker or listener. (The newest room briefly had its own separate "Rejoin" button above
  the list. It was dropped: it led exactly where tapping the first row leads, and because the ✕
  lived only on rows, the most recent room was the one room that could never be forgotten.)
- **One URL, two roles.** Anyone who opens `index.html?room=abc123` sees "Start as Speaker" or
  "Join as Listener." Whoever taps "Start as Speaker" first wins the room (a Firebase transaction
  prevents two people from both becoming the speaker). If the room is already live, new visitors
  land directly in the Listener view.
- **Speaker** picks their spoken language, and the browser's Web Speech API transcribes
  continuously, buffering until a sentence ends (`.`/`?`/`!`) or 3.5s of silence, then pushes the
  segment to Firebase.
- **Mic status bar.** A colour-coded bar under the speaker's controls shows whether audio is
  actually reaching the recognizer — grey "Starting", green "Live" (flashing "Hearing you…" as
  you speak), amber "Paused", red "Mic unavailable" — with a **Pause / Resume** button. Pausing
  sends any half-finished sentence, stops the mic, and releases the screen wake lock, but leaves
  the room open and listeners connected; Resume picks the mic back up. In the red state the
  button becomes **Try again**. Recognition still starts on its own when the speaker view opens —
  pause is an override, not a prerequisite. Dropping *out* of the green state is deferred ~2s,
  because iOS Safari ends and restarts recognition sessions between sentences and repainting on
  every cycle would make a healthy mic strobe; a genuine stall still surfaces. A pause is visible
  only to the speaker — listeners see a quiet room, not a "paused" notice.
- **Leaving a room** takes the listener back to the lobby rather than into a freshly generated
  empty room, so the room they just left is one tap away. It doesn't affect anyone else — the
  speaker and other listeners carry on.
- **Ending a session** (the speaker's red **End session** button) is the one control that affects
  everybody: it clears `isLive` and `speakerId`, which disconnects every listener. It takes two
  taps — the button arms itself, reading "End for everyone?", and disarms after 5s — because it
  sits in a crowded header within a thumb's width of the language picker. It deliberately does
  **not** navigate anywhere; see the note under *Ending a session must not navigate* below.
  Afterwards everyone lands on the room's chooser screen, which is also the handoff: `speakerId`
  is now null, so the next person to tap **Start as Speaker** wins the room. There is no separate
  "leave" for the speaker, because there is no state it could produce — `onDisconnect` clears
  `isLive` the moment the speaker's socket drops, so a speaker walking away always ends the
  broadcast. Two buttons would imply a difference that cannot exist.
- **The chooser has an exit** (**← Back to my rooms**). Three paths land there — you ended your own
  session, a speaker ended one you were listening to, or you opened a link to a room nobody has
  started — and the listener's own Leave button belongs to a view that is hidden by then.
- **Listener** picks their own reading language independently. If it matches the speaker's
  language, the original text is shown immediately with no API calls. Otherwise, the first
  listener to need a given translation calls the Gemini API and writes the result back to
  Firebase — every other listener reading the same language then loads it from the cache instead
  of calling Gemini again.
- Supported languages: Bosnian, Chinese, Croatian, Dutch, English, French, German, Korean, Polish,
  Serbian, Spanish, Ukrainian, Urdu.

## Files

- `index.html` — markup and Tailwind (via CDN) styling.
- `app.js` — all application logic (routing, lobby, Speech Recognition, Firebase, Gemini calls).
- No build step, no `node_modules`, no server code.

The single-file `app.js` and the absence of a build step are deliberate rather than accidental.
Deploying is `git push`, and testing on a phone is "reload the page" — introducing a compile step
(a framework, or bundled modules) would put a CI job between writing a line and being able to try
it on a device, which is the only way this app gets tested. Native ES modules would avoid the
build step but not the other cost: a relative `import` from `app.js?v=7` resolves to
`./speech.js` with **no** query string, so submodules fall outside the cache-busting scheme below
and a phone could pair a fresh `app.js` with a stale module. If the file does get split later,
carry the version through with dynamic `import()` so there's one source of truth for it.

## 1. Set up Firebase (Realtime Database)

1. Go to the [Firebase console](https://console.firebase.google.com/) and create a project (or
   reuse one).
2. In the project, open **Build → Realtime Database** and click **Create Database**. Pick any
   region. Newer Firebase projects default to **locked mode** (`".read": false, ".write": false`)
   even if you pick "test mode" — this app has no login, so with locked rules every read/write
   fails with `permission_denied` in the console. Go to the **Rules** tab and publish:
   ```json
   { "rules": { "rooms": { "$roomId": { ".read": true, ".write": true } } } }
   ```
   See [Security](#security--things-to-know) below before sharing the link widely.
3. Open **Project settings → General**, scroll to "Your apps," and add a **Web app** (`</>`).
   Copy the `firebaseConfig` object it gives you — you'll paste this into the app's Settings
   modal. It must include `databaseURL` (this is what identifies the Realtime Database instance;
   Firestore-only configs won't have it).

## 2. Get a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/) and create an API key.
2. Keep it handy for the Settings modal, same as the Firebase config.

## 3. Run it locally

Because the app uses `fetch`/ES features that behave better over HTTP than `file://`, serve the
folder instead of double-clicking `index.html`:

```bash
cd "Real Time Translation"
python3 -m http.server 8080
# open http://localhost:8080/index.html
```

On first load you'll be dropped into a **Settings** modal (gear icon, top right). Paste in your
Firebase config JSON and Gemini API key, then **Save & Reload**. Both are stored only in
`localStorage` in your browser — nothing is sent anywhere except Firebase and Google's API when
actually translating.

Open the same URL in a second tab (or use the QR code / "Copy" link shown on screen) to test the
speaker/listener flow against yourself — one tab as speaker, one as listener.

## 4. Deploy to GitHub Pages

1. Push `index.html`, `app.js`, and this `README.md` to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under "Build and deployment," set **Source** to `Deploy from a branch`, pick your default
   branch (e.g. `main`) and `/ (root)`, then **Save**.
4. GitHub gives you a URL like `https://<username>.github.io/<repo>/`. Share
   `https://<username>.github.io/<repo>/index.html?room=mytalk` — anyone who opens it can start
   or join that room. Each visitor configures their own Firebase/Gemini credentials once via the
   Settings modal (or you can tell everyone to reuse the same project's config, since it's just a
   read/write endpoint, not a login).

## Optional: skip Settings for listeners

By design, everyone who opens the link configures their own Firebase/Gemini credentials once,
stored in their own browser. If you'd rather hand out a link/QR that just works with nothing to
configure, check **"Include my Firebase/Gemini credentials in this link & QR"** under the share
QR on the Chooser or Speaker screen — it packs your saved config into the URL's `#setup=` hash
(never sent to any server, unlike a query param) and gets picked up automatically on load, so
whoever opens it doesn't need to touch Settings. This is opt-in and off by default; only use it
with a QR/link you control the audience for (see [Security](#security--things-to-know) below —
your Gemini key travels with it).

## Security & things to know

- **The Gemini API key is visible to every listener.** It's embedded in client-side requests, so
  anyone with devtools open can read it from network traffic. This is inherent to a zero-backend
  architecture, not a bug — use a key you're comfortable exposing, and consider setting a quota /
  budget alert on it in Google AI Studio.
- **The "include credentials" link/QR makes that exposure easier to reach.** Your Firebase config
  isn't meant to be secret (Firebase's own access control is the Database Rules, not the config
  values), but your Gemini key is tied to your quota/billing — anyone who scans that QR gets it
  permanently in their browser's `localStorage`. Use a dedicated, quota-capped Gemini key for any
  event where you generate one of these links, and only display the QR to people you intend as
  listeners.
- **Realtime Database test-mode rules allow anyone to read/write.** That's fine for a talk or demo
  with a random room ID, but don't leave it open indefinitely for anything sensitive. At minimum,
  consider rules that expire, or that restrict writes to `/rooms/$roomId/*` paths only.
- **Because the database is world-writable, anyone who has (or brute-forces) a room ID can burn
  your Gemini quota** — they don't need the app's UI at all; a single write straight to
  `/rooms/$roomId/transcript` via Firebase's REST API is enough, since every listener in the room
  automatically calls Gemini to translate whatever text shows up there. Room IDs are only 6
  base36 characters (~2 billion possibilities), which is fine against casual guessing but not
  against a determined, scripted attacker. This is another reason to use a dedicated, budget-capped
  Gemini key, and to close/rotate rooms after each use rather than leaving them open long-term.
- **The Gemini API key is sent as a request header (`x-goog-api-key`), not a URL query parameter**,
  so it won't show up in browser history or in any logging system that only records request URLs
  (proxies, some analytics). It's still visible in the request body/headers to anyone with devtools
  open on that machine — see the point above.
- **The Firebase and QR-code `<script>` tags are pinned to specific versions with Subresource
  Integrity (SRI) hashes**, so the page will refuse to run them if a CDN ever served something
  other than the exact bytes this app was built against. The Tailwind CSS `<script>` is loaded from
  its official "Play CDN," which is not version-pinned by design (it compiles utility classes on
  the fly) — Tailwind's own docs call this unsuitable for production. It's used here anyway to keep
  the "no build step" promise above; if you want SRI/CSP-friendliness for Tailwind too, you'd need
  to switch to a compiled, versioned Tailwind CSS file, which does require a build step.
- **Not implemented here: a Content-Security-Policy.** A `<meta http-equiv="Content-Security-Policy">`
  tag would meaningfully reduce the impact of any future script-injection bug, and works fine on
  static hosting like GitHub Pages. It wasn't added in this pass because getting the `connect-src`
  allowlist right for Firebase Realtime Database requires knowing the exact regional database
  hostname(s) in use (e.g. `*.firebasedatabase.app`, `*.firebaseio.com`) and this repo can't be
  tested end-to-end against a real Firebase project from here — a wrong allowlist would silently
  break the app for real users. Worth adding and testing yourself if you want defense in depth.
- **Speech Recognition requires Chrome (or another browser with Web Speech API support)** and a
  mic permission grant on the Speaker's device. It also needs a real network connection — it's a
  cloud API under the hood, not fully offline.
- **The speaker's language list is limited by the device, not by this app.** Recognition runs on
  whatever engine the browser provides, and those engines don't support the same languages. Chrome
  uses Google's recognizer (a long list); Safari on iOS/macOS uses Apple's, which is considerably
  shorter — notably it has **no Bosnian and no Serbian** model. Picking an unsupported language on
  iOS fails immediately with `service-not-allowed`, which is the same error WebKit reports when
  Dictation is disabled system-wide or when the page is running as a Home Screen web app, so the
  message the app shows names all three possibilities.
  - Because Bosnian and Croatian are mutually intelligible and both Latin-script, a speaker who
    picks **Bosnian** on a device without it automatically falls back to **Croatian recognition**,
    with a notice. Transcripts stay tagged as Bosnian, so translation for listeners is unaffected.
  - **Serbian deliberately has no such fallback**, because it's normally written in Cyrillic and a
    Croatian recognizer would emit Latin text — the wrong alphabet rather than a near-identical one.
  - There is no portable way to ask a browser which recognition languages it has. The spec's
    `SpeechRecognition.available()` does exactly this but is Chrome-only, and therefore absent on
    precisely the platform where the limitation bites. The listener list is unaffected either way,
    since translation goes through Gemini rather than the device.
- **Diagnostics live in Settings.** The gear menu has a collapsed "Diagnostics" section holding a
  timestamped log of the speech-recognition lifecycle (`onstart` / `onaudiostart` / `onerror` /
  restarts), the build stamp, and a **Copy** button that bundles the log with the browser's user
  agent. This is the only practical way to debug speech recognition on an iPhone, where the
  console is unreachable without a tethered Mac — so it ships in production rather than being
  stripped, since the failures it diagnoses are device-specific by nature. It's read-only and
  exposes no credentials.
- **Forcing a fresh copy after a deploy.** iOS Safari will happily serve a cached `index.html`
  and `app.js` for a long time. The `<script src="app.js?v=N">` query busts the script — but only
  once the *new* `index.html` has loaded, since a cached page still points at the old `?v=`. So
  the page is the one that needs the nudge: append `&cb=N` (any changing value), then confirm the
  build stamp under **Settings → Diagnostics** matches what you just shipped before you trust a
  test result. Every navigation *inside* the app (Leave, Start a new room, Back to my rooms,
  reopening a listed room) preserves whatever query parameters are already in the URL, so a `cb`
  you added survives those hops instead of silently dropping you back onto the cached build.
- **Ending a session must not navigate.** `closeRoom()` writes `{isLive:false, speakerId:null}`
  and stops. It is tempting to send the speaker to the lobby on the same tap; don't. Firebase
  applies the write to its local cache and fires the `value` listener *before* the network write
  flushes, and that listener runs `teardownSpeakerView()`, which cancels the `onDisconnect`
  backstop. Unloading the page there can beat the write out the door with the safety net already
  disarmed, leaving the room `isLive` with a speaker who is gone. Every later visitor then routes
  straight to the listener view, so nobody ever sees the chooser and the claim transaction refuses
  to hand the room over — the room is permanently unusable to everyone but that one browser. It
  is network-dependent, so it would show up as an occasional unreproducible "dead room". The
  chooser's own **← Back to my rooms** is the safe way out, one tap later.
- **Toasts that ask you to do something stay until dismissed.** Anything instructing the reader to
  change a device setting, warning about credential exposure, or reporting an error shows a "Got
  it" button and no timer, because a timed-out toast can't be brought back. Incidental messages
  ("Link copied.") still fade on their own, and the default lifetime is 6s. Toasts stack rather
  than replace; when the stack is trimmed the timed ones are dropped before the dismiss-required
  ones, and at most two dismiss-required toasts are kept on screen at a time so they can't bury
  the captions.
- **Screen Wake Lock** keeps the speaker's screen on while transcribing (where supported — Safari
  currently doesn't support it, and the app just quietly skips it there). It's released while
  paused, so a paused phone can sleep normally.
- Refreshing the Speaker's tab briefly drops the Firebase connection, which can trigger the
  auto-close-on-disconnect safety net even though the speaker didn't intend to leave. If that
  happens, just tap "Start as Speaker" again — the room reclaims automatically.
