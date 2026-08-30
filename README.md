# Live Translate

Real-time, multi-language live transcription and translation for a speaker-to-many-listeners
session (talks, sermons, meetings, classes). Runs 100% client-side — no custom backend — so it
can be hosted for free on GitHub Pages. Firebase Realtime Database handles pub/sub between the
speaker and listeners, and the Gemini API handles translation.

## How it works

- **One URL, two roles.** Anyone who opens `index.html?room=abc123` sees "Start as Speaker" or
  "Join as Listener." Whoever taps "Start as Speaker" first wins the room (a Firebase transaction
  prevents two people from both becoming the speaker). If the room is already live, new visitors
  land directly in the Listener view.
- **Speaker** picks their spoken language, and the browser's Web Speech API transcribes
  continuously, buffering until a sentence ends (`.`/`?`/`!`) or 3.5s of silence, then pushes the
  segment to Firebase.
- **Listener** picks their own reading language independently. If it matches the speaker's
  language, the original text is shown immediately with no API calls. Otherwise, the first
  listener to need a given translation calls the Gemini API and writes the result back to
  Firebase — every other listener reading the same language then loads it from the cache instead
  of calling Gemini again.
- Supported languages: Bosnian, Chinese, Croatian, Dutch, English, French, German, Korean, Polish,
  Serbian, Spanish, Ukrainian, Urdu.

## Files

- `index.html` — markup and Tailwind (via CDN) styling.
- `app.js` — all application logic (routing, Speech Recognition, Firebase, Gemini calls).
- No build step, no `node_modules`, no server code.

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
- **Screen Wake Lock** keeps the speaker's screen on while transcribing (where supported — Safari
  currently doesn't support it, and the app just quietly skips it there).
- Refreshing the Speaker's tab briefly drops the Firebase connection, which can trigger the
  auto-close-on-disconnect safety net even though the speaker didn't intend to leave. If that
  happens, just tap "Start as Speaker" again — the room reclaims automatically.
