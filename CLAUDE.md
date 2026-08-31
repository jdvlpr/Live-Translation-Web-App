# CLAUDE.md

Real-time speech translation for a room: one speaker's phone transcribes, listeners read it in
their own language. Static site — `index.html` + `app.js` + Tailwind/Firebase from CDNs, deployed
by pushing to GitHub Pages. No build step, no `node_modules`, no server.

`README.md` is the user-facing document and explains *what* the app does and why each design
decision was made. This file is the operational checklist: what to do, and what not to break.

## Shipping is a paired edit

`BUILD_STAMP` (`app.js:55`) and the `?v=N` on the `<script>` tag (`index.html:274`) **must move
together on every change to `app.js`.** iOS Safari caches the two files independently, so bumping
one and forgetting the other leaves the app working perfectly on a desktop while the phone
silently runs the old code — which from the phone is indistinguishable from the change simply not
working. `tests/static.test.js` fails if they disagree; that assertion is the whole reason the
suite exists.

## This app is tested from a phone

The only real test environment is an iPhone. Assume no desktop devtools and no console.

1. Push.
2. Open the site with `&cb=N` on the URL (matching the new version). `?v=N` alone is not enough:
   it only takes effect once `index.html` itself has been re-fetched, and that is exactly the file
   iOS is holding.
3. **Confirm Settings → Diagnostics reads the new stamp before trusting anything you see.**

Consequences worth internalising before proposing changes:

- **Never introduce a build step, a framework, or bundled ES modules.** Deploy is `git push` and
  test is "reload the page"; a compile step puts a CI job between writing a line and trying it on
  a device. If `app.js` ever must be split, carry the version through with dynamic `import()` —
  a relative `import` resolves without the query string and would let a fresh `app.js` pair with
  a stale module.
- **No `alert()`/`confirm()`.** On iOS they block the page and the speech recognizer until
  dismissed. Confirmation is done inline — see the two-tap End session button.
- **Diagnostics go in the in-app log** (`debugLog`), not `console.log`. Nobody can read a console.

## Tests

```bash
node tests/run.js            # everything; exits non-zero on failure
node tests/run.js speaker    # suites matching a substring
```

Real, unmodified `app.js` under `node:vm`, against `tests/domshim.js` (parses `index.html`, so
elements have their real nesting/classes/`data-*`) and a hand-rolled fake Firebase. Dependency-free
on purpose.

They have **no layout engine and no real network**, so they cannot catch a control that reflows
when its label changes, or a write that races a page unload. Don't claim a change is verified on
those grounds — say what was checked and what still needs the phone.

If you add a selector `app.js` uses, teach `matchesSelector` in the shim about it. It throws on
anything it doesn't know, deliberately: `querySelectorAll` silently returning `[]` is what hid the
fact that the display toggle had no test coverage at all.

## Invariants that look cosmetic and are not

- **`closeRoom()` (`app.js:968`) deliberately does not navigate.** Firebase applies the write to
  its local cache and fires the `value` listener *before* the network write flushes; that listener
  runs `teardownSpeakerView()`, which cancels the `onDisconnect` backstop. Unloading the page there
  can beat the write out the door with the safety net already disarmed, stranding the room `isLive`
  with an absent speaker — every later visitor routes past the chooser to the listener view, and
  the claim transaction refuses to hand the room over. Unrecoverable, network-dependent, and it
  would surface as an occasional unreproducible "dead room".
- **`#btn-close-room` has a pinned width** (`CLOSE_BTN_BOX`, `app.js:955`, kept in step with the
  markup). Its header wraps on a narrow phone, so a button that grew when it armed would reflow the
  row and move the target out from under the thumb between the two taps of its own confirm. Both
  states must occupy the same box. Nothing may be added to that header row without rechecking this.
- **`getElementById` lookups are guarded with `if (el)`.** Not defensive noise: a device can hold a
  cached older `index.html` against a newer `app.js`, and an unguarded throw inside
  `renderSpeakerView` takes the recognizer down with it. Ids that app.js reaches for but the markup
  no longer declares are allowlisted in `tests/static.test.js`.
- **The speaker renders its transcript from its own local push, not a subscription.** Firebase
  fires `child_added` from the local cache for our own write, so subscribing would double-render
  every segment.
- **Each feed detaches its own Firebase listeners on teardown.** `teardownSpeakerView` runs from
  that same local-cache callback; a missed detach keeps firing `value` against removed DOM.

## Deliberate, not oversights

Do not "fix" these without being asked:

- **The Gemini API key is client-side and visible to every listener.** Documented in the README's
  security section, with the mitigations that were chosen instead.
- **Realtime Database rules are world-writable.** Test-mode rules are the intended posture for a
  talk or demo.
- **The recent-rooms list is `localStorage`-only** and never uploaded.
- **Serbian (`sr-RS`) has no speech fallback** while Bosnian falls back to Croatian. Croatian
  recognition of Bosnian speech is near-identical and both are Latin; Serbian is Cyrillic, so a
  Croatian recognizer would emit the wrong alphabet. Silence beats wrong script.

## House style

Comments explain **why**, not what — the tricky parts of this codebase are all "this obvious
simpler thing is wrong because…", and that reasoning is the part worth keeping. Match the
surrounding density. When a constraint spans files (the version pair, the button box), say so in
both places.

## Open questions

- Serbian recognition fails on iOS with `service-not-allowed` and by design has no fallback. How
  to present that to a user is undecided.
- A listener-facing "Speaker paused" banner has been offered but not built: a pause is currently
  invisible to listeners, who just see a quiet room.
