# Changelog

All notable changes to MusicD Remote (formerly Roon Random Albums) are documented here.

## [1.7.69] — 2026-08-12

### Fixed — the defects an 8-angle review found in v1.7.68's own fix

v1.7.68 fixed the reported volume and progress-bar jitter. A full review of it then found nine
further defects, three of them introduced by that fix. This is that pass. Every item below is
covered by an assertion that was mutation-checked — the specific defect reintroduced, the specific
test confirmed red.

**A CSS transition was fighting the new painter.** `.mt-progress-fill` carried
`transition: width .4s linear`. The painter now runs every 250ms, so a 400ms transition is restarted
before it can ever finish: the fill chased a target it never reached and sat permanently ~400ms
behind the position just computed, continuously animating a property that is not
compositor-accelerated. The transition made sense when the position advanced once a second and the
transition *was* the interpolation; against a 4Hz painter it only fights it. Removed here and in
`display.css` (`.bb-fill`, whose `.25s` was exactly its own tick).

**Paused time was counted as playback.** The position clock is a base plus elapsed wall-clock, and
nothing re-anchored it across a pause. A 2.5s pause left the bar permanently 2.5s ahead — silently,
because one pause alone stays under the reconcile threshold. A few short pauses accumulated past it,
at which point the reconcile fired and yanked the bar back by *more* than three seconds: a bigger
version of the jerk v1.7.68 set out to remove, just rarer. The base is now carried forward using the
play state that was in effect for the interval, and a play/pause transition takes the server's
position outright, which is exact at that moment.

**A track change was suppressed by our own seek hold.** The 1.5s hold that protects a scrub from the
refresh that follows it also gated the track-change branch. Scrubbing to the end of a track — a
normal way to skip on — opened the next track with the bar pinned at 100% until the hold lapsed. A
track change is unambiguous new information and now re-baselines regardless.

**The volume hold followed you between zones.** The hold was a bare value with no zone identity.
Tapping + on one zone and switching to another inside the 2s window left the new zone's slider
showing the *old* zone's number — and because the buttons step from what is displayed, the next tap
sent that number, +1, as an absolute value to a zone the user never touched. A zone at 12 could be
jumped to 42 by one tap. The hold is now keyed to the zone it was taken for.

**A hung volume request killed volume for the whole session.** v1.7.68 serialised writes so only one
is in flight at a time. Neither the request nor `/api/volume` has a timeout — the server answers only
when Roon's callback fires — so a Core that drops mid-call left that promise unsettled forever, and
every later write queued behind it. Volume dead until reload, where the old fire-and-forget code lost
only the single request. Writes are now bounded by an abort at 5s.

**A queued write could go to the wrong zone**, because the zone id was read from the current zone
inside the send loop — which is after an await on every iteration but the first. It now travels with
the value. A failed write also no longer discards a value already queued and already painted.

**`soft_limit` is Roon's ceiling and now bounds the slider too**, not only the +/− buttons. Clamping
one and not the other let a drag ask for a value the zone will never report back, leaving the hold
waiting on an echo that could not arrive and then snapping.

Also: the scrubber fill no longer drops out entirely on a NaN position; `stepVolume` reads the
output's range from the output rather than from the slider's attributes (which are only a mirror of
it); the echo now matches within half a step rather than exactly, so quantising outputs settle
instead of stalling for the full hold; and the per-write refresh is coalesced, since the buttons have
no debounce.

### Class of error

Optimistic local state that outlived the thing it was optimistic about. The zone-scoping and
hung-request defects are the same shape as the bug v1.7.68 fixed, reintroduced one level up: state
held on the user's behalf, with no bound on how long it may be believed.

Two lessons recorded rather than fixed. A test can be green because the code is right or because the
stub cannot express the failure — v1.7.68 shipped with a `start` sentinel that could not tell
"rendered the server's value" from "never ran", because the stub and index.html both said 50. And
some things this harness genuinely cannot observe: a CSS transition does not change the inline width
the painter writes, so that one is pinned as a static assertion instead, honouring
`MUSICD_PUBLIC_DIR` so a mutation run can actually reach it.

### Tests

70 static / 701 unit / 352 DOM. Nineteen new assertions across pause drift, zone-switch leakage,
track change inside the seek hold, the soft limit, write ordering under out-of-order arrival, a
never-answering request, mid-flight zone changes, and a stale debounced write landing after release.

## [1.7.68] — 2026-08-12

### Fixed — the volume slider jumped back a step, and the progress bar was jerky

Two reports, one shape: the screen was painted with what the user just did, and then a poll
overwrote it with what the server knew *before* they did it.

**Volume.** The only thing protecting an optimistic paint was `userIsDraggingVolume`, set on the
slider's `input` event and cleared on `change`. The −/+ buttons never touched it. So from the moment
a tap painted 51 until Roon echoed 51 back — an HTTP round trip plus Roon's own ~1Hz event cadence —
any poll tick wrote the pre-tap 50 straight back over it. The thumb retreated after +, and advanced
after −, which is exactly how it was described. Worse, the *next* tap then computed its step from the
reverted display, recomputed a value already sent, and the tap vanished.

Absolute volume writes are now held until the server echoes them. The hold ends the instant the echo
matches, and lapses on its own after 2s, so a change made in the Roon app or on a hardware knob still
reaches the slider — held, not locked. `setVolume()` became the single choke point every caller goes
through, so the guard cannot be forgotten at one of them the way it was for the buttons; it also
serialises writes latest-wins, because these are absolute values issued over separate connections and
a drag emitting 45, 52, 60 could have 52 land last.

Two more things the buttons got wrong: they moved by a hardcoded 2 on outputs whose own step is 1
(two positions per tap), and they ignored `soft_limit` — Roon's own ceiling, which the server has
always sent and nothing ever read, so a request above it was clamped and the poll dragged the thumb
back down, indistinguishable from the jitter. They now step by the zone's own step, once, and stop at
the limit.

**Progress bar.** A 1000ms ticker did `npPos += 1` while the 1500ms poll assigned the server's
position unconditionally. Two unsynchronised timers writing one variable, realigning every 3s: the
bar hopped forward a second, snapped back a second, then caught up two. That beat *is* the
jerkiness.

Position is now a base plus elapsed wall-clock — the model `display.js` has always used — painted
four times a second. The painter paints; it does not advance, so a late or throttled tick cannot make
the bar drift. The poll reconciles rather than snaps: what arrives is stale by up to ~2s (whole-second
quantisation plus Roon's event cadence), so it re-baselines only on a disagreement bigger than that,
which means a real event — a track change, a seek from another remote, a stall. Our own seeks set the
base directly and hold off re-baselining for 1.5s, so the refresh that follows a scrub no longer yanks
the bar back to where it was dragged from and then forward again.

Also fixed while in here: the scrubber's fill was read back out of a `step="1"` input, so it could
only ever move in whole-second jumps; the mini bar's line went on painting the old position for the
whole duration of a drag; and a stream with no length could paint a fill under a thumb parked at zero.

### Class of error

Optimistic local state with no guard against the authoritative source arriving late. Both bugs were
invisible to every existing test because the test server answered instantly and truthfully. The new
assertions only have teeth because the stub now lags the way the real one does — an earlier draft
froze the server's position instead, which made re-baselining *correct* and left the monotonicity
assertion permanently green.

### Tests

16 DOM assertions in `test/dom/volume-row.test.js` (69 static / 701 unit / 333 DOM overall). Each was
mutation-checked by reintroducing the specific defect and confirming it goes red: reverting the guard
to `userIsDraggingVolume`, stepping by a raw delta of 2, making the hold permanent, dropping the
re-baseline tolerance, disabling the snap entirely, and removing either half of the seek hold. Two
assertions that passed under every mutation were found and dealt with rather than kept.

## [1.7.67] — 2026-08-11

### Fixed — the volume popover's row was 8px out of alignment

Reported from a screenshot as "the layout isn't aligned". It was, by 8px, and the cause is the kind
that reads as perfectly correct in the source.

`.vol-controls` is a flex row of three things: the readout (speaker icon + number), the slider
wrapper, and the two step buttons, with `align-items: center`. The wrapper was a **column** — the
slider stacked above the 0/100 scale — which made it about 20px taller than the slider itself.
`center` then did exactly what it says and centred every sibling against the wrapper's *full*
height, while the slider centred on itself. The readout and both buttons ended up sitting low
against the track they belong to.

Measured before: slider centre at 728, readout and both buttons at 736. After: all four at 719.

The scale is positioned rather than stacked now, so the wrapper is exactly the slider's height and
the row lines up on the track. The sheet's padding was also `18px` top against `12px` bottom, which
tipped the whole row upward; it is even now, with room for the repositioned scale.

Five DOM assertions, measured at 360 / 390 / 768 px: all four centre lines within 1px of the slider
track, and the scale still visible, still labelled 0 and 100, still inside the sheet — hiding or
clipping it is the obvious wrong way to make the alignment "pass". The pre-fix layout fails four of
the five.

Nothing in that CSS looked wrong, which is why it had to be measured rather than read.

## [1.7.66] — 2026-08-11

### Added — the iOS full-screen contract, written down and pinned

Confirmed fixed on device. This records what happened so it cannot recur, and is honest about the
part no test can prevent.

**The mechanism.** `apple-mobile-web-app-status-bar-style: black-translucent` shifts the document
*up* under the status bar without growing the layout viewport. The gap that leaves at the **bottom**
equals the **top** inset — 44–62px, not the 34px of a home indicator. That is why the band looked
too tall for a home indicator and appeared on every screen.
`apple-mobile-web-app-capable` opts into the legacy web-app path where that style governs the
window. Both were added in v1.7.60 alongside the icons; neither was needed for an icon.

**Why it took six versions.** iOS reads those two metas at **Add-to-Home-Screen time, not per
launch**, while `viewport-fit=cover` *is* re-read every launch. A shortcut created against a bad
build keeps the bad window configuration permanently, and no server-side fix is observable through
it. So "still broken" and "the fix is live" were both true at the same time, and each new report
looked like the previous fix had failed. Three of the four attempts were built on the resulting
false premise — v1.7.61 asserted the app had never run standalone, which the repo's own v1.7.42
entry had already disproved five days earlier.

**What is now pinned** (`test/static/pwa-icons.test.js`, and pre-flight step 6 in CLAUDE.md):

- No legacy Apple web-app meta in `index.html` **or** `display.html` — matched as a tag, not a word,
  so the comment explaining their absence does not trip it.
- Exactly **one** viewport meta. A second silently overrides the first and zeroes every inset.
- The `viewport` string byte-for-byte as v1.6.50 spells it.
- `html, body`, `.app` and `.modal` still match v1.6.50 — including `height: 100%`, which generic
  PWA advice says to replace with `100vh`. v1.6.50 uses `100%` and fills the screen, so that advice
  does not apply here and the line is load-bearing evidence.
- An **allowlist** on the head: v1.6.50's tags plus four inert icon lines. Anything else fails.

**What cannot be pinned, stated plainly.** The DOM harness is headless Chromium — no browser chrome,
no safe areas, `dvh` == `vh` == `100%`. No assertion in this suite can observe iOS window behaviour,
so writing more of them buys confidence and no coverage. Two of the v1.7.60 assertions were
themselves permanently green. The suite's honest job here is to hold a known-good state still, and
CLAUDE.md now carries the operational half: **a "still broken" report after a `<head>` change is not
evidence the fix failed — ask for the shortcut to be deleted and re-added before diagnosing.**

Five mutations confirmed red: a live `black-translucent` tag, a second viewport meta, a legacy meta
appearing in `display.html`, `html/body` height changed, and `viewport-fit` removed.

## [1.7.65] — 2026-08-11

### Fixed — head reduced to v1.6.50's, plus four lines that cannot affect layout

v1.6.50 was installed and confirmed to fill an iPhone screen correctly. That turns the problem from
a diagnosis into a diff, so this version is that diff applied.

Comparing v1.6.50 to the current build:

- **`html, body`** — byte-identical. Never changed in the repo's entire history.
- **`.app`** — byte-identical.
- **`.modal`** — byte-identical.
- **the `viewport` meta** — byte-identical. It has exactly one distinct value across all 43 commits
  that have ever touched `index.html`.

The whole difference was in `<head>`. v1.7.64 removed the three metas v1.7.60 added; this removes
the last line that iOS also reads: **the manifest link**. iOS 17+ parses the manifest, and
`display: standalone` with a `background_color` is exactly the shape of declaration that letterboxes
a web app rather than letting `viewport-fit=cover` fill the display.

The head now differs from the known-good v1.6.50 by four lines, and none of them can relayout a
window: two `rel="icon"` links, one `rel="apple-touch-icon"`, and `apple-mobile-web-app-title`.

**The duck is unaffected on iOS** — it comes from `rel="apple-touch-icon"`, which is still there.
`public/manifest.json` is kept in place, ready to re-link once the screen is confirmed. The cost
until then is that Android and desktop lose the install prompt.

### Added — an allowlist on the head, which is the check that would have stopped this

Every test written across v1.7.60–64 asked "is this thing present?" — the wrong question, because the
bug was something present that shouldn't have been. The head's `<meta>` and `<link>` set is now
checked against an explicit allowlist: v1.6.50's own tags plus the four inert icon lines. Anything
else fails, with the reason spelled out, and has to be added deliberately by editing the list.

Three mutations confirmed red: the manifest link restored, `apple-mobile-web-app-capable` restored,
and `apple-mobile-web-app-status-bar-style` restored.

## [1.7.64] — 2026-08-11

### Fixed — the black safe-area band: three metas v1.7.60 added, now removed

Three previous attempts failed because the diagnosis was wrong. The changelog itself held the
answer, and I had asserted the opposite of it.

**The correction.** v1.7.61 claimed the app had never run standalone on iOS before v1.7.60, and that
the safe-area CSS had therefore never executed. That was false. **v1.7.42**, five days earlier,
fixed *"Now playing sat under the status bar"* — a symptom that is only possible when the insets are
live and the page is already full-bleed — and its own note says *"only visible in the installed
PWA — in a browser tab the address bar occupies that space"*. The app was standalone, full-bleed,
and correct before v1.7.60.

**What actually broke it.** The head before v1.7.60 was four lines: charset, `viewport` with
`viewport-fit=cover`, `theme-color`, `title`. Modern iOS opens a home-screen shortcut as a
standalone web app by itself, and `viewport-fit=cover` was already filling the display. v1.7.60
added the icons — and, unnecessarily, three metas:

```
apple-mobile-web-app-capable
mobile-web-app-capable
apple-mobile-web-app-status-bar-style: black-translucent
```

`apple-mobile-web-app-capable` opts back into Apple's **legacy** web-app path, where the status-bar
style governs how the web view is inset rather than the page filling the display. The app stopped
reaching the edges, on every screen, which is exactly the report.

All three are gone. The icon never needed them: iOS reads `rel="apple-touch-icon"`, and the manifest
covers Android and desktop. The four working lines are byte-identical to their pre-v1.7.60 state
again, with only icon links added alongside.

### Why the tests did not catch it, honestly

They could not have. Every assertion written across v1.7.60–63 was structural — does this meta
exist, does this rule contain that declaration — and the DOM harness runs headless Chromium, which
has no browser chrome, no home indicator and no safe areas. `dvh`, `vh` and `100%` are identical
there. **No test in this suite can observe iOS chrome behaviour**, so writing more of them would
have produced more confidence and no more coverage. Worse, two of the v1.7.60 assertions were
themselves permanently green (fixed in v1.7.61 and v1.7.63).

What the suite CAN do is pin the known-good state so it is not silently changed again, and that is
what it now does: the three legacy metas must stay absent, and the exact working `viewport` string
must survive. Four mutations confirmed red — each meta reintroduced individually, and `viewport-fit`
removed.

The rest stands on its own merits and is kept: v1.7.62's `height: 100%` on the full-bleed panels
(`100dvh` genuinely does under-measure inside a fixed `inset: 0` parent), v1.7.63's removal of the
strip that painted over the modal, and the toast insets.

## [1.7.63] — 2026-08-11

### Fixed — removed the v1.7.61 strip, which was the thing making Now Playing worse

A full CSS audit of every bottom-anchored surface found what v1.7.62's fix had not: the strip added
in v1.7.61 was itself a bug, and the specific reason the Now Playing screen looked *worse* rather
than merely unfixed.

It sat at `z-index: 69`. `.modal` is `50` and `.share-overlay` is `60`. The transport bar is hidden
on the Now Playing screen, so nothing covered the strip there — it painted `var(--bg)`, the darkest
token in every palette, straight over the panel's lighter `var(--bg-elev)`. A brand-new dark bar,
layered on top of the gap that was already there. The comment shipped alongside it claimed the
transport covered it "whenever it is on screen"; that was simply false for the modal.

It was also unnecessary from the start. `html` carries `background: var(--bg)`, which propagates to
the canvas, so an area no element covers is **already the page ground** — the safe area was never
going to be black from the page's side. Any genuinely black band could only ever have come from a
painted layer, which is exactly what v1.7.62 identified: `.modal-backdrop`'s `rgba(0,0,0,.55)`
showing through a short panel.

The audit confirmed every other bottom-anchored surface already pads its own background into the
inset — `.mini-transport`, `.settings-sheet`, `.lib-sheet`, `.menu-drawer`, both merge bars, both
volume popovers. With `.modal-panel` fixed in v1.7.62, nothing is left for a strip to cover, so it
is gone rather than merely re-layered.

### Fixed — the two floating toasts sat in the home-indicator area

Same v1.7.60 standalone fallout, found by the same audit. `.toast` (`bottom: 28px`) and
`.settings-info-toast` (`bottom: 88px`) were the only bottom-anchored elements with no inset
awareness, so on an installed iPhone they sat 34px lower than intended, over the home indicator.
Both now add `env(safe-area-inset-bottom)`.

### Fixed — two test assertions that could not fail

Both found by mutation-checking this change, and both the same mistake in different clothes:

- The rule lookup used a raw `indexOf` on the stylesheet, so it matched the selector inside a
  **comment** — including the comment written to explain this very fix. Comments are stripped first
  now.
- The transport-inset assertion used `/\.mini-transport\s*\{[\s\S]*?padding-bottom:.../`. That
  `[\s\S]*?` walks straight past the rule's closing brace and matches some *other* selector's
  padding, so deleting the transport's own inset passed cleanly. It is bounded to the rule body now.

Four mutations confirmed red: the v1.7.61 strip reintroduced above the modal, `html` losing its
background, the transport losing its inset, and `.modal` ceasing to be full-screen.

## [1.7.62] — 2026-08-11

### Fixed — the real cause of the iOS band: viewport units on a full-screen panel

v1.7.61's painted strip did not fix it, and the Now Playing screen got worse. Reproduced this time
rather than reasoned about: the stylesheet was copied with `env(safe-area-inset-bottom)` substituted
for a real `34px`, and rendered in the headless harness. **The bars measure correctly** — the mini
transport reaches the viewport bottom with its 44px of padding. So the safe-area CSS was never the
problem, which is why painting a strip behind it changed nothing.

The actual cause is `.modal-panel`, and the Now Playing screen is rendered inside it:

```css
.modal { position: fixed; top:0; right:0; bottom:0; left:0; }
.modal-panel { height: 100dvh; max-height: 100dvh; }
```

Those two do not measure the same box on iOS. A fixed `inset: 0` parent covers the whole screen
**including** the safe areas; the dynamic viewport (`dvh`) **excludes** them. So the panel came up
short by the home-indicator inset, and what showed through the gap was `.modal-backdrop` —
`rgba(0,0,0,.55)` over a blur. That is darker than the page and taller than a bare inset, which is
exactly why Now Playing looked worse than the Home screen rather than the same.

All three full-bleed panels now use `height: 100%`, measured against the fixed parent they fill:
`.modal-panel`, its `≥720px` Now-Playing override, and the Qobuz/TIDAL/Pitchfork overlay sheet. The
`100vh` **max-heights** on deliberately inset panels (the desktop modal's `calc(100vh - 48px)`, the
popovers) are untouched and correct — a test pins that distinction so nobody "fixes" them later.

Headless Chromium has no browser chrome and no safe areas, so `dvh`, `vh` and `100%` are identical
there and this cannot be caught by rendering. The invariant is asserted structurally instead, and
the parents are checked for still being `fixed` + `bottom: 0` — because `height: 100%` is only the
right answer while that holds. Three mutations confirmed red.

v1.7.61's strip is kept. It is a correct backstop for the case where no bar is on screen, it is
invisible where a bar already reaches the bottom, and on any device without a home indicator it has
zero height.

## [1.7.61] — 2026-08-11

### Fixed — the black band along the bottom on iOS, which v1.7.60 caused

Reported after installing v1.7.60's icon: a black strip across the home-indicator area. Traced
rather than guessed, and the answer is not in v1.6 or v1.7 — it is v1.7.60, from the day before.

| What | When |
|---|---|
| `viewport-fit=cover` | 3 Jul 2026, v1.5.104 |
| the `env(safe-area-inset-*)` rules | 3–14 Jul 2026, v1.5.104 / v1.6.13 / v1.6.38 |
| `apple-mobile-web-app-capable` | **11 Aug 2026, v1.7.60** |

**The app had never run standalone on iOS before v1.7.60.** There was no manifest and no
`apple-mobile-web-app-capable`, so "Add to Home Screen" produced a shortcut that opened in Safari —
and Safari's own toolbar occupied the home-indicator strip, so the page never saw it. Every
safe-area rule in the stylesheet, some of them fourteen months old, had never once executed on an
iPhone. Adding the install metadata did not break the layout; it ran it for the first time.

The bars along the bottom do pad themselves correctly. What nothing covered was the case where no
bar is on screen, leaving iOS to paint its own black. `body::after` now paints that strip with the
app's own ground, sitting at `z-index: 69` — directly beneath the transport bar, so where the bar
already reaches the bottom the strip is invisible behind it. On any device without a home indicator
the inset is `0`, the strip has zero height, and the rule does nothing, which is what makes it safe
to apply unconditionally.

### Fixed — v1.7.60's own icon tests were permanently green

Caught while mutation-checking this change. `test/static/pwa-icons.test.js` read
`REPO_ROOT/public` directly instead of honouring `MUSICD_PUBLIC_DIR`, so every mutation ran against
the real, correct files: deleting a declared icon, making the maskable icons byte-identical to the
full-bleed ones, and removing `viewport-fit=cover` all passed. Seventeen assertions that could
never fail. Now pointed at the copy the harness builds, and all five mutations confirmed red.

This is the second time this exact trap has caught a static test in this project — the first was
the pre-flight suite reading `index.js` instead of going through `indexSource()`.

## [1.7.60] — 2026-08-11

### Added — the MusicD duck is now the app icon, on every platform

The app had **no PWA setup at all** — no manifest, no icons, no `apple-touch-icon`. "Add to Home
Screen" saved a screenshot of the page, and the browser tab carried the default blank mark. This
adds the whole thing, not just an image.

The logo is generated into two families, which are not interchangeable:

- **`any`** — the artwork edge to edge, at 192/256/384/512. Used by the browser tab, the desktop
  install, and iOS, which applies its own rounded-rect mask *without* cropping into the art.
- **`maskable`** — inset to 78% on the logo's own black, at 192/512. Android crops adaptive icons
  to whatever shape the launcher uses and guarantees only the centre 80%, so the full-bleed version
  would have lost the headphone cup and the quiff.

The `apple-touch-icon` is pre-flattened with no alpha channel, because iOS composites transparency
onto **white** — which would have haloed a logo drawn on black. The manifest declares
`display: standalone` and a `background_color` matching the app's own ground, so the launch screen
doesn't flash white before the first paint.

The wall display (`/display`) gets the favicon only — it lives in a browser tab on a spare monitor
and should never offer to install itself as the app.

Eleven static assertions cover it, and they **measure** rather than trust: every manifest entry is
opened and its real pixel dimensions compared against the `sizes` it claims, since an icon that
lies about its size fails silently — the browser just falls back and nobody finds out until
somebody installs it. One assertion exists purely to catch a regeneration without the safe-zone
scale, by proving the maskable files are not byte-identical to the `any` ones.

## [1.7.59] — 2026-08-11

### Fixed — a switched-off feature no longer leaves its Home row and its playlists behind

Both of these were flagged as outstanding at the end of the v1.7.58 review; neither was done.

**Smart Picks off now means the carousel is gone.** Switching it off stopped the daily build but
left the row on the Home screen, still showing the last day it produced — recommendations from a
feature the user had switched off, frozen at the moment it stopped. `/api/smart-picks` now serves
nothing when the feature is off, the row does not render, and — the part that actually matters —
the Home screen no longer *fetches* it either. Hiding a row that has already asked for its data
still polls a switched-off feature once per Home visit, forever.

The same treatment for **Label of the week**, which had the identical shape: with Labels off its
route already returned nothing, so the row was an empty heading.

In the Home Screen settings page these rows now read as off and cannot be switched on, with the
reason on the row (*"Smart Picks is off in Settings"*). The stored preference is deliberately **not
rewritten** — switching the feature back on restores the Home screen the user had, rather than one
this page quietly changed while the row was unavailable. A row's feature being off is not a layout
choice, and the two are kept apart in the data.

**A saved playlist that filters by record label now says so.** `libraryView` only applies the facets
`libFacetDefs()` currently publishes, so with Labels off a stored Record-label filter was simply
skipped: the playlist still opened, still played, and returned a completely different set of albums
with nothing on screen to explain it — "Late Night on Blue Note" quietly becoming "every album in
the library". The detail screen and the play path now both refuse it and name the cause and the
setting to change, and the tile carries the same reason so it does not look ordinary until opened.
The saved view is left untouched, so switching Labels back on restores the playlist exactly as it
was.

758 unit / 317 DOM / 42 static. Six mutations confirmed red, including one that proved a redundant
guard was redundant — `applyHomeLayout`'s unavailable term changes nothing today, because the only
two rows that can be unavailable are also the two that hide when empty. It is kept for a future row
that does not, and is now labelled as belt-and-braces rather than as the thing doing the work.

## [1.7.58] — 2026-08-11

### Fixed — the red line people actually see, and the wrong wait time

Two corrections to v1.7.57, both reported from a screenshot of the real thing.

**The message on screen was composed in the client, so v1.7.57 went straight past it.** The line
under the album title — *"Roon offered no playback options for this album."* — is not the server's
`noActionError`; that one is a toast on the play path. This sentence is built in `public/app.js`
from an empty action list, and its "nothing was proven" branch carried no explanation at all. The
pass that added why/what-next/how-to-fix to every message on this path fixed the ones nobody was
looking at. Both branches now explain themselves. The narrow lesson, worth keeping: a message the
server also knows how to build is not evidence the server built the one on screen.

**It quoted one interval where there are two.** They are different clocks. When the live album count
contradicts the snapshot, the site that proves it has *already armed* the recheck chain —
`libraryRecheckMs()`, **5 minutes**. When the change is only the likeliest explanation, nothing was
armed and the next look is the background watch — `libraryCheckMs()`, **10 minutes**. Quoting ten
for both was wrong precisely in the case a user is most likely reading, and told somebody staring at
a red line to wait twice as long as they needed to. Each branch now quotes the clock it is actually
waiting on, read from the constants rather than written into the sentence, so retuning either can
no longer make the message lie.

Four DOM assertions drive the real album view for both branches, and three mutations of the client
confirmed red — including a straight revert to the sentence in the screenshot.

## [1.7.57] — 2026-08-11

### Changed — every "library is changing" message now explains itself

The red messages you get while Roon is adding albums stopped at the symptom — *"Roon offered no
playback options for this album"* — which reads as the extension being broken. Every message on
that path now says three things: **why** it happened, **what the extension is doing about it**, and
**the manual way out** if that doesn't work.

> Roon offered no playback options for this album. Your Roon library changed after this list was
> built — normally because albums are being added or identified. The extension re-checks every 10
> minutes and refreshes itself once Roon settles, so this usually clears on its own. If it hasn't,
> open the side menu and tap Rescan library.

One shared builder, so the four places that raise this cannot drift apart: no playback options,
Roon's own advisory (*"Library is being updated"*), a partial track list, and an empty one. Two
cases deliberately do **not** carry it — Roon offering a different menu, and an unexpected browse
action — because both would send you to a Rescan that cannot help.

The wording keeps the distinction the code can actually prove. When the live album count contradicts
the snapshot the change is stated as fact; when it is merely the likeliest explanation it is
hedged. Overstating the second would be a guess dressed up as a diagnosis.

### Fixed — those messages were unreadable, which would have made the rewrite pointless

The toast was built for "Queued 12 albums": a pill, dismissed after 2.4 seconds. Measuring it at
phone width showed the new text laid out **195px wide and 270px tall** — a narrow ribbon running up
the middle of a 390px screen — and then removed before it could be read.

The cause is not obvious from the stylesheet: `left: 50%` makes the containing block half the
viewport, and a shrink-to-fit box cannot exceed it. `width: max-content` frees it and a max-width
clamps it, giving 362px on a phone and 560px on a desktop. The lifetime now scales with length (11s
over 120 characters), so ordinary confirmations are unchanged. The corner radius drops from a pill
to 22px, which still reads as a pill on one line and as a rounded card once the text wraps.

Six DOM assertions measure this at 390 and 1280px, including the narrow-column case specifically —
the stylesheet gives no hint of it and only measurement catches it.

## [1.7.56] — 2026-08-11

### Fixed — the ten-minute watch would have re-walked the library forever on some installs

Found by review before release, and it is the reason the watch could not have shipped as it stood.

`buildAlbumIndex` keeps two numbers: `count`, the albums that actually arrived once holes are
filtered out, and `declared`, what Roon *said* the library held when the snapshot was taken. Its own
comment explains why the difference matters — *"comparing a live count against the filtered one
would then report 'the library moved' forever on a library that never changed, and every album open
would arm another full re-walk"* — and `loadAlbumSession` was fixed for exactly that.

`libraryChangedSince()`, the probe the watch repeats, was not. It compared the live count against
`count`. On any install whose build hit a short page, every probe returned "changed" on a library
nobody had touched. At the old twelve-hour interval that was two needless re-walks a day and went
unnoticed across several versions. At ten minutes it becomes a full library walk, a genre harvest
(a few hundred browse calls) and an art prewarm **144 times a day** — a self-inflicted denial of
service on the Core, delivered by the feature meant to make the extension well behaved.

The probe now compares against `declared || count`, the same expression `loadAlbumSession` uses. The
first/last identity checks — the only way to see a library whose album count did not change — are
skipped when the snapshot has holes, because with holes filtered out those entries are simply not
the albums at those offsets and comparing them re-creates the same forever-true loop. A holed
snapshot therefore reports "unchanged" until the count moves or somebody presses Rescan: degraded,
but bounded, which the alternative is not. A short read now also says so in the log, since it is the
one line that would explain a library appearing to stop noticing edits.

The probe had **no test at all** — it is the single most-repeated Roon call in the extension. It now
has nine, covering the holed snapshot, a snapshot written before `declared` existed, same-count
swaps at either end, and the empty and one-album libraries. Five mutations confirmed red.

## [1.7.55] — 2026-08-11

### Fixed — the automatic rescan now actually fires, because something finally asks

v1.7.54 repaired the recheck chain: the loop that keeps asking, backs off, and rebuilds once Roon
settles. It did not fix the thing standing in front of that loop, and on its own the chain was
worth very little — because **nothing was asking the question on a schedule that mattered**.

There were exactly two detectors. One is opportunistic: it rides along on `nav.total` when a user
opens or plays an album, costs nothing, and is genuinely fast — but it needs somebody to open an
album. On a box sitting idle, or one used only from Home, the carousels and Now playing, it never
fires at all. The other was a **twelve-hour `setInterval`**. That was the entire detection story.

So "I added albums to Roon and the extension did nothing" was never an edge case. It was the
expected behaviour of the design, and every repair in v1.7.54 was downstream of a question nobody
was asking often enough to reach them.

**The periodic check is now ten minutes.** The affordability argument is that the QUESTION and the
ANSWER have wildly different costs and only the question is being repeated: `libraryChangedSince()`
is 2-3 browse round-trips (about 430 a day) and almost always returns "no". The expensive parts —
the settle probe and the full re-walk — still only happen when something has genuinely changed, and
still never while Roon is importing.

Detection to refreshed snapshot, with nobody touching the app: **≤10 minutes**, plus the 10-second
settle probe, plus the walk. If Roon is still importing when the tick lands, the v1.7.54 recheck
chain takes over at 5-minute intervals and the tick stands down while it runs.

The tick also stands down while a rebuild is in flight, while the index is building, and while a
recheck is already pending — each of those means the question is already being asked or answered,
and probing underneath only adds calls to a Core that is working. A `busy` or `error` result is
handed to the recheck chain rather than being lost until the next tick. The chain and the watcher
now back each other up: if the chain's budget runs out, the watcher is still there.

### Changed — comments that described the old twelve-hour design

Four comments on the index path still told the reader the snapshot is "re-checked only every 12
hours". They now describe the ten-minute watch, including the point that matters when reading this
code: the check is frequent because it is cheap, the rebuild is rare because it is not.

## [1.7.54] — 2026-08-10

### Changed — the Home search magnifier moved to the right of the top bar

It sat beside the hamburger, which is where the always-open search box used to live. That was the
right place while the box owned the whole bar; once it collapsed to a single icon in v1.7.50 the
icon joined the left-hand navigation cluster and read as a third nav control. It now hugs the right
edge at every width. Opening it still fills the bar — the right edge stays where the glass was and
the left edge travels out — measured at 360 / 390 / 768 / 1280 px.

### Fixed — the automatic rescan could stop firing permanently, and did not mean what it claimed

The v1.7.49 automatic rescan was audited end to end against the requirement that it fires **after
Roon has finished adding and identifying albums**. It did not hold up. Five separate defects, all
of them silent — the twelve-hour tick kept running, so the only symptom was the original v1.7.49
complaint quietly coming back:

- **The recheck budget could never refill.** `_libraryRecheckCount` was reset only by a recheck
  returning `fresh`, but at the cap `scheduleLibraryRecheck()` returns before arming anything — so
  no recheck could fire, so no `fresh` could ever arrive to reset it. The counter was global and
  was not refunded on `rebuilt` either, so roughly two dozen ordinary imports were enough to spend
  it. After that the automatic rescan was **dead for the lifetime of the container** and every
  later import waited for the next twelve-hour tick. The budget is now per *episode*: an idle gap
  of 30 minutes — comfortably longer than the 5-minute chain, so a running episode can never refill
  itself — starts a new one with a full budget. This is a *class* of error: a resource whose only
  refill path is gated behind the resource itself.
- **A failed rebuild reported success.** `buildAlbumIndex()`'s rejection was swallowed and
  `{ status: "rebuilt" }` returned regardless. Since the builder only assigns the snapshot after a
  full successful walk, a mid-walk failure left the old data in place, told the recheck chain the
  episode was over, and cleared the "Roon importing" banner. It now returns `error`, which is one
  of the two statuses that re-arm the chain.
- **"Finished" only meant "not still adding".** The import probe compared the album count across
  one 5-second window. Roon imports in bursts, so any pause longer than that window read as
  finished — and identification, which happens *after* the import and changes nothing about the
  count, was not looked for at all. The probe now takes three samples, and each sample carries the
  first and last album's identity as well as the count: identification rewrites titles and artists,
  which moves rows in an alphabetical list. Roon publishes no import-finished event of any kind, so
  this is inference from what the browse API will tell us — good evidence that work is still
  happening, never proof that it has stopped.
- **A re-pair scheduled nothing.** An unpair clears any pending recheck, and a websocket flap is
  most likely during exactly the heavy import that recheck was waiting on — so the refresh silently
  dropped back to the twelve-hour tick. A re-pair with a snapshot already in memory now arms one.
  (The comment claiming `startIndexMaintenance()` "re-verifies it on re-pair with a cheap 2-call
  probe" described code that was never written; it has been corrected.)
- **The automatic rebuild stopped at the album snapshot.** Everything built *on* the snapshot — the
  Qobuz/TIDAL source badges, the Genre facet, the decade and quality data from file tags, the label
  map — was refreshed only by the chain behind the manual Rescan button. An automatically refreshed
  library came back with the right albums wearing last week's metadata, which reads as the automatic
  rescan not having run. Both automatic paths now run the same chain the button does, tagged
  `auto rescan` in the log so the two are tellable apart.

### Fixed — Labels off now means off in scans, searches and filters too

v1.7.51-52 stopped the label *scanning* when Labels is off. The label features it had already
produced were still on screen: the "Record label" entry in the Library Focus sheet, the Labels
section of global search, the "more from this label" grid on the wall display, and the two label
endpoints. A stored Record-label filter also kept narrowing the Library wall with no visible way to
clear it, because the Focus sheet no longer listed the facet it came from. All five are now gated
on the same `labelsEnabled` switch, and the client's Focus count badge follows the vocabulary the
server actually publishes rather than a hardcoded list.

### Fixed — three defects the review found in this version's own changes

Caught before release, all three re-creating the class of bug the version exists to fix:

- **A labels-map failure reported the snapshot as failed.** `rebuildLabelsMap()` was chained into
  `buildAlbumIndex()`'s promise, so a throw from the label map returned `error` for a perfectly
  rebuilt snapshot — which stopped the post-rebuild chain firing and left every dependant stale.
  One line from the fix for exactly that. The flag now tracks the snapshot build alone, and a
  labels-map failure is logged rather than silently swallowed.
- **The automatic chain ran with `force`.** In both scans `force` means "a human insisted": it buys
  past the `libraryIsImporting()` gate, and in the genre walk it turns a fingerprint-skipping pass
  into a full sweep of a few hundred browse calls. Carrying it onto the automatic path would have
  skipped the very import check this version strengthened, at the moment Roon is most likely to
  still be identifying — and swept the whole library every time an import settled. New albums have
  no fingerprint yet, so the incremental walk picks them up regardless.
- **The Focus count badge lagged a version behind.** `libAvailableFacets` was populated only when
  the Focus sheet was first opened, so on a fresh load with Labels off the wall's "N matching
  albums" and the badge still counted a stored Record-label selection the user could neither see
  nor clear. It is now seeded at boot from the Labels switch the client already asks for.

Also de-duplicated: the change probe and the import probe were each spelling out their own
`title||subtitle` identity. They now share `browseItemIdentity()`, because a disagreement between
"is this the library we indexed" and "is this the library it was five seconds ago" would be
unexplainable if the two recognised albums differently.

### Added — the Rescan row now says what the snapshot is

The automatic rescan runs silently by design, which is also why five defects in it went unnoticed:
from the app, a library refreshing itself and a library that had quietly stopped refreshing looked
identical. The server has published `library_importing`, `library_recheck_pending`, `index_built_at`
and `index_count` on `/api/status` since v1.7.49 and no client read any of them. The side-menu
"Rescan library" row now carries a second line — `12,431 albums · checked 2 hours ago`, or `the
library moved, checking again shortly`, or `Roon was importing at the last check — refresh paused`.
Every phrase is past tense or explicitly a schedule: these flags are set at the last check and
cleared at the next clean one, so "Roon is importing" would be a confident lie about an instant
nothing can observe.

### Added — the recheck episode is now driven, not grepped

Everything that previously covered this scheduling was a substring search against `index.js`, which
is why all five defects shipped. The episode is now executed with a fake clock and a fake
`setTimeout`, so every branch of the status dispatch runs: one pending recheck ever, `busy`/`error`
re-ask, the cap engaging, `rebuilt` not refunding, `fresh` refilling, and an exhausted budget
recovering after an idle gap. Ten mutations of `index.js` were confirmed to turn the suite red.
723 unit / 302 DOM / 42 static.

## [1.7.53] — 2026-08-10

### Fixed — Sort floated in the middle of the Library control row

The row was laid out with `justify-content: space-between`. With two controls that put Focus left
and Sort right, which was correct. Adding the text filter as a third made Sort the *middle* child,
so the free space was split either side of it and it drifted away from the control it belongs
beside — and drifted **further the wider the screen**, since every extra pixel was shared between
the two gaps.

Sort now carries an auto left margin, which absorbs all the slack in one place: Focus hugs the left
edge, Sort and the magnifier sit together on the right with the row's own gap between them, at every
width. The `justify-content` declaration was removed rather than changed — auto margins consume free
space *before* justify-content is applied, so no value there could affect the result, and leaving one
in place would have been a rule claiming to do work it wasn't.

### Tests
- The control row is now **measured** at 360, 390, 768 and 1280px wide. Counting controls and
  checking their order passed against the broken layout too — only a rectangle can see that Sort was
  stranded mid-row. The assertion is the request itself: the gap on Sort's left must be several times
  the gap on its right.
- Suite: 42 static / 700 unit / 291 dom.

## [1.7.52] — 2026-08-10

### Fixed — a crash v1.7.51 introduced, caught before release

Splitting the `/music` walk out of the label scan left `bandcampMap` dangling: the Bandcamp pass
still referenced a variable that had moved into the other function. `node --check` passes on it —
it is a runtime `ReferenceError`, swallowed by the scan's own catch and surfacing only as
"[labels] scan aborted by unexpected error", which would have killed every pass after Bandcamp on
any library with `/music` mounted. Exactly the class the pre-flight's startup check exists for.

### Fixed — the last label work that ran with Labels off

The audit turned up four more paths beyond v1.7.51's:

- **Every album you opened recorded a label.** The Qobuz metadata lookup behind the album view and
  the wall display persisted a label name and added it to the label index on each open — a label
  scan by another name, one album at a time.
- **The local-files badge rebuild ran through the label scan.** Both boot timers that rebuild
  `local-albums.json` called `runLabelsIndexScan`, which now returns immediately when Labels is off
  — so a missing or old-format file would never have been rebuilt and the badges would have stayed
  empty. They call the walk directly now, which is what they always wanted.
- The label-folder-depth setting still triggered a scan and wrote to the labels log.
- The merge/unmerge routes and the FanArt key save still wrote label data and log lines.

### Changed — the Library control row matches Roon's

Focus on the left, Sort on the right, and the text filter last, in the position Roon puts its own
magnifier — and drawn as a magnifier rather than a funnel, since that is what it is doing. The
top-bar search is hidden on this screen, so there is no second glass to confuse it with.

### Tests
- 7/7 mutations still caught; suite 42 static / 700 unit / 285 dom.
- The control-row order test now pins Roon's arrangement rather than the previous one.

## [1.7.51] — 2026-08-10

### Fixed — Labels off now genuinely stops label scanning

v1.7.48 put the on/off gate in the *middle* of the label scan. The boundary was right — everything
before it was the `/music` tag read, which four Library filters and a badge depend on — but the
shape was wrong. With Labels off the extension still entered a function named for labels, set
`labelsIndex.building`, seeded the label map (which writes label names **and** kicks logo fetches),
and wrote `[labels] 12-hour auto-rescan triggered` into the labels scan log. From outside, that is
label scanning, whatever the gate did afterwards.

**The tag walk is now its own job.** `runFileMetadataScan` reads `/music` and produces release years
(the Decade filter), the local-files badge, and the Format / Sample rate / Bit depth / Channels
filters. It runs on its own schedule regardless of the Labels setting, and logs under `[files]`.

**`runLabelsIndexScan` bails on the first line.** No label state touched, no cache seeded, no log
line written, no network call. Also closed: the 12-hour timer no longer enters the label scan at all
when off; `/api/home/label-of-the-week` returns an empty row rather than reaching into the label
index; and the two label rescan routes refuse rather than scanning, for a stale client posting to a
page that is no longer reachable.

To be explicit about the one thing that does **not** stop: the `/music` tag walk. It is not label
work, and gating it would take the Decade, Format, Sample rate, Bit depth and Channels filters and
the local-files badge down with the labels.

### Tests
- The static gate test was rewritten around the new structure: the flag check must be the *first*
  statement of the label scan with nothing label-shaped before it, the walk must not be gated on the
  flag, and the 12-hour timer must run one and not the other.
- `syncchain.test.js` gained a Labels-off case asserting the walk still runs and the label pass does
  not.
- 7/7 mutations caught. Suite: 42 static / 700 unit / 285 dom.

## [1.7.50] — 2026-08-10

### Changed — search lives behind a magnifying glass

The field is no longer permanently in the top bar. Tap the glass to open it; tap anywhere away from
it, or press Escape, to close it. **Closing always clears.** A field that reopens holding an old
query, with the results gone and the Home rows back, reads as a search that has silently stopped
working.

It follows the overflow menu's pattern exactly — one module-level "what is open", `stopPropagation`
on the trigger, a `closest()` containment test on the document — rather than inventing a second
idiom for the same gesture. A tap on the X or the status text counts as inside, so clearing does not
also dismiss.

This fixes a layout inconsistency too: the search box measured 48px against 40px icon buttons, so
the top bar was 48px tall on Home and 40px everywhere else and visibly jumped on every navigation.
The collapsed state is measured in a test rather than assumed.

The search bar previously had **no test coverage at all** — the largest untested surface in the
client, which mattered here because almost everything this change touches is invisible in a
screenshot.

### Added — a text filter on the Library wall, behind a funnel

Type "F" to narrow the wall to albums and artists starting with F. Tap away to close and clear.

**On the request.** The ask was an A-Z rail down the edge of the screen, which worked under Album
name and Artist and did nothing under the others. That is not a bug to fix: a letter is a *position
in an alphabetical list*, and there is no such position when the wall is ordered by year, play count
or random. A filter is orthogonal to sort order, so it works under all seven — and it reaches
artists as well as titles, which a rail down the side of an album grid structurally cannot.

Two matcher rules worth stating:

- **Titles match on the article-stripped key** the wall already sorts by, so "The Wall" narrows
  under W exactly where the wall files it. Typing "the w" still finds it, so somebody typing what
  they see is not told the album is missing.
- **Artists match per credited name**, so "F" finds Fela Kuti inside "Tony Allen / Fela Kuti". It is
  `startsWith`, never `includes` — v1.6.56 was spent removing substring artist matching from
  thirteen call sites, and a filter is exactly where it would creep back.

It runs in the filter chain *before* the comparator, which is what makes it sort-independent; a test
asserts that ordering. The typed text is bounded (it arrives on a query string), and a filtered view
is deliberately not cached — every keystroke is a new key, and a fixed-size cache would be evicted
down to nothing by one session of typing.

### Changed — button sizing and placement

The stylesheet had **no sizing tokens at all**: every height, padding and min-width was a one-off.
That is how one shared `.action-btn` class came to render at four different heights — 37px on the
playlist screens, 40px in the album modal, 38px on a track row, 38px in the label merge sheet —
because each container re-declared its own padding. There is now one control height, and
`.action-btn` uses it everywhere.

- `.icon-btn`'s phone size tiers were scoped to the top bar only, so the album modal's corner
  buttons never shrank on a small screen. It now uses the shared token.
- Tap targets raised: the settings info button (18×14px, the smallest in the app by a wide margin),
  the artist-view Back button (27px, and the only way out of that screen), the settings Back button,
  the search clear, the dev and update buttons, and the Smart Picks card actions.
- The modal's corner buttons were positioned by hand-computed arithmetic (`12`, `60`, `108`), so
  changing the icon size silently mis-spaced all three. They now derive from the token. The overflow
  menu was also missing the `env(safe-area-inset-top)` its two neighbours had, so on a notched phone
  it sat higher than the × and Share it lines up with.
- Deleted three dead rule sets (`.filter-pill`, `.filter-pills`, `.active-filter-chip`) with no
  references anywhere in the client.

### Fixed — the Library control row restored focus to the wrong button

`renderLibraryControls` restored focus by an element's *first* class name, and every control there
begins with `lib-ctl` — so focus on Sort came back on Focus after any view change. It now restores
by the control's own class.

### Fixed — three defects the review of v1.7.48/v1.7.49 found, one of them destructive

The independent review pass ran late (a usage limit), and it caught a bug that had already shipped:

- **`pruneOldPlays` was deleting listening history four other features depend on.** The horizon was
  set to the History row's 30-day *display* window, but `plays` is not that row's private table:
  "Play something unheard" reads 12 months, the "Not played in 6 months" row reads 6, and the
  Library's play-count sort and Focus → Never played read all of it. The row is on by default, so
  one visit to Home after upgrading silently deleted everything older than 30 days — irreversibly,
  since Roon exposes no last-played date and nothing can rebuild it. Retention is now 400 days and
  the row simply queries a narrower slice. **If you have already run v1.7.48 or v1.7.49, history
  older than 30 days at that moment is gone; this stops any further loss.**
- **A Home row switched off could not be switched back on.** `applyHomeLayout` only ever *added*
  `.hidden` — nothing removed it, and the row renderers write into the carousel rather than the
  section wrapper, so the row stayed gone until a full reload.
- **After the first save, every switch on the Home Screen page was a no-op.** The server's reply
  replaced the draft array with freshly-built objects, orphaning every checkbox handler that closed
  over the old ones; the second toggle in a session mutated a discarded object and the request went
  out with the previous value. After a drag, the whole list went dead.

Also from that review: Labels switched **off** was still fetching logos from FanArt.tv and Discogs
every twelve hours (the logo kick hangs off `seedLabelsFromCache`, which runs before the scan's own
gate); a boot where the database could not be opened wrote "no evidence of use" down as a permanent
*off* for both opt-in features, which repairing the database would not undo; and the new library
re-check could loop indefinitely, because the snapshot's count is taken *after* dropping holes from
a short page while the live count is not — so a library that never changed could report as moved
forever. The snapshot now records what Roon declared, and only a genuinely unchanged library resets
the re-check budget.

Both client bugs shipped because `homerows.test.js` covers only the server's layout repair; nothing
exercised the page itself, and neither failure is visible in a screenshot of it.

### Tests
- `test/dom/search-toggle.test.js` — also covers the Home Screen settings page, with both of the
  above as named regressions.
- `test/unit/libraryfilter.test.js` — 18 tests over the prefix matcher, including substring matching
  as a named regression, plus structural assertions that the filter precedes the comparator and that
  filtered views bypass the cache.
- `test/dom/search-toggle.test.js` — 8 tests, the first coverage the search bar has ever had, with
  the collapsed top-bar height measured rather than assumed.
- 13/13 mutations caught. Suite: 41 static / 699 unit / 285 dom.

## [1.7.49] — 2026-08-10

### Fixed — the real reason a library change kept breaking playback for hours

Adding albums to Roon made the extension show "no playback options available" and return short or
empty track lists. The cause of the *symptom* was known — stale offsets while Roon re-indexes. The
reason it **persisted instead of clearing itself** was not, and it is the actual bug:

> The maintenance loop is a plain twelve-hour interval. When a tick found Roon mid-import it
> correctly declined to rebuild — and then returned, **scheduling nothing**. The snapshot stayed
> stale until the *next* tick, up to twelve hours after Roon had already finished.

That is why the manual Rescan looked like the only cure: it forces past that gate. Declining to
rebuild during an import now arms a re-check a few minutes out, and an ordinary album open that
notices Roon's live album count no longer matches the snapshot arms one too. One pending re-check at
a time, capped so a permanently-churning library cannot poll forever, and the budget is wide enough
to outlast a large streaming import.

### Added — the extension now says what is actually wrong

Three facts were being thrown away at the exact moment a user needed them:

- **Roon's own words.** A browse response can come back as `action: "message"` carrying the Core's
  explanation and an `is_error` flag. Four sites discarded it and raised *"Unexpected browse action:
  message"* — a sentence about a protocol where Roon had supplied the reason. Roon's message is now
  shown as *"Roon says: …"*, and because such advisories are transient it gets the same "try again"
  contract a stale offset does rather than a server error.
- **Roon's live album count.** Already fetched on every album open and every play, and dropped on
  the floor. Against the snapshot's count it proves the library has changed — free, and available at
  the moment of failure.
- **How many tracks Roon said the album had.** The level declares its row count, so a short read is
  now distinguishable from a short album. The view says *"Roon sent 3 of 12 tracks"* instead of
  silently hiding the whole section.

`/api/status` also reports the sync state at last. The extension has always known when it last saw
Roon importing; that only ever reached Roon's own Settings screen, so the app itself could not tell
anyone why albums were misbehaving.

**On wording.** A count mismatch proves the library *changed*; it does not prove an import is running
*now* — establishing that costs four Core calls and a five-second sleep, which is not available on a
play path. So the message stays past tense: *"your library has changed since this list was built."*
A test pins that, because replacing a vague truth with a confident guess is the easy mistake here.

### Fixed — "No matching action for 'play_now'. Available: "

An internal diagnostic shown to a human in a toast, with a dangling empty list whenever Roon had
offered no menu at all. Four sites built their own copy of it. One shared builder now tells the two
cases apart: Roon offered nothing, or Roon offered something else and here is what.

### Changed — Labels and Smart Picks leave the side menu when switched off

A menu entry for a disabled feature leads to a screen that can only ever be empty. Hidden at boot
and the instant the switch is flipped, on whichever device flipped it and on the next open elsewhere.

### Tests
- `test/unit/librarychange.test.js` — 16 tests over the message builders, the recheck budget, and
  static assertions that the importing branch and the album-open path both arm a recheck (neither is
  reachable from a unit test — both are async I/O against a live Core).
- 9/9 mutations caught. Suite: 41 static / 681 unit / 272 dom.

## [1.7.48] — 2026-08-10

### Changed — Labels and Smart Picks are now opt-in, and off means *off*

Both reach the network on their own schedule — Smart Picks queries MusicBrainz and ListenBrainz and
writes favourites into a streaming library; the label pipeline walks five metadata APIs and fetches
logos — so neither should be running for somebody who never asked for it. Both are off by default,
with a switch at the top of their Settings page.

**Off stops the timers, not just the rows.** Smart Picks is gated in `kickSmartPicks`, the single
funnel every entry point goes through (the ten-minute timer, the post-sync kick, the request path
and the manual rebuild), and the timer is not started at all while it is off. Labels is gated inside
the scan itself.

**Existing users are not switched off underneath them.** An absent setting plus evidence of use on
the data volume — a populated label cache, or picks already built — is read as consent, because that
state cannot exist unless the feature was running and nobody minded. The decision is written down
once, so it never has to be inferred again. A fresh install has neither and starts off.

**One deliberate exception, and it matters.** Turning Labels off does *not* stop the `/music` tag
read. That pass is where release years (the Decade filter), the "local files" badge, and the Format,
Sample rate, Bit depth and Channels filters come from — gating the whole scan would take four
filters and two badges down with the labels, which is not what the switch asks for. The gate sits
exactly at the boundary: the tag read still happens, and the label names, the iTunes → Qobuz →
TheAudioDB → MusicBrainz → Discogs cascade and the FanArt/Discogs logo fetches do not. That
placement is asserted by a test, because getting it wrong in either direction is invisible in a diff.

### Removed — the Smart Picks "stretch" pick

The sixth daily pick, drawn from a genre the library barely touched. It read well on paper and did
not work in practice: an artist reached through a genre tag rather than through the user's own taste
is a stranger, and the answer was almost always no. Removed rather than hidden — the build path, the
genre-weighting, the MusicBrainz tag traffic behind it, the badge, the card styling and the copy are
all gone. Smart Picks is five albums a day.

### Added — Settings → Home Screen

Every Home carousel in one list: a drag handle on the left, an on/off switch on the right, hold the
handle to drag a row into a new position. **A row switched off is not fetched at all** — the loader
skips it rather than loading it and hiding the result.

The list is built from the same row table the Home screen itself loops, so the rows you can reorder
and the rows that actually render cannot drift apart. Reordering *moves* the live sections rather
than rebuilding them from markup, which is the v1.6.52 lesson about listeners. The layout is stored
on the server, so it is the same on every device, and it is repaired on read: a row removed by an
update is dropped, and a row *added* by an update appears switched on rather than silently hidden.

### Added — a Recently played row

Albums played in the last 30 days, most recent first, one tile per album rather than one per play.
Older plays are deleted outright rather than merely hidden from the row — `plays` was the one table
here that grew without bound. Toggleable and reorderable like every other row.

The artist on each tile comes from the library snapshot, never from the play history: that column
holds the *track* artist, so a compilation would name a performer rather than the record.

### Tests
- `test/unit/homerows.test.js` — 21 tests over the layout repair rules and the Smart Picks gate,
  including a newly-shipped row defaulting to visible as a named case.
- `test/static/preflight.test.js` — the Labels gate's *position* between the file walk and the
  metadata cascade, since that ordering is not reachable from a unit test.
- The static preflight suite now reads through the extractor rather than opening `index.js`
  directly, so mutation runs can actually reach it — it had been passing against every mutant.
- 6/6 mutations caught. Suite: 41 static / 665 unit / 272 dom.

## [1.7.47] — 2026-08-10

### Fixed — a partial answer from Roon could permanently destroy an album's track record

v1.7.46 records an album's tracks under its identity, and does so by **replacing** that album's rows
wholesale — deliberately, so that a re-rip or a different edition cannot leave phantom tracks behind.
The hole in that: while Roon is re-indexing, an album's contents come back short — rows arrive as
placeholders with no `item_key`, or do not arrive at all. Reading three tracks of a twelve-track
album at that moment would overwrite the correct twelve-track record for good, and playlist import
would then resolve against a nine-track hole with no way to know it.

Roon's response already says how many rows the level holds, so a short read costs nothing to detect —
the count sits in the reply that was fetched anyway. When the rows delivered are fewer than the rows
declared, the cache is simply not written: a partial answer is not evidence about an album's
contents. It is also logged, so the condition stops being invisible.

This is the same reasoning as the rest of the resolver — an absent or partial fact must not be read
as a complete one — applied to the write side rather than the read side.

## [1.7.46] — 2026-08-05

### Fixed — a shared playlist could match the WRONG album, silently

The title-only rung of the import resolver did not look at the artist at all. With Queen's
"Greatest Hits" in the library and no Foo Fighters one, the entry *All My Life · Foo Fighters ·
Greatest Hits* resolved to **Queen** — and was reported as a clean match, not even listed as a
substitution. A miss is a visible, honest outcome; the wrong record placed quietly into somebody's
playlist is the exact failure this report was built to prevent. The rung still exists, because a
Various Artists compilation genuinely cannot name the track's artist, but an album crediting a
*different* artist is now declined.

### Fixed — owning two editions of an album made it unmatchable

v1.7.44 began stripping edition suffixes to build identities, so "Greatest Hits" and "Greatest Hits
(Deluxe Edition)" by one artist both claim the same key. They were then ambiguous *by construction*
and every later rung declined — meaning a library that owned both editions resolved worse than one
that owned neither, and worse than the same library did before v1.7.44. When exactly one of them is
titled precisely what the share named, there was never anything ambiguous about it.

### Added — Roon's name for a record can be longer than the one on disk

Roon identifies a compilation as *"20th Century Masters - The Millennium Collection: The Best of The
Cranberries"* where the files on disk say *"The Best Of The Cranberries (20th Century Masters)"*. No
amount of suffix-stripping reaches that, because the extra words are on the front. A containment
rung now bridges it, guarded hard: whole words only (never substrings — the v1.6.56 lesson), at
least three of them, the credit must *name* the artist, and exactly one album may qualify.

### Added — the extension now knows which tracks are on which album

This was the real gap, and it is why the previous fix did not land. **Nothing in this extension
recorded track titles.** The snapshot is album-level. The /music scan opens one file per *directory*
and never reads the title tag. No service client makes a track-level call. So when a share named a
record this library files under a different name, "which album holds this track, then?" had no
answer at any price — every rung could only compare names, and no name comparison discovers that
Roon groups a recording differently than the server that shared it.

A new `album_tracks` table records Roon's own contents for an album, keyed by album identity rather
than by offset so it outlives the snapshot. It fills itself for free: **every album you open in the
app** writes its track list through. Import then answers from it with zero Roon calls, refusing on
ambiguity exactly as the album rungs do — a track on two records is a coin flip, and the artist gate
keeps somebody else's cover version out entirely.

For what is still unknown, import runs a **second pass** that opens the handful of library albums
credited to that artist and reads their contents — bounded to 25 albums per import and 8 per entry,
cached permanently, and shared across entries so two tracks off one record cost one lookup. It runs
automatically after the instant result is already on screen, because a manual search is the thing
this replaces.

Also: the play history is no longer matched byte-for-byte (Roon's "Dreams (Remastered 2020)" now
meets a share's "Dreams"), its artist column is grouped correctly instead of being an arbitrary row's
value used as a veto, and the import resolves each entry once rather than twice.

### Fixed — a silent zone after the Random Album Radio appended an album

Following the v1.7.45 investigation, with `/api/radio` confirming radio was enabled for the reporting
user's zone. Two defects, one of which needs no timing assumption at all:

- **The recovery was suppressed and its evidence spent.** When a top-up was in flight and the queue
  ran dry, the resulting `"play"` decision was dropped by the "already working" guard — but the line
  recording the zone's state ran anyway, consuming the playing→stopped transition that is the only
  thing authorising `"play"`. It could then never fire again for that episode, so a slow or failed
  top-up left the zone silent for good. A dropped decision no longer consumes the transition, and a
  re-check reconsiders the zone once the guard lapses, because a stopped zone emits no further events
  on its own.
- **An append landing in a queue Roon had already stopped.** The append fires during the last track
  but takes eight sequential Roon calls to land. If the audio runs out first, the album arrives in a
  stopped queue and nothing restarts it: the radio's only start verb was Roon's browse Play Now,
  which *replaces* a queue, so it is correctly never used on a queue with music in it. A third verb
  now resumes the existing queue instead. It is scoped to finishing what the extension started —
  it fires only when the zone stopped while *our own* append was in flight, once per episode, and
  never when Roon says the zone cannot play. The queue floor also moved from one track of headroom
  to two, which costs nothing because appending is not destructive.

This is a mechanism that fits the report; it is not proof that it caused it. The v1.7.45 `[zone]`
logging is what will settle that, and a `[radio] resume` line now says plainly when it happens.

### Fixed — a Roon browse call that never came back hung forever

`browse` and `load` were the only I/O in the file with no deadline — `/api/queue` has one, every
HTTP fetch goes through `fetchWithTimeout`. A Core that accepted a call and never answered left its
promise pending permanently, leaking the pooled browse session and, on the radio path, never
clearing the "already working" guard. Now 90 seconds: a stuck-call backstop, deliberately far beyond
any healthy call so a slow Core is not broken by it.

Guard hardening throughout: `Number.isFinite`, not `typeof x === "number"`. NaN passes the typeof
test and every comparison against it is false, so the same value read as "not empty" *and* "not
full" — it slipped through the new resume guard during development and was caught by a mutation
check.

### Fixed — nine defects the review of this change found in it, before release

The parallel review pass caught two that re-opened the very bug above, and they are recorded here
rather than quietly patched, because both were introduced by the fix itself:

- **The edition-twin tiebreak re-admitted uncredited albums.** It fell back to the full set when
  *no* album was credited to the share's artist — walking straight around the credit check one rung
  above. With Queen's and ABBA's "Greatest Hits" in the library and no Foo Fighters one, a Foo
  Fighters track resolved to **Queen** again, returned as a clean match. The tiebreak now only ever
  looks at albums that credit the artist.
- **Containment was bidirectional.** The rung exists because *Roon's* name can be the longer one;
  accepting the reverse resolved "20 Golden Greats Volume 2" onto "20 Golden Greats", and "The Dark
  Side of the Moon Live" onto the studio album. Those are different records. It is one-directional
  now, and a containment match reports as `contains`, so it lands in the substitution list instead
  of passing as an exact match.

Also from the review:

- The track-index lookup read a fixed window ordered by a track's position on its album, so a
  generic title ("Intro", "Untitled") could have the real album truncated out — and the caller,
  seeing one survivor, would resolve confidently to the wrong record. It now reads distinct albums
  and declines outright when it cannot see the whole set: uniqueness has to be *shown*, not assumed.
- The play-history canonical retry ran an unparameterised full-table aggregate **per unmatched
  entry**, though its result is identical every time. On a large history that measured tens of
  seconds of fully blocked event loop per import — better-sqlite3 is synchronous, so nothing else in
  the process runs meanwhile. Memoised for a minute.
- The deep pass re-derived credit identities for every (album × entry) instead of using the ones
  already on each record, and since the entries reaching it are precisely those whose artist is
  absent from the library, the loop never broke early.
- The write-through was hooked at one of four places that hold a track list. It now sits in
  `loadAlbumSession`, which all four go through — so the album view, per-track actions,
  dynamic-playlist materialisation and add-albums all contribute — and it is deferred off the tick
  so a cache fill never sits in front of the music.
- The Save button stayed live during the second pass; saving there created a playlist from the
  smaller set, and a second tap made a *second* playlist with the same name. Disabled until the
  count is final.
- The deep pass had an album budget but no clock, on an unauthenticated route where each open can
  take up to 90s against a wedged Core. It now has a 45s wall-clock budget too.
- `radioResumeDecision` did not stand down for Roon Radio, which would have made the "the two never
  fight" guarantee false; the episode could be latched from a top-up that finished long ago,
  which would have restarted music a user deliberately stopped; a resume Roon refused was terminal;
  and radio state survived unpair and zone removal, so a stranding latched before a Core reboot could
  resume a queue on reconnect. All closed, with the resume capped at three attempts.

### Tests
- `test/unit/import-tracks.test.js` — 51 tests over the resolver's rungs and the track index,
  including the Queen mis-match and both review regressions as named cases. 12/12 + 5/5 mutations
  caught.
- `test/unit/radio.test.js` — extended to 34; 8/9 mutations caught (the ninth is a
  consistency-only change with no behavioural difference, and is not claimed as covered).
- Suite: 37 static / 657 unit / 274 dom.

## [1.7.45] — 2026-08-05

### Investigated — "playback stops at the end of an album even when another track is queued"

**With Random Album Radio off for a zone (the default), this extension cannot stop that zone or
empty its queue.** There is no code path. Every playback command — play/pause/stop/next, pause_all,
transfer_zone, grouping, play_from_here, standby — lives inside an HTTP handler reached only from a
click. Every `setInterval` in the server and the client was checked; none issues a transport command.
The zone poll is a pure read, and nothing anywhere reacts to `state === "stopped"`.

With radio **on**, the extension makes exactly one automatic queue write, and its timing coincides
exactly with the reported failure: during the final track of every album it invokes Roon's own Queue
action to append the next one. That is an append — `matchAction` will only return an action whose
title matches `/queue/`, and the loose "starts with play" fallback is gated to `kind === "play_now"`
— so it cannot replace a queue. Whether an append during the last track can make Roon stop is not
observable from this code, and this changelog will not pretend otherwise. What is now possible is
telling the two apart from the log.

### Added — always-on zone transition logging

The one fact that settles this — *did the queue still have items at the instant Roon stopped?* — was
read in exactly one place (`radioDecision`) and recorded nowhere: not in the zone poll, not in
`/api/zones`, not in any log line. So the question could not be answered even in principle.

Every genuine zone state change now logs one unconditional line:

```
[zone] "Kitchen" playing→stopped remaining=3 radio=off auto_radio=false np="Track / Artist"
```

`remaining=absent` is printed as such rather than as `0`, because those are different facts. The
`[radio]` lines are unconditional too now, and one is emitted **before** the Core call as well as
after, so a top-up that hangs inside Roon is visible instead of silent.

### Fixed — an absent queue count was read as an empty queue

Found while investigating. `radioDecision` treated a **missing** `queue_items_remaining` on a stopped
zone as "the queue is empty" and returned `"play"` — which is Roon's Play Now, and **replaces the
queue**. `queue_items_remaining` is optional in Roon's transport payload, so a Core that simply did
not mention the field could have had a user's queue wiped and a random album started over it.

This is the third appearance of one error class in this project, and v1.7.1 already named it:
*"Unknown" read as "none"*. Absent is not zero. The asymmetry that makes the fix correct is that
`"queue"` only appends, so thin evidence costs an extra album, while `"play"` destroys something and
may only fire on positive evidence.

It does **not** explain the reported symptom — if that path fired, music would start, not stop — and
it is not presented as the fix for it.

### Tests
- `test/unit/radio.test.js` — 21 tests, the first this feature has ever had, which is how the above
  survived. Pins the append/replace asymmetry, that only a stopped zone can produce the destructive
  verb, and that absent, `null`, `"0"` and `NaN` are none of them an empty queue.
- 593 unit + 274 DOM + 37 static.

### How to check your own case
`GET http://<host>:3399/api/radio` lists the zones radio is enabled for. If the affected zone is not
in that list, this extension made no automatic queue writes and the cause is elsewhere. Note radio
can also be switched on from **Roon's** Settings → Extensions, per zone, so never having touched the
toggle in the app is not conclusive.

## [1.7.44] — 2026-08-05

### Fixed — imported playlists reported tracks as missing that you actually own

A playlist shared from a Lyrion/LMS instance indexing **the same local files and the same Qobuz
account** reported tracks as unmatched. Three real examples, all compilations: *Dreams* and *Linger*
by The Cranberries on "The Best Of The Cranberries (20th Century Masters)", and *All My Life* by Foo
Fighters on "Greatest Hits".

Two servers indexing the same music do not agree on how to group or title a compilation, and Roon in
particular credits one to **Various Artists** while a playlist names the *track's* artist. The
resolver compared `normalize(album)` for exact equality and `normalize(artist)` for exact equality —
stricter than anything else in this codebase. Every other identity path here (source badges, the file
join, streaming favourites) matches through `albumKeys`, which strips edition suffixes, folds
"&"/"and", drops a leading "The" and splits a credit into individual artists. The import path simply
never used any of it.

It does now, in rungs, and still **zero Roon calls**:

1. **Tolerant identity** — `albumKeys`, so "(20th Century Masters)" and a leading "The" stop mattering.
2. **Title alone, edition suffixes stripped** — the compilation case, where no title+artist key can
   ever match because the album is credited to Various Artists. Safe only when exactly one album in
   the library carries that title.
3. **The credit decides** among several albums sharing a title, using the same whole-name comparison
   the artist links use.
4. **The play history** — `plays` records `line3` from Roon's own now-playing feed, so for any track
   this household has played it already holds **Roon's** name for the album that track sits on. That
   is the one fact a share cannot carry and the snapshot cannot infer, and reading it is free.

**The safety rule is unchanged.** A coin flip is still refused: two albums sharing a title with no
artist to separate them resolves to nothing, exactly as before. What changed is that far fewer
entries are *genuinely* ambiguous. And because rung 4 can find a track under an album the share never
named, the import report now lists those separately — *"N found on a different album than the
playlist named"* — because silently swapping one record for another is what makes these tools
untrustworthy.

A side effect worth noting: an entry with **no album at all** can now resolve. Shares made from a
Roon playlist carry no album (Roon does not put one on the row), so those were previously
unresolvable by construction.

### Fixed — a test fixture that was hiding all of this

`test/unit/userplaylists.test.js` faked every album's `srcKeys` as `"k1"`, `"k2"`… and stubbed
`creditIdentities` with the wrong shape, which makes `creditHasArtist` return false for everything.
So the identity rung matched nothing and the artist-disambiguation test passed without ever reaching
the comparison it claimed to be about. Both are now faithful to production, plus 20 new tests
covering the compilation case and the history rung against a real SQLite `plays` table.

## [1.7.43] — 2026-08-05

### Fixed — "Couldn't play from here: Load failed" when opening the app

A native dialog appeared over Now playing on reopening the installed PWA, while the music was
playing perfectly well.

"Load failed" is WebKit's message for a fetch that never completed. The chain: you tap a queue row
and confirm, `/api/play-from-here` goes out, Roon answers from inside a Core callback (which this
project has already measured at seconds under import congestion), iOS backgrounds the app before the
response arrives and tears the connection down. The rejection is delivered **when you reopen the
app**, and the catch reported a failure for a tap you made minutes earlier. The server had already
carried the command out — which is exactly why the music was playing.

A request interrupted by the app being suspended is no longer reported: the queue is quietly
re-pulled instead (the success path's own follow-up never ran). A request that fails while the app
is in the *foreground* still reports, so nothing real is swallowed.

While in there: these were the app's last two `window.alert` / `window.confirm` calls. They now use
the app's own confirm sheet and toast like everything else — which also closes a second route to the
same bug, since a native confirm left open while the app is backgrounded resolves on reopen and
fires the request into a network stack that is still coming back up.

### Changed — one overflow menu, Roon's three-dots-in-a-circle

The playlist action row ran six pill buttons across one line. `.action-btn` is `flex: 1 1 0`, so they
shrank together instead of wrapping and "Send to Roon" rendered as "end to Roo".

**Play now** and **Queue** stay on the row; everything else moves behind a ⋯ button:

- Dynamic Playlist — Send to Roon, Share, Edit, Delete
- Roon playlist — Share
- Stored playlist — Share, Delete
- Album view — Next, Shuffle, Radio (five pills had the same problem)

The multi-select menu already *was* an overflow menu; it wore a chevron, which reads as "expand"
rather than "more actions", so it now wears the same glyph. Its count badge stays — it is the only
indication of how many items are selected.

One SVG and one `buildOverflowMenu()` for all of it, and the dropdown reuses the existing
`.sel-menu` styling rather than introducing a second dropdown that almost matches.

Deliberately **not** converted, after a survey of every candidate: tab bars, the side menu, the
Settings list, the zone pickers (the trigger is a picker for where the music plays — hiding that
behind ⋯ would bury the most-used control in the app), the Library Sort/Focus row (its labels are a
state readout, not a name), and the wall display (a 10-foot screen where a small circular glyph is
the wrong ergonomics, and which cannot reach the shared helper without copying it).

### Fixed — the playlist name was shown twice

The topbar printed a truncated copy ("My Dynamic Playlist - Electroni…") directly above the full
heading. All three playlist detail screens already print their own name, so the topbar copy is gone;
an empty title now hides the readout rather than showing a blank one.

## [1.7.42] — 2026-08-05

### Fixed — Now playing sat under the status bar

Reported as "occasionally when I reopen the extension and go to the now playing screen it is
stretched too high above the top of the screen".

The page is served `viewport-fit=cover`, which is what lets the app fill the display edge to edge —
and which also means the layout viewport starts at the *physical* top of the screen, under the
status bar and the dynamic island. The topbar has always added `env(safe-area-inset-top)` back. The
modal never did, and Now playing is where it shows worst: its design deliberately shortens the top
padding to 14px so the tabs sit beside the corner buttons, leaving nothing to absorb a ~59px status
bar. Only visible in the installed PWA — in a browser tab the address bar occupies that space — which
is why it read as occasional. The inset is now applied to the modal body, the Now playing body, and
all three pinned corner buttons.

My first diagnosis was wrong and is worth recording: I assumed a retained `scrollTop` on the shared
`.modal-body`. The Now playing tab is `overflow: hidden` and cannot scroll at all, so that could
never have been it. The scroll reset that came out of the wrong theory is kept — an album opened
after another was scrolled halfway down really did start halfway down — but it is not this fix.

### Fixed — Smart Picks kept asking you to add albums you had already added

Tapping Add favourited the album on Qobuz and latched the button to "Added" — **in the DOM node
only**. Reopening the app rebuilt the card from the server, which had no idea, so every pick read
"+ Add" again and tapping it asked to add an album that was already in the Qobuz library.

`added` is now derived on every read from the service's own favourite ids — the same source the
Qobuz browser already uses — so it is true on every device and after every restart. A service that
cannot be reached reports `null` (not asked) rather than `false`, so a Qobuz outage never claims an
album is un-added.

### Added — the five genre picks are ready to play

They are favourited automatically when they are chosen, so Roon has the whole night to import them.
Each card then shows one of three states, and which one is entirely about what Roon has done:

- **Play** — Roon has imported it, so it has a real library offset and plays like any other album.
- **Added — waiting for Roon** — favourited on the service, not imported yet. Roon decides when.
- **Add** — not in the streaming library.

The **stretch pick is never auto-added**: it is the one album a day you are actually being asked to
judge, and putting it in your library unasked would remove the only decision the feature makes.
Auto-add can be turned off, at which point all six behave as Add / Not for me.

### Added — Settings → Smart Picks

The daily build now runs at an hour **you choose** (default 04:00 local) rather than whenever the
first request of the day happened to arrive. It reaches three external services and then hands Roon a
batch of albums to import, so keeping it away from Roon's own work matters. If the box is off at that
hour the build runs the next time it starts, so a day is never skipped. The pane also carries the
auto-add switch and a **Rebuild** button that discards today's set and chooses six again.

### Changed — Pause all / Mute all / Unmute all moved to the zone picker

They were in the side menu; they act on zones, so they now live in the sheet that is already about
zones — both the now-playing picker and the mini-transport one. One implementation behind all six
buttons, so the two pickers cannot drift apart. A test now asserts they are **gone** from the side
menu, because a move that only adds leaves two copies of every action.

## [1.7.41] — 2026-08-05

### Added — Smart Picks: six albums a day by artists you don't own

A discovery feature rather than a playlist generator. Every day it surfaces **five "adjacent" picks**
— artists absent from your library but rooted in genres it already lives in — and **one "stretch"
pick** from a genre your library barely touches. There is a Smart Picks row on Home and a full
screen from the side menu carrying each pick's reason and its actions.

**Nothing here touches the Roon Core.** Library analysis reads the existing snapshot; similarity
comes from ListenBrainz and MusicBrainz over plain HTTP; albums are resolved against Qobuz/TIDAL.
The only Core cost is the sync that already runs, noticing a newly favourited album. The build runs
on the v1.7.38 global background queue, so it can never burst alongside a genre walk or an art
prewarm.

**Picks are addable, not playable.** Roon plays only what is in the library, so an artist name alone
is useless — every pick is resolved to a real streaming album, and Add favourites it so Roon imports
it and it becomes playable on the next sync. Add is deliberately one-way: unlike the Qobuz browser's
toggle, a second tap cannot silently un-favourite what you just asked for.

Three decisions do the actual work, and each was made against measured output rather than intuition:

- **Seeds come from the obscure end of your library.** Similarity quality *inverts* with seed
  popularity — Radiohead returns Nirvana, RHCP and Coldplay, while Bark Psychosis returns Mogwai,
  Talk Talk, Tortoise, Slint and Labradford. One request for ListenBrainz's sitewide top 1000 gives
  a hub list, and no artist on it is ever used as a seed or offered as a pick.
- **Ranking is by distance from your library, not similarity to it.** An artist reachable from one
  seed outranks one reachable from twelve: the latter is somebody you have had every opportunity to
  buy and haven't. Every other recommender sorts the other way, which is why they all return the
  obvious.
- **The picks are dealt round-robin across seeds.** Caught by running the real pipeline against the
  live APIs: ranking alone returned Loscil, Harold Budd, Hammock, Helios and Biosphere — five
  ambient records that were all neighbours of one album, saying one thing between them. Once most
  candidates sit in the one-seed bucket the sort decides on score alone and the loudest seed takes
  every slot. Dealing one candidate per seed per round turns that into Loscil, Do Make Say Think,
  Galaxie 500, Benoît Pioulard and The White Birch.

The stretch pick draws from MusicBrainz's relevance order for a genre, so it is that genre's
canonical name (Flamenco → Camarón de la Isla) rather than a random unknown — a stretch worth
listening to, not just an unfamiliar one. Its reason line never claims similarity to anything,
because it was chosen for the opposite.

Every reason line is derived from the chain that produced the pick, so it is always true. **No LLM
is involved.** A generated sentence would read better and would sometimes be wrong, and a
hallucinated album cannot be favourited — it just looks broken.

**"Not for me" is permanent and explicit; silence is never rejection.** The premise is albums you
would not otherwise reach for, so treating an ignored pick as a no would empty the pool within a
week. Shown artists rotate out for 120 days and come back.

### Added
- `lib/discovery.js` — keyless clients for ListenBrainz similar-artists (batched, one request per
  ten seeds, each result attributed to the seed that reached it), the sitewide hub chart, and
  MusicBrainz genre rosters.
- New tables on the data volume: `smart_picks`, `smart_pick_seen`, `smart_pick_blocks`, and
  `smart_cache` — every third-party read is persisted, so a rebuild on an unchanged library costs no
  network calls either. Expired cache rows are swept once per build.
- 114 new tests (97 unit, 17 DOM), with all 20 policy and safety mutations verified to fail the
  suite.

### Fixed — the 8-angle review, before this ever shipped

The review found nine defects in the new code. Six would have been visible to a user:

- **The TIDAL path could never succeed.** `searchArtists` returns `{items, total}`, not an array,
  so `(found || []).find(...)` threw on every lookup — the `|| []` never fires because an object is
  truthy. For a TIDAL-only setup that meant zero picks, permanently.
- **The whole Smart Picks screen rendered in one grid cell** — 110px on a phone, 125px on desktop.
  A container appended into the shared `#album-grid` must carry `grid-column: 1 / -1`, exactly as
  `.playlist-detail` does. Every element was present and every count correct, so only a measurement
  could see it; the DOM test now takes one.
- **The stretch pick led the row every day.** The read sorted `ORDER BY kind DESC` and "stretch"
  sorts after "adjacent", inverting the rank the writer had just assigned. Now covered by a test
  that builds the real schema out of index.js and exercises the real query.
- **An unbounded build.** Every candidate *tried* costs a streaming search, so the pool size was not
  the bound. A day with expired credentials would walk 150 candidates and then every outside genre
  times its 60-artist roster — thousands of live calls against the unofficial Qobuz/TIDAL APIs.
  Capped, plus a 429 abort matching the existing Discogs/iTunes precedent.
- **A zero-pick day was retried on every request**, because "did we build today?" was answered by
  "are there rows?". Now marked. The build is also skipped outright with no service connected, since
  every resolve would return null.
- **`/api/smart-picks` awaited the whole background queue.** `bgRun` returns the tail *after*
  appending, so awaiting it waits for everything already queued — on a fresh pair, an art prewarm of
  the entire library. The build is now timer-driven and the route is a pure read.

Three more were latent but would have been very hard to diagnose:

- An empty hub chart would have **silently disabled the seed policy** — no hubs means no filtering,
  so the feature would seed from the library's most famous artists, the exact inversion it exists to
  avoid. It now refuses to build rather than produce a day of picks that discredit it.
- A negative album lookup was cached for seven days **even when no service had been consulted**, so
  a user who connected Qobuz would have got an empty feature for a week. A transient failure was
  cached the same way.
- Rows the similarity endpoint failed to attribute to a seed would have **poisoned every seed's
  cache with an empty array for 30 days**, with nothing in the log, because the request succeeded.

### Changed
- `libraryArtistProfile` is deliberately uncached: the obvious key (`albumIndex.builtAt`) only moves
  on a full walk, so on a library that has stopped growing it would freeze the play counts forever —
  and plays-per-album-owned *is* the seed policy.
- `albumPlayKey` replaces the duplicated plays-table key expression in `libraryView`.

## [1.7.40] — 2026-08-04

An agent audit of the duplicate genre walk visible in a production log. Every Home load was making
six Roon calls, two of them a byte-for-byte duplicate.

### Fixed — /api/filters/genres had no cache at all
It walked the genres hierarchy on **every single request**. The client fetches it and
`/api/home/genre-groups` together on Home load, and both walk the same root — which is why the log
showed two browse sessions hitting `genres pop_all` 2 ms apart. It is now cached for thirty minutes
like its neighbour.

**The HTTP 304s these requests return are a red herring.** Express computes the ETag from the
finished response body, so the handler has already made every Roon call by the time the 304 is
decided. They save bandwidth and nothing else — worth knowing before anyone "fixes" this with
`Cache-Control`.

### Fixed — neither genre cache was ever invalidated
Both are TTL-cached against the Core and neither was on any invalidation path, so a genre added to
the library stayed invisible on Home and in the filter sheet until the clock ran out, with no way to
hurry it. Both are now cleared by `bumpLibraryMeta()` alongside the library view cache.

### Fixed — concurrent cache misses each ran their own fetch
`makeTtlCache` only wrote the map after the fetch resolved, so two callers arriving on a cold key
both did the work. On Home that is two Roon walks; with several clients waking together it
multiplies. Callers now share one in-flight fetch.

**A rejection is never stored.** The obvious way to share a promise is to put it in the same map as
the values, which caches the *failure* for the whole TTL — turning a one-second Core blip into a
half-hour outage that looks exactly like the Core being down. The next caller after a failure
retries.

### Note — a `typeof` guard that would have crashed startup
The first draft declared the caches near their routes and guarded `bumpLibraryMeta` with
`typeof x !== "undefined"`. That does not work: unlike an undeclared name, a `const` in its temporal
dead zone throws from `typeof` too, and `bumpLibraryMeta` runs during startup. Caught by the
pre-flight before it shipped; the caches are now declared at first use, as the rules require.

### Tests
26 static / 446 unit / 243 dom. `ttlcache.test.js` drives the real cache, and the failure-caching
case is asserted directly — it is the one way this change could make things materially worse.

## [1.7.39] — 2026-08-04

Diagnostic build. v1.7.38's genre-harvest skip rests on an assumption nobody has verified, and this
makes one restart answer it.

### Added — the harvest says whether its own optimisation can work
The skip decides a genre is unchanged by comparing the album count Roon states in that genre's
subtitle. **If Roon's genre list carries no such count, `parseAlbumCount` returns null, the "any
doubt walks" guard fires for every genre, and the skip never engages** — while the harvest goes on
logging plausible totals. A failure that hides itself is worse than one that shouts, so it now says
which case it is in, once per harvest, in words:

```
[genres] fingerprint OK — all 21 genres state an album count, so unchanged ones can be skipped
```

or

```
[genres] fingerprint UNUSABLE — only 0 of 21 genres state an album count (0 have any subtitle at
all), so every genre must be walked every time. Sample: "Pop/Rock => ", "Jazz => ", …
```

The sample matters: without it there is no way to tell "Roon sends nothing" from "Roon sends
something we failed to parse", and those need different fixes. Unconditional, not behind `RRA_DEBUG`
— the answer matters on a quiet install too.

The classification is a named function rather than an inline block, so it is testable. A library
where the skip can never work being reported as "all good" is precisely the failure this exists to
prevent, and that is now pinned by tests rather than by reading.

A **partial** result counts as UNUSABLE. One unfingerprintable genre makes the scheme unreliable,
and "mostly works" is the reading that would stop anyone looking further.

### Fixed — the harvest summary mixed two different units
It reported `albumGenreCache.size` as "albums genred" alongside an album count. The cache is keyed
on identity, and albums sharing an identity share a row — so on a real library that read
`8816 albums genred … 237 with no genre` out of 9,209, a 156-album gap that looks like data loss
and is not. It now says identities and albums separately.

### Measured, for the record
On a 9,209-album library with 21 genres: the full snapshot build is 21 Roon calls in 0.5 s and the
full genre harvest is ~142 calls in 3 s. Both are far cheaper than the estimates in v1.7.38's notes,
which assumed a 2,234-album library. If the fingerprint turns out to be unusable, the honest
conclusion is that a 3-second harvest does not justify further complexity.

### Tests
26 static / 434 unit / 243 dom.

## [1.7.38] — 2026-08-04

Performance pass on the Roon Core. The extension is welcome to spend its own CPU and RAM; the
Core is not. Two agents audited the real call counts before anything was changed, and one of them
corrected a wrong assumption of mine before it became code.

### Changed — the genre harvest now skips genres that haven't changed
It cost ~6 Roon calls per genre, ~180 per sync, and ran in full whenever the library changed at
all — even when the change had nothing to do with genres. Roon states each genre's album count in
the subtitle of the root listing the harvest **already fetches**, so the fingerprint that decides
whether a genre needs walking was free and was being discarded one line later.

A genre is skipped only when its raw subtitle *and* its image key are unchanged, its count parses,
and the count it last stated matches the count its album list actually reported. Any doubt walks.

- **Steady state with nothing changed: 2 calls instead of ~180.**
- A sync that touched three genres: ~20.
- **A full sweep runs weekly regardless.** No free fingerprint can see a same-count membership
  swap, or an album Roon re-identified — that changes the mapping's key without moving any genre's
  count. So the skip is bounded by time rather than trusted indefinitely.
- The Rescan button always forces a full walk. It is what you press when the Genre facet looks
  wrong, and a recourse that can be skipped is not a recourse.

### Fixed — an album could gain a genre but never lose one
The harvest merged into the previous value (`(prev || []).concat(name)`), which made album→genres a
monotonic union: **no full walk could ever correct a removal**, and an album that left a genre kept
it forever. A walked genre's membership is now rebuilt from scratch, and an album that has left
every genre has its row deleted rather than kept empty. This was a real bug shipped in v1.7.35 —
the skip would have been built on top of it.

### Changed — all heavy background work goes through one queue
The art prewarm, the genre walk and the streaming refresh were three fire-and-forget kicks issued
together. The number of calls was never the problem; the **burst** was — it all shares one
multiplexed Core websocket with browse and transport.

The first attempt at this serialised each chain internally and was still wrong: a manual Rescan
starts its own chain *and* triggers a rebuild whose chain starts too, so the two ran side by side
and the two most expensive jobs still overlapped. There is now a single global queue, so at most
one job talks to the Core at a time however many chains are in flight. Order within a sync is
cheapest-first: streaming favourites (no Roon calls at all) → genres → art prewarm last, because
nothing waits on it.

### Fixed — the genre harvest ran during a Roon import
Every other heavy path consults `libraryIsImporting()`; this one only got it transitively, and the
Rescan button called it directly and bypassed the check entirely — at exactly the moment a user is
most likely to press it, right after adding albums.

### Fixed — a failed background job could silently kill every job behind it
The queue used a two-argument `.then`, which treats a rejected tail as handled and **skips the next
job's callback**. One failure would drop the job after it while everything later ran normally.

### Corrected — a claim I made about the art prewarm was wrong
I said it re-fetched every thumbnail on each rebuild. It does not: it has always built its work
list by skipping keys already on disk, so on an unchanged library it makes **zero** image requests —
and on that path it is never even called. The audit also found it is the *only* place that can
answer whether Roon's image keys churn: its own `pruned N stale` log line. Worth watching after a
rebuild.

### Where the load actually is, measured
Idle and paired, with the library unchanged: **14 Roon calls per day**, all of it the two 12-hourly
freshness probes. Everything else is snapshot reads. The genre harvest was the only thing in a
rebuild cycle worth attacking, which is why it is the one thing attacked.

### Changed — the test extractor understands `async function`
Every async top-level function in `index.js` was previously untestable, which had been quietly
steering tests toward the synchronous half of the file. The scan pipeline is entirely async.

### Tests
26 static / 424 unit / 243 dom. New: `syncchain.test.js` drives the real queue (never a stub —
"serialised" is exactly what it provides) including two chains racing, and `genreskip.test.js`
covers the fingerprint's refusal to skip on ambiguous evidence. All new assertions mutation-checked.

## [1.7.37] — 2026-08-04

### Changed — Order and Playlist size now lead the Dynamic Playlist sheet
They are decisions about the *playlist*, not about which albums match, and they were sitting below
ten collapsed facets — a full scroll away from the two controls that screen exists to set. Both now
come first and open by default; the filters follow, still collapsed.

### Added — formats for albums you have no file for, cross-referenced from Qobuz and TIDAL
The quality badge only knew about local files, so a Roon library with streamed albums in it showed
badges on some tiles and nothing on the rest. Those albums are in your library because you *added*
them, which favourites them in the service — and the favourites pages are already being fetched for
the source badges. So this reads one more field off a response already in hand: **no extra request,
no new API, no extra scan.**

- **Qobuz** states an exact bit depth and sample rate, so those albums badge `24/96`, `16/44.1` and
  so on, exactly like local files.
- **TIDAL** states a *tier* rather than numbers, and its hi-res spans 24/44.1 to 24/192. Turning a
  tier into "24/96" would be inventing both numbers, so those badge **Hi-Res**, **Lossless** or
  **AAC** — what TIDAL itself says. Hi-Res is still highlighted.

**A local file always wins.** Sources are ranked (file → Qobuz → TIDAL), so if you own a CD rip of
an album you have also favourited in hi-res, the badge says `16/44.1` — what will actually play.
Claiming `24/96` for audio you will never hear is precisely the confident lie this badge must not
tell. The ranking survives the race between the file walk and the favourites refresh in either
order, and rows written by v1.7.35–36 carry no source, so the first identified one corrects them.

Disconnecting a service takes its formats with it, the way it already takes its badges — otherwise
a bit depth sourced from a removed account would persist on the data volume and come back on the
next restart.

The Focus sheet's Format coverage note and the Appearance toggle's help text both say where the
numbers came from, including that Qobuz gives numbers and TIDAL gives a tier.

### Tests
26 static / 394 unit / 243 dom. The precedence rules are driven in both write orders, because which
of the file scan and the favourites refresh finishes first is a race. All new assertions
mutation-checked.

## [1.7.36] — 2026-08-04

### Added — Dynamic Playlists have an Order: Album order or Random
A Tracks playlist came out in album order, marching through one record at a time. Order is now its
own section in the Focus sheet, separate from what the playlist is made of:

- **Album order** — the sort you chose, each album's tracks in disc order.
- **Random** — shuffles the albums, *and* the tracks within each page, so a Tracks playlist
  genuinely interleaves rather than reordering whole records.

It applies to Albums playlists too, where it shuffles which albums and what order they play in.

The shuffle is **seeded, not `Math.random()`** — deliberately. Tracks are paged by album, so a
fresh shuffle per request would repeat some tracks and skip others as you scroll. It is a pure
function of the playlist's seed, so page 2 continues page 1 instead of reshuffling underneath it.

Random also shuffles **before** the playlist's size limit, not after: a random playlist of 100 is
100 drawn from everything that matched, not the first 100 by title then jumbled.

Listing and playing now read one function, so the wall of albums you are looking at and the queue
the Play button builds cannot be in different orders. The detail screen also states the mode and
order under the title — "Tracks · random · Electronic" — so "why are these shuffled?" is
answerable without opening Edit.

### Added — sample rate and bit depth on the artwork (off by default)
**Appearance → Show sample rate on artwork.** Puts `24/96`, `16/44.1`, or the file type for a
lossy one on every album tile, and on the album view's own cover. Hi-res — anything above 16-bit
or 48 kHz — is tinted with the accent.

It is read from your own files during the library scan, so it costs nothing extra: the scanner
already parsed the format block and had simply never looked at it. A **streamed album has no file
to read, so it gets no badge at all** rather than an empty box or a guess.

A lossy file shows its container (`MP3`, `AAC`) and never a bit depth — music-metadata reports a
`bitsPerSample` for MP3 that describes the decoder, not the recording, so "16/44.1" on a 128 kbps
rip would be a confident lie about CD quality.

The value rides on every album payload, so the switch is one class on `<body>`: it changes the
wall already on screen rather than waiting for a navigation. Stored per device, like the theme.

### Tests
26 static / 381 unit / 242 dom. New: `test/dom/quality-badge.test.js` measures painted boxes
rather than counting elements — `display:none` is how the badge hides, so an element count would
pass with every badge on screen. All new assertions mutation-checked.

## [1.7.35] — 2026-08-04

### Changed — the Library control row now matches Roon
The row read as three heavy boxed pills — SORT | ↑ | FOCUS — where Roon's own phone header is
`› Focus` on the left and the current sort on the right, as plain text over a hairline. That is
what it is now.

**The separate direction arrow is gone.** Roon has no such button: direction is a property of the
sort and lives inside the sort menu, which has flipped it on a re-tap since v1.6.59. The row still
*shows* the direction (and the ⟳ glyph for Random) as part of the sort's own label, so nothing is
hidden — it just isn't its own control any more.

### Added — Focus grew from three categories to ten
Roon's Focus offers genre, format, sample rate, label and more. Ours offered Source, Decade and
Listening. Now:

| Category | Where it comes from |
|---|---|
| **Genre** | Roon's own genres hierarchy, walked once per library sync |
| **Record label** | the label scan that already runs |
| **Format / Sample rate / Bit depth / Channels** | your file tags — free, the scan already parsed them |
| **Starts with** (A–Z) | the snapshot's sort titles |
| **Added in the last** (7 days → a year) | the dates v1.7.31 taught it to work out |
| Source, Decade, Listening | as before, with **Played** added beside Never played |

**Genre is the significant one.** It used to live in the old "main filter", which navigated Roon
into a genre's own list and therefore could not be combined with anything — that list has its own
offset space, unrelated to the full-library offsets every other facet returns. Genres are now
harvested into the snapshot the way release years were in v1.6.59, so Genre is an ordinary chip
that combines with the rest. The join is Roon-to-Roon (both sides are Roon's own title strings),
so unlike years it lands on essentially every album.

### Added — tap a filter again to exclude it
Roon's signature Focus interaction. First tap includes, second excludes (red, struck through),
third clears. Encoded in the value itself, so saved playlists and shared links carry it unchanged.

### Changed — Focus categories collapse
Ten categories, some hundreds of labels long, do not fit on a phone. Each is now a header that
opens, and a category holding an active filter opens by itself — a filter you cannot see is a
filter you cannot clear. Each says how many albums it actually covers, because none of this comes
from Roon and the chips will not add up to the library.

### Added — a new Dynamic Playlist asks Albums or Tracks first
Then it opens the Focus screen, whose options fuel the playlist. **Albums** queues whole records
and its detail screen now shows a wall of albums — read straight from the snapshot, zero Roon
calls, where listing tracks costs ~5 calls per album just to look. **Tracks** behaves as before.

The filter is always album-level, and the sheet says so: Roon publishes no track list without
opening each album, so a genuinely track-level *filter* would mean indexing every track in the
library — ~10,000 Roon calls, redone on every change. That is the traffic the snapshot model
exists to avoid.

### Fixed — the source badge appeared on every single album
v1.7.34 made the Local count right by elimination, and in doing so put a "Local albums" badge on
all 2,234 tiles. A badge that is on everything is not a fact about an album. The count and the
badge are now separate: Focus still says 2,234, and no tile carries a badge unless more than one
source is actually in play.

### Fixed — a capped playlist under-reported what it left out
The "N of M albums" message compared the queued count against the number of albums the endpoint
returned — which is always the same number, so the message was dead code. It now compares against
how many the query *matched*, which is what the playlist was capped against.

### Fixed — clearing the last filter in a category collapsed it
The section's active count dropped to zero mid-repaint and it shut under your finger, taking its
other chips with it.

### Fixed — a filter the server didn't list could not be cleared
Genre and Label are truncated to the commonest 40 values. A saved playlist naming one outside that
list left an active filter with no chip — invisible, and clearable only by wiping every other
filter with it.

### Fixed — `sanitizeLibView` stored `null` as the text "null"
A JSON round-trip of a sparse array produced a valid-looking filter value that matched nothing.

### Changed — "Dynamic Playlists" is capitalised as a feature name

### Not possible, and why
Roon's Focus also offers star ratings, its own favourites, album types (Main/EP/Single) and the
Inspector states. The extension browse API returns `title`, `subtitle`, `image_key`, `item_key`
and `hint` per item — nothing else — and the request side has no sort, filter or focus parameter
at all. The sort/filter feature request has been open on RoonLabs/node-roon-api since 2020. The
Focus sheet says this rather than leaving the gap unexplained.

### Tests
26 static / 360 unit / 233 dom. New: `test/unit/facets.test.js` drives the shipping facet table so
counting and filtering cannot disagree, and `test/dom/focus-sheet.test.js` proves an excluded chip
reaches the server as an exclusion — the chip turning red proves only that the chip turned red.
Every new assertion was mutation-checked.

## [1.7.34] — 2026-08-04

### Changed — the Source facet is now derived, not proved
Every version from v1.7.27 to v1.7.33 attacked the local-album count the same way: prove each
album is local by matching a file tag against Roon's album title. Each fix moved the number
(1601 → 1648 → 1831 → 1953) and none of them could ever finish, because **Roon replaces file tags
with its own metadata for albums it identifies** — so the two sides legitimately disagree about
the album's name and no amount of matching closes the gap.

The question was the wrong one. Roon's library is local files plus streaming albums you have
added, and adding a streaming album favourites it in the service — which is what makes the
Qobuz/TIDAL key sets meaningful in the first place. So **with no streaming service connected,
there is nothing else an album can be**, and locality does not need proving album-by-album at all.

An album no connected service claims is now counted as local. On an all-local library that is
exactly the library size, always, with no join to leak through.

The guard rails matter as much as the rule:

- **With a service connected, elimination is switched off.** An unclaimed album could be local, or
  from a service that isn't connected here — guessing would badge someone's TIDAL album as a local
  file. Positive evidence is all we have there, and the old behaviour stands.
- **A connected service whose favourites failed to load claims nothing, and that is silence, not
  an answer.** Treating it as "claims nothing" would call every one of its albums local,
  confidently and wrongly. A service counts only when it is connected *and* its key set loaded.
- The facet and the filter now go through **one** function. A facet that counts one way while the
  filter selects another is worse than either being wrong on its own: the number promises
  something the list then fails to deliver.

The Focus sheet says which reasoning produced the number, because "we matched your files" and
"nothing else could have put these here" mean different things and only one of them is exact.

The file scan is unchanged and still earns its keep — it supplies release years, labels, and the
positive evidence used whenever a service *is* connected.

## [1.7.33] — 2026-08-04

### Fixed — the remaining local-album shortfall
The `[local:walk]` line added in v1.7.30 settled it in one reading:

    2831 dirs visited, 2383 with audio, 2383 tags read, 2383 albums keyed

No skipped depths, no unreadable directories, no failed tag reads. The walk finds **more** album
directories than Roon has albums, so the missing 403 were never a scanning problem — they fail the
**tag↔Roon match**.

The cause is that Roon replaces file tags with its own metadata for albums it identifies. A rip
tagged *Rumours* sits in a library where Roon calls it *Rumours (Deluxe Edition)*, and with one
title string on each side those can never meet. The streaming path has had edition tolerance since
v1.6.55 — `addFavouriteKeys` indexes both `Album` and `Album (Deluxe)` — and the local path never
got it.

`albumKeys()` now generates an extra key with the edition marker removed, which means **both**
sides inherit it, symmetrically:

- a trailing bracketed chunk — `(Deluxe Edition)`, `[2016 Remaster]`
- a trailing dash suffix, but **only** when it reads as an edition. *Album - Remastered* collapses;
  *Album - Part Two* does not, because that is a different record and merging them would be worse
  than missing one.

The stripped form is always an **extra** key, never a replacement, so albums that differ only by
edition can still match each other exactly. Two albums that collapse to the same stripped title
simply share an identity, which `ambiguousAlbumKeys` already suppresses for badging.

### Fixed — a regression caught by the existing suite
The first version applied the ≥3-character floor to the **original** title as well as the stripped
one, so an album genuinely called *X* or *÷* came back with **no keys at all** — every identity
gone, silently. The floor belongs only on stripped forms, where a short result means the marker was
most of the title and what remains would match everything.

## [1.7.32] — 2026-08-04

### Added
- **Create a dynamic playlist from the Dynamic playlists screen.** A "New dynamic playlist" tile
  leads the wall and opens **the same editor Edit opens** — every focus section plus the Playlist
  size control, which exists nowhere else and so could not be set at all during creation before.

  Creating is editing a playlist that doesn't exist yet: the same sheet is passed a target with no
  id, and the absent id is what makes the save create rather than overwrite. One editor rather
  than two that have to be kept in step.
- The empty-state message now points at New instead of sending the user to the Library screen to
  discover Focus → Save as… on their own.

## [1.7.31] — 2026-08-04

### Fixed
- **Pasting a shared playlist failed because iOS lowercased the marker.** Autocorrect treats
  `MDRP1` as a word it doesn't know and rewrites it on paste, leaving the payload untouched but
  the marker unrecognisable. Two changes: the import box now sets `autocapitalize`, `autocorrect`
  and `spellcheck` off so it stops happening, and the decoder matches the marker
  case-insensitively so a blob that was already mangled still works.
- The payload's own case is **never** normalised — base64url is case-sensitive, so "helpfully"
  lowercasing it would decode to different bytes. A blob whose payload has been case-folded fails
  the checksum, which is the correct outcome, and there is a test that says so.

### Added — Recently added
A new Library sort, built from the only evidence available: Roon's extension API publishes **no
import date of any kind**, so nothing here comes from Roon.

- **Local files** are dated by the timestamp of the file the scanner already reads — a real date,
  and the strongest evidence available.
- **Anything else** is dated when it first appears in a library rebuild.
- Where those disagree, the file wins; within one source, the earliest date wins, because "first
  seen" means the earliest evidence rather than the most recent scan to notice.

**What it gets wrong, stated plainly:** an existing library has no history to recover. The first
run therefore records **nothing at all** and leaves those albums undated — stamping them with the
moment the feature was installed would be a timestamp that is technically a date and factually a
lie, producing a list that sorts perfectly and means nothing. Accuracy accrues going forward:
albums added after this ships get real dates within 12 hours.

Undated albums are **held out of the ordering and appended**, in both directions, exactly as the
Release year sort already does — so reversing to newest-first can't float them to the top. The
Focus sheet reports the coverage number the same way it does for release years.

## [1.7.30] — 2026-08-04

### Added
- **The file scan now says what it walked.** One unconditional line per scan:

      [local:walk] 1873 dirs visited, 1712 with audio, 1698 tags read, 1690 albums keyed

  with counts appended for directories skipped past the depth limit, unreadable directories,
  failed tag reads, and files with no album tag.

  This exists because diagnosing the v1.7.27 local-albums shortfall was harder than fixing it.
  The only logged number was `[local] N album keys recorded`, and keys are not albums — one
  directory contributes one or two — so a short count could not be attributed to the walk missing
  albums or to the keys not matching. Those live in different halves of the code. Counting is
  free; not counting cost a round trip through the user's logs.

  It also makes `SKIPPED past depth` visible, which was previously silent: a subtree one level
  deeper than the limit is skipped whole, without a word.

## [1.7.29] — 2026-08-04

### Fixed
- **Importing a playlist you had just shared failed with "That doesn't look like a MusicD Remote
  playlist".** Two causes, and the first made the second inevitable:
  - **Copy never worked on this app's own origin.** `navigator.clipboard` is a *secure-context*
    API and the extension is served over plain http on the LAN, so on most devices it does not
    exist at all — the button fell through to "the text is selected, copy it by hand" every time.
    A hand-selected 3 KB blob on a phone comes back short or wrapped. `document.execCommand("copy")`
    still works on http and is now tried **first**, with the async API as the fallback.
  - **The decoder demanded the marker at character zero** of a trimmed string, so a paste carrying
    a leading newline, soft-wrapped lines, or the words the sender typed around it was rejected
    while holding a perfectly good playlist. It now finds the marker wherever it sits and ignores
    whitespace and quote markers inside the payload.
- Trailing prose ("…Enjoy!") cannot be separated by inspection — letters are valid base64url. But
  gzip carries a checksum, so the decoder shaves characters off the end and retries, bounded at 40.
  A wrong length fails the CRC rather than yielding plausible garbage, which is what makes that a
  recovery rather than a guess. A genuinely truncated blob still reports itself as cut short.

### Added
- **Import from a file.** The import sheet takes a `.musicd` file as well as a pasted blob — the
  other half of Share's Download button, and far more reliable on a phone than a clipboard.

## [1.7.28] — 2026-08-04

### Fixed
- **Albums can be added to a playlist.** Selecting albums and choosing *Add to playlist* refused
  with "Playlists hold tracks — open an album and pick the ones you want". That was a design
  decision made in v1.7.23 and it was the wrong one: a stored entry does name a specific track,
  but resolving albums into tracks is this app's job, not something to hand back to the user.

  The new `/api/user-playlists/add-albums` reads each selected album's tracklist off the Core —
  ~5 browse calls each, one album at a time, capped at 30 per add — and stores every track. The
  result is reported per album: *Added 137 tracks from 12 albums to "Mix"*. An album Roon won't
  open is **named** rather than counted, because knowing which one is the only way to act on it.

### Changed
- Both add routes now share one target resolver and one append helper. They had separate copies
  of "find the playlist or create it", which is how two routes end up disagreeing about what a
  name with no id means.

## [1.7.27] — 2026-08-04

### Fixed — the local album count was too low
Five separate causes, found by tracing the whole join. In rough order of how many albums each
probably cost:

- **"Rescan library" never re-ran the /music file scan.** It refreshed the Roon snapshot and the
  Qobuz/TIDAL badges and left the local set untouched — so the one button a user presses when the
  local count looks wrong was the one button that could not fix it. It now kicks the file scan too.
- **The two sides of the join used different key functions.** The library index stores
  `albumKeys()` for every album — the whole credit *plus each name in it* — while the file scanner
  stored `albumKey()`, the whole credit only. A tag reading "Robert Plant & Alison Krauss" could
  therefore never match a Roon credit of "Robert Plant", while the reverse matched fine. A
  one-directional match errors nowhere; the count is just quietly short.
- **`MAX_DEPTH` was 3.** `/music/Artist/Album/CD1` fits; `/music/Genre/Artist/Album/Disc 1` does
  not, and a subtree past the limit is skipped *whole and silently*. Raised to 5.
- **Compilations without an `ALBUMARTIST` tag** were keyed under whichever performer happened to
  be on the first track, which never matches Roon's "Various Artists". They are now also keyed
  under that.
- **The facet counted through the ambiguity suppression.** Skipping identities held by more than
  one album is right for a *badge* — it would be a coin flip — but wrong for a *count*: two copies
  of an album are both local. The Focus total is now counted without it.

Also: a missing `local-albums.json` scheduled no rebuild (only a wrong-version one did), and the
Focus sheet cached its counts for the life of the page, so a rescan changed the library and the
sheet went on reporting the old numbers until a full reload.

### Fixed — dynamic playlists no longer promise more than they deliver
A dynamic playlist advertised its full match count and could only ever play 400 albums of it.
Playlists now carry their own **album limit**, default **100**, adjustable to 400 in Edit →
Playlist size:

- The tile reads **"100 of 1179 Albums"** when the query matched more, instead of "1179 Albums".
- The limit applies to the track list, to Play now / Queue, and to Send to Roon alike.
- Saving says so: *Saved "Never played" — it plays 100 of the 1179 albums that match.*
- **Playlists saved before this take the default** rather than staying uncapped.

Why 100: every album costs 8 Roon calls to queue, so 400 albums is ~3,200 calls and, by the code's
own note, "takes minutes". 400 albums is also roughly 4,400 tracks — about 88% of the ~5,000-track
Roon queue ceiling, which is community-reported and unverified. 100 albums is ~800 calls, ~1,100
tracks and still around 75 hours of music: more than any session will reach.

### Answering "how many are added to the Roon queue"
**Every track of every album sent.** There is no per-album track cap — the extension invokes
Roon's own album-level Queue action, and Roon enqueues the whole album. At the previous 400-album
cap that was roughly 4,400 tracks. It is now roughly 1,100 by default.

## [1.7.26] — 2026-08-04

### Fixed
- **Selecting a track in the album view gave you ticks and no way to act on them.** The
  multi-select menu lives in the top bar, and the album view is a full-viewport modal painted over
  the entire app shell — so while an album was open the menu was both invisible and untappable.
  The live menu node now moves into the album view's own header band, left of Share and ×, and
  moves back when the album closes.

### Changed
- The menu in the album view reads **Play now / Add to end of queue / Add to playlist… / Clear
  selection**. "Add to playlist" is hidden for ALBUM selections — a stored playlist entry names a
  specific track, so offering it there would only explain itself after being tapped.
- "Add to queue" is now **"Add to end of queue"**, which is what it does.
- The source facet and badge now say **"Local albums"** rather than "Local files".

### Class of error
A stacking failure that every logic assertion passes. The count was right, the handlers were
bound, the element was in the DOM with the correct text — and the feature was unusable. The DOM
test written for it in v1.7.22 asserted all of that and never asked whether the button could be
touched. The new test is a hit test — `elementFromPoint` at the button's centre must land on the
button — with a control assertion proving the probe is capable of failing, following the
precedent set for the v1.6.58 sort-sheet regression.

## [1.7.25] — 2026-08-03

### Changed
- **One Playlists screen.** "My playlists" is gone as a separate destination; playlists stored by
  this extension now appear on the Playlists wall alongside Roon's, stored ones first. Imports
  land there. Finding a fresh import buried under the Roon list would read as an import that
  failed.
- The two sources are fetched together but tolerated separately: **Roon being unreachable no
  longer hides the playlists on this disk** — they render, with a banner saying the list is
  incomplete.
- **Side menu order** is now Dynamic playlists → Playlists → Import a playlist.
- **Filter removed from the side menu.** It lives on the Library screen, which is the only place
  it applies. "Random albums" already clears any active filter, so a random wall is a random wall.
- **"Play something unheard" removed from the side menu** and put on Home, as the first tile of
  the "Not played in 6 months" carousel. That row *is* the unheard albums, so the action and the
  row it leads mean the same thing — and it sits at the top of Home without needing a slot of its
  own. Built as a normal tile, so it inherits the carousel's sizing at every screen width instead
  of carrying breakpoints of its own.

### Fixed
- The unheard action now spins **whichever control was pressed**. Forwarding the Home tile's click
  to the hidden top-bar button would have left the pressed tile visibly inert for the two seconds
  the pick takes.

## [1.7.24] — 2026-08-03

### Changed
- **Smart playlists are now called Dynamic playlists** everywhere they appear: the side menu, the
  wall heading, the Back button, the naming prompt, the empty state, every toast and confirm, and
  the server's error text.

### Not renamed, deliberately
The internal name stays `smart` — the `smartPlaylists` key in settings.json, the
`/api/smart-playlist*` routes, the `sp_` record ids and every identifier in the source. Renaming
the persisted key would drop every existing dynamic playlist unless a migration shipped with it,
and that is real risk for a cosmetic change. The rename is skin-deep on purpose, and a new test
pins the visible name so it cannot silently drift back — the internals were already covered.

## [1.7.23] — 2026-08-03

The other half of Share: import. Plus the playlist store both it and "Add to playlist" needed.

### Added
- **Import a playlist.** Side menu → *Import a playlist*, paste the blob, and every entry is
  matched against **your** library. A shared file names music, it doesn't carry it, so what you
  get is whatever your own library can answer for. Resolution is entirely in memory — zero Roon
  calls — so it answers in milliseconds however long the playlist is.
- **The report is the deliverable.** "2 of 3 tracks found in your library", and the ones that
  didn't match are *listed*, not just counted. Every tool in this space quietly substitutes the
  wrong version; showing the misses is what makes it worth trusting. Saving is a separate, named
  act, and an import that matched nothing doesn't offer to save nothing.
- **My playlists** — an ordered list of specific tracks, stored by this extension on the data
  volume. Play now, Queue, Share and Delete, with each row carrying its album's artwork.
- **Add to playlist** in the multi-select menu, for tracks selected in the album view: add to an
  existing playlist or name a new one.

### Notes on what this is and isn't
Roon's API cannot create or modify a playlist — verified against a live Core in v1.7.15, and
unanswered on Roon's own tracker since 2017. So an imported playlist is a **MusicD Remote**
playlist: it lives here, and it will not appear on other Roon remotes. Filling the Roon queue and
using Roon's own *Add the queue to a Playlist* is still the only route to a real Roon playlist.

Albums cannot be added to a playlist. A stored entry names a specific track, and an album's
tracklist only exists on the Core — opening every selected album behind a menu tap would be
seconds of Roon calls. Selecting albums and choosing *Add to playlist* says so rather than
quietly doing something slower than expected.

### Storage
Imported playlists live in `data/playlists.json`, written atomically, **not** in `settings.json` —
that file is written non-atomically, has no key whitelist, and holds the Qobuz password hash and
the TIDAL refresh token. Third-party content has no business in it. Unlike the other versioned
files on that volume, a version mismatch here **renames the file aside** rather than discarding
it: those are derived caches that cost a rescan, this is the only copy of something the user made.

### Safety
An entry the resolver cannot identify with confidence is reported, never guessed at — two albums
sharing a title is a coin flip, and a coin flip that silently puts the wrong record in someone's
playlist is worse than a miss they can see. Nothing from a shared file reaches storage except
through a fresh object literal built from a named field list, and a Roon `item_key` can never be
stored: those are session-scoped and already invalid by the time anyone reads them back.

## [1.7.22] — 2026-08-03

Multi-select, part one: the selection mechanics. "Add to playlist" and "Recently added" follow
in the next build — the first needs an extension-side playlist store, the second needs dates
Roon does not give us.

### Added
- **Long-press to multi-select tracks in the album view.** The press *arms* the mode without
  selecting the track under your finger. Each row then shows a hollow circle on the right; the
  circle becomes a tick only once it is tapped. With the mode armed, tapping anywhere on a row
  selects it — hunting for a small circle is the wrong ergonomics for a list you are working
  through deliberately.
- **An actions menu in the top bar**, appearing only once at least one thing is selected, with
  the count on it: Play now, Add to queue, Clear selection. The same menu serves both selections;
  they can never be live together, because opening an album ends a grid selection.
- Selected tracks play in **album order, not tap order**, and only the first honours the requested
  kind — sending `play_now` for each would leave the last track playing alone, having wiped the
  ones before it.

### Fixed
- **Long-press on an album tile was broken and had been all along.** The callback fires at 500ms
  while the finger is still down, so the browser went on to dispatch a click on release — which
  selected the album a second time and toggled it straight back off. A long press opened select
  mode with nothing in it. The right outcome was resting on a double-fire; it is now a suppression
  flag consumed by the next click, in the capture phase.
- **Multi-select was unavailable on seven of the eleven album-grid screens** — including the two
  biggest walls (Library A–Z, "Not played in 6 months"), label albums and the Home carousels. Not
  by design: `buildAlbumTile` inferred "selectable" from "was a custom opener passed", and those
  screens pass one purely to force `filter: null`. Selectability is now stated outright, so it
  works everywhere. Playlist and smart-playlist tiles state `false` — a playlist is not an album
  and cannot be queued as one.
- **`/api/play-track` never received the album's identity**, so `albumIdentityMatches` short-
  circuited and the whole stale-offset ladder — relocate in memory, then live search — was
  unreachable for a per-track play. Survivable while the only caller was a modal opened seconds
  earlier; not survivable at all once a track reference outlives the session. `album_title` /
  `album_subtitle` now travel with every per-track play.
- Exiting select mode cleared the selection outline only inside `#album-grid`. Now that Home's
  carousels are selectable, that left ticks behind on rows already scrolled past.

### Changed
- The bottom action bar no longer carries Play Now / Queue — those live in the top-bar menu now.
  It survives as the "select mode is on, nothing chosen yet" hint, because without it a long
  press produces no visible change until the first tap.

## [1.7.21] — 2026-08-03

Review findings against v1.7.19's export. Six defects, all sitting in the test suite's blind
spot, and four of them the same mistake: a limit applied without being reported — the exact
failure v1.7.17 was written to fix and which v1.7.19's own comments claimed to have avoided.

### Fixed
- **Stopping at the 100-album cap was silent.** Share expands a smart playlist album by album and
  stops at 100. The sheet reported truncation only from the *server's* flag, which describes the
  list it was handed and knows nothing about what the client stopped collecting. A 900-album smart
  playlist shared roughly a ninth of itself and said "1180 tracks" with no caveat.
- **A failed page was indistinguishable from a finished one.** `done` is set both when the
  playlist ends and when a page errors, and Share's only completion test was `!done`. A timeout on
  album 4 of 40 exited the loop and opened the share sheet — over the error message still on
  screen — announcing a complete export of 10% of the playlist. Failure is now recorded
  separately, and the file is marked INCOMPLETE.
- **A Roon playlist longer than 1,000 tracks** arrives already cut short from `/api/playlist`. The
  screen said so; the share sheet claimed a clean "1000 tracks". It now carries the caveat.
- **`truncated` could be true when nothing was truncated.** It was derived from the input length,
  so 2,100 entries of which 300 were untitled encoded 1,800 tracks — nothing dropped for the cap —
  and still claimed "stopped at the sharing limit". It is now set only when the cap actually
  stopped the loop.
- **The JSPF trackList vanished when empty.** Pruning drops empty arrays, so a document with no
  shareable tracks omitted `track` entirely. An absent trackList means "malformed"; an empty one
  means "a playlist with no tracks". Phase 2's importer has to tell those apart.
- **`meta.creator` was unreachable** and has been removed; **`bytes` was computed and read by
  nobody** and now drives a warning — above 40 KB a paste gets silently truncated by messaging
  apps, which produces a blob that decodes to nothing on the far end.
- Smaller: the progress toast used the 9-second duration meant for end-of-operation reports, so
  "Reading album 1…" sat over the finished share sheet; clamped text could keep a trailing space,
  which canonicalises differently on the far end in a file that is never re-issued; "1 entries had
  no title and were left out"; and `/api/share/encode` now bounds how many entries it will walk,
  not just how many it will encode.

### Class of error
Reporting that describes the wrong layer. Every one of these limits was correctly *applied*; each
was reported by asking a component that could not know. The server's `truncated` answers "was the
list you gave me too long", which is not the question the user has. **And the tests were green
throughout**: the DOM stub hardcoded `truncated: true`, so the assertion named after v1.7.17's
lesson passed for a reason unrelated to the caps it was testing — the same shape as v1.7.16, a
test asserting the right sentence about the wrong mechanism. The stub now returns `false` and the
client-side caps are asserted from client state, with fixtures for the album cap, a mid-crawl
failure, and a mixed skip/over-cap input.

## [1.7.20] — 2026-08-03

### Fixed
- **Qobuz stayed in the side menu and the top bar after logging out.** The Qobuz controls were
  gated on the connection in exactly one place — the Disconnect button inside Settings. The
  top-bar Qobuz button and the side-menu entry were never touched, and `loadQobuzStatus()` was
  never called at boot, so it only ran when Settings was opened. The result: after disconnecting
  the account, the Qobuz browser was still one tap away, and every catalogue call behind it threw
  "Qobuz not connected".
- Both surfaces now start hidden and are toggled on the connection, and the status loads at boot
  rather than waiting for someone to open Settings. Tidal already worked this way — it was built
  second and got the wiring; Qobuz came first and never had it retrofitted.

### Class of error
A second implementation of the same idea, done properly, while the first was left behind. Nothing
about the Qobuz code was wrong on its own terms — it did what it had always done. The bug was that
"a disconnected service disappears" became the rule when Tidal shipped, and Qobuz was never held
to it. The new test holds *both* services to the rule, in both directions, so a third service
cannot be added with half the wiring either.

### Not changed (checked, already correct)
The badge and album paths were verified rather than assumed: disconnecting clears the cached
Qobuz album keys and `refreshStreamAlbumKeys` skips Qobuz entirely without credentials, so source
badges do go; every Qobuz catalogue call routes through `qobuzWithToken`, which refuses without a
token; and the global search skips a service that returned nothing. Albums that came from Qobuz
and remain in the Roon library are Roon's own state, not the extension's cache.

## [1.7.19] — 2026-08-03

First half of playlist sharing: **export**. A playlist leaves the app as a description of the
music — never the audio — so that another MusicD Remote user can import it and have it resolved
against their own library or streaming service. Import is the next phase; see
`docs/design/playlist-sharing.md` for the whole design and the research behind it.

### Added
- **Share on a Roon playlist and on a smart playlist.** Produces a `MDRP1:` blob (gzipped,
  base64url) that can be copied into a message or downloaded as a `.musicd` file.
- **The format is JSPF**, the JSON serialisation of XSPF, in the dialect ListenBrainz uses — the
  only formally specified open playlist interchange format, and its MusicBrainz extension
  namespaces give real slots for identifiers instead of a bespoke schema. M3U was rejected on
  capability, not taste: it has nowhere to put an identifier of any kind, which makes it useless
  to a streaming-only library.
- **Identifier slots are present from day one** — ISRC, UPC, service ids, MusicBrainz URIs,
  duration — and populated whenever we have them. We have none yet. They exist anyway because a
  share file is forever: a reader written against this format must keep working once exports
  start carrying IDs, and that cannot be retrofitted to files already sent.
- **Track numbers are now recovered** from the `"N. "` prefix Roon puts on track titles.
  `stripTrackNumber()` was discarding it, and Roon's browse API exposes no track-number field of
  its own — so this prefix was the only place it existed, and it is the one piece of hard identity
  an export can carry today at no cost.

### Notes
- A smart playlist is a **query**, so its tracks do not exist until each album has been opened on
  the Core. Share finishes the paging the "Load more" button drives, with progress shown, capped
  at 100 albums — and reports what it left out rather than looking complete.
- Share reports skipped and truncated counts in the sheet. An export that quietly dropped half a
  playlist is worse than one that refused to build.
- Fixed while building: tapping Share while the first page of a smart playlist was still loading
  saw "already loading", returned instantly and shared nothing. Awaiting a load that is already
  running now means waiting for it.
- A Roon playlist row carries the track and its artist but **no album** — Roon does not put one on
  the row. That slot is left absent rather than guessed, so an importer can tell it was never
  told, instead of concluding the album is empty.

## [1.7.18] — 2026-08-03

Review findings against v1.7.17. Raising the album cap to 400 made four latent problems
reachable that the old 100/200 ceiling had kept out of range.

### Fixed
- **One failed album turned a 400-album queue fill into a total failure.** `/api/play-multi`
  answered HTTP 500 whenever *any* album failed, and both callers return early on `!ok` — so a
  run that queued 399 of 400 showed a red error, and the truncation the whole of v1.7.17 exists
  to surface was never mentioned. A partial result is a success: the first album is already
  playing and everything that queued is queued. The route now answers 200 with
  `{queued, failed, total}` and the toast reports them: `Playing 397 of 1179 albums (Roon refused
  3) — that's the limit per go`. With 4× the albums, the odds of hitting one stale offset are 4×.
- **A dropped connection let a retry wipe the queue mid-fill.** A 400-album run takes minutes,
  and nothing cancels the server side of it — backgrounding the PWA drops the fetch, the button
  re-enables, and a second tap starts a run whose *first* album is `play_now`, destroying the
  queue the first run is still building; the two then interleave into garbage order.
  `/api/play-multi` now allows one run per zone and answers 409 to a second, and the client says
  "Lost contact while filling the queue — check Roon before trying again" instead of inviting the
  retry.
- **A 400-album request could exceed express's body limit.** 400 × `{offset,title,subtitle}` runs
  ~250 bytes an item on a classical library with long work titles and performer credits, past the
  100 kb default — and express answers that with an HTML 413 the client can only render as a
  generic "Roon refused that". Limit raised to 1 MB.
- **Send to Roon asked for consent without disclosing the cap.** The confirm destroys the existing
  queue; agreeing to send 1,179 albums is not agreeing to wipe the queue for 400 of them. It now
  says "Only the first 400 of 1179 albums fit in one go" *before* the user commits.
- **The report vanished before it could be read.** Toasts hide after 2.4s — the end of a
  multi-minute operation is exactly when the user has looked away. Reports about a queue fill now
  stay up for 9s.
- **"Queued 1 albums."** The non-truncated Send to Roon branch never got the pluralisation its
  sibling gained. All three callers now share one `multiOutcome()` so the wording cannot drift
  again.

### Class of error
A limit raised without re-checking what the old limit had been protecting. Every one of these was
present at 200 albums too; 400 just made them likely enough to hit. The lesson recorded for next
time: when a ceiling moves, re-walk the whole path under the new number rather than only the code
that changed.

## [1.7.17] — 2026-08-03

### Fixed
- **Playing a large smart playlist silently queued only 100 albums.** `/api/smart-playlist/albums`
  defaulted to 100 albums and clamped at 200, and the Play now / Queue buttons asked for no limit
  at all — so a 1,179-album playlist put 100 albums in the Roon queue while the toast said
  "Playing <name>", exactly as if it had queued everything. Both halves are fixed: the client now
  requests the full ceiling, and the ceiling is 400 albums (~4,400 tracks, near Roon's own queue
  limit) instead of 200.
- **The cap is no longer silent.** When a playlist is larger than one go can take, Play now, Queue
  and Send to Roon now report `Playing 400 of 1179 albums — that's the limit per go` rather than a
  bare success. Send to Roon says the same before repeating its "save the queue as a playlist in
  Roon" instruction.
- **`Play now` swallowed server errors.** A failed `/api/play-multi` showed the error toast and
  then fell through to the success toast, so a refusal read as a success. It now returns on error,
  matching every other caller.

### Class of error
A limit that is applied but never reported. The code was correct at every step — the server capped
honestly, the client rendered what it got — but nothing in the chain told the user that what
happened was smaller than what was asked for. The regression test now pins both the requested
ceiling and the reported count, and both halves were mutation-checked.

## [1.7.16] — 2026-07-30

Review findings against v1.7.6–v1.7.15. Five confirmed defects, all introduced by the playlist
work, one of which made a shipped feature fail on every use.

### Fixed
- **Every smart-playlist track tap returned HTTP 400 — nothing could be played.** The track row
  posted the *playlist* route's field names (`track_index` / `track_title`) to the *album* route,
  which destructures `track` / `title`. The DOM test asserted the same wrong names against a stub
  that accepts any body, so it stayed green while the feature was entirely broken. The success
  toast also read a `j.invoked` the route never returns.
- **Editing a smart playlist permanently rewrote the Library screen.** `editSmartPlaylist` copied
  the playlist's view into `libView` and called `saveLibView()` immediately, so opening Edit and
  closing it again left the user's own Library sort and focus silently replaced. The view is now
  applied without persisting, and restored if the sheet is abandoned — `openLibSheet` gained an
  `onClose` hook that fires on every dismissal path.
- **Decades were written into the live view as numbers.** The server stores them as numbers while
  the whole client compares against `String(decade)`, so Edit opened with the active decade's chip
  showing *off*, and tapping it pushed a duplicate (`[1990, "1990"]`) instead of toggling.
- **Four screens took over the shared grid without orphaning playlist work** (`showWall`, the two
  label screens, the artist view). A late `/api/playlists` response could paint its tiles over the
  labels or artist screen, and `fillPlaylistMosaics` kept firing a browse walk per playlist at the
  Core after the user had left. Centralised as `leavePlaylistScreens()` so a future screen calls
  one thing instead of remembering four flags.
- **Every Roon playlist claimed to be truncated.** `truncated` compared the browse level's row
  count against the track count, and the level includes the play-menu row — so a fully loaded
  20-track playlist reported "showing the first 20 of 21". It now reports truncation only when the
  read ceiling is actually reached.
- A failed track page left a "Load more" button that did nothing, and a network blip on the smart
  playlist list rendered "No smart playlists yet", which reads as *your saved playlists are gone*.
  The two states are now distinguished.

### Added
- **A static guard against client/server field-name drift.** For each guarded route, the client's
  POST body must carry every field the handler 400s without. This is the class of bug above, and
  it is invisible to a DOM test whose stub accepts any body.
  - Worth recording: the first version of this guard was **vacuous**. Its regex
    (`/if\s*\(([^)]*?)\)\s*return\s+res\.status\(400\)/`) could not match
    `if (!Number.isFinite(offset))` because of the nested paren, so it asserted nothing and passed.
    Only re-introducing the real bug exposed that. It now scans line by line.

### Not changed
- v1.7.15 hardened the playlist art cache against a read-modify-write race. Review showed the race
  is unreachable — `savePlaylistArt` is synchronous end to end, so Node cannot interleave the two
  mosaic workers inside it. The hardening is harmless and stays, but it guarded a window that did
  not exist.

## [1.7.15] — 2026-07-30

### Added
- **"Send to Roon" on a smart playlist.** Roon's extension API has no playlist write of any kind —
  no create, add, remove or reorder, and no "Add to Playlist" action anywhere in the browse tree.
  Three independent extension authors report the same, and Roon Labs has left the request
  unanswered since 2017. What Roon *does* offer is saving the current queue as a playlist from its
  own remote, so this does the half an extension can: it fills the queue in the saved view's
  order, then says exactly which two taps finish the job (queue → 3 dots → "Add the queue to a
  Playlist"). Confirms first, because it replaces the queue.
- **The debug browse probe can now drill an action menu, and can be zone-scoped.**
  `?album=<n>&action=<i>&zone=<id>` lists the actions Roon offers on an item. This exists because
  the browse tree *does* carry non-playback actions — "Add to Library" is one — so "there is no
  playlist action" is worth confirming against a real Core rather than assumed. Roon gates some
  items on a zone, so a probe without one can only prove absence *without* a zone. Still
  read-only: menus are listed, nothing is invoked.

### Tests
- 1 new test (403 total) covering Send to Roon: the confirm naming the destructive effect and the
  Roon-side step, the queue built in the saved order, and the toast telling the user what only
  Roon can do.

## [1.7.14] — 2026-07-30

Two defects found reviewing the playlist work, both introduced by it.

### Fixed
- **An abandoned edit could hijack the next save.** `smartEditTarget` was a module-level variable
  set by a smart playlist's Edit button and cleared only on save. Closing the editor without
  saving — the X, the backdrop, or "Show albums" — left it set, so a later "Save as…" from the
  Library screen's Focus bar would silently overwrite the playlist edited earlier, with no
  indication anything had happened to it.
  - The edit target is now a parameter of `openLibFocusSheet`, so it cannot outlive the sheet it
    was opened for. The Focus-bar entry point is wrapped rather than passed by reference, because
    `mk()` hands its callback an event object, which would otherwise arrive as "a playlist to
    save over".
- **The playlist art cache could drop an entry.** `loadPlaylistArtCache()` handed back a fresh
  `{}` when no cache existed. Mosaics are fetched by two workers at once, so on a first run both
  would build their own object and the second save would discard the first's entry — costing a
  re-walk on the next visit. It now installs the map into the settings object on first use, so
  both writers share the reference `savePersistedSettings` mutates in place.

### Tests
- 1 new test (402 total; the count fell from 414 as the Roon smart-playlist tests were removed in
  v1.7.12). It walks the real UI path — edit, close with X, Home, Library, Focus, Save as — and a
  mutation reintroducing the leaked target went red.

## [1.7.13] — 2026-07-30

### Added
- **Playlist tiles show a cover mosaic**, built from the artwork of the first few tracks, the way
  Roon draws them. Every playlist tile was a music-note placeholder before, because Roon hands an
  extension no artwork for a playlist at the list level.
  - Four distinct covers make a 2×2; two make halves; one fills the tile — a lone quarter-sized
    sleeve in an empty square looks broken. Covers are de-duplicated, so a playlist drawn from one
    album doesn't show the same sleeve four times.
  - **Smart playlists get this for free** — the first few albums their view resolves to are already
    in the snapshot, so the keys cost no Roon calls at all.
  - **Roon playlists cost a browse walk each**, so the grid renders immediately and the mosaics
    fill in behind it, two at a time. An unthrottled sweep would fire a browse walk per playlist at
    the Core at once. Results are cached on the data volume and keyed by playlist name, so only the
    first visit pays; a playlist with no artwork is cached as empty rather than being re-walked
    every time.

### Tests
- 3 new tests (414 total) covering the mosaic on both playlist types, the artwork request firing
  once per playlist that lacks it, and a playlist with no artwork keeping its placeholder instead
  of going blank. Two mutations planted — never fetching mosaics, and using a single cover — both
  went red.

## [1.7.12] — 2026-07-30

### Removed
- **All handling of Roon's own Smart Playlists.** Roon's extension API cannot open them — the
  Core returns a placeholder row and omits the play action — and that is confirmed by the authors
  of three other extensions, not something this app can work around. The special-case detection,
  messaging and comments are gone. What remains is a general rule that earns its place on its
  own: a browse item with no `item_key` cannot be invoked, so it is not a track and never reaches
  a track list.

### Changed
- **Smart playlists now open like playlists, not like the library.** Previously, tapping one
  applied its saved view and showed the library wall — the query working exactly right, and
  reading as "it just took me to the library screen".
  - The side menu now shows a **wall of tiles** (name + album count) instead of a cramped sheet.
  - Opening one shows a **detail screen listing tracks**, in the saved sort order, with **Play
    now**, **Queue**, **Edit** and **Delete**.
  - **Every track row carries the artwork of the album it came from** — for Roon playlists too,
    which previously rendered as bare text.
  - Tapping a track plays that track from its album.
- Play now / Queue resolve the view to albums (no Roon calls) and hand them to `/api/play-multi`,
  which already batches and carries the stale-offset defense.
- **Edit** reopens the Focus editor with the saved view loaded and writes back to the **same**
  record, so editing can't leave two near-identical playlists behind.
- The name prompt no longer suggests the view's description — the sheet was printing the same
  string as both a row's title and its subtitle.

### Added
- `GET /api/smart-playlist` expands a saved view to tracks, **paged by album**. Albums only yield
  tracks by being opened on the Core (~half a dozen calls each), so nothing is expanded until a
  playlist is opened and the screen fills a batch at a time with a Load more control. One
  unreadable album is skipped and logged rather than emptying the whole playlist.
- `GET /api/smart-playlist/albums` resolves a view to its albums for play-all — zero Roon calls.

### Tests
- The smart-playlist DOM test is rewritten for the new screen (411 total): tiles not a sheet, a
  detail screen not the library wall, tracks with their album artwork, paging that resumes at the
  right album, the action set, the play-multi payload, and an edit that keeps the same id. Two
  mutations planted — reverting to the library wall, and an edit that mints a duplicate — both
  went red.

## [1.7.8] — 2026-07-30

### Added
- **Smart playlists.** Set up a sort and focus on the Library screen, then **Focus → Save as…**
  to keep it under a name. A new "Smart playlists" entry in the side menu lists them; opening one
  applies its view and shows the library wall. They re-run every time they're opened, so they
  follow the library as it grows.
  - **Zero Roon calls.** A smart playlist is nothing but a saved `libraryView` query, and
    `libraryView` filters the extension's own in-memory album index — the same engine the Library
    Sort + Focus screen has used since v1.6.57. Saving one adds no Core traffic and no Core
    memory.
  - Each row describes what the view *does* ("Year ↓ · 1990s · not played in 12 months"), not
    just what it was named — a name alone can't be checked against reality.
  - Saved to `settings.json` on the data volume, so they survive container recreation. Saving
    under an existing name replaces it rather than creating an indistinguishable duplicate.
  - Every saved view is re-sanitised on load against the same vocabulary `libraryView` accepts.
    `settings.json` is a plain file that can be hand-edited or half-written, and a view that got
    through with a bogus field wouldn't error — it would quietly return the whole library, or
    nothing.

### Changed
- The library-view vocabulary (`libSortIds`, `libPlayedIds`) is now exposed as functions rather
  than bare constants, so the sanitiser's tests read the **shipping** list instead of a copy
  injected beside them. A duplicated vocabulary is how a mutation adding a bogus sort would slip
  past the suite — the v1.6.59 year-source-ranking hole in a new place.

### Tests
- 22 new tests (398 total: static 22, unit 213, dom 163). The unit tests cover the sanitiser
  exhaustively (unknown sorts, non-decade years, runaway lists, extra keys, corrupt records) and
  the DOM test covers the save → list → open → delete round trip, asserting the **query the wall
  actually fetches with** rather than merely that a row was clicked. Three mutations planted — a
  bogus sort added to the shipping vocabulary, extra keys leaking through, and a nameless record
  kept — all three went red.

## [1.7.7] — 2026-07-30

### Added
- **Roon playlists.** A new "Playlists" entry in the side menu lists every playlist in your Roon
  library; tapping one shows its tracks with **Play now** / **Queue** for the whole playlist, and
  a tap on any track to play it.
  - Uses `hierarchy: "playlists"` — a first-class browse hierarchy the extension had simply never
    used. Every existing helper worked unchanged: the pooled browse sessions, the offset cache,
    and the action-menu drill (`drillActionMenu` takes the hierarchy as a parameter, so Play Now /
    Queue needed no new code).
  - **Read and play only.** There is no playlist create, add, remove or reorder anywhere in the
    Roon extension API — `playlists` appears exactly once in the whole browse SDK, as a hierarchy
    value. This is a limit of the official API, not a decision.
  - A playlist is identified across requests by **(offset, title)**, never `item_key` —
    item_keys are session-scoped server-side. The offset is a hint and the title is the check, so
    a playlist added or renamed above the one you tapped costs a re-scan instead of opening the
    wrong playlist. Same defense the album path took v1.6.38–.49 to get right.
  - Reached from the **side menu, not a Home row**: listing playlists is a Roon browse walk, and a
    Home row would pay for it on every Home load.
  - Play actions read the **live** zone selector, so switching zone before pressing play targets
    the zone you're actually on (the defect fixed for the Queue tab in v1.7.6).
  - Long playlists report how many of their tracks are shown rather than looking silently
    truncated.

### Tests
- 7 new tests (376 total: static 22, unit 197, dom 157) covering the menu entry, that both offset
  *and* title travel on every request, the track list, play-all and play-track payloads (with a
  zone switch between them), Back returning to the playlist list rather than Home, and the empty
  state explaining itself. Two mutations planted — the title dropped from the open request, and a
  captured zone instead of the live one — both went red.

## [1.7.6] — 2026-07-30

### Fixed
- **The Queue tab showed the wrong zone's queue.** Playing to a Sonos zone, switching the
  extension's zone selector to another zone *without* moving playback left the Queue tab still
  showing the Sonos queue — and "Play from here" acted on it, so tapping a row played on the
  zone you thought you'd left.
  - Root cause: `currentSourceZoneId` is a snapshot taken in `openAlbum()`, so the queue was
    pinned to whichever zone was selected when the screen was *opened*. A queue belongs to a
    zone, and the zone the user is pointed at changes underneath an open screen.
  - The queue now reads the live zone selector — the single source of truth the transport bar
    and now-playing screen already follow — and "Play from here" re-reads it at click time, so
    the action can't target a different zone from the rows on screen.
  - Switching zones with the Queue tab open now refetches immediately. Fixing only the fetch
    would have left the stale list on screen until you left the tab and came back, so the test
    holds both halves separately.

### Tests
- 4 new tests (369 total: static 22, unit 197, dom 150) reproducing the reported scenario
  end-to-end — two zones with distinct queues, switch the selector without moving playback,
  assert the rows swap and the tab doesn't bounce. Two mutations planted (the original snapshot
  bug, and a fetch-only half-fix with no refetch); both went red.

## [1.7.5] — 2026-07-30

Production logs from a real Core, which confirmed one fix and disproved one assumption.

**Confirmed:** the v1.7.3 keyless retry works. A WiiM/Linkplay output rejected keyed
`convenience_switch` in 1 ms (`SourceControlNotFound`), the keyless fallback ran, and the call
succeeded in 519 ms — real work on the device, not a silent no-op.

**Disproved:** v1.7.4's premise that the Power button shared the weakness. Keyed
`toggle_standby` succeeds on that same output with that same `control_key` — every attempt
returned 200 with no fallback. So `control_key` is *valid*; `toggle_standby` and
`convenience_switch` simply resolve down different paths inside the Core. The v1.7.4 entry has
been corrected, and its fallback is now described as defensive cover rather than a bug fix.

### Fixed
- **The `source_controls` diagnostic never actually printed.** It sat *after* the retry
  decision, and a keyed not-found always retries — so the one log line that explains the
  failure was unreachable in the only situation it was written for. It now prints when the
  error arrives, before the retry, in both power routes. A recovered failure is still the
  failure worth recording.
- A not-found that recovers no longer logs the same block twice.

### Changed
- The comment above the keyed-toggle path no longer claims device-provided controls fail it —
  production shows the opposite.

## [1.7.4] — 2026-07-30

Follow-up to v1.7.3, hardening the Power button against the failure "Roon input" hit.

**Corrected after testing against a real Core (see v1.7.5).** This entry originally claimed the
Power button "had the same weakness as Roon input". Production logs disproved that: keyed
`toggle_standby` succeeds on the very device and `control_key` that keyed `convenience_switch`
rejects with `SourceControlNotFound`. The key is valid; the two calls simply resolve down
different paths inside the Core. The fallback below is therefore **defensive cover for other
devices, not a fix for an observed bug** — nothing was broken on this path.

The reasoning that motivated it still holds and is worth recording: `control_key` is minted by
the *provider* extension, defaults to the literal `"1"`, and is only unique within one
provider — and the SDK documents it neither as a field of `Output.source_controls` nor as a
required argument to any of the three power calls.

### Added
- **A keyless fallback for the Power button.** If keyed `toggle_standby` is ever refused with
  `SourceControlNotFound`, it retries keyless rather than surfacing an error.
  - `toggle_standby` is the one power call with no documented keyless form, so there is no
    like-for-like retry — the fallback has to infer what the press meant. In standby → wake
    (`convenience_switch`, which Roon documents as taking a device out of standby). On →
    `standby`. **Anything else refuses and reports the error**, because guessing on an unknown
    status is how a Power button turns a device the wrong way.
- **A `SourceControlNotFound` logs what the Core actually said** — both power routes dump the
  raw `source_controls` for that output, so `docker logs` shows the real key shape.
  (v1.7.5 moves this ahead of the retry, where it actually fires.)

### Tests
- 10 new tests (365 total: static 22, unit 197, dom 146) over the fallback's intent mapping and
  the live-status lookup, including that the two directions can never collapse to one value and
  that a malformed cache can't throw on the failure path. Two mutations planted — an unknown
  status guessed at, and the status lookup ignoring the key — both went red.

## [1.7.3] — 2026-07-30

### Fixed
- **"Roon input" failed with `SourceControlNotFound` on a WiiM/Linkplay endpoint.** Roon
  defines two forms of `convenience_switch`: addressed at one source control by `control_key`,
  or — with the key omitted — at every control on the output. The device answered the keyed
  form with `SourceControlNotFound` while reporting that exact `control_key` to us in its own
  `source_controls` array, so the keyed form is not universally honoured by device-provided
  source controls. The keyed call is now retried as the keyless form.
  - Only `SourceControlNotFound` retries. Every other error means Roon *found* the control and
    refused on its own terms, and repeating the call as a broadcast would act on outputs the
    user never tapped — the one genuinely harmful outcome available here.
  - Both attempts are logged with which form was used, so `docker logs` gives a one-line
    diagnosis instead of a bare error name.
- **Roon's bare error names no longer leak into the interface.** `SourceControlNotFound` is a
  useful log line and a useless toast. The names a user can actually hit now map to a sentence,
  while the raw name still travels in the response for support. An *unmapped* name passes
  through unchanged rather than being swallowed by a generic apology — hiding an unknown
  failure is how a new Roon error becomes unreportable.

### Tests
- 10 new tests (355 total: static 22, unit 187, dom 146). The retry rule and the error mapping
  are both extracted top-level functions so the suite exercises the shipping code — the error
  text is a `switch`, not a lookup table, specifically so an injected copy can't shadow it (the
  hole that let a v1.6.59 mutation reorder the year-source ranking unnoticed). Two mutations
  planted — retry on any error, and unmapped errors swallowed — both went red.

## [1.7.2] — 2026-07-30

The last four unused Roon transport methods. With these, every capability the vendored
extension SDK exposes is now wired up — nothing official is left on the table.

### Added
- **Device power.** A new "Device power…" sheet (from either zone picker) can put a device
  into standby and switch it to its Roon input, via Roon's `standby` / `toggle_standby` /
  `convenience_switch`. Roon can only do this through a *source control* the device itself
  exposes — many network streamers and AVRs have one, plain audio endpoints don't — so the
  sheet lists source controls rather than zones, and says so plainly when there are none
  rather than opening empty and looking broken.
  - Power is `toggle_standby` on one control, because that is how Roon defines it. A separate
    "Put whole device into standby" appears only on a device with more than one
    standby-capable control, where the keyless bulk `standby` form is genuinely a different
    action.
  - Controls with no `control_key` are dropped: they can't be addressed individually, so a
    power button on one would have done nothing at all.
  - Each control's state is spelled out ("On — Roon input selected", "In standby"), and an
    unrecognised status reads as unknown rather than as a blank line.
- **Pause all zones / Mute all zones / Unmute all zones** in the side menu, via Roon's
  `pause_all` and `mute_all`. Mute and unmute are separate rows on purpose: the drawer closes
  before the action runs, so a single toggling label could not be refreshed and would be wrong
  half the time.

### Tests
- 21 new tests (345 total: static 22, unit 177, dom 146): `unit/zonemodes` gains the
  source-control projection, `dom/device-power` covers the sheet (row element type, which
  buttons appear, the live power state, the request bodies, the empty state) and the three
  menu actions. Four more mutations planted — keyless controls kept, unknown status passed
  through, Power shown regardless of `supports_standby`, and the bulk form sent with a
  control_key — all four went red.

## [1.7.1] — 2026-07-29

Roon parity from the official extension API. Six transport capabilities the SDK has always
offered were simply unused here; these are the four that close the biggest gaps, with no
reverse-engineered protocol involved.

### Added
- **Shuffle, repeat and Roon Radio** on the now-playing screen, via Roon's own
  `change_settings`. Repeat cycles off → whole queue → this track the way Roon's remote does,
  with the mode named on the button and a "1" inside the repeat arrows for track-repeat.
- **Zone grouping.** A new "Group zones…" sheet (from either zone picker) ticks the outputs
  that should play in sync and applies the change with `group_outputs` / `ungroup_outputs`.
  Only outputs the Core says it can sync with the current zone are offered, and the zone you
  are listening to is always sent first, so grouping can never lose the playing queue.
- Grouped zones now name their member outputs on a second line in both zone pickers — a real
  "Kitchen + Study" group was previously indistinguishable from a zone called that.
- `GET /api/outputs`, `POST /api/zone-settings`, `POST /api/group-outputs`,
  `POST /api/ungroup-outputs`; `settings` (shuffle/loop/auto_radio) added to
  `/api/zone-state` and `/api/zones`.

### Changed
- A second long-lived Roon subscription (`subscribe_outputs`) now feeds the output cache.
  The zone feed only ever mentions an output as a member of a zone, so it cannot report a
  change that is purely about the output — and grouping depends on exactly that
  (`can_group_with_output_ids`). While that feed is live it owns the cache's removals,
  because grouping an output into another zone *removes* its old zone and the zone feed's
  removal path would have deleted a perfectly live output.
- The now-playing transport row holds five buttons instead of three; its gap is now
  responsive and the buttons no longer shrink, so the row fits a 360px phone.
- The mode buttons repaint only when the zone's modes actually change. They are painted from
  the 1.5s poll, and `setAttribute` marks an attribute dirty even when the value is unchanged
  — the same paint-invalidation the mini bar's `lastBarSig` gate exists to avoid.
- Turning Roon Radio on reports that the app's own Random Album Radio stands down for that
  zone (it always did — `lib/radio.js` defers to `auto_radio` — but nothing said so).

### Error classes documented
- **State the client invented.** Every mode button is painted from the zone poll and sends a
  concrete state rather than "toggle", so a change the Core rejects leaves the button dark
  instead of lit-but-wrong. `loop: "next"` is deliberately not exposed for the same reason.
- **"Unknown" read as "none".** An absent `can_group_with_output_ids` means the Core didn't
  say, and must offer every output; an empty array means it did say, and offers none.
  Collapsing the two would have made grouping silently list nothing on some Cores.
- **A fixed wait standing in for a signal.** Grouping retires zone ids asynchronously, so the
  app polls for the settled topology instead of guessing a delay, and closes the sheet as soon
  as Roon accepts rather than waiting for it.

### Tests
- 33 new tests (324 total: static 22, unit 170, dom 132): `unit/zonemodes` for the two server projections,
  `dom/np-modes` for the three mode buttons (including a 360px layout assertion that the
  five-button row neither overflows nor squashes), `dom/group-sheet` for the grouping diff,
  the locked anchor, the can-group filter and the unknown-list fallback. Seven mutations were
  planted — a fixed transport gap, an unchecked `loop` passthrough, "unknown" collapsed to
  "none", a dropped ungroup half, a mis-ordered group call, an unlocked anchor and an
  over-eager repaint gate — and all seven went red.

## [1.7.0] — 2026-07-29

A minor-version bump rather than another point release, because the app looks and behaves
differently enough that "1.6.x" would undersell it. No new code over v1.6.63 — this is the
version number the UI work ships under.

### What changed since v1.6.60

- **The interface is flat.** Every screen used to wrap its content in a softly-tinted
  rounded panel with a decorative watermark behind it. Those are gone — from Home
  (v1.6.61), and from the album view and Queue (v1.6.62). Sections are now separated by a
  title, a hairline and whitespace, in Roon's layout: rows run to the screen edge so the
  next tile peeks, and the currently-playing queue row is a full-bleed block rather than an
  inset pill.
- **Four themes instead of two** (v1.6.63). The original dark and light are unchanged, and
  two new ones are drawn from the MusicD site's own colours: **Copper dark** (charcoal and
  copper) and **Brass light** (warm parchment and brass). Settings → Appearance is now a
  picker: choose one, see a swatch of its actual colours, press **Apply**.
- **Contrast is measurably better**, and now machine-checked. Three places printed white
  text on the accent fill at 2.28:1; both new palettes fix the faint-text failure the
  originals ship. Every theme's ratios are computed from the real applied tokens by the
  test suite.
- **Artist names on the Now playing screen are links** (v1.6.60), matching the album view.

### Known and deliberate

- Track rows in the album view keep their numbers; Roon uses a per-row play button.
- The Queue's "Now playing" divider stays centred; Roon left-aligns it.
- Back from an artist opened via the Now playing screen returns to the screen underneath,
  not to Now playing.

## [1.6.63] — 2026-07-29

### Added

- **Two new themes, drawn from the MusicD site's colours**, alongside the existing two:
  - **Copper dark** — charcoal and copper. Eight of its thirteen colours are the site's
    own values verbatim, so it reads as the same design rather than a recolour.
  - **Brass light** — warm parchment with a brass accent. The site has no light mode, so
    this one is designed: the restraint is in the *chroma*, not the hue — the neutrals sit
    a few points of yellow above grey, which reads as paper rather than a yellow wash, and
    all the colour weight lives in the accent.
  - **The original dark and light themes are untouched.** Not "carefully preserved" —
    literally unchanged, because the new palettes are keyed on a separate attribute.
- **A theme picker in Settings → Appearance**: a list of all four, one selected at a time,
  each with a swatch showing that theme's own background and accent, confirmed with
  **Apply**. Choosing a row no longer changes the app instantly — nothing happens until
  you apply it, so a choice can be backed out of. Replaces the old dark/light toggle.
- **The browser chrome colour now follows the theme.** It was hard-coded to the dark
  background and never updated, so it had always been wrong in light theme.

### Fixed

- **Every toast in the Settings sheet was broken.** All 28 `showToast()` calls inside the
  settings code were throwing `ReferenceError` — the function lives in a different
  top-level scope — so token saves, display settings and the entire Qobuz/TIDAL connect
  flow reported nothing, and the error handlers that tried to say so threw again. Found by
  the new theme tests on their first run.
- **Three places printed white text on the accent fill in *every* theme**, measuring
  **2.28:1** in dark — well under the readable threshold. These now use a proper
  `--on-accent` token, which also collapses three different hard-coded "text on accent"
  values (`#0b1418`, `#04121a`, `#fff`) that had drifted apart across nine sites.
- **Both new palettes fix the `--text-faint` contrast failure** the originals ship
  (2.64:1 at worst in dark, 2.90:1 in light — both below AA). Copper dark reaches 4.61:1
  and brass light 4.71:1 on the same surfaces. Brass light additionally fixes two failures
  the current light theme has: accent-as-text (3.35:1 → 5.32:1) and text on an accent fill
  (3.65:1 → 5.75:1).

### Changed

- Themes are now two attributes rather than one: `data-theme` (dark/light **family**) and
  `data-palette` (classic/copper **colours**). Thirteen rules in the stylesheet are keyed
  on the light *family* — white-on-accent text, the light hover washes, the translucent
  top bar — and a new light theme under a third `data-theme` value would have silently
  missed every one of them. This way the new themes inherit all thirteen and the existing
  two cannot drift.
- `--accent` now has a companion `--accent-text`. In three palettes they are the same
  value and nothing changes; copper genuinely needs two, because the copper that reads
  well as a *fill* measures 4.27:1 as *text* on the deepest surface.
- A saved theme from before this release carries over untouched.

### Added (tests)

- **48 more tests** (243 → 291). `test/dom/themes.test.js` computes every theme's contrast
  ratios from the real applied tokens and asserts them — contrast is worth automating
  because it is invisible to review. The two original themes are asserted at the level they
  actually meet, with the shortfall named rather than papered over.

## [1.6.62] — 2026-07-29

### Changed

- **The album view and the Queue are flat, in Roon's layout** — the same treatment Home
  got in v1.6.61. The tinted panels and their decorative watermarks are gone from the app
  **entirely**; nothing is a card any more.
  - **Album view.** The Tracks and About panels lose their tint, corners and watermark.
    Track rows are now full-width, separated by the app's standard hairline. The artwork
    is square and unshadowed, and the album title is larger and heavier — at 22px it read
    as a caption above the button row rather than the heading of the screen.
  - **Queue.** Rows run **edge to edge**, and the now-playing row is a full-bleed block
    rather than an inset rounded pill. Taller rows, a larger square thumbnail, and a bold
    title over the artist, as Roon has them.
  - **Button layout is unchanged, as asked** — same four actions, same equal-width row.
    Only the finish moved: the secondary actions are outlined on the page background
    instead of filled chips, and the primary carries more weight. Scoped to the album
    view's row, because `.action-btn` is shared with five other places (the logo sheet,
    the label merge bar, the multi-select bar, the Library Focus sheet, Settings).
  - **The ambient cover glow is off.** Roon's album and queue screens are flat black, and
    a blurred cover wash behind flat rows was the last of the card-era look. The element
    and its JS are left in place, so restoring it is a one-line change.

### Fixed

- A comment lost its closing `*/` during the above and silently swallowed the next
  comment's opener. Harmless in outcome, but caught by the CSS integrity check added in
  v1.6.61 — which is the second time that check has earned its place in two versions.

### Added

- **10 more tests** (233 → 243). `test/dom/home-flat.test.js` is now
  `test/dom/flat-ui.test.js` and asserts the end state across **all eight surfaces** in
  both themes: nothing tinted, nothing card-cornered, no watermarks.
  - New cases cover the queue's edge-to-edge rows at **a phone width and a tablet width**.
    The tablet case is the one that matters: `.modal.np-mode .modal-info` caps every
    now-playing pane at 460px, so a "full-width" queue looks perfect on a 390px phone and
    floats mid-screen on a tablet. Also asserted: row content still lines up with the
    header above it (the bleed has to be paid back as row padding), and the page never
    gains a horizontal scrollbar.
  - Five mutations run against them — dropping the column-cap lift, the bleed, the padding
    payback, the full-bleed highlight, and re-tinting the panel — all five fail the suite.

## [1.6.61] — 2026-07-29

### Changed

- **The Home screen is flat, in Roon's layout.** Each section used to sit in its own
  softly-tinted rounded panel with a decorative watermark behind it. Those are gone. A
  section is now a **bold title, a hairline rule beneath it, then the row** — separated by
  that rule and by whitespace alone, on the page background. Clean and simple.
  - The rows are **left-aligned and bleed to the screen edge**, so the next tile is
    half-visible and the row reads as scrollable — Roon's edge-to-edge carousels. Short
    rows used to be centred, which was right inside a panel and looks like a mistake
    without one.
  - **Tile sizing and grid layout are untouched**, as asked: still 150px tiles with a 12px
    gap at every breakpoint, and the genre grid keeps its 2/3/4/6-column steps. The rows
    are 28px wider now simply because the panel padding is gone, so slightly more of the
    next tile peeks.
  - Applied at the base level, so it is the same on phone portrait, tablet and desktop.
    There was no phone-only hook for the panel system, and since nothing about the grid
    changes, flattening everywhere was both simpler and more consistent than inventing one.
  - **The album view's Tracks and About panels and the Queue tab keep their tinted panels
    and watermarks.** They shared the same CSS as Home — the recipe was written as five
    shared selector lists — so this was a trim of each list, not a deletion.

### Fixed

- **A CSS comment left unterminated during the above silently commented out the entire
  carousel definition.** No error, no warning — the parser simply swallows everything up
  to the next `*/`. Caught by a screenshot; now caught by a test (below).

### Added

- **18 more tests** (215 → 233):
  - `test/dom/home-flat.test.js` — asserts both halves of the split in both themes: every
    Home section is transparent with no radius, padding or watermark, **and** the album
    modal's three panels still have all four. Deleting one line too many from a shared
    selector list silently strips the modal; one too few leaves a Home card. Neither
    throws, and nothing else would have noticed. Also pins the title/rule treatment and,
    explicitly, that tile width and gap did not move.
  - **CSS integrity checks** in the static suite — every stylesheet must have balanced,
    terminated comments and balanced braces. This is the class of bug above: it produces
    no error at all, just a screen that quietly lost its layout.

## [1.6.60] — 2026-07-29

### Added

- **Artist names on the Now playing screen are clickable links**, the same control the
  album view already offers. A multi-artist credit becomes one link per artist, split the
  same library-validated way — so "T-Bone Walker / Big Joe Turner / Otis Spann" gives
  three links while **AC/DC stays one**, and "Earth, Wind & Fire" isn't torn into three.
  Tapping one leaves the Now playing screen and opens that artist's albums, exactly as it
  does from the album view. The album title beside it was already a link; now the whole
  credit block is.
  - **Names the library can't open are shown as plain text, not as links.** This screen's
    credit is Roon's *track* artist, which on a compilation, soundtrack or classical disc
    is usually not the album's credit at all — most of those performers have no album of
    their own, and a link to them would open an empty page. Each name is checked against
    the artists the library can actually show a screen for, and only those become links.
    The album view doesn't need this: an album credit always belongs to at least the album
    it came from.
  - Matching is whole-name, never substring, and tolerates a leading "The" — the same rule
    the artist screen uses, so a link that appears always leads somewhere.
  - Costs **no extra requests**. The split rides along on the zone poll the screen already
    runs, and is memoised server-side, so the same credit isn't re-split every 1.5 seconds.

### Changed

- The album view and the Now playing screen now share **one** artist-link renderer instead
  of having two implementations to keep in step.

### Notes

- Styled to the Now playing screen's own convention — plain text with an underline on
  hover/focus, like the album title below it — rather than the album modal's accent
  colour, so the Roon-parity look of that screen is unchanged.
- **Back from an artist opened this way returns to the screen underneath, not to Now
  playing.** The artist view parks the grid, top bar and labels browser, but has never
  known anything about the modal the Now playing screen lives in. Left as-is deliberately:
  changing what that view parks is how the v1.6.52 "albums untappable after Back" bug
  happened, and it isn't worth risking for this.

## [1.6.59] — 2026-07-29

### Fixed

- **The Decade focus was missing most of the library — now it collects release years
  from data already being fetched.** Roon's browse API publishes no release year at all
  (title, subtitle, cover, item key, and nothing else), so every year the Decade filter
  uses has to be found elsewhere. It used to be picked up only as a **by-product of the
  label scan**, and that scan's work list is "albums with no cached label" — so the
  moment an album got a label it could never acquire a year, and on an established
  install the year lookups stopped running altogether. Coverage froze at a fraction of
  the library. Nothing about it was visible: a short decade list looks like a short
  decade list.
  - **Qobuz and TIDAL now supply years, at no API cost.** The extension already pages
    your favourites from both services to decide the source badges, and every album in
    those responses carries its own release date — it was simply being discarded. Those
    dates are now harvested from the same responses and matched to your library through
    the **same identity matcher the badges use**, so "The Beatles" vs "Beatles" and
    "&" vs "and" still line up. No extra requests to either service.
  - **File-tag years are no longer stranded.** The `/music` scanner already read a year
    from your tags, but stored it under the *tag's* spelling while the filter looked it
    up under *Roon's*. Every album Roon renamed ("(Deluxe Edition)"), re-credited, or
    filed under a different album artist lost its year to that mismatch. Those years are
    now matched the same way the "local files" badge is — anything the badge can find,
    the year can now find.
  - **iTunes and TheAudioDB stop throwing their years away.** Both already return a
    release date alongside the record label during a scan; it's now kept. Captured
    *before* the label is validated, so an album with an unusable label still keeps its
    year.
  - Coverage is joined onto the library on every sync, rescan and favourites refresh —
    no longer once-ever.
- **The Decade chips in the main filter counted albums you don't own.** They were
  counted over the year cache, which is keyed by album identity and never pruned — so it
  included albums removed from the library and Qobuz releases you had merely *looked at*
  in the browser. Counted over the actual library now, matching what the filter returns.

### Changed

- **Library sorting is now one arrow, as in Roon ARC.** The wordy
  "Order: A → Z (tap to reverse)" row is gone. A single arrow sits beside the Sort pill:
  tap it and the order reverses, tap it again and it goes back. That gives all four
  orderings — **A→Z, Z→A, newest→oldest, oldest→newest** — from one control, without
  opening anything.
  - In the Sort sheet, only the **selected** option carries an ↑/↓ arrow, and tapping
    that option flips it in place instead of re-selecting it. Tapping a different option
    switches to it.
  - Each sort now opens the way you'd expect it to: alphabetical sorts start A→Z, while
    **Release year starts newest-first** and **Most played / Last played start
    highest-first**. Previously a sort inherited whatever direction the last one used.
  - **Random** has no direction, so its slot becomes a reshuffle button.
  - The words didn't disappear entirely — they moved to the arrow's tooltip and
    screen-reader name ("Newest first", "Most played first"), so the control still
    explains itself without putting a sentence on screen.
- **`dir` now means the same thing for every sort.** The server used to invert
  Most played / Last played, so `asc` produced *most*-played-first there and
  *least*-first everywhere else. One arrow cannot point two ways, so the inversion is
  gone and each sort's sensible default direction is chosen up front. A saved view from
  v1.6.57 has its stored direction reset once, on first load, and is rewritten at the
  new version so it only happens once.
- **The Focus sheet now says how complete the Decade data is** — "4,120 of 6,800 albums
  have a release year so far" — instead of silently showing chips that don't add up to
  the library.

### Review fixes (found before release, in the same version)

A review of the above turned up two ways it could have written the **wrong** year — worse
than the missing years it set out to fix, because a wrong year is saved and then never
looked at again. Both are fixed here, and every fix below is pinned by a test that fails
without it.

- **Years now record where they came from, and a better source can correct a worse one.**
  Filling gaps only sounds safe, but the sources race: the disk walk takes minutes while
  the Qobuz/TIDAL favourites come back in seconds. On any rescan the services landed
  first, so a TIDAL 2011 remaster date would stick to a 1973 album **permanently** — the
  user's own ORIGINALDATE tag arriving too late to correct it. Each year now carries its
  provenance (your file tags > an explicit original-release date > an edition date > a
  catalogue match), and a higher-ranked source may overwrite a lower-ranked one. Years
  stored before this existed rank lowest, so the first identified source repairs them.
- **iTunes and TheAudioDB no longer record years from unverified matches.** Both fall
  back to "first result" when they can't find an exact match — which is fine for a label
  (wrong labels are cosmetic and get overwritten) but not for a year. An album with no
  artist credit, common on classical and box sets, would take a stranger's release date
  and keep it. Years are now recorded only from a match verified on title *and* artist.
- **File tags: ORIGINALDATE now beats DATE.** On a remaster DATE is the reissue year, and
  the reissue was being preferred — filing remasters in the decade they were reissued in.
- The Decade counts in the main filter now answer **503 while the library is still
  loading** instead of reporting "no albums have a year", which is a very different claim.

An 8-angle review of the sort UI turned up four more:

- **The v2 migration was too broad.** It dropped the saved direction for *every* sort,
  but only Most played / Last played changed meaning — so a Z→A wall would silently
  come back A→Z, and because the migrated view is written straight back, the preference
  was gone for good rather than just for that load. It now touches only those two sorts.
- **The arrow destroyed the focus of the button you just pressed.** Every tap rebuilds
  the controls row, so with a keyboard one Enter reversed the order and the next did
  nothing — focus had fallen to the page body. Focus now moves to the replacement
  control, which also announces the new direction to a screen reader.
- **A malformed saved view could brick the Library wall.** A blob can be valid JSON and
  still the wrong shape (a partial write, a synced value); the loader's `try/catch` only
  covered the parse, so a bad `decade` threw later, at render time, inside an un-awaited
  handler — the wall opened empty with no error and no way out short of clearing site
  data. Every field is now range-checked on load.
- **The sort row could overflow sideways** at narrow widths rather than truncating the
  label, because a grid `1fr` track won't shrink below its content.
- Switching **to** Random now re-rolls the seed. Previously the first shuffle on a fresh
  install always ran on the default seed, so "random" gave every device the same order
  until the reshuffle button was tapped.
- The year harvest runs in **one database transaction**. Unwrapped, the first run on a
  large library is one implicit transaction — and one disk sync — per album (measured at
  35× slower on this container, and far worse on a Pi with a USB disk).
- **The library ordering cache is invalidated reliably again.** A well-tagged library
  could write thousands of years during a scan and never flush it, so the Library kept
  serving an ordering in which those albums were still undated while the Focus sheet
  simultaneously reported them as dated. Conversely, the scan's per-year invalidation is
  now coalesced — it was clearing the cache several times a second for the hours a first
  scan runs, so every Library page re-sorted the whole library from scratch.
- A failure inside the year harvest no longer aborts the rest of the library sync (it
  used to silently stop the Qobuz/TIDAL badge refresh for that sync).
- The three harvest maps were declared far below the code that assigns them — safe only
  because those calls happen to be deferred. Moved up beside the data they belong to;
  that arrangement is the v1.5.66 startup-crash shape and shouldn't be left lying around.
- Dead CSS from the old sort rows removed, and the decade filter now shares `albumYearOf`
  instead of keeping a fourth hand-written copy of the key expression.

### Added

- **77 more tests** (111 → 188), covering the two things above that fail invisibly:
  - `test/unit/libraryview.test.js` — every sort in both directions, undated albums
    always sorting last, decade filtering, and stable seeded shuffling. Mutation-checked:
    restoring the old plays/lastplayed inversion fails 5 subtests; restoring v1.6.57's
    whole-list reverse fails 3.
  - `test/unit/years.test.js` — date parsing, harvest keying, and the join. Six
    mutations were run against it, including "write the service's key instead of Roon's"
    and "overwrite years that already exist"; all six fail the suite.
  - `test/dom/library-sort.test.js` — drives the real arrow in a headless browser and
    pairs every glyph with the `dir=` actually sent, because an arrow that flips on
    screen while the server keeps sorting the old way looks completely normal.
    Also boots the app with a **v1.6.57 saved view** in localStorage — the migration path
    no other test reaches, and the one that runs for every existing user exactly once.
    That test found a real bug before release: the migrated view wasn't written back, so
    it re-ran on every load and kept resetting the direction the user had just chosen.
  - `setAlbumYear` is now extracted from `index.js` rather than stubbed in tests. The
    hand-written stub was more conservative than the shipping function and silently hid
    two of the six mutations above.

## [1.6.58] — 2026-07-29

### Fixed

- **Library Sort and Focus sheets no longer open underneath the now-playing bar.**
  Whenever something was playing, the mini transport bar painted over the foot of both
  sheets: the "Random" sort option and the A→Z direction row were cut off, and Focus's
  **Clear all** / **Show albums** buttons were completely hidden — and untappable, since
  the bar was also swallowing the taps.
  - Root cause: a **stacking-order** error, not a layout one. The sheet's backdrop sat at
    `z-index: 60` while the transport bar sits at `70`, so the bar was drawn on top of it.
    The sheets now sit on `90` — the same layer every other bottom sheet in the app already
    uses (Settings, Filter, label unmerge), all of which clear the bar correctly.
  - Also switched the sheets' height cap from `vh` to `dvh`, so on mobile Safari a full
    sheet is measured against the *visible* viewport rather than the toolbar-hidden one —
    previously the overflow pushed the sheet's title off the top of the screen.

### Added

- **DOM regression test for the sheets** (`test/dom/library-sheet.test.js`). It drives the
  real UI headlessly at a phone viewport with a genuinely playing zone, opens each sheet
  from the Library wall, and hit-tests every control: any control the transport bar covers
  fails the test. Test count: 111 → 116.
  - Class of error: **stacking context / z-index regression** — a bug where the markup,
    the layout and the listeners are all correct and the element is simply painted over.
    Nothing in the existing suite could see it, because every prior check asked whether a
    node existed or whether a click handler fired, not whether the user could reach it.
    The new probe uses `document.elementFromPoint`, which is the only check that answers
    that question.
  - The test carries **controls that fail loudly** if it stops being able to detect the
    bug: it asserts the transport bar is on screen and genuinely overlaps the sheet at the
    moment of each probe. An earlier draft measured the bar once at boot and passed against
    the un-fixed CSS, because the transport poll had hidden the bar again by the time the
    Focus sheet opened.

## [1.6.57] — 2026-07-28

### Added

- **Sort and Focus on the Library screen.** Two controls sit above the wall: **Sort**
  (Album name, Artist, Release year, Most played, Last played, Random — each with an
  A→Z / Z→A toggle) and **Focus** (Source: local files / Qobuz / TIDAL; Decade; and
  Listening: never played / not in 6 or 12 months). Your choice is remembered.
  - Focus facets **combine** — "local files AND 1990s AND never played" is one tap each.
    Roon's browse tree can't express that, because each facet there is a separate list.
  - Everything is computed from the extension's own library snapshot, so changing sort or
    focus makes **no calls to your Roon Core** and returns instantly. Results are cached
    per combination and rebuilt when the library or its scanned data changes.
  - Album and Artist sorting file "The Wall" under W, as a record shop would.
  - Albums whose release year hasn't been discovered yet are treated as **unknown** and
    always listed last, never as "year 0" — sorting newest-first can't float them to the top.
  - Random uses a fixed shuffle per visit, so scrolling never repeats or skips albums.

### Note on Roon parity

Roon's own Sort and Focus run on a private interface that extensions cannot reach — the
public API exposes four fields per album and no ordering control whatsoever. What's here is
the closest useful subset built from data this extension already has. **Not possible:**
star ratings, Roon favourites, Roon's own play counts and date-added, per-folder storage,
and the Inspector predicates (Live, Compilation, Duplicates…). Release year, plays and
source coverage depend on the library scan, and each approximate sort says so in the sheet
rather than pretending otherwise. **Genre and Tag stay in the main filter**, because Roon
keeps those in separate lists that can't be combined with the rest.

## [1.6.56] — 2026-07-28

### Fixed

- **Wrong artists no longer appear under "Also appears on"** (reported with a screenshot:
  opening **Prince** listed an album by *Jordan Prince* and two by *Bonnie "Prince" Billy*).
  The artist screen was asking "does this credit contain the letters of the artist's name?",
  so any credit containing "prince" matched. It now asks "is this artist one of the album's
  credited artists?", using the same library-validated splitter that decides which artist
  names are clickable — so if an album shows a link for an artist, that album appears on
  their screen, and nothing else does. Genuine work is unaffected: "Prince & The Revolution"
  and "Prince/Miles Davis" stay under **Albums**, "Sheena Easton feat. Prince" under
  **Also appears on**.
- The same flaw was found in six more places and fixed with one shared rule:
  - **Playback.** When a tile's saved position is stale the app re-finds the album by name;
    that matcher used the same substring test and then fell back to *whatever Roon returned
    first* with no identity check — it could start a completely unrelated album. It now
    requires the artist to match as a whole name and never guesses.
  - **Now playing.** The album lookup behind the now-playing screen could show a different
    artist's tracklist and artwork (a Kate Bush album answering for the band Bush).
  - **Wall display.** "More from <artist>" matched a prefix of a credit segment, tiling
    "Madonna / Prince Paul" under Prince; and a YouTube channel merely *containing* the
    artist's name (the "Kate Bush" channel for Bush) could score high enough to play.
  - **Artist photos.** The MusicBrainz lookup took the first fuzzy result with no name check
    at all, so short names (Low, Air, Ash, Yes) could show another act's photos entirely.
  - **Tapping the album name** on the now-playing screen matched on only the first word of
    the credit, so playing Kate Bush could open any "Kate …" album.
- **An artist whose name is only punctuation or non-Latin characters** ("!!!", "少年ナイフ")
  no longer returns the entire library: those names normalise to an empty string, and
  "anything contains nothing" is always true.

## [1.6.55] — 2026-07-28

### Fixed (multi-angle review of the v1.6.53/54 badge work)

- **Wrong badges are now impossible in three cases that could produce them.** (1) Titles made
  entirely of symbols or non-Latin characters ("+", "÷", Japanese, Cyrillic) reduced to an
  empty identity, so one such local album could badge every other one as local — those are
  now never keyed. (2) An album favourited in *both* Qobuz and TIDAL was always labelled
  Qobuz; it's genuinely unknowable, so it gets no badge. (3) Two library albums sharing an
  identity (a local rip plus a streaming copy Roon didn't group) now suppress each other's
  badge instead of guessing.
- **Badges no longer outlive the account.** Disconnecting Qobuz or TIDAL clears its badges,
  and an empty favourites list is now honoured — previously un-favouriting everything (or
  switching accounts) left the old badges in place permanently, saved across restarts.
- **All your Qobuz favourites are read, not just the first 500** — the request was a single
  un-paged page, so larger collections were silently half-badged.
- **A refresh triggered while another was running is no longer dropped** — tapping Rescan
  used to be swallowed by the sync's own refresh, so badges appeared not to update.
- TIDAL favourites now go through the same token-refresh-and-retry path as every other TIDAL
  call; a compilation on disk can no longer claim a track artist as its album artist; and
  both badge files are written atomically so a crash mid-write can't wipe every badge.
- **Multi-artist links**: a mixed credit like "Miles Davis/John Coltrane & Bill Evans" now
  splits fully instead of leaving "John Coltrane & Bill Evans" as one dead-end link, and a
  repeated name no longer produces two identical links.

### Changed

- **Streaming badges now match far more of the library.** Roon credits every performer on a
  collaboration while Qobuz and TIDAL report only the primary artist, so albums like
  "T-Bone Walker/Big Joe Turner/Otis Spann" could never match — every collaboration was a
  guaranteed miss. Each credited artist is now tried individually (the album title must
  still match exactly, so this can't cause a wrong badge). Matching also ignores "&" vs
  "and" and a leading "The", and uses the edition the services report separately, so
  "Rumours" matches "Rumours (Deluxe Edition)".
- Badges now appear on **every** screen — filtered genre/decade walls, search results, the
  labels browser and Label of the week previously showed none, which made a missing badge
  meaningless there.
- Album lists no longer recompute matching keys per request; the identities are built once
  with the library snapshot.

## [1.6.54] — 2026-07-28

### Added

- **Qobuz and TIDAL badges on albums**, completing the source icons started in v1.6.53.
  Roon's extension API still exposes no source field, so this uses the Qobuz/TIDAL logins
  the extension already holds: adding a streaming album to your Roon library favourites it
  in the service, so your own favourites tell us which library albums came from where.
  Each service's mark is shown top-right of the cover, alongside the existing local-files
  icon, on tiles and on the album screen.
  - Favourites are read when a service is connected, on every library sync, and on a manual
    **Rescan library** (the way to refresh badges after adding albums in Qobuz/TIDAL). The
    result is saved on the data volume, so badges are there immediately after a restart.
  - Matching is on title + artist, and stays deliberately conservative: an album that can't
    be matched confidently (a different edition or remaster, say) simply gets no badge
    rather than the wrong one. Local files win when an album is both on disk and favourited.
  - A service you haven't connected costs nothing and shows nothing.

## [1.6.53] — 2026-07-28

### Fixed

- **Multi-artist albums now give you a link per artist.** Credits like
  "T-Bone Walker/Big Joe Turner/Otis Spann" and "François Couturier/Dominique Pifarély"
  were shown as a single link covering the whole line, because Roon writes these with an
  unspaced slash and the splitter only broke on a spaced one (deliberately, to protect band
  names like AC/DC). It now splits on the unspaced slash too, but only on evidence: either
  every part looks like a full name (contains a space — "AC"/"DC" don't), or the library
  recognises one of them as an artist. Tapping a name opens that artist's screen, which
  already lists their own albums first and then an **Also appears on** section.

### Added

- **"Local files" badge on albums.** Albums found on the mounted music folder now carry a
  small badge (top-right of the cover, on tiles and on the album screen). Roon's extension
  API exposes no source field, so this uses the read-only /music mount the label scanner
  already walks: every album directory's tags are recorded during the scan and matched on
  title + credit. The list is saved on the data volume, so badges survive restarts. No
  badge means "not confirmed local" rather than "streaming" — a missing badge is preferred
  over a wrong one, and nothing is badged at all when /music isn't mounted.

## [1.6.52] — 2026-07-28

### Fixed

- **Albums became untappable after coming back from an artist's discography** (reported by a
  tester, reproduced here). Going album → artist → Back returned you to a wall that looked
  perfect but where no tile responded to taps; only refreshing the wall recovered it. The
  artist view was saving the screen it came from as an HTML *string* and rebuilding it from
  that markup on Back — which recreates the tiles as fresh elements and throws away the tap
  handlers and the album identity attached to the originals. It now sets the original tiles
  aside and puts those exact elements back, so everything on them survives. This fixes the
  dead tiles on **every** screen the artist view can be opened from: random albums, genre /
  tag / decade walls, Not played in 6 months, the Library wall, and label albums. (Home rows
  were never affected.)
- Returning to the **Library wall** now resumes loading more albums as you scroll — its
  paging was switched off on the way into the artist view and never switched back on.
- Returning to a **label's albums** restores the labels bar and the label you were viewing,
  instead of stranding you on a grid with no way back to the label list.
- **Back now returns you to where you were scrolled to**, rather than the top of the wall.
- A **multi-select left open** on a wall no longer follows you into the artist view (its
  action bar stayed on screen and made tiles select instead of open).
- **Rotating a phone while viewing an artist** (or Safari hiding its toolbar mid-scroll) no
  longer silently replaces the discography with a random wall.
- Opening a second artist from within an artist view no longer breaks the Back trail.

## [1.6.51] — 2026-07-17

### Added

- **Library panel dressed to match the other Home sections** (user-approved design): the
  Library row now sits in its own warm library-brown tinted panel with a books watermark —
  two staggered book spines and one leaning against them — in the same solid-silhouette
  style, size, rotation and opacity as the clock/vinyl/tag/notes motifs. Adapts to light
  theme like the rest (soft tan panel, dark motif).

## [1.6.50] — 2026-07-17

### Added

- **Library carousel on Home + full scrolling library wall.** A new "Library" row shows the
  start of the whole library in Roon's own album order; tapping the header opens a full
  grid (3 columns on phones, wider on tablets/desktop, like the other walls) that pages in
  60 albums at a time as you scroll. Pages come straight from the extension's snapshot
  index — scrolling the entire library costs **zero Roon Core calls**.
- **Persistent thumbnail store, grabbed during sync.** Album covers are now written to the
  data volume (`data/art-cache/`, one 500px JPEG per album) by a throttled prewarm pass
  that runs after every library sync (first pair, 12-hour check, manual Rescan). All
  tile-sized art (300–500px) is served from disk with no Core round-trip, survives
  container restarts, and even keeps rendering while the Core is offline. Normal browsing
  also writes through to the store, so art you've already looked at never needs fetching
  again; a sync prunes files for removed/changed albums.

### Fixed (found by the pre-release 8-angle review)

- Library wall's infinite scroll could append A-Z tiles into the labels browser, a label's
  album grid, or the artist view when reached directly from the wall — those views now
  explicitly release the wall, and every fetch re-checks view ownership after each await.
- A rebuild landing mid-prewarm no longer skips warming the new snapshot (the kick is
  queued and re-runs); prewarm writes are atomic (temp file + rename) so a tile requested
  mid-write can't cache a torn JPEG for a week; art filenames use an injective encoding so
  two albums can never collide onto one file.
- One 500px master per album is now also the single in-memory cache entry for all
  tile-sized requests (previously each size stored its own copy, shrinking the 64MB LRU);
  small art (96px wall-display backdrop, 120px queue rows) keeps the exact-size Core path
  instead of shipping 500px bytes.
- A transient server error while refreshing the Home Library row no longer wipes the
  cached tiles with a false "No albums." state; a stale multi-select action bar can no
  longer survive into a freshly opened wall; a late "Not played" response no longer
  overwrites whichever view the user navigated to meanwhile.

## [1.6.49] — 2026-07-16

### Fixed

- **Live-name play fallback rebuilt on Roon's dedicated search hierarchy.** A production log
  audit showed the v1.6.48 fallback fired 12 times and resolved 0 — every attempt died at
  "no Search entry at browse root", because a pooled browse session already deep in `albums`
  navigation doesn't reliably expose the Search item when crawling the general browse root.
  The fallback now goes straight at Roon's documented **`search` hierarchy** (query as `input`
  at the root, zone attached) and only falls back to the old browse-root crawl if that fails.
  Each stage still logs unconditionally (`[album:search] …`), so `docker logs` shows exactly
  how a stale-offset album was (or wasn't) resolved.
- **Discogs logo pass no longer burns the whole scan on 429s.** The same audit found 116
  Discogs 429 responses at fixed ~1.1s cadence ending in "0/107 logos found" on every scan —
  once rate-limited, the pass kept hammering and marked nothing retryable. Now a 429 triggers
  a single 65-second cooldown (Discogs' limit window is per-minute) and retries that label;
  if the retry is still limited the pass aborts with a clear summary and every remaining
  label stays eligible for the next scan cycle. Rate-limited labels are never marked as
  "tried", and per-attempt 429 error lines are gone (the pass summary reports the abort).
- **FanArt.tv 404s no longer flood the log.** A 404 is the normal "no artwork exists for
  this label" answer and is already counted in the pass summary ("N without fanart artwork") —
  the per-label error line for 404s is dropped; real errors (timeouts, 5xx) still log.

### Changed

- **Wall display idle polling quietened.** When the display toggle is off, the /display page
  already stops all zone/content polling (the 2-second tick bails immediately); the only
  request it makes is the settings check that lets the wall wake up when the toggle is
  switched back on. That check now runs every **60s while off** (30s while on, as before),
  and `/api/settings/display` is excluded from `[http]` request traces, so an idle wall no
  longer writes a poll line to the log twice a minute.

## [1.6.48] — 2026-07-15

### Fixed

- **The live-name playback fallback now actually resolves albums** (v1.6.47 shipped it but it
  failed for real albums). Comparing it against the extension's proven now-playing resolver
  found two faults: (1) it passed **no zone** on the Roon search browses, but Roon's browse
  root and search are zone-scoped, so the Search entry / results came back empty — it now
  passes the play zone (or any live zone as browse context when opening detail); (2) its
  album match gave up after an exact-title check, so a Roon title that differs slightly (e.g.
  a "(Live)" suffix) fell through to the "close and reopen" error — it now mirrors the
  now-playing resolver's fallbacks (exact + artist → exact → substring → top result). Every
  stage of the fallback logs unconditionally, so a miss shows in `docker logs` exactly which
  step failed (`[album:search] …`).

## [1.6.47] — 2026-07-15

### Changed

- **Simpler, snapshot-based library model + robust playback** (user request, replacing the
  v1.6.46 sync-deferral). The album index is now a stable snapshot: Roon owns the library;
  the extension scans it once on first pair, then re-checks only **every 12 hours** or on a
  **manual Rescan** — and **never rebuilds while Roon is importing**. Gone are the 5-minute
  probe, the play-triggered rechecks, and every user-action rebuild, so the extension stays
  off a busy Core entirely.
  - **The "close and reopen it" playback error is fixed.** Playback previously resolved an
    album by its stored list position, which a Roon import reshuffles — so tapping an album
    whose position had moved failed. Now, when a stored position is stale, the album is
    resolved **live by name** via Roon's own search (offset-free, always current, a single
    lookup — not a scan), so a snapshot that's hours out of date never blocks a play. Only a
    genuinely-removed album still reports the error.
  - **Manual "Rescan library"** added to the side menu. It rebuilds the snapshot, but refuses
    with "Roon is still adding albums — try again shortly" while an import is in progress, so
    a deliberate press never fights the Core. The 12h auto-check applies the same rule.
  - Import detection needs no Roon API support: a manual Rescan / 12h check reads the album
    count, waits a few seconds, reads again — a still-moving count means Roon is importing.

## [1.6.46] — 2026-07-15

### Added

- **Automatic library-sync awareness — the extension stops fighting a busy Core** (user
  request, prompted by Roon Early Access 1674's browse-performance issues). While the Roon
  Core is importing local files or syncing streaming favourites, the extension now detects
  it and **defers its heavy background work** — the full-index rebuild (a 17-page re-walk)
  and the labels scan — instead of thrashing an already-congested Core with a fresh rebuild
  on every 5-minute tick that lands on a still-changing library. Album selection, playback
  and search stay fully operational throughout: they serve from the existing in-memory
  index, and the stale-offset play defense keeps playback correct even while offsets shift.
  - **Detection** is automatic and needs no Roon API support (Roon exposes no "importing"
    signal): the existing 5-minute probe already reads the album count each tick, so a count
    that keeps *moving* between probes means a sync is in progress. On detection the probe
    speeds up to once a minute to catch the end quickly; once the count holds steady for two
    consecutive probes the extension runs **exactly one** rebuild and returns to normal. On a
    ~550-album import this collapses roughly six wasteful mid-sync rebuilds into one.
  - The Roon status line shows "Roon library updating…" while deferring. An explicit manual
    "Rescan" in the labels UI bypasses the wait (a deliberate action never silently no-ops).

## [1.6.45] — 2026-07-15

### Fixed

- **Genre/wall screens open at the top on desktop** (community contribution — thanks
  @markmcclusky, PR #67). Home and the album wall share `<main>`'s scroll container, so
  entering a wall while Home was scrolled down (e.g. tapping a genre card below the fold)
  opened mid-page or at the bottom instead of at the top. `showWall` now resets the scroll
  position on entry. This release wraps the already-merged fix in a versioned build.

## [1.6.44] — 2026-07-15

### Changed

- **Roon call traces are now self-attributing** (follow-up to a user's log analysis on Roon
  Early Access 1674 that found browse calls taking 13–27 seconds). `[browse:res]`/`[load:res]`
  and failure lines now carry the session key and request shape (`rra_s3 albums pop_all` /
  `rra_s1 albums @1500x500`) alongside the duration, so a slow call reads directly off one
  log line even when concurrent operations interleave — no more hunting for the matching
  request line. Investigation context recorded: session-key pooling verified healthy on
  1674 (bounded key set, 168/168 request/completion match); the multiple keys seen were
  operations correctly stacking behind slow Core responses, not a leak.

## [1.6.43] — 2026-07-15

### Added

- **Roon-style log files** (user request, follows v1.6.42's observability pass). Everything
  the extension prints is now also written to `data/logs/MusicD-Remote_log.txt` on the data
  volume — logs survive container rebuilds and updates, and can be zipped for a bug report
  exactly like Roon's own `RoonServer_log.txt`. When the current file reaches ~8 MB it
  rotates to `MusicD-Remote_log.01.txt` (newest) through `.10.txt` (oldest, then dropped) —
  Roon's rotation scheme, capped at 10 numbered files (~88 MB worst case) instead of Roon's
  20. Retention is size-based, not time-based. `docker logs` is unchanged (stdout keeps the
  same lines); if the data volume is unavailable the file side disables itself and stdout
  carries on. The startup banner states the log path and rotation policy.

## [1.6.42] — 2026-07-14

### Changed

- **Observability overhaul** (user request: debug by default in Docker, better logging,
  Roon API call focus, better traces all round).
  - **Debug logging is now ON by default inside Docker** (the image already sets `DOCKER=1`;
    every debug gate in the codebase is logging-only — verified — so nothing behavioral
    changes). `-e RRA_DEBUG=0` quiets a container; `RRA_DEBUG=1` still forces it on for
    native runs. The startup banner states the version and whether debug is on.
  - **Every log line is timestamped** (ISO-8601 UTC, both the app and the launcher), so
    `docker logs` can be correlated line-for-line with Roon Server's own logs.
  - **Roon API calls are traced with round-trip durations**: `browse`/`load` log the request,
    the duration, the action/title and item/total counts; image fetches log duration, key,
    content type and size (only cache misses reach Roon). **Failures always log** — with the
    duration and the offending opts — even with debug off; a failed Roon call is never
    invisible again.
  - **API request tracing**: every user-action API request logs method, path, status and
    duration (`[http] POST /api/play -> 200 312ms`). The steady pollers (zone-state, zones,
    image, status polls) are excluded so real actions stay readable.
  - **Pairing lifecycle is always logged**: paired (with core id/name/version), zone
    subscription established (zone count), unpaired.

## [1.6.41] — 2026-07-14

### Changed

- **Artist bio header now matches the LMS-remote reference** (user feedback on v1.6.40).
  The artist portrait was a small 72px thumbnail beside the text; it is now a large centred
  round portrait (up to 200px) above the bio, with the bio full-width beneath it and the
  Show more control and "Bio: <source>" caption centred underneath — the layout from the
  user's example. The Qobuz browser's artist screen keeps its compact avatar+name row and
  inline footer.

## [1.6.40] — 2026-07-14

### Added

- **Individual artist links on multi-artist albums** (user request). The album view's
  credit line now splits collaborations into separate tappable links — "Panda Bear, Sonic
  Boom & Adrian Sherwood" becomes three artists, each opening their own albums screen
  (their albums first, then "Also appears on"). Splitting on `,` `&` `+` `and` `/` is
  inherently ambiguous ("Earth, Wind & Fire" is one band), so the split is
  library-validated server-side: it's accepted only when at least one fragment is a known
  artist in your library (the exact credit of some album) — real collaborators usually
  have their own albums, band-name fragments never do. Credits that fail validation stay
  as one link, exactly as before.
- **Artist bios on the artist screen** (user request, LMS-remote style). The artist-albums
  view now opens with a header: round artist portrait, editorial bio clamped with
  Show more/Show less, and a "Bio: Qobuz" (or Tidal/Wikipedia) attribution. It reuses the
  wall display's validated bio pipeline — Qobuz/Tidal album-matched first, then
  album-cross-checked Wikipedia, sharing the same bounded cache — with the artist's own
  album pinning their identity, so lesser-known names don't get someone else's bio. The
  Qobuz artist portrait that the pipeline always fetched (and discarded) now becomes the
  avatar. The in-app Qobuz browser's artist screen gains the same bio block — Qobuz's
  editorial biography was already in the API response and previously thrown away.
  (Band MEMBERS as shown in LMS aren't available from any pipeline source — Qobuz's
  artist payload doesn't carry them; noted as a known limitation.)

## [1.6.39] — 2026-07-14

### Changed

- **Album view track rows show the full artist credits** (user request). Track rows were
  [number | title | artist right-aligned in a 35%-wide ellipsis column], which cut off
  multi-artist credits ("Crosby, Stills, Nash…"). They now use the same two-line layout as
  the Queue tab and the Qobuz app: title on the first line, the complete artist/composer
  credit beneath it in dim text that wraps instead of clipping. The per-track Play now /
  Queue tap-to-expand actions are unchanged.

## [1.6.38] — 2026-07-14

### Fixed

- **"Play now" no longer plays a different album after a library change.** Album tiles carry
  a position (offset) into Roon's albums list captured when the extension's index was built;
  a Roon import/rescan shifts those positions, and both the album view and Play/Queue
  resolved the album by raw offset with no identity check — so during (or after) a scan the
  view could look right (its header renders from the cached tile) while the tracks and the
  actual playback came from whatever album now sat at the stale position. Per-track play has
  verified identity since v1.6.10; the album-level path now gets the same protection: the
  album's title/artist travel with every open and play, the server verifies the item at the
  offset matches, silently re-locates the album by identity in the index when it moved (and
  returns the corrected position to the UI), and refuses loudly ("library just changed —
  close and reopen") instead of playing blind when it can't. A verify-mismatch also triggers
  the library-change probe immediately instead of waiting for the next 5-minute tick. The
  album view previously *detected* this exact mismatch and silently kept rendering the wrong
  album's tracks under the right title — that path now adopts the server-corrected position.
  The same identity check covers every offset-based play path: multi-select Play/Queue, the
  wall display's grid tiles, Random Album Radio's auto-advance, and the unheard/random
  shortcuts — each already knew which album it meant; now Roon is held to it.
- **Review hardening (8-angle)**: a stale radio pick keeps the 30s throttle armed instead of
  retrying on every zone event (~1/sec) during an import; the play-time change probe can't
  overlap itself or chain rebuilds hotter than every 30s; label-browser albums now open with
  the explicit full-library filter override (a lingering genre/tag filter made their offsets
  resolve against the wrong list — previously a silent wrong-album, now it would have been a
  spurious "library changed" refusal); `/api/play-multi` returns the same 409 as the other
  play routes when the first album moved; the volume sheets read the output's volume type at
  tap time instead of from a mirrored global that a zone switch could strand.

### Changed

- **Roon-style volume control** (user request). The volume popovers on the mini play bar and
  the now-playing screen are now one shared full-width sheet matching the official Roon app:
  large speaker icon + numeric readout, a full-width slider with a proper touch-size thumb
  (the old 4px hairline was unusable on phones) and the output's real min/max on a scale
  beneath it, and round − / + buttons. Both sheets stay in sync, dB-scaled outputs show
  their true range, and relative-only ("incremental") volume outputs — which previously got
  a meaningless absolute slider — now collapse to the − / + nudge buttons, as in Roon.

## [1.6.37] — 2026-07-13

### Fixed

- **Hourly full-library re-walks eliminated** (follow-up to a community report of Roon Server
  Build 1670 heap/GC churn, investigated against two users' Roon Server logs). A clean
  5-minute library probe (count + first/last album identity unchanged) did not refresh the
  album index's 1-hour freshness window, so on an actively used system every hour of use
  kicked off a full paginated re-walk (`load count:500` × the whole library) of a provably
  unchanged library — the spiky large-payload JSON serialization visible in the reporter's
  heap graphs. A clean probe now counts as verification and extends freshness; a full walk
  still runs when the probe detects a change, and at most once every 24 hours regardless
  (the probe can't see mid-list count-neutral edits, so verification alone must not extend
  freshness forever — the daily cap is enforced by the probe itself, so it also holds on an
  idle box). Worst case drops from ~24 full walks/day to 1.
- Log-verified while investigating (no code change needed): the reporter's other findings
  were already fixed or unfounded on current builds — the fresh random `multi_session_key`
  per 5-min probe (~265 never-released Roon-side browse sessions/day) was fixed by v1.6.35's
  pooled browse sessions; the web UI's 1.5s zone-state poll is served entirely from the
  extension's in-memory zone map (zero Roon calls, and polling stops while the tab is
  hidden); and Roon's `devicedb` traffic is the Core's own audio-device database refreshing
  on a fixed ~4-hour timer, uncorrelated with extension activity.

### Changed

- **docker-compose.yml modernised**: it still referenced the pre-rename
  `roon-random-albums` container and — dangerously — a `roon-data` volume, which would
  start compose users with an empty data volume (re-pairing, lost history). It now builds
  straight from the GitHub release tag (no container registry, no manual download), names
  the container `musicd-remote`, and mounts the standard `musicd-remote-data` volume.

## [1.6.36] — 2026-07-13

### Fixed

- **macOS / Docker Desktop installs can now actually reach the Roon Core.** The README's
  macOS instructions have told users to set `-e ROON_CORE_IP=<ip>`, but the extension never
  read that variable — it unconditionally ran `roon.start_discovery()`, whose UDP multicast
  (SOOD, `239.255.90.90:9003`, TTL 1) cannot escape Docker Desktop's VM without host
  networking. macOS installs could therefore never pair, and the documented workaround was
  wired to nothing. When `ROON_CORE_IP` is set the extension now connects straight to the
  Core's websocket API (`ws://<ip>:9330/api`; port overridable via `ROON_CORE_PORT`).
  Class of error: documented configuration never implemented in code — caught by tracing
  every documented env var to a `process.env` read.
- **Direct connection self-heals.** Unlike discovery (which rescans every 10 s), the Roon
  API's `ws_connect()` is single-shot: it never retries, and a failed *first* connect fires
  only its error callback. The direct path re-arms itself on both close and error with a
  10 s backoff, so a Core restart, a network blip, or the container starting before the Core
  comes up no longer strands the extension until a manual container restart. Linux /
  host-network installs are untouched — without `ROON_CORE_IP`, discovery runs exactly as
  before.

- **Direct-connect misconfiguration is diagnosable** (8-angle review findings). A wrong IP or
  port previously retried forever showing only "Starting…", with the connect log gated behind
  `RRA_DEBUG`. Now: the first failed attempt (and one every ~5 minutes after) logs
  `cannot reach Roon Core at <ip>:<port>` to `docker logs` unconditionally; the Roon status
  line shows the address being tried; an invalid `ROON_CORE_PORT` value is rejected with a
  warning instead of silently producing `ws://<ip>:NaN/api`; and a pasted scheme, trailing
  slash, or embedded `ip:port` in `ROON_CORE_IP` is normalised instead of building a broken
  URL (an out-of-range embedded port falls back to 9330 — unvalidated it made `new URL()`
  throw synchronously and crash-loop the container at boot, and any other unconnectable
  host value now routes into the logged retry instead of crashing). A stale socket's late
  error callback can no longer re-arm the retry loop against a healthy connection
  (connection-generation guard).

### Added

- `ROON_CORE_IP` and `ROON_CORE_PORT` documented in the README configuration table and the
  docs-site environment table.

## [1.6.35] — 2026-07-11

### Fixed

Roon API hygiene (Core load) — prompted by the community reports of Roon Server Build 1670
GC problems where API extensions were suspected: a full review of everything this extension
asks of the Core found no library writes and a tiny idle footprint (2 browse calls / 5 min),
but four real hygiene issues that made it look worse than it is. All four are fixed:

- **Queue subscriptions no longer leak.** Opening the queue modal subscribed to the zone's
  queue and never unsubscribed (an acknowledged leak) — every open added one more live
  subscription the Core kept pushing queue deltas to until the extension restarted.
  `/api/queue` now unsubscribes immediately after the first payload (including after a
  timeout), so the Core carries zero standing queue subscriptions.
- **Browse sessions are pooled instead of minted per operation.** Every operation used to
  invent a fresh random `multi_session_key` and never release it — the Core holds browse
  state per key for as long as the extension stays connected, so sessions accumulated
  without bound (~288/day from the 5-minute index probe alone, plus one per play, filter,
  search and now-playing lookup). Keys are now checked out of a small pool and returned when
  the operation finishes: the Core holds at most as many sessions as the extension's peak
  concurrency (single digits), regardless of uptime. Safe because every operation already
  starts with `pop_all`/fresh navigation and item_keys are never held across operations.
- **Re-pairing no longer triggers an unconditional full library re-walk.** The album index is
  now kept across an unpair and re-verified on re-pair with the existing cheap 2-call probe
  (full rebuild only if the library actually changed). Previously a flapping connection — for
  example a Core struggling with GC pauses dropping its extensions — got hit with a complete
  library re-page on every single reconnect, on top of its existing trouble.
- **"Play all" / multi-album queueing is throttled.** Queueing N albums fired N parallel
  album-opens (~7 browse round-trips each) in one unbounded burst over the single Roon
  websocket; subsequent albums are now opened in batches of 4.

### Changed

- **Roon API libraries pinned to exact commits.** The six `node-roon-api*` dependencies
  pointed at RoonLabs' GitHub master, so every Docker build silently pulled whatever the API
  repos contained that day. They are now pinned to the commits current at this release, so
  builds are reproducible and API-lib behaviour can only change deliberately.

## [1.6.34] — 2026-07-11

### Changed
- **Settings redesigned as a category list.** The single long-scrolling Settings sheet is now a home list of categories — Playback, Labels, Artwork & metadata, Streaming accounts, Wall display, Appearance, System — each opening its own focused pane with a back arrow. Every control keeps its exact behaviour; they are just grouped so the sheet is no longer one long scroll. Escape now steps back a level (pane → home → closed).

### Fixed
- **Artist search is faster.** Each album's individual artist names (split on `/`, `feat.`, `ft.` etc.) are now computed once when the library index is built rather than re-split and re-normalised on every keystroke of an artist search. Results and ordering are unchanged.

## [1.6.33] — 2026-07-11

### Fixed
- **Release automation now matches the MusicD-Remote naming.** The GitHub release workflow still built assets named `roon-random-albums-v…-docker.tar.gz` and titled releases "Random Albums" — so every release needed the asset re-uploaded by hand. It now builds `MusicD-Remote-v<version>.tar.gz`, titles the release "MusicD Remote", and excludes any committed `*.tar.gz` from the build so a root tarball can no longer be nested inside the release asset.
- **Migration banner (shown to old native installs) pointed at a dead v1.5.9 URL on the pre-rename repo.** It now links to the current releases page with copy-ready `musicd-remote` Docker commands.

## [1.6.32] — 2026-07-11

### Changed
- **The repository is now [`meltface-80/MusicD-Remote`](https://github.com/meltface-80/MusicD-Remote)** (renamed from `Roon-Random-Albums-Extension`), completing the v1.6.31 rename. GitHub redirects all old URLs, so existing installs keep updating; this build makes the new home native:
  - The self-updater now derives the repo from `package.json` (which points at `MusicD-Remote`) instead of relying on redirects from the old hardcoded name; the fallback was updated too.
  - **Release tarballs are renamed**: `MusicD-Remote-vX.Y.Z.tar.gz` (the `-docker` suffix is gone — Docker is the only install method).
  - **README install instructions rewritten** for the new names: install folder `/opt/musicd-remote` (macOS: `~/musicd-remote`), image/container `musicd-remote`, and — for new installs — the data volume `musicd-remote-data`. Installs upgrading from v1.6.31 or earlier keep their Roon pairing, play history, and label cache by moving the old `roon-random-albums-data` volume once (a one-time `cp -a` copy container, documented in the README's Updating section, with a bold warning that skipping it means re-pairing and lost history).
  - The Settings "View on GitHub" link points at the new repository.
- No functional changes to the app itself.

## [1.6.31] — 2026-07-11

### Changed
- **The extension is now called MusicD Remote.** Display name in Roon ("MusicD Remote v1.6 (Build 31)"), the web app menu, and the Settings version line all renamed. The Roon `extension_id` is deliberately unchanged — no re-authorization needed; the zone/pairing carries over untouched.
- **Update checks now survive a repository rename.** GitHub answers a renamed repo's old API URLs with a redirect, which the updater previously treated as "no update available" — silently stranding every installed copy. The update check now follows redirects (with the auth token withheld from any non-GitHub host). Install this version BEFORE the repository is renamed and the transition is seamless.

## [1.6.30] — 2026-07-11

### Fixed
- **FanArt.tv label logos now self-heal when the API key is added or changed.** Previously, every label checked while the key was missing or broken got a permanent "no logo" verdict that survived restarts and even Force rescan — so a key added after the first scans could never produce logos (the exact cache-poisoning found on a live install: 1,040 blocked labels, 468 real FanArt logos underneath). Saving the key now purges those cached misses (real logos are kept), refetches immediately, and reports how many verdicts it cleared. The FanArt pass also writes its progress to the labels scan log like the Discogs pass ("fetching logos for N labels" / "done: X/N…"), so it is diagnosable without `RRA_DEBUG`.
- **Wall-display artist bios no longer show the wrong artist.** The bio card is now sourced and validated in strict order:
  1. **Qobuz, then Tidal** — when the playing album is found in the connected service's catalogue (album title AND artist must both match), the bio comes straight from that service's own artist page, pinning identity exactly. Tidal's `[wimpLink]` markup is stripped.
  2. **Wikipedia, hardened** — the article title must *be* the artist (a single "(band)"/"(musician)" qualifier allowed), disambiguation pages are rejected outright, and the article must additionally be connected to the playing album (full-text cross-check covering discography sections). No confident match → no bio card, rather than a guess: previously any music-flavoured search result could win, so a generic name like "Camel" could surface a different musician's biography.
  - Every credited artist on a multi-artist album goes through the same validated chain, attribution names the real source (Qobuz/Tidal/Wikipedia), and lookups are cached per artist+album.
- Code-review findings fixed pre-commit: bare slashes in artist names (AC/DC) are no longer treated as multi-artist separators; Qobuz search items that carry `performer` instead of `artist` now match; a redundant entity-decode was removed.

## [1.6.29] — 2026-07-10

### Changed
- **Playing a genre-, label-, tag- or decade-filtered album is much faster after the first time.** To play a filtered album the extension first has to locate that genre/label/tag in Roon's browse tree by title, which meant paging through the list 100 entries at a time — up to ~30 sequential Roon round-trips for a genre and ~200 for a label, every single time, adding seconds to each filtered play. It now remembers each filter's *position* in its (alphabetically stable) list and jumps straight there in one round-trip, verifying the title on arrival. A stale position (after a library edit shifts the list) simply falls back to the old scan and re-learns it, so it can never open the wrong album — only ever be as slow as before. Positions are relearned automatically when the library changes. Item keys, which are session-scoped, are still never cached — only the stable list position is.

## [1.6.28] — 2026-07-10

### Changed
- **Home screen opens instantly — it no longer reloads and re-randomises everything each time you open the PWA.** The in-memory freshness state was destroyed whenever the app was backgrounded, so every cold open rebuilt all four Home rows (Not played / Random / Label of the week / Browse by genre) from scratch behind "Loading…" placeholders. The last rendered rows are now persisted to `localStorage` and repainted the instant the app opens — before it has even reconnected to Roon — then revalidated quietly in the background with no "Loading…" flash. A reopen within 5 minutes does no refetching at all. Covers come straight from the browser's week-long HTTP cache, so it's a flash-free repaint, not a reload.
- Root cause of the sluggish feel was confirmed (via a performance + code review) to be **client-side**, not the backend language: the server work is ~90–95% waiting on sequential Roon Core round-trips, which no rewrite (Rust/C++/.NET) would speed up. This change removes the most visible repeated cost — the full Home rebuild on every open.

### Fixed
- Instant-open review fixes: an empty `200` response while the index is still building right after a restart no longer blanks the hydrated Label-of-the-week / genre rows (the cached rows are kept until real data arrives); the unplayed and random rows now carry independent freshness timestamps so a stale row can't ride a fresh sibling's freshness; and a genuinely empty unplayed result is no longer persisted as cache.

## [1.6.27] — 2026-07-09

### Changed
- **Wall display: bounded the artist-bio cache (`displayArtistBioCache`) at 500 entries**, matching the eviction its sibling `displayContentCache` already had. Found during a performance + code review of the display feature: it was the only cache that grew without a cap, so a streaming-heavy box that never restarts could accumulate one small entry per distinct artist/member name ever played. The review found no correctness bugs in the v1.6.22–v1.6.26 display changes; the O(n) per-request label scan is confirmed off the hot path (served from the 6 h content cache, keyed per track).

## [1.6.26] — 2026-07-09

### Fixed
- **Wall display: the "More on <label>" grid covers are finally selectable — this was the real root cause.** The two crossfade layers (`slide-a`, `slide-b`) both cover the whole screen; the hidden layer only had `opacity: 0`, which does **not** stop it from receiving taps. Because `slide-b` sits on top, whenever a library grid rendered into the lower `slide-a` layer, the empty top layer silently swallowed every tap — so the artist grid (which happened to land on top) worked while the label grid (which landed underneath) did not, regardless of the album offsets being correct. The non-visible layer now has `pointer-events: none`, so taps always reach the grid actually on screen. Verified with a headless render test that taps a cell in both grids and confirms the Play now / Queue panel opens with the tapped album; the same test reproduces the failure when the fix is removed.

## [1.6.25] — 2026-07-09

### Fixed
- **Wall display: covers on the "More on <label>" grid are now selectable (Play now / Queue) — for real this time.** The v1.6.23 attempt started from the labels-index snapshot and tried to match each album *back* to the live album index by title+artist; when the snapshot's stored subtitle came from a different seed source (Qobuz / disk cache) than the live Roon browse rows, the match silently failed and the tiles arrived with no usable offset, so tapping did nothing. The label grid is now built the **same way the working "More from <artist>" grid is** — by iterating the live album index directly and keeping albums whose resolved label matches the now-playing album's label. Every tile is therefore a live album-index entry carrying a current, valid offset. As a side effect this also fixes label grouping for **manually merged labels** (the entry is now looked up by the merge-redirected group key).

## [1.6.24] — 2026-07-09

### Fixed
- **Wall display: artist photos are no longer cropped top and bottom.** Portrait/full-frame band photos were shown with `object-fit: cover`, which fills the screen by clipping whatever doesn't fit — so heads and feet got cut off on tablet/desktop. The photo slide now uses `object-fit: contain`: the whole photo is always shown, letterboxed with black bars on the sides when it's a different shape from the screen, and the slide reserves the bottom strip's height so the full image stays clear of the progress bar.

## [1.6.23] — 2026-07-09

### Fixed
- **Wall display: covers on the "More on <label>" grid are now tappable (Play now / Queue), like the artist grid.** The label grid took its album offsets from the labels index, which is a snapshot that isn't rebuilt when the album index is — so after any library change/reorder those offsets went stale and the covers pointed at the wrong album or an empty slot, making them unresponsive. The label grid now re-resolves every album against the live album index (by title + artist) at request time, so its offsets and artwork are always current; albums no longer in the library are dropped.
- **Same staleness fixed for the labels browser generally** — the labels index is now re-seeded from the fresh album index whenever a library change triggers an album-index rebuild, so browsing a label and playing from it can't land on the wrong album after a reorder.

## [1.6.22] — 2026-07-09

### Changed
- **Wall display: the artist bio card now covers every credited artist.** For multi-artist credits (e.g. "Jeff Beck / Tony Hymas") a Wikipedia bio is fetched for each member (up to 4), and the bio card alternates to the next one on each rotation pass — pinning **Bio** cycles through the members too. Single-artist tracks behave as before.

## [1.6.21] — 2026-07-09

### Fixed
- **Wall display: skipping a track no longer keeps the previous track's video playing.** Content was reloaded per album; the video is per track, so a skip within the same album left the old clip running (the bug that needed a force-close). Content now reloads per track — the album-level parts (photos, review, bio, library grids) are served from cache so the refresh is instant.
- **Wall display: the video starts at the track's live position** (best-effort sync — video edits rarely match track length exactly), instead of always starting from 0 while the song is mid-way.
- A "no video found" verdict now expires after 30 minutes instead of sticking for the whole server session, so transient YouTube API failures don't blank a track's video for good.

### Changed
- **When a track has a video, the display opens straight to it and stays on it** — synced and playing through — unless a mode chip is tapped. Tracks without a video rotate as before. A manual pin still always wins.

### Added
- **Library grid albums are now tappable: Play now / Queue.** Tap a cover on the "More from <artist>" / "More on <label>" screens → a panel offers **▶ Play now** and **+ Queue** to the display's zone (same playback path as the album view). The panel auto-dismisses, and confirms with "Playing ✓ / Queued ✓".

## [1.6.20] — 2026-07-08

### Fixed
- **Wall display: videos from real artist channels now qualify.** The v1.6.19 scorer demanded "official video" in the title on top of the channel match — but genuine artist channels (e.g. Stereophonics) title their uploads plainly ("Artist – Track"), so nothing passed. The artist's own channel (including "Artist Music" / "Artist Official" / VEVO variants) is now trusted outright; the search query and category filter were also loosened so those uploads surface at all (the scorer still rejects Topic audio, teasers, interviews, chat shows, lyric videos, covers and bootlegs).

### Added
- **Wall display: on-screen mode controls.** Tap the screen (or move the mouse) to reveal a chip bar — **Auto** rotates everything; **Art / Photos / Bio / Review / Library / Video** pin that screen. Photos cycle within themselves when pinned; a pinned **Video plays through in full** (and loops) instead of rotating away after N seconds. Chips only appear for content that exists for the current album; a pinned choice survives album changes and re-applies whenever the new album has that content. Controls fade out after 5 seconds.

## [1.6.19] — 2026-07-08

### Changed
- **Wall display videos: official music video or official live performance — or nothing.** Candidates are now scored precision-first: the channel must be the artist's own (or their VEVO); "official (music) video" titles score highest; live versions are accepted only from the artist's own channel. Hard-rejected outright: " - Topic" auto-uploads (static album art with audio — pointless muted), lyric videos, visualizers, covers, reactions, remixes, karaoke, chat-show/fan uploads, and any title missing the track name. Survivors are verified playable (embeddable, public, not age-restricted — age-restricted never plays embedded) with view count as tiebreak. A wrong video no longer beats no video.

### Added
- **Wall display: artist bio card** — the artist's Wikipedia biography is now its own rotation slide (the review card keeps the album text).
- **Wall display: "More from <artist>" and "More on <label>" slides** — cover grids drawn instantly from your own library (album index + labels index, no API keys): other albums by the playing artist, and label-mates of the playing album. Only shown when there are at least 3 to show.

## [1.6.18] — 2026-07-08

### Fixed
- **Wall display: video clips now actually play.** Videos were found but rendered as YouTube's "Video unavailable — Watch on YouTube" card: the search API's embeddable filter is unreliable, and many music videos block third-party embedding. The server now verifies the top 5 results against YouTube's `status.embeddable` flag and picks the first video that genuinely allows embedding; the page also switched to the YouTube IFrame Player API so any failure that still slips through (region blocks, takedowns) is detected and the video is dropped from the rotation — album art returns instead of an error card sitting on screen.
- **Wall display never scrolls and the progress strip always stays on screen** — the page body is pinned to the visual viewport with touch panning disabled (iOS Safari ignores plain `overflow:hidden` for touch drags), so nothing can rubber-band the bar out of view on phones.

## [1.6.17] — 2026-07-08

### Added
- **Wall display** — a Roon-style always-on screen at `http://<server-ip>:3399/display`. Point any tablet or TV browser at it: it follows the playing zone (pin one with `?zone=<name>`) and rotates between **album art**, **artist photos** (fanart.tv, using your existing key), an **album review card** (the same legally-safe Qobuz/Wikipedia text as the album view — Pitchfork text stays link-only), and a **muted video clip** of the playing song (optional — needs a free YouTube Data API key, new field in Settings; without one the rotation simply skips video). A Nest-Hub-style progress strip along the bottom shows track, artist · album, elapsed/total and a thin progress bar.
- **Settings → Wall display**: an on/off toggle and a "rotate every N seconds" slider (5–60s, default 10s). When off, the page shows a notice and **nothing is fetched** — no lookups, no polling work; flipping the toggle brings a mounted display to life within 30 seconds, no reload needed.

## [1.6.16] — 2026-07-08

### Fixed
- **Updates no longer pile up duplicate entries in Roon's "Extension authorizations" list.** The Roon pairing token was stored in `config.json` in the container's working directory — wiped by every docker update — so each new build registered as a brand-new extension and Roon issued a fresh authorization, leaving the old ones behind as ghosts. The pairing state now lives on the persistent data volume (`data/roonstate.json`), with a one-time migration for a running install's existing token, so future updates reconnect with the same authorization. The stale duplicate entries need removing once by hand (Roon → Settings → Extensions → View extension authorizations → Remove the old builds).

## [1.6.15] — 2026-07-08

### Changed — performance pass (the UI had grown sluggish since the Home redesign)

Server:
- **Cover art is now cached in memory on the server** (64 MB LRU) and served with long immutable browser-cache headers. Previously every art request — ~85 per Home render — was a live round-trip through the single Roon websocket, with the Core rescaling each image on demand; that connection also carries all browse/transport traffic, so everything queued behind everything else.
- **The album index no longer rebuilds on nearly every Home visit.** Its staleness window was 10 minutes, so most visits kicked off a full library re-walk that competed with the very render it was serving. It's now a 6-hour safety net — the existing 5-minute count probe still rebuilds promptly when the library is actually edited.
- **Random albums are picked from the in-memory index** (unfiltered requests): removes ~6 Roon browse round-trips + 30 single-item loads from every Home visit and wall refresh. Genre/tag/label-filtered picks still use live browse.
- **Responses are gzip-compressed** (app.js ~75% smaller on the wire). The app's html/js/css deliberately stay revalidate-on-load (cheap ETag 304s) so a new build shows up immediately after an upgrade — no stale-app hard-refresh dance.

Web UI:
- **Home keeps its rows for 5 minutes.** Every Back tap used to rebuild the unplayed + random rows with a fresh random set — ~60 new cover fetches each time. Within the window the existing tiles (and the browser's image cache) are reused; after it they refresh as before.
- **Backdrop blur removed from the bars that float over the scrolling page** (mini transport, filter bar, label-merge bar) — iOS Safari re-blurs everything beneath them on every scroll frame; they're now solid. This was the main scroll-jank source while music was playing.
- **The album view's ambient glow uses a tiny 96px cover** instead of the 800px art (upscaling does the smoothing) — a fraction of the blurred-layer cost during modal scrolling.
- **Tile art is sized to the screen** (devicePixelRatio-aware) instead of always 500px — iPads/desktops were fetching ~2.8× more pixels than they display.
- **The 1.5s transport poll only touches the DOM and localStorage when something actually changed** (track/state/volume signature) instead of rewriting the bar every tick.
- **Below-the-fold Home sections (label of the week, genres) skip rendering until scrolled near** (`content-visibility: auto`).
- Album-of-the-day and the unplayed list now load in parallel instead of one after the other.

### Not changed
- **No rewrite needed:** profiling showed Node CPU is essentially idle — the time went to Roon Core round-trips, image bytes, and browser paint. A Rust port would wait on the same websocket at the same speed; the wins above are architectural and language-independent.

## [1.6.14] — 2026-07-07

### Fixed
- **Landscape Now playing on tablets and desktops** — broken by the v1.6.13 layout change: at ≥720px the modal panel is a centred auto-height dialog, so the height-driven artwork had nothing to size against and collapsed to zero — the screen shrank to a small floating box with no album art. Now playing is now a full-screen view at every size (Roon parity), and landscape tablets/desktops get a proper two-pane layout: tabs centred on top, big album art on the left, track/seek/transport on the right. Verified headlessly at 1400×900, 1080×810 (tablet landscape), 810×1080 (tablet portrait), 390×844 (phone), and short desktop windows (1100×640, 1100×460 — art shrinks, nothing scrolls or clips).

### Changed
- **The share card adapts to long album titles and long artist lists.** Title and artist each wrap onto up to 4 lines (was 3 and 2), and the text automatically steps down in size (title 56→27px, artist 37→21px) until it fits — an ellipsis only appears when even the smallest size can't hold it. King Gizzard's full 127-character "PetroDragonic Apocalypse…" title and five-artist credit lists now render complete on the card.

## [1.6.13] — 2026-07-07

### Changed
- **Now playing screen laid out to mirror Roon's spacing, and it no longer scrolls.** The tabs sit up top beside the corner buttons, the album art moves up directly beneath them and now sizes itself to the space available (bigger on tall phones, smaller on short ones — the whole screen always fits the viewport), and the track/artist/album block moves up under the art. A safeguard restores scrolling on very short desktop windows so the transport can never be clipped out of reach.
- **Bracketed details in the track title get their own line** — e.g. "Hangover Sex (with Viktoria Tolstoy)" renders as the title with "(with Viktoria Tolstoy)" beneath it, smaller and dimmer.
- **Corner buttons reworked on the Now playing screen:** the × is gone; **Share** now sits in its top-right spot, and a new **Home button** in the top-left closes the screen and lands on the Home screen. (Escape and the desktop backdrop still close it too. The album detail view keeps its × and Share unchanged.)

### Fixed
- Code-review findings fixed pre-commit: a no-scroll fallback for sub-480px-tall windows, the artwork's shadow no longer letterboxes off the art on narrow phones, an inert flex rule removed, a redundant state reset removed, and the track-title renderer skips DOM rebuilds on unchanged poll ticks.

## [1.6.12] — 2026-07-07

### Changed
- **Now playing screen reverted to the Roon-style look** (undoes v1.6.9's redesign of that screen only): the amber panel, its equaliser watermark, and the ambient glow on the Now playing tab are gone; the screen is again the clean full-bleed layout with the track title directly under the art. Everything else from recent builds is retained — the album view's blurred-cover backdrop, the Queue tab's tinted panel and glow, and the selectable track rows are all untouched (verified by the full headless regression suite).

## [1.6.11] — 2026-07-07

### Changed
- **Pitchfork written reviews are no longer displayed anywhere in the app (UK-law compliance).** Scores and Best New Music badges stay everywhere they appeared; in place of the review text the app now links to the review on pitchfork.com:
  - **Pitchfork magazine page** — a review's detail view keeps the cover, artist/title, score and BNM badge, shows a short notice, and leads its actions with **"Read on Pitchfork ↗"** (followed by Open in your library / Find on Qobuz / Find on Tidal as before).
  - **Album view "About this album"** — when the review source is Pitchfork, the panel shows no text but keeps the score/BNM in the title line and a **"Read the full review on Pitchfork"** link. Qobuz and Wikipedia editorial descriptions are unaffected and still display in full.
  - **Qobuz/Tidal browser review section** — same treatment; the source link now renders even when there is no displayable text (previously it hid with the text).
  - Enforced **server-side at every response boundary**: `/api/album/extras` emits no description for Pitchfork-sourced entries, and `/api/pitchfork/review` no longer serves (or even fetches) the review page at all — it returns only the local library match, since scores/BNM already ship with the listing items. An exhaustive audit traced every producer and consumer of review text to confirm no path remains; the search results, mosaic cards, Home rows, and share card never carried review text to begin with.
- Side benefits from the review of this change: opening a review's detail no longer performs a throttled full-page scrape of pitchfork.com (the "Read on Pitchfork" link and streaming actions now paint instantly, with the library-match button arriving right after), and the now-dead by-URL scraper and its cache were removed.

## [1.6.10] — 2026-07-07

### Added
- **Selectable tracks in the album view.** Tapping any track row expands it in place with two actions — **Play now** and **Queue** — for that single track (one row open at a time; tap again to collapse). Actions target the selected zone, work with genre/decade/tag/label filters active, and show the usual confirmation toast. Under the hood a new `/api/play-track` endpoint re-resolves the album by offset, finds the tapped track with the same filter the track listing uses (so indexes always align), verifies the track title before firing — if the library changed since the modal opened the tap is re-matched by title, and if the track is gone the app says so instead of playing the wrong thing — then drills into Roon's per-track action menu.
- The shared album drill-in was extracted into one helper used by both album-level and per-track actions (`loadAlbumSession` + `drillActionMenu`), byte-equivalent to the previous behaviour for every existing play path (verified against the old code in review).

### Fixed
- Code-review findings, all fixed pre-commit: the per-track action buttons reuse the standard `.action-btn` recipe at a proper 38px tap target (the first draft's pills were ~31px, below the app's own touch norm); the track-drill response is now sanity-checked so a non-list reply errors instead of reporting false success; the track index is validated as an integer; and `fetchAlbumDetail` now bails if the modal moved to a different album while the response was in flight — previously a cosmetic race, but with live tap handlers on the rows it could have fired a track action against the wrong album.

## [1.6.9] — 2026-07-07

### Changed
- **Album view — the cover now visibly glows under the art.** The ambient backdrop introduced in v1.6.6 was a heavy 48px blur that read as a colour wash; it is now a lighter 30px blur at slightly higher opacity and taller reach, so a faint but recognisable image of the album cover sits beneath the artwork, fading out down the panel. Tuned separately for dark and light themes.
- **Now playing screen — separated from Roon's look, now in the extension's own visual language.** The track title, artist, album link, progress bar and transport controls sit in a Home-style tinted rounded panel (the amber tint — completing all four Home tints inside the modal) with a new cut-off equaliser-bars watermark. The ambient cover glow now shows on the Now playing tab too (previously it was deliberately suppressed there to preserve the Roon-style look). The device and volume controls stay outside the panel so their pop-up menus are never clipped by the panel's watermark cropping. No JS changes — the live transport wiring is untouched.

### Fixed
- **Code-review finding (hover regression)** — the new panel-scoped translucent hover fill out-ranked the play/pause button's solid hover fill, which would have left its icon nearly invisible on desktop hover. The rule now excludes the play/pause button (`:not(.np-playpause)`), and the retired base hover rule that all three transport buttons no longer reach was removed rather than shadowed. Error class: a broad descendant rule silently out-ranking a sibling component's state style — caught by the simplification/removed-behaviour review angles before commit.

## [1.6.8] — 2026-07-07

### Fixed
- **Settings "Check for updates" said "tap Update below" — but there was no button.** The real Update button lives in the in-page update banner, which (a) sits *behind* the full-screen Settings sheet, (b) isn't re-checked when you tap the Settings button (it refreshes on a 15-minute timer), and (c) stays hidden for the session if you ever dismissed it with "Later" — so the promised button was invisible or absent. Now the Settings button itself becomes the action: after a check finds an update it turns into an accent-highlighted **"Update to vX"** (or "Roll back to vX") button with the release notes shown beneath; tapping it closes Settings and installs through the existing banner, whose download/unpack/restart progress is then visible. Error class: UI copy referencing a control in a different component without verifying it is reachable — the fix reuses the banner's single apply/progress implementation rather than duplicating it.
- **Code-review finding (stranded button)** — the first draft left the Settings button disabled at "Updating…" with no reset path, so if the install failed the button was dead for the session. It now resets to "Check for updates" at hand-off; the banner owns all progress, error, and retry state.

## [1.6.7] — 2026-07-06

### Changed
- **Queue tab refresh — the Now-playing Queue screen now speaks the same Home visual language as the album view.**
  - The whole Queue pane (track count summary + list) sits in a Home-style tinted rounded panel — the Not-played blue-grey — with a new cut-off "play queue" watermark motif (stacked list bars + play triangle), sharing the exact panel/watermark CSS recipe with the Home sections and the v1.6.6 album-view panels.
  - The ambient blurred-cover glow is enabled on the Queue tab (it stays off on the Now playing tab, which keeps its clean Roon-style look): the playing album softly tints the area behind the tab chips. The transport poll keeps the glow (and the big art) in sync when playback crosses an album boundary — via a small bridge between the modal and transport code, since they live in separate closures.
  - Queue rows use the same translucent hairline separators as the album view's Tracks panel (now a shared `--panel-hairline` variable so the two lists can't drift apart), with the now-playing row highlight, divider, and tap-to-play behaviour unchanged.

### Fixed
- **Code-review finding (unreachable sync)** — the first draft put the glow-sync call inside the now-playing screen updater, which early-returns unless the *Now playing* tab is active; the glow would have gone stale on the exact tab where it is visible. The art/ambient update now runs before that gate whenever the np-mode modal is open, and the fix is verified end-to-end headlessly (album change while sitting on the Queue tab updates both). Error class: new code placed behind a pre-existing guard that excludes the state it serves — caught by two independent review angles before commit.
- **Code-review finding (:active flash lost)** — the Queue tab's new id-scoped `:hover` background out-ranked the base `:active` accent flash on tappable rows during a press; the accent flash is restated at higher specificity so tap feedback is preserved in both themes.

## [1.6.6] — 2026-07-06

### Changed
- **Album detail refresh — the album view now speaks the Home screen's visual language.**
  - **Ambient cover glow** — the album's own artwork, heavily blurred and faded, washes the top of the detail panel so every album subtly tints its own view (dark and light theme tuned separately; decorative only — never intercepts taps, hidden when the album has no art, and reuses the exact same image URL as the cover so no extra download happens).
  - **Home-style panels** — the Tracks list and "About this album" sections now sit in the same softly-tinted rounded panels as the Home rows, complete with the cut-off corner watermark treatment: the vinyl-record motif (shared with Home's Random albums row) on Tracks, and a new oversized quotation-marks motif on the review panel. Watermarks run fainter than Home's because these panels carry dense text.
  - **Softer track rows** — translucent hairline separators replace the solid border colour, which fought the tinted background; the list's framing top border is gone since the panel itself now frames it.
  - The Now playing screen (transport-bar view) and Queue tab are deliberately untouched.
- **Shared panel infrastructure** — the modal panels reuse the Home sections' CSS rules (shell, watermark placement, theme flip, vinyl mask) rather than duplicating them, so future tweaks to the Home panel recipe automatically stay in sync with the album view. (Code-review finding: an earlier draft duplicated the ~500-char SVG mask data-URI and the placement block verbatim.)

### Fixed
- **Code-review finding (stacking context)** — an early draft gave the modal's scrolling body `z-index: 1`, which would have trapped the now-playing device/volume popovers *below* the pinned close/share buttons on short viewports. The body is now positioned without a z-index (paints above the glow by DOM order, creates no stacking context), preserving the popovers' original paint order. Error class: CSS stacking-context introduced on a shared container — caught by the cross-file tracer angle before commit.

## [1.6.5] — 2026-07-06

### Fixed
- **Clean `docker build` — the npm install warnings and both audit vulnerabilities are gone.**
  - **`2 vulnerabilities (1 moderate, 1 high)`** — both were ASF-parser infinite-loop advisories in `music-metadata@7` and its bundled `file-type` (GHSA-v6c2-xwv6-8xf7, GHSA-5v7r-6r5c-r473), used by the file-tag label scan. Upgraded to `music-metadata@11.13.0`; the scan already loaded it via dynamic `import()` with a shape-tolerant shim (and already handled v11's object-style comment tags), so the parsing code needed no changes — verified against every tag field the scan reads (label, organization, album, albumartist, year/dates, Bandcamp comment URLs). `npm audit`: **0 vulnerabilities**.
  - **`npm warn deprecated node-uuid@1.4.8`** — pulled in by Roon's own `node-roon-api`, which uses it only for `uuid.v4()`. An npm override now substitutes the maintained `uuid@11` (a drop-in for that call), so the deprecated package isn't installed at all; verified the Roon discovery layer (sood.js) boots and generates ids through the alias.
  - **`npm warn deprecated prebuild-install`** — comes from `better-sqlite3`, and even its newest release still depends on it, so it can't be fixed by upgrading. The Dockerfile's install now runs `--loglevel=error` (with `--omit=dev --no-audit --no-fund` and the update-notifier off), so the unavoidable warning — plus the audit/funding/new-npm-version chatter — no longer clutters the build output, while real errors still print.

## [1.6.4] — 2026-07-06

### Added
- **Global search** — the Home search box now searches everything, not just the Roon library. Below the instant library results (Artists / Labels / Albums), three new sections appear as they load: **Qobuz** and **Tidal** catalogue matches (only when that service is connected; tapping a result opens that service's browser pre-seeded with a search for the album, ready to favourite), and **Pitchfork reviews** (matches from the review lists, with score/BNM chip; tapping one jumps straight to the full review). External sources ride a longer debounce than the local search (600ms — they're rate-limit-sensitive network calls), are each failure-tolerant (a blocked or disconnected source simply contributes no section), share one 10s deadline so a slow source can't stall the response, and can surface matches even when the library has none.
- New endpoint `GET /api/search/external` (no Roon required); Pitchfork review-list builds now dedupe concurrent callers (a search racing the Pitchfork page opening no longer scrapes twice), and repeated failed Qobuz re-logins from stale saved credentials are deduped + backed off for 60s instead of retrying on every search (an explicit Settings save is never blocked).

### Fixed
- **Pitchfork page × now sits top-right on the title row**, matching the Qobuz/Tidal browsers — it previously wrapped below the title (the v1.5.100 title-row rule was scoped to only those two overlays).
- From the pre-commit review of this feature: opening an artist from an album modal mid-search no longer lets late-arriving external results append under the artist view; a library search failure can no longer mix the previous query's results with the new query's external sections, and external arrivals no longer wipe the Roon-disconnect/error banner (only the "No matches" one); external sections now survive a slower-than-external library response; external cover art gets a clean placeholder on a dead URL; and an empty Pitchfork tab response is no longer pinned for the session (retries next visit, matching the backend rule).

## [1.6.3] — 2026-07-05

### Fixed (found by a 3-agent, 8-angle review of the v1.6.2 parser/mosaic changes)
- **Both Pitchfork tabs were rendering oldest-first.** The state-walk's traversal order is the reverse of the page's display order (verified against the live pages: 95/95 and 29/29 pairs ascending), so month-old reviews appeared at the top. Listings are now sorted newest-first by pubDate; verified end-to-end through the real route against the captured live pages (Latest topped by its newest review, Best New Music topped by Pitchfork's current Best New Album).
- **The Latest tab's RSS fallback never ran on the most likely failure** — a network error/403 from the listing page threw before the fallback was reached (only an *unparseable* page fell back). A blocked listing now falls back to RSS, and only when both sources are down does the page show "couldn't load" (all three paths covered by tests).
- **Old-Safari (≤14) covers rendered as blank tiles** — the cover image used the `inset` shorthand, which that Safari doesn't support, exactly the `aspect-ratio`/`inset` fallback class documented in v1.5.99. Converted to longhand `top/left` (also on the ♪ fallback glyph).
- **Card-title legibility**: the gradient scrim under the overlaid album/artist text was near-transparent where the first title line sits on small tiles; strengthened plus a subtle text shadow, so titles stay readable on light covers.
- Hardened the title extraction (an empty-after-stripping `dangerousHed` now consults the `source.hed` fallback; non-string fields can no longer render as "[object Object]"), removed a redundant entity-decode pass (and a decode-before-strip order bug in the RSS parser), dropped the unused `blurb` payload field, and rewrote the stale "two data paths, merged" architecture comment to describe the current single-source-plus-fallback design.

## [1.6.2] — 2026-07-05

### Fixed
- **Best New Music tab now populates, and Latest reviews now show their scores.** The listing-page parser was matching against a guessed JSON shape and finding nothing (so Best New Music was empty and Latest had no score badges). Rewritten against the real Pitchfork page structure — each review item is read from `contentType:"review"` objects (`dangerousHed` title, `subHed.name` artist, `ratingValue.score`/`isBestNewMusic`, square `image.sources` covers) — verified against the live pages (96 latest / 30 best, every item with score, cover and artist).
- Because the listing now reliably carries square cover art + all fields, it's the primary source for both tabs; the RSS feed is kept only as a Latest-tab fallback if the listing shape ever changes again. This removes the earlier RSS↔listing URL-join entirely.

### Changed
- **Deliberate "woven" mosaic layout** — the tiles now alternate one large square with two small squares stacked beside it, the large one switching sides row to row, for a magazine feel. Album/artist sit in a gradient overlay on each cover, and every tile is force-squared (an absolutely-positioned cover) so an off-square source image can no longer make tiles uneven — the accidental little/large sizing in the first build.

## [1.6.1] — 2026-07-05

### Added
- **Pitchfork page** — a new full-page, magazine-style browser reached from the side menu (**≡ → Pitchfork**). Two tabs: **Latest Reviews** and **Best New Music**, shown as a responsive grid of cover-art cards with the Pitchfork score overlaid and a Best New Music badge. Tap a card to open a detail view with the full review, then act on it:
  - **▶ Open in your library** — appears when the album is matched in your Roon library; opens the existing album modal (play/queue from there).
  - **Find on Qobuz / Find on Tidal** — jumps to that streaming browser pre-seeded with a search for the album (Tidal shown only when connected), so you can favourite it (which is what makes it appear in Roon).
  - **View on Pitchfork** — opens the original review.
  - Data comes from Pitchfork's public RSS album-reviews feed (reliable cover art) enriched by the review-listing pages for the score, Best-New-Music flag and artist name; cached ~6h (Pitchfork publishes only a few reviews a day). No API key. The single-review scraper that already powered the album modal's editorial review is reused, and the review-body extraction is now a shared helper so the two paths can't drift apart. The magazine is theme-aware and the page's back button (and Android/browser Back) behaves naturally.

### Fixed (found by the 8-angle pre-commit review of this feature)
- Switching tabs while reading a review could leave a phantom navigation entry (Back landed on the wrong list); the tab chips are now hidden inside a review, so you return to the list first.
- The "Find on Qobuz/Tidal" hand-off now waits for the Pitchfork overlay to actually close before opening the streaming browser, instead of relying on a timer — fixes a potential race (notably on iOS Safari) that could make the streaming overlay immediately close itself.
- A transient Pitchfork block/timeout is no longer cached: a failed review body, and an unparseable listing page, both retry on the next visit instead of being stuck for the 6h cache window.
- The RSS↔listing merge now joins on a trailing-slash-normalized URL so scores/Best-New-Music/artist reliably attach to the Latest cards.
- Guarded a punctuation-only album title from false-matching a library album; added the missing cover-art fallback to the review detail head; and made the review listing survive a Roon-disconnect / block with an honest "couldn't load" state rather than an empty page.

## [1.6.0] — 2026-07-04

### Fixed (found by an 8-angle multi-agent review of the v1.5.101–116 Home redesign)
- **A genre/tag filter no longer gets silently wiped on reload.** `bootstrap()` always landed on unfiltered Home after pairing, and `showHome()` unconditionally cleared any filter restored from `localStorage` — so reopening the app after filtering to a genre always dropped back to unfiltered Home and deleted the saved filter. A restored filter now re-opens the filtered wall instead.
- **"Browse by genre" could get stuck empty for the rest of the session** after a single transient load failure — the "loaded once" flag was set before the fetch resolved, unlike the sibling "Label of the week" row, which already retried correctly. It now only marks itself loaded once genres actually render, so a cold-cache or network blip on the first Home visit no longer permanently disables the section.
- **Roon Core disconnecting mid-session showed misleading empty states on Home** ("Nothing here yet", "No albums.", "Couldn't load genres.") instead of a "Waiting for Roon Core" message — four of the five Home data loaders never checked for the 503 "not paired" response the way the older wall loader always has. All four now show the same Roon-disconnected message.
- **Opening a second artist view after an improper exit could restore corrupted content.** `artistViewActive` and its DOM snapshot were never cleared by `showHome()`/`showWall()` (unlike the equivalent `labelsActive` flag), so leaving an artist view via the shared Back button left it stuck active; a second artist view opened afterward would restore the first view's stale snapshot on exit instead of Home. `showHome()`/`showWall()` now exit the artist view the same way they already exit the Labels browser.
- **The artist view never synced the shared top bar**, so depending on where you opened it from, either a second empty back affordance or none at all sat next to its own "← Back" button. It now hides the shared Back/Refresh/Search on entry and restores whatever the previous screen had on exit.
- **A resize (iOS Safari's URL bar collapsing, iPad split-view) could silently replace an active search or the "Not played" full grid with the random wall** — the resize handler only excluded the Labels browser. It now also skips Home, an active search, and the unplayed-wall view.
- **A search query left visible when the user detoured through Labels** — leaving Home for the Labels browser and returning didn't clear the search box, so a stale query reappeared even though its results had already been discarded. `showHome()`, `showLabelsList()`, and `showLabelAlbums()` now clear search state the same way the wall view already does.
- **Search result-count/progress text ("3 albums, 1 label", "Building index… NN%") was permanently invisible** on Home's relocated search box — a leftover `search-status-hidden` class unconditionally hid it regardless of content.
- **The "Random albums" row re-fetched ~30 albums with fully sequential Roon round-trips on every single Home visit** (menu → Home, or the Back button), not just once on first load as before the Home redesign — a visible delay on every revisit. The album loads are now batched (8 at a time) instead of one-by-one.
- Tapping an artist name on an album opened from inside the Labels browser could leave the Labels-browser flag stuck active while viewing the artist; it's now cleared the same way the equivalent search result chip already does.

### Changed (reuse / simplification, same review)
- Deduplicated a hand-rolled cache, a SQL "played since" query, an FNV-1a hash loop, and an album-count regex that each existed in two places — now shared helpers (`makeTtlCache`, `getPlayedTitlesSince`, `fnv1aHash`, `parseAlbumCount`).
- Removed dead code left over from the Home redesign: an unused `sessionStorage` cache, the fully-unused `openSearch`/`closeSearch` functions and their inert `#search-toggle` button, a no-op `loadAlbumCount()`, and an unnecessary `typeof` guard.
- The four Home watermarks (clock/vinyl/tag/note) now each ship one SVG used as a CSS mask (with a `-webkit-mask-image` fallback) instead of two near-identical SVGs per motif for light/dark — the theme swap is now a color change, not a second image.
- Two silent `catch (e) {}` blocks now carry the explanatory comment this project's conventions require.

### Changed ("Play something unheard")
- **"Play something unheard" now considers an album unheard if it hasn't been played in the last 12 months** (previously: only albums with *zero* plays ever, all-time — a much stricter bar than the "6 months" it was assumed to use, and stricter than the README's description of a 30-day fallback, which was never actually implemented). A 12-month window naturally includes never-played albums too, and gives a much larger eligible pool on libraries with real listening history, so the plain-random fallback (used once the whole library has been heard recently) should trigger far less often. Applies to both the topbar button and its Apple Shortcuts twin (`/api/shortcut/play-unheard`); the two near-identical implementations were also merged into one shared `pickUnheardAlbum()`.
- **Reminder: "heard" is entirely self-tracked**, not sourced from Roon. This extension has no Roon API available to it that reports a library-wide last-played date — it only knows about a play if it was running and connected to Roon Core while that play happened (via `scrobbleUpdate`, which watches live zone transport state). Plays from before this extension was first installed, or during any downtime (container stopped, update in progress, etc.), are invisible to it. If Roon ever exposes real per-album/track last-played data through the extension API, that would let this feature (and "Not played in 6 months" on Home) work off Roon's own history instead.

## [1.5.116] — 2026-07-04

### Added
- **"Browse by genre" panel now has a music-note watermark** — solid-filled beamed eighth notes, matching the clock, vinyl and tag watermarks in size, rotation, opacity and top-left cut-off crop. All four Home sections now carry a themed watermark.

## [1.5.115] — 2026-07-04

### Added
- **"Label of the week" panel now has a tag watermark** — a solid price/luggage-tag silhouette (with its string hole), matching the clock and vinyl in size, rotation and top-left cut-off crop.

### Changed
- **All Home watermarks are now solid-filled silhouettes instead of thin outlines**, so they stand out more — the clock (Not played), vinyl record (Random albums) and tag (Label of the week). Slightly higher opacity too. Still clipped inside each coloured panel, theme-aware, behind the tiles, non-interactive.

## [1.5.114] — 2026-07-04

### Added
- **"Random albums" panel now has a vinyl-record watermark** — a line-art record (grooves, centre label, spindle hole, a shine glint) cropped at the panel's top-left corner, matching the clock's size, rotation, thickness and cut-off effect. Contained within the coloured section, theme-aware, behind the tiles, non-interactive. The two panels' watermarks now share one set of placement rules (only the artwork differs), ready for the remaining sections.

## [1.5.113] — 2026-07-04

### Changed
- **"Not played in 6 months" clock watermark is now contained within the coloured panel** — it no longer spills onto the page outside the section. The cut-off crop at the panel's top-left corner is kept (that's the effect you liked), but the art is clipped to the panel. The clock is also **bigger** and drawn with **slightly thicker lines**.

## [1.5.112] — 2026-07-04

### Changed
- **The "Not played in 6 months" clock watermark now has real artistic flair.** It's larger, tilted, and moved to the **start (top-left) of the bar**, where it deliberately spills **outside** the coloured panel onto the page — and it's a proper clock face with tick marks, hands, and sweeping motion arcs (time flying by). The spill is up-and-left only, so it never adds a horizontal scrollbar on any screen; the title stays fully legible above it; theme-aware and non-interactive as before.

## [1.5.111] — 2026-07-04

### Added
- **Faint themed artwork on the "Not played in 6 months" panel** — a subtle line-art clock watermark (time gone by) now sits behind that section's coloured panel, reflecting its theme. It's a self-contained inline SVG (no external requests), theme-aware (light art on the dark panel, dark art on the light panel), clipped to the rounded panel, and sits behind the tiles at very low opacity so it never obscures album art or intercepts taps. First of the coloured sections to get themed art.

## [1.5.110] — 2026-07-04

### Fixed
- **Tapping an artist in Search now shows that artist's albums again** (their own albums plus "Also appears on"), instead of falling back to the Home sections. Regression from the Home-landing redesign: the search artist-chip clears and hides the results grid before opening the artist view, but the artist view rendered its albums into that still-hidden grid while the Home rows showed through. The artist view now reveals the grid and hides the Home view, and its "← Back" button restores exactly the screen you came from (the Home landing, or the album wall you were browsing).

## [1.5.109] — 2026-07-03

### Fixed
- **"Label of the week" now shows as a single-row carousel on every screen** (phone, landscape tablet, desktop). On desktop it was wrongly wrapping to 3 rows and leaving a large empty area; it's now one horizontal row that scrolls, like the other rows.
- **"Not played in 6 months" and "Random albums" rows are centred** in their panels when the albums don't fill the full width, instead of hugging the left edge (`justify-content: safe center` — still left-aligns and scrolls when the row overflows, so nothing is clipped).

## [1.5.108] — 2026-07-03

### Fixed
- **Rock/Metal no longer pulls in soft-rock, singer-songwriter and pop albums** (Carole King – Tapestry, James Taylor, Madonna, Duran Duran, Bryan Ferry, Ultravox). The old rule keyed on the word "rock", which appears in soft/pop styles ("Soft Rock", "Contemporary Pop/Rock", "Adult Alternative Pop/Rock", "Folk-Rock"), so those leaked in. The classifier now: (1) skips the generic "Pop/Rock" catch-all; (2) routes anything with the literal word "pop" to Pop; (3) excludes soft styles with no "pop" (Soft Rock, Folk-Rock, Adult Contemporary, Singer/Songwriter, Easy Listening, New Age); (4) sends only genuinely hard, guitar-driven styles (metal, hard/album/arena/classic/garage rock, punk, grunge, prog, psychedelic, shoegaze, indie rock, britpop, goth, industrial, ska, rap-rock…) to Rock/Metal; (5) sends remaining pop-family styles (Dance, Disco, Synth, New Wave, Soul, R&B, Funk, Motown) to Pop.

### Added
- **"Not played in 6 months" title is now a button** — tap the section header to open a full-screen grid of albums you haven't played in 6 months (up to 96), with a Back button to Home.

### Changed
- **Desktop: "Not played in 6 months" and "Random albums" now fill the width** — 2 rows on desktop (was 3 short, half-empty rows) so wide screens show more albums per row. Phones/tablets unchanged. The Home "Random albums" row now fetches 30 albums (was 24).
- **"Label of the week" carousel is taller** — 1 row on phones, 2 on tablets, 3 on desktops — and now features labels with at least 6 albums (was 3) so the row fills out.
- **Each Home section has its own tinted panel** — grey (not played), teal (random), violet (label of the week), amber (browse by genre) — muted in dark mode, pastel in light mode, so the sections read as distinct blocks.

## [1.5.107] — 2026-07-03

### Added
- **"Random albums" on the Home screen** — the random-albums shuffle (previously only in the side menu) now also appears as a Home carousel of 24 random albums, refreshed on every Home visit so it's always freshly random. Tapping the **Random albums ›** header opens the full random wall. Reuses the existing `/api/random-albums` endpoint (no new backend).
- **"Label of the week" on the Home screen** — one record label is featured for the whole ISO week (Mon–Sun), chosen deterministically so it's stable all week and rotates every Monday. Shows a carousel of that label's albums; tapping the **Label of the week: … ›** header opens the full label view. New endpoint `GET /api/home/label-of-the-week` (labels with ≥ 3 albums, deterministic per-week pick, cached ~1h). The section stays hidden until the background labels scan has produced a qualifying label, then retries each visit until it populates.
- Both new sections reuse the responsive `.home-carousel` layout: single row on phones, 2 rows on landscape tablets, 3 rows on desktops.

### Changed
- **Better separation of Rock/Metal from Pop in "Browse by genre"** — the old rule ("any Pop/Rock sub-genre without 'pop' in its name → Rock/Metal") swept in indie-pop, singer/songwriter and adult-contemporary styles. The classifier now uses curated allow-lists: rock/metal sub-genres (metal, punk, grunge, prog, shoegaze, indie rock, …) go to **Rock/Metal**, pop sub-genres go to **Pop**, and unrelated styles (Singer/Songwriter, Adult Contemporary, Easy Listening, …) are excluded rather than dumped into Rock/Metal.
- **"Browse by genre" now shows an even 12 buttons** so the grid rows are balanced on every screen. Rock/Metal and Pop are guaranteed slots; the rest are the library's biggest genres. Column counts adjusted (2 / 3 / 4 / 6) so 12 buttons always fill full rows with no lone trailing card.

## [1.5.106] — 2026-07-03

### Changed
- **"Browse by genre": the Pop/Rock parent is split into "Rock/Metal" and "Pop" buttons.** Roon files rock, metal, punk, indie, etc. as sub-genres under a single "Pop/Rock" parent. The Home genre buttons now split it: sub-genres whose name contains "pop" form the **Pop** button, everything else forms the **Rock/Metal** button. Tapping a button picks a random sub-genre from that group (weighted by album count) and shows its albums; the top-bar breadcrumb shows the group name. This replaces the earlier R&B→Metal swap (Metal is a Pop/Rock sub-genre, now reachable via Rock/Metal).
- **Nested genre filter** — the genre filter now supports a parent (`filter_parent`), so a sub-genre nested under a parent genre resolves correctly across browse, album detail, and play. New endpoint `GET /api/home/genre-groups` enumerates and classifies the Pop/Rock sub-genres (cached 30 min).

## [1.5.105] — 2026-07-03 — Home redesign (phase 2 fixes)

### Fixed
- **"Album not found at offset …" when opening a Home tile after viewing a genre** — and the related **genre name lingering in the top bar back on Home**. Both had the same cause: the active genre filter wasn't cleared when returning to Home, so Home's full-library album offsets were resolved against the (smaller) genre-filtered list and fell out of range. Returning to Home now clears the filter (and its breadcrumb), and Home tiles always open unfiltered regardless of any active filter.

### Changed
- **Search box moved into the top bar**, beside the hamburger (both visible), on the Home screen — instead of sitting in the Home content.
- **"Browse by genre": R&B replaced with Metal** — the R&B card is swapped for the library's Metal genre (or dropped if there's no Metal genre).

### Added
- **Album of the day** — one completely random album shown first in the "Not played in 6 months" row, chosen fresh each day (stable through the day). On iPad/desktop it appears once, top-left. Once you've played it, it disappears until tomorrow's pick. New endpoint `GET /api/home/album-of-the-day`.

## [1.5.104] — 2026-07-03 — Home redesign (phase 2)

### Changed
- **Album counts removed from every screen** — the topbar breadcrumb now shows just the genre/label name (no "N albums"), the labels list header shows "Labels" (no count), and the library-total line was removed from Settings.
- **Search moved to the top of the Home screen** — a permanent search box sits above the Home sections instead of living in the side menu. Typing shows results in place of the sections (the box stays put); clearing returns to the sections. The Search item was removed from the side menu.
- **Play Now no longer closes the album view** — playing (Play Now / Shuffle / Radio) from an album's detail page keeps the page open so you stay on the album.
- **"Not played in 6 months" fills more of the screen on bigger displays** — single row on phones, **2 rows on landscape tablets**, **3 rows on desktops** (horizontally scrollable), and the section now fetches enough albums to fill them.
- **"Not played in 6 months" stands out with a coloured panel** — a pale grey panel in dark mode, a soft blue panel in light mode.

### Added
- **Back-to-Home button** in the top bar, shown on every screen you navigate to from Home (random wall, genre grid, labels).
- **Refresh (shuffle) button** in the top bar, shown on the random-album and genre grid screens — reshuffles the current grid (keeps the active genre).

### Dev
- Added `scratchpad/smoke.js` runs to pre-flight — a DOM-stub harness that executes the app's top-level IIFEs and fails on any startup throw (the v1.5.103 crash class).

## [1.5.103] — 2026-07-03

### Fixed
- **Blank screen on load (startup crash).** `let albumCount = computeAlbumCount()` runs during the app's initialisation, but `computeAlbumCount` references the `const PHONE_WALL` that was declared *after* it — a temporal dead zone. On phones this threw `ReferenceError: Cannot access 'PHONE_WALL' before initialization`, which aborted the whole app IIFE, so nothing rendered (blank page, not even the "Waiting for Roon" banner). Moved the `PHONE_WALL` declaration above its first use. (Latent since v1.5.101; exposed once the Home view depended on the same init path completing.)
- **Error class:** the v1.5.66 "declaration-after-use temporal-dead-zone" startup-crash class. `node --check` can't catch it (it's valid syntax), and there's no browser in the build environment to run the load-time check. Added a DOM-stub smoke harness (`scratchpad/smoke.js`) that executes the app's top-level IIFEs under a stubbed `window`/`document` and fails on any synchronous startup throw — it reproduces this exact error on the broken build and passes on the fix.

## [1.5.102] — 2026-07-03

### Added — Home redesign (phase 1)
- **Home landing page with sections.** The app now opens on a Home view instead of the raw album wall:
  - **"Not played in 6 months"** — a horizontal carousel of albums with no play in the last 6 months (backed by the play history), reusing the standard album tile → detail modal (all metadata retained). New endpoint `GET /api/home/unplayed?months=6&count=N`.
  - **"Browse by genre"** — the top 10 library genres (biggest first) as cards; tapping one opens that genre in the album wall at the device-appropriate grid size. Reuses the existing genre filter and `/api/filters/genres`.
- **Pop-out side menu (hamburger).** A drawer slides in from the left. **All former top-bar buttons now live in the menu as icon + label** — Filter, Labels, Qobuz, Tidal (shown only when connected), Play something unheard, Search, Settings — plus **Home** and **Random albums**. The top bar now shows just the hamburger, decluttering it. Menu items trigger the original controls (unchanged behavior); backdrop tap and Escape close the drawer.
- The album wall is reached from the menu ("Random albums") or by tapping a genre/filter; it loads lazily on first entry and keeps the v1.5.101 phone-fit sizing.

### Notes
- This is phase 1 of the redesign. Still to come: separate Qobuz/Tidal "new releases in the last 30 days" carousels (excluding albums already in your library), and a Pitchfork magazine area.

## [1.5.101] — 2026-07-02

### Changed
- **Phone portrait wall now shows 4 rows, fitted to the screen without scrolling** — the wall targets 4 rows of 3 albums (12 total) and sizes the artwork to exactly fit the visible area. When the layout is width-limited the tiles stay at their natural full size; only when the viewport is short does the art shrink a little so all 4 rows still fit rather than overflowing into a scroll. Falls back to 3 rows on very short phones (art would otherwise get too small). Re-fits on viewport resize.
- **Slightly shorter mini transport bar** — trimmed vertical padding (13→10px) and phone button sizes, and reduced the reserved clearance below the wall (96→80px), giving the grid more room for the 4th row.

### Fixed
- **Wall row count under-filled on tall phones** — the previous measurement divided by `main.clientHeight` (which includes the padding reserved for the transport) and, on the very first call, ran before layout and fell back to a guess — so tall phones under-filled to 3 rows with dead space below. The new sizing measures the true content box (subtracting `main`'s padding) and derives the tile size that makes the target rows fit, so the outcome no longer depends on call timing.
- **Error class:** measurement-vs-layout mismatch (dividing by a height that included reserved padding, plus a pre-layout first call). Resolved by measuring the real content box and solving for tile size instead of counting rows against an approximate height.

## [1.5.100] — 2026-07-02

### Changed
- **Bigger top-bar buttons on phones** — the persistent "N albums" count has been removed from the top bar (it crowded the controls and forced tiny 34px buttons). The buttons now grow to 40px on typical phones, sized down in tiers (37px / 33px) only on narrower widths so all controls still fit one row without overflow down to 320px. The library album total moved to the Settings sheet ("N albums in the library"). The top-bar readout is kept only for transient context — the active filter value and the labels-browser breadcrumb — and is hidden on the plain wall.
- **Qobuz/Tidal overlay close button on the title row** — the × now sits top-right on the same line as the "Qobuz"/"Tidal" heading instead of wrapping onto its own line below it. Scoped to those two overlays; the Settings and Filter sheets are unchanged.

## [1.5.99] — 2026-07-02

### Fixed
- **Old iPad (Safari < 15) rendered a broken wall grid** — ragged, unequal columns with tile text colliding between neighbours. Root cause: `aspect-ratio: 1/1` (the rule keeping covers square) is ignored by Safari before 15, so each cover's intrinsic image size inflated/deflated its grid track. Fixed with the classic padding-top square fallback + absolutely positioned artwork inside `@supports not (aspect-ratio: 1/1)` — old Safari gets uniform square tiles back (wall, label tiles, and album-modal art); modern browsers are untouched. Also converted all `inset: 0` shorthands (unsupported < Safari 14.1) to longhands — this was silently breaking the album modal and other overlay backdrops on the same devices.
- **Phone wall always rendered exactly 9 albums, leaving a dead bottom third on tall phones** — `computeAlbumCount()` hardcoded `return 9` for any phone. It now measures the real grid area and fills as many 3-column rows as fit (e.g. 12 albums on a Pro-class iPhone), min 9, capped at the server's 96.
- **Phone title/artist sizing rules were dead CSS** — the phone typography block sat *before* the base rules with equal specificity, so source order made phones silently render the desktop 14px sizes. Moved after the base rules (and the 2-line title clamp now also applies below 360px viewport width).
- **Error class:** the iPad bug was *modern-CSS-without-fallback* (aspect-ratio, inset) — fixed with `@supports`-gated fallbacks and longhands; the dead phone CSS was an *equal-specificity source-order* trap — documented in place so the block isn't moved again.

### Changed
- **Compact top bar on narrow phones (≤ 479px)** — the nine controls shrink to 34px with tighter gaps so the album count no longer truncates to "8,07…".
- **Denser phone wall** — tighter grid gutters (12×8px) and a slimmer tile text block (12px 2-line titles, 10.5px artist) so more music fits each screenful.

## [1.5.98] — 2026-07-02

### Changed
- **Qobuz top-bar button now shows the Qobuz "Q" logomark** (open ring, centre dot, diagonal tail — line-style mark from Arcticons, CC BY 4.0) instead of the generic music-note icon, matching the Tidal button's branded diamond mark. Rendered at the same stroke weight as the neighbouring icons (48-unit viewBox with a proportionally scaled 3.6 stroke).

## [1.5.97] — 2026-07-02

### Added
- **Tidal browser with full Qobuz feature parity** — a second streaming-service browser alongside Qobuz:
  - Catalog search (debounced live search, paged 50 at a time, artist matches strip), artist discographies, and browse tabs (New Releases, Top Albums, Rising, Recommended).
  - Favourite toggle (♥ ⇄ ✓ Added) on every album — adding to your Tidal favourites is what makes an album appear in Roon — plus the tap-for-detail review view.
  - **Separate top-bar button** with the Tidal diamond mark, shown **only while a Tidal account is connected**; the Qobuz button is unchanged.
  - **Login via Tidal's OAuth device flow** (Settings → Tidal account → Connect): the extension shows a code and a link to Tidal's own authorization page — your password is never entered into the extension; only tokens are stored. Access tokens are refreshed silently server-side.
  - Uses the unofficial Tidal API with the Lyrion/LMS Tidal plugin's client credentials — browse/search/favourites only, **no streaming and no downloading** (Roon streams); against Tidal's ToS and may break at any time, same caveats as the Qobuz integration.
  - New: `lib/tidal.js`; routes `/api/tidal/{new-releases,featured,search,artist-albums,favorite,unfavorite}` and `/api/settings/tidal{,/start,/status,/disconnect}` — browse responses share the exact shape of their Qobuz counterparts.
- **Service-generic frontend browser** — the Qobuz overlay code was refactored into a single `initServiceBrowser(config)` factory that now drives both the Qobuz and Tidal overlays (one implementation, two instances; Qobuz behaviour byte-identical, verified by a dedicated regression review). The backend favourite-ids cache (60 s, in-flight dedup, stale ceiling) and featured-list cache (10 min) were likewise generalized into shared factories used by both services.

### Fixed (found by the multi-agent pre-commit review of this feature)
- **Device-flow robustness** — Tidal's schemeless authorization links are now prefixed with `https://` (a raw `link.tidal.com/XXXXX` href resolved relative to the extension and 404'd); RFC 8628 `slow_down` stretches the poll interval instead of killing the login; transient network blips during the server-side poll retry 3× instead of failing the login one-strike; concurrent Connect taps are generation-guarded so the shown code always matches the polled device code.
- **Token lifecycle** — access-token refreshes are single-flight (parallel route calls no longer race refresh-token rotation); a revoked/expired refresh token (`invalid_grant`) now degrades cleanly to "Not connected" (clearing the stored connection and hiding the top-bar button) instead of returning 502 forever; a disconnect racing an in-flight refresh can no longer silently re-connect the account.
- **Featured tabs resilience** — Tidal's `/featured` groups are matched by id, name, or path (exact, then prefix) and an unmatched group is no longer cached as empty for 10 minutes; the group-list response tolerates `items`/`rows`/bare-array shapes.
- **Settings truthfulness** — a login failure that happens while Settings is closed is now surfaced on reopen ("Not connected — last login attempt failed: …") instead of being silently swallowed; the transient error toast no longer gets clobbered by the status refresh.
- **Error class:** most fixes are *optimistic single-shot handling of a multi-step external protocol* — treating recoverable OAuth poll states (slow_down, network blips, races) as terminal. Resolved by classifying outcomes (structured OAuth error = terminal, everything else = retryable) and guarding every await-gap against supersession.

## [1.5.96] — 2026-07-02

### Fixed
- **"Play on" zone list rows overlapped with many zones (user report, 18 zones)** — `.np-device-list` is a flex column capped at 240px with `overflow-y: auto`, but the zone rows kept their default `flex-shrink: 1`, so instead of overflowing into the scrollbar they were compressed below their text height (18 rows ≈ 718px squeezed into 240px → ~11px boxes under 18px text). Rows now have `flex-shrink: 0`, restoring natural height and scrolling; the list cap was also raised to `min(48vh, 320px)` so tall screens show more zones at once. Applies to both the mini-transport and now-playing zone pickers (shared class); verified no ancestor clips the taller popover on small phones.
- **Error class:** flex children inside a max-height scroll container shrink before the container scrolls — the scrollbar never appears because the compressed content technically "fits". Other capped lists were audited: none share the pattern (block layouts or uncapped sheets).

## [1.5.95] — 2026-07-02

### Fixed
- **Qobuz sheet "ducked" out of view while typing a search** — the overlay reused the settings bottom-sheet styles, whose height is content-driven (`max-height: 86vh`, bottom-anchored). Every search render cleared the list before fetching, so the sheet collapsed to a sliver while the request was in flight, then re-expanded when results arrived. The Qobuz overlay is now full screen with a fixed, viewport-driven height (`100dvh`, `100vh` fallback, safe-area aware) so the frame never moves, and list content is cleared only when a fetch outcome (results, empty, or error) is ready — previous rows stay visible under the "Searching…" status.
- **Error class:** content-driven container height + clear-before-fetch — two independently reasonable pieces (a collapsible bottom sheet, an eager list reset) composing into a layout jump. Fixed at both altitudes: fixed-height frame and deferred clearing.

### Changed
- **Qobuz overlay is persistent until closed manually** — grip, title/close, search box, and tab chips are pinned to the top of the sheet while the list scrolls beneath. Escape while typing now clears the search text (like the × button) instead of navigating; a second Escape blurs the input; only with the input unfocused does Escape step back/close. Typing can never dismiss the overlay.
- Stale chrome from an outgoing view (artist "‹ Back" header, "Load more") is hidden the moment a new view's request starts, so it can't act on the view being replaced; opening a detail from a still-loading list self-heals by refetching on back; closing the overlay orphans any in-flight request so late responses can't repopulate it.

## [1.5.94] — 2026-07-02

### Added
- **Full Qobuz catalog access** — the Qobuz overlay is now a complete browser, not just New Releases:
  - **Catalog search** — search the entire Qobuz catalogue (debounced live search, Enter for immediate), with album results paged 50 at a time via a Load more button and a strip of matching artists above the results.
  - **Artist discographies** — tap an artist match to browse every album Qobuz has for them, paged.
  - **Browse tabs** — New Releases, Best Sellers, Most Streamed, Press Awards, and Editor's Picks category chips.
  - Every album everywhere keeps the favourite toggle (♥ Favourite ⇄ ✓ Added) and the tap-for-detail review view, so anything found can be added to (or removed from) your Qobuz library — which is what makes it appear in Roon.
  - New endpoints: `GET /api/qobuz/search`, `GET /api/qobuz/artist-albums`, `GET /api/qobuz/featured`; new lib functions `searchCatalog`, `getArtist` (`catalog/search` / `artist/get` — unsigned endpoints, still no streaming and no app_secret). `/api/qobuz/new-releases` is unchanged.
- **Rate-limit protection** — the user's favourite ids are cached for 60 s and shared across all browse routes (with in-flight dedup and a 10-minute stale ceiling); featured lists are cached raw for 10 minutes per category, so tab-flapping doesn't hammer the unofficial API; upstream data + favourite ids are fetched in parallel per request.

### Fixed (found by the 8-angle pre-commit review of this feature)
- **History/back robustness** — the overlay's back navigation now reconciles its view stack against the depth stored in `history.state` instead of blindly popping once, so browser Forward presses and multi-step history jumps self-heal instead of corrupting navigation.
- **Search results survive artist detours** — opening an artist from search results snapshots the rendered list; pressing back restores it instantly (loaded pages, favourite-button state and all) with no refetch.
- **Load more correctness** — "more pages exist" is now computed server-side from the raw page length (`has_more`); the old client-side `filtered-count < total` math could leave a dead Load more button when Qobuz returned malformed items.
- **Artist discography paging order** — removed the server's per-page re-sort, which made release dates jump around at every Load more seam.
- **Pending search debounce cancelled on navigation** — a 450 ms search timer could previously fire after the user had opened an album detail and replace it with search results.
- **Escape while typing** — Escape in the search box now clears/dismisses the field instead of closing the whole overlay mid-edit.
- **Non-JSON error bodies** — gateway/maintenance HTML error pages now surface as "HTTP nnn" instead of a JSON parse error message (JSON is parsed defensively before the ok-check).
- **Misc UI states** — tab switches and back presses keep the search box, clear button, and tab chips in sync with the visible view; a too-short Enter press gives feedback; "no albums but artist matches" search results no longer show a contradictory "No results" line; generic not-connected copy for non-New-Releases views.
- **Error class:** the paging and status bugs were *contract mismatches between filtered and raw counts* across the client/server seam — resolved by moving the pagination decision to the side that sees the raw data. The history bug was *convention-maintained parallel state* (view stack vs history stack) — resolved by reconciling against the authoritative copy (`history.state`) instead of mirroring by discipline, the same class as the v1.5.93 share-card fix.

## [1.5.93] — 2026-07-01

### Fixed
- **Share card still showed a stale album on the now-playing screen's Queue tab** — this is the third fix for this bug class (see v1.5.89, v1.5.90). Root cause: `window.__currentNpData` was only reassigned inside `updateNpScreen()`, which bails out via `onNowPlayingScreen()` unless the modal's "Now playing" tab (not "Queue") is the active tab. So switching to the Queue tab while a track advanced left the share button reading the last track that was showing before the tab switch. Instead of adding a fourth sync point, removed the mirrored global entirely: the share button now calls `window.__getCurrentNp()`, a getter that reads `currentZone.now_playing` live at click time, so there is no cached value to go stale regardless of which modal tab is active.
- **Error class:** repeated "stale mirrored global" bug — a value copied into `window.*` by convention at one call site, read from a different call site, going out of sync whenever a new UI state (Queue tab) bypassed the sync point. Replaced the mirror with a read-time getter to make the whole class structurally impossible going forward.

## [1.5.92] — 2026-06-26

### Fixed
- **TypeError crash on `/api/album/extras`** — `bios` was declared `const` in a destructured `await Promise.all()` but then conditionally reassigned when `labelDiskCache` held a canonical label for the album. In Node.js strict mode this throws `TypeError: Assignment to constant variable`, returning a 500 for any album whose label had been scanned. Changed to `let`.
- **NaN score chip** — Pitchfork score guard used `!= null` which passes NaN through; `parseFloat` on a malformed JSON value can return NaN. Changed guard to `typeof score === "number" && !isNaN(score)`.
- **Silent catch comment** — malformed JSON-LD block catch in `fetchPitchfork` now explicitly notes why silence is safe (loop continues to the next script tag).

## [1.5.91] — 2026-06-25

### Added
- **Pitchfork reviews** — album detail modal now shows the Pitchfork editorial review and score when available. The score (e.g. 8.4) and a **BNM** badge for Best New Music are displayed alongside year and label. Pitchfork is preferred over Qobuz as the review source; Qobuz still provides label/year when Pitchfork has the review. Falls back silently for albums with no Pitchfork review (older albums or those not reviewed). Review body extracted from JSON-LD `reviewBody` field; score from `__PRELOADED_STATE__`.

## [1.5.90] — 2026-06-25

### Fixed
- **Share card shows previous album on now-playing screen (correct fix)** — the v1.5.89 attempt wrote to `currentAlbum`, a variable not declared in the mini-transport IIFE, causing a sloppy-mode scope leak with unreliable results. Root cause: `window.__currentAlbum` is only written by `openAlbum()` when the modal opens, so it never updates as tracks advance. Fix: `updateNpScreen()` now writes the live `now_playing` object to `window.__currentNpData` on every poll; the share button reads this when the modal is in NP mode, bypassing `window.__currentAlbum` entirely.

## [1.5.89] — 2026-06-25

### Fixed
- **Share card stale album on now-playing screen** — when the next album started playing, the share card still showed the previous album. `updateNpScreen()` was updating the display but not `window.__currentAlbum`, so the share button read the album that was playing when the modal first opened. Fixed by syncing `currentAlbum` / `window.__currentAlbum` whenever the album art key changes (the same point where the artwork is refreshed).

## [1.5.88] — 2026-06-25

### Fixed
- **Code review fixes (multi-angle review):**
  - Qobuz slug scorer: `minScore` now uses `Math.max(1, Math.min(titleCheck.length, 2))` — the previous `Math.min` alone produced `minScore = 0` for titles where all words are ≤3 chars (e.g. "Hi", "S/T"), allowing a zero-score slug through with no title verification. The `Math.max(1,...)` floor ensures at least one title token must match.
  - `fetchLabelFromBandcamp`: removed a redundant outer `try { ... } catch (e) { throw e; }` wrapper that caught and immediately rethrew without any transformation — dead code that contradicted the JSDoc contract and added misleading structure.
  - Silent catch comment in `fetchLabelFromBandcamp` now explains why silence is safe (`JSON.parse` failure on one JSON-LD block is safe because the while-loop continues to the next block).
  - Bandcamp pass partition: replaced two sequential `.filter()` traversals of `needsApiScan` with a single one-pass partition, halving `normalize()` calls during queue building.

## [1.5.87] — 2026-06-25

### Fixed
- **Qobuz link and label opens wrong album for compilations** — the Qobuz search result slug matcher used only the first significant title word (e.g. `"songs"`) to pick the best match, which was too loose for compilation albums by Various Artists: `"songs-of-peace-praise-various-artists"` matched just as well as `"songs-about-new-york-various-artists"`. The matcher now scores every candidate by how many title words (> 3 characters) appear in its slug and picks the highest scorer, so the correct album is selected. Short single-word titles fall back to the previous first-token check. This also fixes the wrong label appearing in the album modal when the Qobuz pass resolved the label from the incorrect album page.

## [1.5.86] — 2026-06-25

### Added
- **Bandcamp label lookup (Pass 0B)** — local libraries now get a dedicated Bandcamp metadata pass during the label scan. Bandcamp downloads embed the album page URL in the `COMMENT` tag of every file; the extension now extracts that URL during the file scan and fetches the album's JSON-LD to retrieve the label name and release year — no API key required. Self-released albums (where Bandcamp lists the artist as the label) are detected and forwarded to the standard API chain rather than creating spurious artist-named label tiles. The pass runs after file-tag resolution and before iTunes, so it resolves Bandcamp purchases before hitting external APIs. Serial with 1.5 s between requests; circuit breaker at 5 consecutive errors or any 429/403; 5-minute wall-clock cap per scan. Results are cached in SQLite so subsequent scans skip already-resolved albums. Inert for streaming-only (Qobuz/Tidal) setups that have no `/music` mount.

## [1.5.85] — 2026-06-23

### Added
- **"Label from folder depth" setting — fixes reissues fragmenting under their pressing label** — for local libraries filed in label folders, an album physically in (say) your Blue Note folder could be listed under the granular pressing label from its file tag (e.g. "EMI Finland", "ECM New Series"), because the file scan read each file's `label`/`organization` tag. A new opt-in setting takes the label from the folder at a chosen depth under your music root instead (e.g. `/music/Jazz/Blue Note Records/Album` → depth **2**), so reissues group under the parent label like they do in Roon. `0` = off (use the file tag, the default and prior behaviour). The depth is measured from the music root, so it's unaffected by disc subfolders. Saving a new value re-runs the label scan, and the file pass overrides any cached labels that differ. Only affects local libraries (requires the `/music` mount); inert for streaming-only setups.

## [1.5.84] — 2026-06-23

### Added
- **Decade focus in the filter button** — the filter sheet now has a "Decade" section alongside Genre and Tag. Pick a decade (e.g. 1990s) to narrow the random wall to albums released in that decade. Because Roon's browse API exposes no release year, the decade is matched against a per-album year the extension now collects — for free — during the existing label scan: from file tags (local libraries), the Qobuz pass (streaming), and MusicBrainz label hits (same response, no extra request), plus whenever an album modal is opened. Years are stored in a new `album_years` SQLite table.
  - **The Decade list populates gradually** and may be sparse at first: it only lists decades that already have albums with a resolved year, so it fills in as the label scan runs and as you browse. For streaming-only libraries especially, expect it to grow over the first scan rather than appear complete immediately.

## [1.5.83] — 2026-06-23

### Fixed
- **Back from a Qobuz album review returns to the new-releases list, not the random wall** — the Qobuz overlay is now history-aware. Opening the overlay and opening an album's review each push a history entry, and a `popstate` handler unwinds **detail → list → closed**, so the Android/browser back button (and the ‹ Back / × / Esc controls) all behave naturally. The handler is a no-op when the overlay is closed, so the rest of the app (which uses no history state) is unaffected.

## [1.5.82] — 2026-06-23

### Added
- **Tap a Qobuz new release to see its review** — tapping a row in the Qobuz New Releases overlay now opens an isolated detail view with the album artwork, the editorial review (fetched by title + artist via the existing `/api/album/extras`, so no Roon library entry is needed), and a favourite toggle. A Back button returns to the list. The favourite button in the detail and the one on the list row stay in sync, so adding/removing in either place is reflected in both. Tapping the favourite button on a row no longer also opens the detail (event isolated).

## [1.5.81] — 2026-06-23

### Added
- **Un-favourite from the Qobuz new-releases overlay** — the favourite button is now a two-way toggle. Tapping "✓ Added" removes the album from your Qobuz favourites (via `favorite/delete`) and flips back to "♥ Favourite"; tapping "♥ Favourite" adds it as before. The add behaviour is unchanged; the button is disabled only while a request is in flight, and reverts cleanly on error.

## [1.5.80] — 2026-06-23

### Fixed
- **Qobuz new releases now show your existing favourites as "✓ Added"** — previously the new-releases overlay only marked an album Added if you favourited it in that same browser session, so albums already in your Qobuz library (or favourited on another device) still showed "♥ Favourite", and the state differed between devices. The list now fetches your current Qobuz favourite album IDs (`favorite/getUserFavoriteIds`) on load and marks any already-favourited release as a disabled "✓ Added" — consistent across all devices. The lookup is best-effort: if it fails, the list still renders with everything clickable.

## [1.5.79] — 2026-06-23

### Added
- **Qobuz New Releases + add-to-favourites (pre-release, unofficial API)** — a new `lib/qobuz.js` lite client talks to the Qobuz API (using the LMS/Lyrion Qobuz plugin's `app_id`) to list new releases and add an album to your **own Qobuz favourites/library**. A Qobuz button in the top bar opens a self-contained overlay listing releases from the last 30 days (artwork, title, artist), each with a **♥ Favourite** button that writes straight to Qobuz (and syncs back through Roon). Connect your Qobuz account in Settings (email + password; only the resulting token and an MD5 of the password are stored — never the plaintext). **No streaming or downloading — Roon still does all playback.**
  - This uses an **unofficial, reverse-engineered Qobuz API** (the same one the LMS plugin uses). It is **against Qobuz's Terms of Service, may break at any time, and is used at your own risk** — clearly noted in Settings.
  - The new-releases overlay is fully isolated from the album grid / labels / filters, so existing navigation is unaffected. Favouriting is by Qobuz album id straight from the new-releases feed (no fuzzy title/artist search), so there's no edition-mismatch risk.

## [1.5.78] — 2026-06-23

### Added
- **Read-only Roon browse probe (`/api/debug/browse-probe`)** — a diagnostic endpoint to confirm, against a live Roon Core, exactly what's reachable for a future Qobuz integration: whether Qobuz "New Releases" can be browsed (and how many albums it holds), and whether an "Add to Library"/"Add to Favorites" action exists on a Qobuz album. Walks the browse tree from the root through a slash-separated `path` of node titles and dumps the resulting level; with `album=<index>` it drills into one album to list its actions. **It never passes a zone, so nothing is ever played, queued, or added** — purely a read of the tree. No user-facing behaviour changes; no Qobuz/favourites/decades features are implemented yet (pending what this probe reveals).

## [1.5.77] — 2026-06-23

### Fixed
- **Back from a deep-linked label now lands on that label in the Labels grid** — when you open a label by tapping its link in an album view (or a search chip) rather than by scrolling the Labels grid to it, pressing back used to reset the Labels grid to the top. `showLabelAlbums` previously saved the *current* screen's scroll offset, which was meaningless for a deep-link. It now records the label name for deep-links and scrolls that label's tile into view (centered) when you return, while tile taps from the grid keep restoring the exact scroll position as before.

## [1.5.76] — 2026-06-22

### Changed
- **Manual logo picker thumbnails doubled in size** — the Discogs logo candidates shown when manually choosing a label logo were 52×52px and hard to make out. They are now 104×104px (container `min-height` bumped to match) so the logos are legible before selecting.

## [1.5.75] — 2026-06-22

### Changed
- **Faster label scan for streaming-only (Qobuz/Tidal) libraries** — when no `/music` directory is mounted, the scan now inserts a Qobuz pass between iTunes and TheAudioDB. Qobuz is the user's actual streaming source, so it resolves most iTunes-misses in a single pass and keeps them out of the slow serial TheAudioDB → MusicBrainz → Discogs cascade (each of which is rate-limited to ~1 req/sec). The pass reuses the existing `fetchQobuz` scraper, filters results through `isLikelyNotALabel`, routes hits through `saveLabelEntry` (so label-logo MBID resolution still runs), and uses the same 10-consecutive-error circuit breaker as the other network passes. Progress weighting gains a dedicated Qobuz band when the pass is active.

## [1.5.74] — 2026-06-21

### Changed
- **"Self-Released" and "Independent" now appear as label tiles** — previously filtered out entirely; now treated as valid labels so self-released albums are browsable in the Labels view.

## [1.5.73] — 2026-06-21

### Added
- **Search now shows Artists, Labels, and Albums** — results are split into three sections. Artists and Labels appear as tappable chips above the album grid; tapping an artist chip opens that artist's albums; tapping a label chip navigates to that label in the Labels browser. Albums section renders as before.
- **Multi-artist name splitting in album modal** — artist fields containing multiple names separated by ` / `, ` feat.`, ` featuring`, or ` ft.` are split into individual tappable links. Each name navigates to that artist's albums independently. ` & ` is intentionally not split as it is often part of a band name (e.g. "Simon & Garfunkel").

### Fixed
- **Album modal label now matches the Labels browser** — the label shown in the album subtitle line previously came from Qobuz and could disagree with the label the album is listed under in the Labels browser (which uses the scan pipeline: file tags → iTunes → MusicBrainz). The modal now uses the canonical label from the scan pipeline, so tapping the label always navigates to the correct tile.
- **Labels browser scroll position lost on back-navigation** — returning from a label's album list always reset the labels grid to the top. The grid now restores its scroll position when you navigate back.

## [1.5.72] — 2026-06-21

### Fixed
- **Qobuz-sourced labels bypassed `isLikelyNotALabel` filter** — both `seedLabelsFromCache` and `rebuildLabelsMap` injected Qobuz labels directly into `labelsIndex` without calling `isLikelyNotALabel`, allowing "Self-Released", "Independent", and similar non-label strings to appear as real label tiles. `fetchQobuz` had the same gap when writing back to `labelDiskCache` and `labelsIndex`. All three paths now call `isLikelyNotALabel` before injecting.
- **iTunes fetch used a subset filter instead of the authoritative `isLikelyNotALabel`** — `fetchLabelFromiTunes` had an inline `/self.released|independent|self-released/i` guard that missed many values covered by `NON_LABEL_RE` (e.g. "Promo Only", "Not On Label", "White Label"). Replaced with `isLikelyNotALabel(label)` so all iTunes results go through the same shared gate as every other fetch path.
- **Redundant inline filter in `fetchLabelFromDiscogs`** — after calling `isLikelyNotALabel(label)`, the function also tested `/self.released|independent/i` — a strict subset that could never add a new rejection. Removed the duplicate check.
- **FanArt TV logo stored under source key after merge** — `fetchFanArtLogo` wrote the logo URL (and the `null` 404 sentinel) directly under `groupKey` without consulting `labelMerges`, so if a merge happened before or during the fetch the logo landed under the merged-away key. After a restart, the canonical target key had no logo entry. Now follows `labelMerges` in both the success and 404 error paths, mirroring the fix already applied to Discogs in v1.5.71.
- **`discogsLogoTried.add()` fired before the fetch completed** — if the network request threw an error, the groupKey was permanently marked as tried for the session, preventing any retry. Moved `.add()` to after the result arrives; errors (`reason === "error"`) are excluded so they can be retried on the next scan cycle.
- **`labelMbidCache` did not store null for failed MusicBrainz lookups** — `saveLabelEntry` only called `labelMbidCache.set(gk, mbid)` on success, so every scan cycle re-queried MusicBrainz for labels that returned no MBID. Now caches `null` as a session sentinel on failure; the sentinel is not persisted to DB so failed lookups are retried on restart.
- **`sanitizeDiscogsSearchTerm` logic duplicated in two places** — the leading/trailing non-alphanumeric strip was inlined in both `fetchLogoFromDiscogs` and the `/api/labels/logo-candidates` endpoint. Extracted into a shared `sanitizeDiscogsSearchTerm()` helper; both call sites now use it.
- **Logo picker did not pre-fill existing URL when opened** — `currentLabelLogoUrl` was populated correctly (since v1.5.70) but never written to `logoUrlInput.value` when the sheet opened. The URL field was always blank even for labels with a stored logo. Now pre-fills `logoUrlInput.value` with `currentLabelLogoUrl` on open.
- **CLAUDE.md violation: 9 more silent catches without explanatory comments** — `updater.apply()`, `updater.checkNow()`, `refreshSettings()`, `pickSmartAlbum`, `ensureAlbumIndex`, `startIndexMaintenance`, two `/api/play-unheard` routes (index.js), and `fetchAlbumExtras`, `seek`, `control`, `toggleMute`, `renderBarZoneList`, `initDockerMigration` (app.js) all lacked required explanatory comments. Added comments to all.

## [1.5.71] — 2026-06-21

### Fixed
- **`kickDiscogsLogoFetches` re-fetched labels already confirmed as having no logo** — used `labelLogoCache.get(key)` (truthy check) which is falsy for `null` sentinel entries (stored when FanArt TV found no logo). Changed to `labelLogoCache.has(key)` so labels previously confirmed as logo-less are correctly skipped, consistent with `kickFanArtFetches`.
- **iTunes label match returned wrong-artist album** — fallback `results.find()` had a permanently-dead title operand in an `||` condition (line 1036 already exhausted all title matches). Effective behaviour was artist-only matching, which could attribute any album from the same artist regardless of title. Cleaned up to clearly express the intent: artist-alone as a tiebreaker before `results[0]`.
- **Progress bar froze at 20% for entire iTunes pass** — `PASS_ENDS = [0.20, 0.20, ...]` gave the iTunes pass zero width (`end === start`). Fixed to `[0.10, 0.20, ...]` so files cover 0–10% and iTunes covers 10–20%.
- **Discogs searches failed for labels with leading or trailing brackets** — `[PIAS]` was stripped to `PIAS]`; `(4AD)` to `4AD)`. The trailing bracket was passed to Elasticsearch and could trip range-query parsing, returning zero or wrong results. Changed to strip both leading AND trailing non-alphanumeric characters in both `fetchLogoFromDiscogs` and the `/api/labels/logo-candidates` endpoint.
- **`"Self-Released"` persisted as a real record label** — the MusicBrainz and TheAudioDB fetch paths only checked `isLikelyNotALabel` which did not test for "Self-Released"/"self released". iTunes and Discogs had private inline guards that the shared gate was missing. Added `self.?released` to `NON_LABEL_RE` so all four fetch paths reject it consistently.
- **Logo URL not updated in `currentLabelLogoUrl` after saving** — `saveLogo()` in app.js ignored the `storedUrl` field returned by `POST /api/labels/logo`. The server downloads and locally caches the image (returning `/api/labels/logo-image/xyz.jpg`), but `currentLabelLogoUrl` was left pointing to the original Discogs CDN URL. Now assigns `j.storedUrl` on success.
- **Discogs logo stored under source key after mid-flight merge** — if `POST /api/labels/merge` ran while `kickDiscogsLogoFetches` was in progress, the logo was persisted under the source (merged-away) groupKey in SQLite. After a restart, `labelLogoCache` held the logo under the source key but not the target key, so the merged label tile showed no logo. Now follows `labelMerges` at store time to write under the canonical target key.
- **CLAUDE.md violation: two silent catches without explanatory comments** — `catch (e) {}` in `runLabelsIndexScan` (awaiting album index build) and `catch (e) { return; }` in `buildFileLabelMap`'s `scanDir` (directory read failure) both lacked required comments. Added comments explaining why silence is safe in each case.
- **Duplicate TheAudioDB section header comment** — removed copy-paste duplicate 3-line comment block above `fetchLabelFromTheAudioDB`.

## [1.5.70] — 2026-06-20

### Fixed
- **Label scan permanently locked after exception** — if `buildFileLabelMap` or any scan pass threw an unhandled exception, `labelsIndex.building` was never reset to `false`, blocking all future auto-rescans and manual rescans for the lifetime of the container. Wrapped the scan body in try/catch with guaranteed reset.
- **Discogs CDN image fetch storing login-page URL as logo** — when a candidate image URL redirected to a Discogs login page (HTML, not an image), the code fell through to `storedUrl = resp.url` and stored the login page URL as the logo, producing a permanently broken image tile. Now any non-`image/*` response is discarded and the original URL is kept (tile fails gracefully rather than storing a bad URL).
- **Discogs API calls fired unauthenticated when no token set** — `fetchLabelFromDiscogs`, `fetchLogoFromDiscogs`, and `kickDiscogsLogoFetches` all sent `Authorization: Discogs token=` (empty) when no token was configured. Added early-return guards: calls are skipped entirely when `discogsToken` is empty, saving rate-limit headroom. `/api/labels/logo-candidates` now returns a clear error message "Discogs token not configured — add it in Settings" so the picker UI shows an actionable message instead of "Discogs search failed".
- **Logo picker showed generic error on auth/server failure** — `loadLogoCandidates` swallowed the error message and always showed "Discogs search failed". Now propagates the server's error text (e.g. "Discogs token not configured").

### Changed
- **`savePersistedSettings` now uses in-memory cache** — previously every save called `loadPersistedSettings()` (a synchronous `readFileSync`) to merge before writing. Added `_settingsCache` so the file is read once at startup and all subsequent saves update in-place with no disk read. Eliminates the read-before-write pattern on every radio toggle and token save.
- **All silent `catch` blocks now have comments** — every `catch (e) {}` and `catch (_) {}` in `index.js` and `app.js` has a comment explaining why silence is safe. Required by CLAUDE.md zero-tolerance rules.
- **`currentLabelLogoUrl` captured from label-albums response** — the `logo_url` field returned by `/api/label-albums` is now stored in a frontend variable, making the current label's stored logo available for future use in the picker UI.

## [1.5.69] — 2026-06-20

### Fixed
- **API token/key Save buttons not working** — both settings inputs were `type="password"`, which triggers iOS's keychain manager and can silently clear the field value before the click event fires, causing the empty-field guard to bail out. Changed to `type="text"` (API keys are not authentication passwords; the masked display in the status row provides sufficient visual protection). Also: the server-side POST handlers now reject empty values with a 400 response (instead of silently setting an empty token), log the received key length to Docker logs for diagnostics, and report whether the file write succeeded so the client can warn if persistence fails.

## [1.5.68] — 2026-06-20

### Fixed
- **Extension not appearing in Roon (properly fixed)** — the v1.5.67 commit did not actually include the temporal dead zone fix due to a staging sequencing error; the crash was still present. This build correctly declares `let discogsToken` and `let fanartKey` at the load site and removes the duplicate `let` declarations that appeared later in the file.

## [1.5.67] — 2026-06-20

### Fixed
- **Extension not appearing in Roon** — v1.5.66 introduced a JavaScript temporal dead zone crash: `discogsToken` and `fanartKey` were assigned at startup (line ~672) but their `let` declarations appeared hundreds of lines later. Node.js throws a `ReferenceError` before the process can register with Roon. Fixed by declaring both variables at the point they are first assigned.
- **Discogs API calls broken** — all Discogs auth headers referenced `DISCOGS_TOKEN` (an undefined constant) instead of the `discogsToken` variable loaded from settings. Every API call was sending `Authorization: Discogs token=undefined`, causing silent auth failures. Fixed to use the correct variable name throughout.

### Changed
- **FanArt.tv key in Settings UI** — removed the hardcoded FanArt.tv API key. It is now entered via the Settings panel (gear icon → FanArt.tv key field) and stored in `data/cache/settings.json`. Enter your own free key from fanart.tv/get-an-api-key. No credentials remain hardcoded in source code.

## [1.5.66] — 2026-06-20

### Changed
- **Discogs token in Settings UI** — the Discogs personal access token is now entered via the Settings panel in the web UI (gear icon → Discogs token field). It is stored in `data/cache/settings.json` and never appears in source code or environment variables. Existing installs can paste their token after upgrading.

## [1.5.65] — 2026-06-20

### Fixed
- **Albums appearing under wrong labels** — two bugs in the scan pipeline caused stale API-derived label assignments to persist even when file tags had correct data. (1) The file-tag override pass only ran when ≥10 albums were uncached, so 12-hour auto-rescans where everything was already cached never re-read file tags. (2) Even when the override pass did run, it updated the SQLite cache but not the in-memory index, so the labels page still showed the old wrong attribution. File tags (populated by beets/MusicBrainz) now always take priority: the file scan runs unconditionally at the top of every scan, and a `rebuildLabelsMap()` call follows any corrections so the in-memory index matches immediately.
- **Discogs logo fetch using wrong auth** — all Discogs API calls used consumer key+secret authentication, which behaves like an unauthenticated request (25 req/min) and may be rejected by certain endpoints. Switched to personal access token auth (`Discogs token=…`) which is the method recommended by Discogs and used in working reference implementations.

## [1.5.64] — 2026-06-20

### Fixed
- **Logo picker shows "No logos found" for labels like `~scape`** — Discogs search results often omit `cover_image` for niche labels even when the label page has images. The candidates endpoint now falls back to the Discogs Labels API (`/labels/{id}`) for the best name-matched result, which always includes the full `images[]` array.
- **Pasting a Discogs label URL in the logo sheet didn't work** — the Discogs image viewer URL (`discogs.com/label/1495-~scape/image/…`) requires a browser session to serve image bytes; the server-side fetch got HTML instead. The save endpoint now detects any Discogs label URL, extracts the label ID, calls the Discogs API to get a real `i.discogs.com` CDN image URL, and downloads that instead.

## [1.5.63] — 2026-06-20

### Changed
- **Label logo picker** — the photo icon now opens a Discogs logo picker alongside the URL paste field. When the sheet opens, the server queries Discogs and shows up to 6 logo candidates as tappable thumbnails; tap one to save immediately with no URL copying needed. Works fully on iPhone with no clipboard gymnastics.
- **Logo URL caching** — when a logo URL is saved (whether from the picker or pasted manually), the server downloads the image and stores it locally under `data/cache/logos/`. This means any URL works — including Discogs image viewer pages that aren't direct image links — because the server fetches and caches the bytes itself.

## [1.5.62] — 2026-06-20

### Fixed
- **Label scan stalls at ~95%** — the Discogs data pass (finding label names for albums not identified by iTunes/TheAudioDB/MusicBrainz) runs at 1 req/sec and was taking many minutes for large libraries after a Force Rescan. Added a 5-minute time cap: the pass aborts cleanly at the limit and any remaining albums are picked up at the next 12-hour auto-rescan.

### Added
- **Manual logo for label tiles** — a photo icon button appears in the label album header (when viewing a specific label's albums). Tapping it reveals a URL input; paste any direct image URL (e.g. from the Discogs label page) and tap Save. The logo is stored in the database and survives restarts.

## [1.5.61] — 2026-06-20

### Fixed
- **Discogs logo search fails for labels with leading symbols** — labels like `~scape`, `(((Belle Sound)))`, or `[PIAS]` were not found because Discogs uses Elasticsearch where `~` is a fuzzy operator. The search query now strips leading non-alphanumeric characters before sending to Discogs; the original name is still used for result matching, so `~scape` searches for `scape` but matches the `~scape` result correctly.
- **Force rescan skips Discogs logo re-fetch** — the per-session dedup Set (`discogsLogoTried`) was never cleared by Force Rescan, so labels that previously got no logo result would be silently skipped even after the search bug was fixed. Force Rescan now clears the Set so all logo lookups are retried.

## [1.5.60] — 2026-06-20

### Added
- **Label link in album modal** — the record label now appears on the subtitle line alongside the artist and year (`Kraftwerk · 1974 · Parlophone UK`). Tapping the label name navigates directly to that label's albums in the Labels browser.

### Fixed
- **Year shown from album data when MusicBrainz year is missing** — the subtitle year now falls back to the year returned by the album extras (Qobuz/Wikipedia source) if the MusicBrainz lookup returned nothing.

### Changed
- **Multi-select queue speed** — when queuing multiple albums, albums 2–N are now sent to Roon in parallel rather than sequentially. For a typical 3-album queue this roughly halves the wait time.

## [1.5.59] — 2026-06-20

### Fixed
- **Duplicate exit control in select mode** — removed the "Done" topbar button; the "×" in the action bar already exits select mode, making "Done" redundant.

## [1.5.58] — 2026-06-20

### Fixed
- **Merge bar / action bar invisible on mobile** — `#label-merge-bar`, `#album-action-bar`, and `#label-unmerge-sheet` were inside `.app` which has `z-index: 0`, placing them behind the mini-transport (`z-index: 70`) and modal (`z-index: 50`). Moved all three elements outside `.app` so they sit in the root stacking context at their own `z-index: 75/80`.
- **Two Select buttons (iPad) / cluttered topbar** — removed the separate `#album-select-toggle` and `#label-select-toggle` buttons. Selection mode is now entered by long-pressing any album or label tile (500ms, with haptic feedback). A single "Done" button (`#select-done-btn`) appears in the topbar when any select mode is active.
- **Scanning progress message overflows topbar** — removed the `(scanning… X%)` suffix from the count text. Added a slim 2px progress bar at the very bottom of the topbar that animates as the scan advances.
- **File scan stalls with large libraries** — `buildFileLabelMap()` now only runs when `toScan.length > 10` (skips file scan for small incremental additions). Progress is reported during the file scan via an `onProgress` callback so the bar begins moving immediately.

### Added
- **Force rescan button in Settings** — a "Force rescan" button clears the label name cache (logos and MBIDs are kept) and triggers a complete fresh scan from all sources. Useful after importing new music or if label data looks wrong.

## [1.5.57] — 2026-06-20

### Fixed
- **Topbar buttons shift left on first load** — `justify-content: space-between` placed the controls div at flex-start when the album count badge was hidden (display:none). Added `margin-left: auto` to `.topbar-controls` so buttons always hug the right side regardless of the count badge visibility.
- **Album multi-select: filter context missing** — when a genre or tag filter was active, multi-select play/queue requests omitted `filter_type`/`filter_value`, causing offsets to resolve against the full library instead of the filtered list and playing the wrong albums.
- **Album select tiles: no visual feedback** — selected album tiles on the random wall had no highlight or checkmark. Generalised the existing label-tile selected-state CSS (outline + checkmark badge) to apply to all `.album.is-selected` tiles.
- **Labels page: "No labels found yet" on fresh restart** — when the album index had not built yet (count=0) but `albumIndex.building` was still null (brief window before `buildAlbumIndex()` is called), the API reported `scanning:false`. The client showed the permanent "No labels found yet" message instead of polling. Now any response with empty labels AND zero albums returns `scanning:true`.
- **`exitLabels()` not clearing album select mode** — navigating away from labels while album select mode was active left the action bar open.
- **"Rescan now" button wrong class** — used `primary-btn` (square icon button style) instead of `action-btn primary` (text button style).

## [1.5.56] — 2026-06-20

### Fixed
- **Labels merge button invisible on mobile** — the Merge button used the `primary-btn` class whose CSS hides `<span>` text on small screens, making it appear as an empty blue square. Replaced with a new `action-btn primary` style that always shows the button label.

### Added
- **Album multi-select on the random wall** — a Select button appears in the topbar when on the album wall. Tap to enter select mode, tap tiles to choose albums, then use the action bar (Play Now / Queue) to play them all. Play Now starts the first album and queues the rest; Queue adds all to the queue. Cancel clears the selection.

## [1.5.55] — 2026-06-20

### Changed
- **Version display** — both the Roon Extensions list and the web UI Settings panel now show `MusicD Random Albums v1.5 (Build 55)` instead of the raw semver string. The Roon registration `display_name` is `MusicD Random Albums v1.5` and `display_version` is `Build 55`.

### Fixed
- **Long-press on artwork** — images inside album and label tiles no longer trigger the iOS save/copy context menu or browser drag-to-save on desktop (`pointer-events: none` + `-webkit-touch-callout: none`).

## [1.5.54] — 2026-06-20

### Fixed
- **Labels grid unstable during scan** — the tile grid was fully re-rendered on every 5-second poll whenever new labels appeared, causing a visible flash. The grid now only renders on first load and once more when the scan completes; the count text updates each poll so progress is still visible without the grid flickering.

## [1.5.53] — 2026-06-20

### Added
- **Label merge UI** — a "Select" button appears in the topbar when the Labels page is open. Tap it to enter select mode, then tap two or more label tiles to choose them (the first tapped is the merge target — shown with an accent checkmark). The merge bar at the bottom shows the target name and a Merge button. Merges are saved to the SQLite database and survive container restarts and rescans.
- **Label unmerge** — tiles that have labels merged into them show a small "N merged" indicator below the album count. Tapping it opens a bottom sheet listing each merged label with an × button to remove it one at a time.

## [1.5.52] — 2026-06-20

### Fixed
- **Labels blank during scan** — `/api/filters/labels` now calls `seedLabelsFromCache()` eagerly when the in-memory map is empty but the album index is ready, so the first response on a fresh restart always includes cached labels rather than returning an empty list while the scan runs in the background.
- **Labels rescan on every restart** — `labelsIndex.builtAt` was in-memory only and reset to 0 on each container restart, triggering a full rescan every time the Labels page was opened. The scan timestamp is now written to `data/cache/last-labels-scan.txt` on completion and reloaded at startup; rescans only trigger when the file is absent or the last scan is older than 12 hours.
- **Labels polling stops on error** — a single network error in the `showLabelsList` fetch permanently stopped label updates (no retry was scheduled in the catch block). The catch block now retries after 10 seconds so transient errors recover automatically.

## [1.5.51] — 2026-06-20

### Fixed
- **Label fragmentation (Inc. / LLC variants)** — stripping a corporate suffix (e.g. `Inc.`) from `"A&M Records, Inc."` left a trailing comma that blocked the next pass from stripping `"Records"`, producing group key `"amrecords"` instead of `"am"`. Trailing punctuation is now stripped after *each* suffix pass, so `"A&M Records, Inc."` correctly merges with `"A&M Records"` and `"A&M"`.

## [1.5.50] — 2026-06-20

### Fixed
- **Label fragmentation** — trailing commas (and semicolons/colons) in file-tag label names (e.g. "A&M Records,") now stripped before suffix normalisation, so "A&M Records," and "A&M" correctly merge into one tile.
- **Discogs logo auth** — logo search was using key/secret as query params rather than the `Authorization: Discogs key=…, secret=…` header used by the working label-data fetch; switched to the header, which Discogs requires for authenticated API calls.
- **Discogs placeholder filter** — added `no-label` pattern to the image filter regex to catch Discogs' own "no image" CDN URL.
- **Discogs logo diagnostics** — completion log now breaks down result counts: logos found / no results / placeholder filtered / errors, so problems are visible in the scan log without enabling debug mode.

## [1.5.49] — 2026-06-20

### Added
- **Discogs label logos** — after Fan Art TV finishes (which requires a MusicBrainz MBID), a second logo pass now searches Discogs by label name and fetches `cover_image` URLs. This covers the large number of labels that have no MBID and therefore no Fan Art TV logo. Results are cached in SQLite alongside Fan Art TV logos. Placeholder/spacer images are filtered out. Runs in the background after every scan and on startup.

## [1.5.48] — 2026-06-20

### Changed
- **Label text size increased** — bumped from 8cqw to 9cqw.

## [1.5.47] — 2026-06-20

### Changed
- **Label text tiles: consistent font size across all tiles using container query width** — removed per-label JS font-size calculation entirely. Font is now `8cqw` (8% of the tile's own width), so "Rockproduktionen" (16 letters) fits with thin margins and every other label uses that same size. Scales automatically with tile width on any screen size.

## [1.5.46] — 2026-06-20

### Fixed
- **Label text tiles: font size now scales by longest word, not word count** — the previous approach made 4 short words ("3 Beads of Sweat") smaller than 2 long words. Font is now sized to fit the longest word in the label name, so the tile width is always the constraining factor. Short words at any count display larger; only genuinely long words (e.g. "Rockproduktionen") force a smaller size.

## [1.5.45] — 2026-06-20

### Fixed
- **Label tiles still showing album covers** — labels without a Fan Art TV logo were falling back to the first album's cover art, making the tile indistinguishable from an album. Removed the album-art fallback from label tiles entirely. The display hierarchy is now: Fan Art TV logo → label name text. Nothing else.

## [1.5.44] — 2026-06-20

### Changed
- **Label tiles without a logo now show the label name** — previously showed a generic tag icon. The label name is displayed centred in the tile, with each word on its own line (e.g. "Blue Note" = two lines, "Warner Music Group" = three lines). Font size scales down slightly for longer names. The tag icon is retired entirely from label tiles.

## [1.5.43] — 2026-06-19

### Fixed
- **Progress bar shows >100%** — albums that fail one API pass and cascade to the next (e.g., fail iTunes → TheAudioDB → MusicBrainz) were counted once per pass, so `done` grew to 3× the album count and the percentage climbed to 112%+. Replaced the single `done` counter with a pass-weighted progress function: files+iTunes share 0–20%, TheAudioDB 20–50%, MusicBrainz 50–80%, Discogs 80–100%. The bar now moves linearly through each pass and always stays between 0% and 100%.

## [1.5.42] — 2026-06-19

### Fixed
- **Progress bar frozen during passes 2–4** — `done` was only incrementing inside the iTunes pass. TheAudioDB, MusicBrainz, and Discogs passes now update progress correctly so the UI percentage moves throughout the full scan.
- **No visibility into long-running passes** — the log only wrote at pass boundaries, making it impossible to tell if TheAudioDB (potentially 37+ minutes) was stuck or just slow. Now logs every 100 albums processed within each pass.
- **TheAudioDB could block for hours on timeout storms** — added a circuit breaker: 10 consecutive request errors in any pass abort that pass immediately and log the reason. The next 12-hour auto-rescan retries. Reduced TheAudioDB timeout from 10s to 6s so stalled requests fail faster.

## [1.5.41] — 2026-06-19

### Added
- **Scan error logging** — all scan events (start, per-pass summaries, errors, completion) are now written to `data/labels-scan.log` with timestamps. The log rotates automatically at ~100KB.
- **Scan log download** — a "Download scan log" and "Copy log" link appears in the Labels view after a scan, for easy sharing when debugging.
- **12-hour auto-rescan** — the labels scan now re-runs automatically every 12 hours while paired with a Roon Core, so new albums are picked up without a manual rescan.
- **`GET /api/labels-scan-log`** — serves the scan log as a plain-text download.

### Changed
- **Rate-limit errors now abort silently** — when iTunes returns 429/403, the error is recorded in the log and the pass aborts; the next scheduled 12-hour window will retry rather than erroring again in the same run.

## [1.5.40] — 2026-06-19

### Fixed
- **iTunes rate limiting** — reduced concurrency from 20 to 3 parallel requests and added a 500ms delay between batches. On the first 429 or 403 response the entire iTunes pass is aborted immediately rather than continuing to hammer a blocked endpoint; remaining albums fall through to TheAudioDB and MusicBrainz.
- **File labels now override stale cache** — when file metadata scanning is enabled, the file label is now compared against every existing cache entry. Where the file tag disagrees with the cached API result, the file wins and the cache is updated. Previously file labels only applied to albums with no cache entry at all.

## [1.5.39] — 2026-06-19

### Fixed
- **TheAudioDB rate limiting** — the free API has a strict rate limit; added 1.1s delay between requests and changed from 5 concurrent to serial to stop HTTP 429 errors.
- **MusicBrainz timeouts** — increased request timeout from 8s to 20s to handle slow MB responses without aborting.
- **File scan silent failure** — added a debug log when `parseFile` can't be resolved from music-metadata, replacing a silent early return that made it impossible to diagnose.
- **"Independent" treated as a label** — added `independent` to the non-label filter so it's rejected at all sources and never shown in the labels view or looked up in Fan Art TV.

### Changed
- **Update check interval** — reduced from every 6 hours to every 7 days. Updates are still checked on startup; the Settings page manual check is unaffected.

## [1.5.38] — 2026-06-19

### Fixed
- **File metadata scanner: wrong directory structure assumed** — the previous scanner expected strict `Artist/Album/tracks` nesting. Real libraries use mixed layouts (flat `Artist - Album/`, year-prefixed folders at root, proper nested `Artist/Album/` alongside each other). The scanner now recursively walks the music directory and matches on audio file tags (`common.album` + `common.albumartist`) rather than directory names, so naming convention is irrelevant.

## [1.5.37] — 2026-06-19

### Added
- **File metadata scanning** — the extension can now read LABEL/ORGANIZATION tags directly from your audio files when the music directory is mounted read-only in Docker (`-v /path/to/music:/music:ro`). File tags are the most authoritative source and are checked first, before any network API. Add `-v /mnt/dietpi_userdata/4tb/Music:/music:ro` to your `docker run` command to enable.
- **Discogs label source** — restored as a final-pass fallback for albums no other source could identify. Runs serially at 1 req/sec to respect the rate limit.
- **TheAudioDB label source** — added as a third-pass source between iTunes and MusicBrainz. Free, no key required, runs 5 concurrent requests.
- **`/api/music-mount` endpoint** — reports whether the `/music` directory is mounted and what path is configured.

### Fixed
- **Label fragmentation by country/region** — labels like "[PIAS] America", "[PIAS] Belgium", "Universal Music Canada", "Universal Music France" now all group correctly under "[PIAS]" and "Universal Music" respectively. A new regex strips country and regional qualifiers (US, UK, America, Canada, France, Germany, Belgium, and 30+ others, plus International, Global, Nordic, etc.) before computing the group key.
- **Management company false positives** — album entries where iTunes (or another source) returned a management or booking company instead of the actual label (e.g. "Velvet Hammer Music and Management" for Korn) are now detected and skipped. Existing bad entries are evicted from the SQLite cache on startup.

### Changed
- **Label scan pipeline** — now a 4-pass pipeline: file metadata → iTunes (20 concurrent) → TheAudioDB (5 concurrent) → MusicBrainz (serial) → Discogs (serial). Each album is only sent to subsequent passes if the previous pass found nothing.

## [1.5.36] — 2026-06-19

### Fixed
- **Missing `.dockerignore`** — without it, `COPY . .` in the Dockerfile was baking the native install's `node_modules` into the Docker image, overwriting the clean ones built by `npm install`. Also excluded `config.json`, `data/`, tarballs, and `.git` from the image.
- **Migration instructions** — updated to use a fresh separate directory for the Docker build, making cleanup unambiguous: the old native directory can be safely `rm -rf`'d without any risk of deleting Docker build files.

## [1.5.35] — 2026-06-19

### Added
- **Downgrade / rollback via web UI** — the in-app updater now follows whatever version is marked as "latest" on GitHub, regardless of direction. If the latest release is rolled back to an older version number, the app will offer to install it. The toast and Settings button both indicate "Roll back" vs "Update" so there's no ambiguity.
- **Release notes in update UI** — when an update or rollback is available, the GitHub release notes are shown directly in the update toast and under the "Check for updates" button in Settings, so you can read what changed before tapping.

### Fixed
- **Incorrect "Listening statistics" feature in README** — removed from the features list; the stats UI was removed in a previous build (play history still exists in the backend and is used by Play Unheard and Random Album Radio).

## [1.5.34] — 2026-06-19

### Changed
- **Labels scan: two-pass strategy** — iTunes lookups now run first in batches of 20 (fast, no rate limit). Only albums iTunes misses are passed to MusicBrainz, which runs serially to respect the 1.1-second rate limit. Reduces total scan time for large libraries.
- **Library stats: served from in-memory index** — `/api/library-stats` now reads directly from `albumIndex.count` instead of walking the Roon browse hierarchy on each request. Eliminates the 60-second cache and the background Roon API call entirely.
- **Artist view re-entry guard** — calling `showArtistAlbums()` while already in artist view now exits cleanly before rebuilding, preventing stale grid/count state.

### Removed
- **Dead code cleanup** — removed `fetchLabelFromDiscogs()`, `discogsWait()`, the unused `_albumCountCache` variable, the `buildSimpleTile()` fallback function, and the stale Qobuz-data comment block. Removed dead CSS rules: `.brand`, `.brand-mark`, `.brand-logo`, `.brand-name`, `.filter-grid`, `.filter-grid .filter-row`, `.filter-loading`, `.filter-backdrop`.

### Fixed
- **`.count-text` missing from CSS** — the class used in the artist view count bar was referenced in JS but absent from the stylesheet; added the rule.

## [1.5.33] — 2026-06-19

### Fixed
- **Random Album Radio auto-starts on restart** — eliminated the bug where radio would begin playing automatically whenever Roon or the extension restarted. Root cause: any `zones_changed` event for a zone in "stopped" state (with empty queue) after the 15-second grace window would trigger playback. Replaced the unreliable grace timer with proper state-transition detection: a "play" command is now only issued when the extension observes an actual `playing → stopped` transition for a zone (i.e. the queue genuinely ran out). A zone that is already stopped when first seen after a reconnect will never auto-start. Enabling radio explicitly via the UI still starts playback immediately as expected.

## [1.5.32] — 2026-06-18

### Fixed
- **Phone portrait grid** — restored 3×3 (9 albums) layout. The CSS override that forced 2 columns has been removed; the base 3-column grid now applies correctly to all phone portrait views.

## [1.5.31] — 2026-06-18

### Fixed
- **Roon extension publisher** — changed `extension_id` from `com.local.*` to `com.musicd.*` so Roon's Extensions list now shows "MusicD" instead of "Self".
- **Now-playing album link** — tapping the album name on the Now Playing screen no longer triggers "Valid offset query parameter required". The handler now only opens the album detail when a valid index match with an offset is found; otherwise shows a brief toast.
- **Labels screen flickering** — eliminated the blank-then-reload flash that occurred every 4–5 seconds while the label scan was running. Skeletons are only shown on the first open; subsequent polls only re-render when the label count actually changes.
- **Share card text size** — increased release-date label (20 → 26 px), album title (48 → 56 px), and artist (30 → 37 px) for better readability.
- **Share card MusicD wordmark** — removed the "MusicD" text fallback from the share card.
- **Play unheard tooltip** — removed `title` attribute from the compass button; the text tooltip no longer appears on tap.
- **Grid album counts** — corrected `computeAlbumCount()`: desktop now returns 45 (9 × 5), tablet portrait returns 20 (5 × 4); tablet landscape (7 × 3 = 21) and phone portrait (2 × 3 = 6) unchanged.

### Added
- **Album count in topbar** — the total number of albums in your library (or the active filter) is now shown as a bold label on the left side of the topbar, white on dark and black on light.

### Changed
- **Labels scan speed** — increased concurrent iTunes lookup batch from 6 to 20 albums, significantly reducing scan time for large libraries.

## [1.5.30] — 2026-06-18

### Added
- **"Play unheard" in topbar** — the compass icon button (⊙) is now in the main
  header alongside Filter, Labels, and Search, so it's always one tap away without
  opening Settings. Removed from the Settings sheet.

### Changed
- **Now-playing album title is tappable** — the album name shown on the Now Playing
  screen is now a button. Tapping it opens the full album detail view (tracks and
  actions) for the currently playing album.

### Fixed
- **Tap-to-select disabled globally** — iOS and Android no longer show the text
  selection handles when tapping album tiles, labels, or any non-interactive text.
  Text selection is still active in the search input and any other text fields.

## [1.5.29] — 2026-06-18

### Added
- **Smart random radio** — the random-album radio now prefers albums not played
  in the last 30 days. It picks candidates in small batches and skips recently
  heard titles, falling back to pure random only when nothing fresh is found.
- **Play something unheard** — new button in Settings (and `POST /api/play-unheard`)
  that picks an album with zero plays in the plays table and starts it immediately
  in the selected zone. Falls back to pure random if your entire library has been
  heard at least once.
- **Play count badges** — album tiles now show a small "N×" badge in the
  bottom-right corner for any album that appears in the plays table, so you can
  see at a glance which albums you've listened to before.
- **Recently played in stats** — the stats panel now shows a "Recently played"
  section (last 25 tracks, regardless of whether the play was marked completed).
  This section is visible immediately, even before any completed-play statistics
  have accumulated, so the stats page is never blank after the first track starts.
- **Zone breakdown in stats** — plays-per-zone bar chart shown when more than
  one zone has play history.
- **Apple Shortcuts / HTTP automation endpoints**:
  - `GET /api/shortcut/zones` — returns all Roon zones with name, ID, and state.
  - `GET /api/shortcut/play-random?zone=ZONENAME` — plays a random album in
    the named zone. Accepts both display name and zone ID.
  - `GET /api/shortcut/play-unheard?zone=ZONENAME` — plays an unheard album in
    the named zone.

### Fixed
- **Stats page no longer crashes when `labelsDb` queries fail** — the `/api/stats`
  endpoint is now wrapped in `try/catch` and returns a proper JSON error instead of
  an unhandled exception.
- **Stats page shown even before any completed plays** — previously the page
  returned a plain text message and rendered nothing. Now the recently-played
  section populates as soon as any track starts playing.

## [1.5.28] — 2026-06-18

### Fixed
- **Random album radio auto-start after Roon restart** — after the initial
  `Subscribed` snapshot (which correctly passes `isInitial=true`), Roon fires
  additional `zones_changed` events as it settles its state. These arrived
  without `isInitial`, causing stopped zones with radio enabled to auto-start.
  Added a 15-second grace window (`RECONNECT_GRACE_MS`) stamped on every
  `Subscribed` event; "play" decisions are suppressed within this window.
- **MusicD logo missing in header** — `logo.jpg` was never committed to the
  repository. Replaced the broken `<img>` with an inline SVG text wordmark.
- **MusicD wordmark missing on share cards** — `logo.png` was similarly absent.
  The share card now renders "MusicD" as text in the bottom-right corner when
  no image is available.

## [1.5.27] — 2026-06-18

### Fixed
- **Listening statistics never recorded** — `scrobbleUpdate` read
  `now_playing.line1 / line2 / line3` directly, but Roon nests those strings
  inside `now_playing.three_line.line1` etc. The guard `np && np.line1` was
  always falsy, so zero plays were ever written to SQLite and the stats page
  showed nothing. Fixed to use the same `three_line` / `one_line` property
  paths already used elsewhere (e.g. the transport API endpoint).

## [1.5.23] — 2026-06-18

### Fixed
- **Random album radio auto-start on restart** — when the extension reconnected
  to Roon, the initial zone-state snapshot was treated the same as a live zone
  change. Any zone with radio enabled that was stopped/idle would immediately
  start playing. The `"Subscribed"` event (startup snapshot) now passes
  `isInitial=true` to `handleRadioZone`, which suppresses the `"play"` decision
  so a stopped zone is left alone on reconnect. Queue top-up for zones that are
  already playing is unaffected — seamless continuation still works.

## [1.5.22] — 2026-06-18

### Fixed
- **Stats panel transparent background** — `var(--bg-page)` was used but never
  defined, causing the stats screen to show the album grid through it.
  Corrected to `var(--bg)`, the app's standard page background colour.

## [1.5.21] — 2026-06-18

### Changed
- **Statistics** — moved from the topbar bar-chart icon into the Settings panel.
  Tap *View stats* in Settings to open the full-screen stats view. The ✕ button
  in the top-right corner of the stats screen returns you to the album grid.

### Removed
- **Heart / love button** — removed. The Roon browse API did not expose a love
  action at the album browse level (button was always greyed-out and untappable).
  Use `/api/debug/album-items?offset=N` if you want to investigate the browse
  structure for a future re-implementation.

## [1.5.20] — 2026-06-18

### Fixed
- **Heart / love button** — relocated from the top-right corner of the modal
  to sit inline next to the artist name, so it's always visible alongside the
  album info rather than floating over the cover art.
- **Heart button persistence** — button stays visible when Roon's browse API
  hasn't returned a love state yet; it appears greyed/disabled rather than
  disappearing, making the loading state obvious.
- **Heart browse reliability** — the server now searches inside every nested
  action_list returned by Roon's album browse level (not just the top-level
  items), so the love action is found even when Roon places it inside a
  sub-group. All browse items are now logged unconditionally (docker logs will
  show the full structure for diagnosis if needed).
- **Debug endpoint** — added `GET /api/debug/album-items?offset=N` which dumps
  the raw browse items Roon returns when entering an album, making it easy to
  diagnose browse API structure issues without code changes.
- **Updater 415 error** — POST requests to `/api/update/apply`,
  `/api/update/check`, and `/api/album/love` now send `Content-Type: application/json`.
  iOS Safari was supplying an implicit content type on body-less POSTs that
  Express's json() middleware rejected with 415 Unsupported Media Type.

## [1.5.19] — 2026-06-18

### Added
- **Listening statistics** — tap the bar-chart icon in the topbar to open your
  stats. Plays are captured server-side via the Roon zone subscription, so
  every track played from any zone (extension UI or Roon app) is recorded
  automatically, even with the browser closed.
  - **At a glance**: total plays, unique albums/artists, replay %, busiest
    day, peak listening hour
  - **Top 10 albums** — with cover art and play count
  - **Top 10 tracks** — by play count  
  - **Top artists** — percentage bar chart of listening share
  - **By decade** — breakdown of what era you listen to most
  - **By genre** — populated as the label scan enriches albums (iTunes returns
    genre alongside label data, stored in `album_meta` table)
  - **Time of day** — 24-hour sparkline showing listening patterns
  - **Day of week** — bar chart
  - Stats accumulate from this version onwards; no historical Roon data is
    imported. Genre/decade data fills in gradually as albums are label-scanned.

## [1.5.18] — 2026-06-18

### Added
- **Love / heart button** — a ♥ button appears in the album modal. Tapping it
  loves or unloves the album via Roon's browse API, reflected immediately in
  Roon's own UI and usable in Focus. The button is pink/filled when loved and
  hidden for albums that don't support it (e.g. not in your library).

## [1.5.17] — 2026-06-18

### Fixed
- **Transport bar persistence** — the mini bar was being hidden by two
  defensive `bar.classList.add("hidden")` calls: one when the zone selector
  was momentarily empty on page load (race with zone population), another on
  any API error. Both now return early without touching bar visibility. The
  bar is only hidden when Roon definitively reports nothing is playing for the
  selected zone, so it stays visible through network hiccups and page loads.

## [1.5.16] — 2026-06-17

### Fixed
- **Artist name link** — artist name in the album modal is now always a
  clickable link. Previously it flashed blue on open then reverted to plain
  text because the detail-fetch response was overwriting the button with a raw
  text node. A dedicated `setModalArtist()` helper is now used consistently
  everywhere the subtitle is set.
- **Wrong album opened for offset-shifted entries** — if the album index has a
  stale offset (e.g. after adding albums to the library), the detail fetch
  could return a completely different album and overwrite the modal title and
  artist with wrong data. The returned title is now compared to the expected
  title and ignored if it doesn't match, keeping the correct header while
  the user can trigger a re-index to restore full consistency.

## [1.5.15] — 2026-06-17

### Fixed
- **Roon extension settings** — removed duplicate version label (version is
  already shown in the Roon panel header). Changed the "Check for updates"
  dropdown placeholder from "—" to "No action" for clarity.

## [1.5.14] — 2026-06-17

### Added
- **Artist album links** — artist names in the album detail modal are now
  clickable. Tapping opens a filtered grid showing all albums by that artist:
  primary releases at the top, albums they appear on below.
- **Roon extension settings: per-zone radio toggle** — the random-album-radio
  switch for each zone is now also available inside Roon's own extension
  settings panel, so you can toggle it without opening the web UI.
- **Roon extension settings: Check for updates** — a *Check for updates* action
  in Roon's extension settings triggers an immediate update check.

### Changed
- **Label scan speed** — iTunes Search API is now the primary label source
  (free, no API key, returns `recordLabel` directly). MusicBrainz is used as
  a fallback. Scans now run 6 albums concurrently, reducing scan time from
  ~17 minutes to ~2–3 minutes for a 1 000-album library.

## [1.5.13] — 2026-06-17

### Changed
- **Share card** — redesigned to 1200×600. Album art now fills the entire left
  half (600×600, full bleed, no padding). Year, title and artist are vertically
  centred in the right half with even breathing room. A subtle dark gradient
  feathers the art-to-text boundary. Wordmark pinned to the bottom-right corner.

## [1.5.12] — 2026-06-17

### Added
- **Settings info icons** — help text replaced with a small ⓘ button on each
  settings row. Tapping it shows a toast that auto-closes after 5 seconds or
  on any tap, freeing up space in the settings panel.
- **Transport bar persistence** — the mini transport bar now restores its last
  known track title and artist from `localStorage` immediately on page load,
  so it appears before the first poll completes after a restart or update.

### Fixed
- **Radio zone persistence across container recreation** — the random-album-radio
  toggle state is now also saved to `data/cache/settings.json` inside the Docker
  volume, so it survives `docker stop`/`docker rm`/`docker run` cycles. Roon's
  own config is still updated as a secondary copy for backward compatibility.
- **In-app updater** — a `v1.5.12` git tag is now pushed to GitHub so the
  built-in updater can detect and install future releases without manual Docker
  intervention.

## [1.5.11] — 2026-06-17

### Changed
- **SQLite label database** — the three JSON cache files (`labels-cache.json`,
  `labels-mbid.json`, `labels-logo.json`) are replaced by a single
  `data/cache/labels.db` SQLite database. Writes are immediate and ACID;
  no more debounce timers or risk of partial writes on crash. Existing JSON
  caches are migrated automatically on first startup and deleted.
- **docker-compose.yml** now declares a named `roon-data` volume mounted at
  `/app/data`. Running `docker-compose up -d` is the recommended install/upgrade
  path and guarantees label data is never lost across rebuilds.
- **Dockerfile** installs `python3 make g++` so `better-sqlite3` compiles
  correctly during `docker build`.

### Fixed
- Label database (`data/cache/`) is now correctly preserved by the in-app
  updater's skip list. Upgrading via the settings cog no longer risks losing
  scan results.

## [1.5.10] — 2026-06-17

### Added
- **Label cache persistence** — label name, MusicBrainz MBID, and Fan Art TV
  logo caches are now written to `data/cache/` and excluded from the update
  overlay. Once built, the label database survives in-app updates without
  rescanning.
- **Docker volume for `data/`** — the Dockerfile now declares `VOLUME /app/data`
  and the docker run command mounts a named volume (`roon-random-albums-data`),
  so the cache and Roon pairing persist even when the container is removed and
  rebuilt.

### Changed
- **Fan Art TV logo fetches run 5 at a time** instead of sequentially with a
  500 ms delay. A library with 200 unique labels that all have MBIDs now
  finishes logo fetching in ~8 seconds instead of ~100 seconds.

## [1.5.9] — 2026-06-17

### Added
- **Check for updates** button in the settings cog — tap it to trigger an
  immediate update check without restarting the container.
- **Docker migration banner** — native (non-Docker) installs now see an
  amber banner with copy-ready commands to switch to the Docker version.
  Dismissed permanently once you tap *Got it*.
- `is_docker` field on the `/api/update/status` API response so the UI can
  distinguish Docker from native installs.

### Changed
- **Share card** — fixed height (1200 × 592); release date, album title, and
  artist are now spaced evenly within the cover area. Title and artist both
  wrap up to 3 lines. No review section, no label in the meta line.
- README rewritten as Docker-only. Includes fresh-install steps for v1.5.9,
  upgrade steps from v1.5.8, and native-to-Docker migration instructions.

### Fixed
- In-app updater (`tar` extraction) now works correctly inside Docker/Alpine
  containers — `shell: true` ensures `tar` is found on PATH when the update
  is applied.
- Dockerfile installs `tar` explicitly and sets `ENV DOCKER=1` so the
  migration banner is correctly suppressed for Docker users.

## [1.5.8] — 2026-06-16

Initial Docker release. Packaged as a self-contained `*-docker.tar.gz`
with Dockerfile, all source files, and in-app self-update support via
GitHub Releases.
