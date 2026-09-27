# Playlist sharing — design

Status: **accepted, phase 1 in progress**
Written: 2026-08-03, against v1.7.18
Research: four parallel agent passes over the codebase, the Roon KB and community,
and the playlist-interchange ecosystem.

Share a playlist — **not the audio** — so that another MusicD Remote user can import it and
have it resolved against *their* library or *their* streaming service.

This document exists because the obvious implementation is wrong in three separate places, and
each wrong turn is expensive to undo once share files are in the wild. A share file is forever:
whatever identity we fail to put in it today cannot be added retroactively to files already sent.

---

## 1. What Roon actually allows

The extension API **cannot write playlists**. This is confirmed, not assumed — v1.7.15 extended
`/api/debug/browse-probe` specifically to drill item action menus against a live Core, because the
browse tree *does* carry non-playback actions ("Add to Library" is one). There is no
"Add to Playlist" anywhere. Roon's own Smart Playlists cannot even be *read* (v1.7.12: the Core
returns a placeholder row with no play action).

The request is old and unanswered:

- [node-roon-api-browse#3](https://github.com/RoonLabs/node-roon-api-browse/issues/3) — opened May 2017, no staff response
- [node-roon-api#23](https://github.com/RoonLabs/node-roon-api/issues/23) — opened Oct 2020, no staff response
- [Playlist write access in the extension API](https://community.roonlabs.com/t/playlist-write-access-in-the-extension-api/323174) — no staff reply

But there are two doors that do not go through the extension API at all:

**Roon imports playlist files from a watched folder.** `.m3u`, `.m3u8`, `.pls` and `.xspf` are all
supported ([Roon KB](https://help.roonlabs.com/portal/en/kb/articles/importing-playlists)).
Resolution is **by file path**, tracks must live in the same watched folder, and the resulting
playlist is not editable in Roon (only "Save a Local Copy").

**Roon syncs playlists two-way with Qobuz, TIDAL and KKBOX** as of March 2024
([Roon blog](https://blog.roonlabs.net/playlist-enhancements/)). Create a playlist in Qobuz and
Roon pulls it in as a real, editable Roon playlist. This is the workaround the community feature
request itself landed on.

Native sharing does not exist. Roon's own advice for "share a playlist with a friend" is to
[export to Excel and paste the table into a forum post](https://community.roonlabs.com/t/can-i-share-a-roon-playlist-made-by-me-to-the-community-or-other-roon-users/311029).
For streaming content Roon Labs [explicitly directs users to Soundiiz or a spreadsheet](https://help.roonlabs.com/portal/en/kb/articles/export),
because "TIDAL and Qobuz content is not stored locally".

No Roon playlist import/export/sharing extension exists. This is unbuilt ground.

## 2. Output paths

| Path | Produces | Works for | Status |
|---|---|---|---|
| **C** — extension-side playlist | A playlist in MusicD Remote, with Play now / Queue / Send to Roon | Everyone | **Chosen for phase 2** |
| **A** — create in Qobuz, let Roon sync | A real, *editable* Roon playlist | Qobuz users | Phase 4, needs a decision |
| **B** — write XSPF into a watched folder | A real, non-editable Roon playlist | Local files only | **Parked** |

**Why B is parked.** Two independent blockers. The `/music` scanner reads exactly one audio file
per album directory as a label/year probe and **never records a path** (`index.js:2764-2911`) —
there is no path index to build an M3U or XSPF from. And the reference Docker install mounts
`/music` read-only (`-v …:/music:ro`), so the extension cannot write a playlist file into the
watched folder without a config change on every user's box. Neither is fatal, but together they
make B the most expensive path for the narrowest audience.

**Why A is deferred, not rejected.** It is the only route to a genuine Roon playlist for a
streaming library, and it is what users actually want. It needs Qobuz `playlist/create` +
`playlist/addTracks` and track-level catalogue search, none of which we have — and it deepens our
dependence on an undocumented API. That is a decision to take deliberately, not to drift into.

**Why C is first.** It always works, depends on nothing external, and every piece of the output
side already exists: `/api/play-multi` (queue in order, per-zone lock, stale-offset defense) and
the "Send to Roon" flow that fills the queue for Roon's own *Add the queue to a Playlist*.

## 3. Format — JSPF, ListenBrainz dialect

[JSPF](https://ftp.osuosl.org/pub/xiph/websites/xspf.org/jspf/index.shtml.en) is the JSON
serialisation of [XSPF](https://www.xspf.org/spec), field-for-field. It is the only formally
specified, non-proprietary playlist interchange format, and JSON means no XML parser in a codebase
that has none.

Standard track fields carry most of what we need: `title`, `creator`, `album`, `trackNum`,
`duration` (milliseconds), plus two repeatable identity fields whose semantics are exactly right:

- `location` — a concrete resource URI
- `identifier` — "a canonical ID for this resource… likely to be a hash or location-independent
  name"; the spec explicitly frames this as the handle that enables content resolution

[MusicBrainz's JSPF extensions](https://musicbrainz.org/doc/jspf) define the rest:
`release_identifier`, `artist_identifiers`, and `additional_metadata` — a free dict which is
precisely where service-specific IDs belong (ListenBrainz itself puts `subsonic_id` there).

This buys interop with ListenBrainz and with
[listenbrainz-content-resolver](https://github.com/metabrainz/listenbrainz-content-resolver),
which is the same problem solved for a local collection: JSPF in, MBID match then fuzzy fallback.

### M3U is rejected

Not on taste — on capability. **M3U has nowhere to put an identifier of any kind.** `#EXTINF`
carries one free-text display string and a duration; `#EXTALB`/`#EXTART` are ad-hoc, unevenly
implemented, and still free text. Identity *is* the file path, which for a streaming-only library
is either absent or a service-internal URL the other end cannot resolve. A Roon user
[tried importing an M3U of Tidal/Qobuz tracks](https://community.roonlabs.com/t/importing-m3u-playlist-with-qobuz-and-tidal-tracks/214804);
it silently did nothing and the question was never answered.

M3U/XSPF stays on the table for exactly one job: watched-folder output for local files (path B).

### Wire format

    MDRP1:<base64url(gzip(JSON))>

A version magic so the schema can evolve and garbage can be rejected on paste. Primary transport
is a copy-paste text blob; secondary is a downloaded file (which doubles as watched-folder input if
path B is ever revived).

Transport ceilings, for reference:

| Mechanism | Practical ceiling |
|---|---|
| Copy-paste blob | ~10–50 KB before clipboards and chat apps misbehave |
| File download/upload | unbounded |
| QR code | v40/ECC-L is 2,953 bytes binary; at scannable density budget ~1.2–1.8 KB ≈ 15–25 tracks |
| URL fragment | ~8–16 KB; never sent to a server, but needs a page we host |

QR is an opt-in convenience below a size threshold, with an explicit "too big for QR" fallback.
Never embed cover art — third-party imagery, and it destroys every budget above.

## 4. Identity — the actual problem

**We persist zero exact identifiers.** No MusicBrainz ID, ISRC, UPC, or Qobuz/TIDAL ID for any
album or track. Worse, we *receive* several and throw them away:

| Identifier | Where it arrives | Where it is discarded |
|---|---|---|
| Qobuz album id | favourites sync | `index.js:2519` — `a.id` read, never persisted |
| TIDAL album id | favourites sync | `index.js:2550` — same |
| MB release-group id | `fetchAlbumYear` | `index.js:3745` — only `first-release-date` kept |
| Track number | every Roon tracklist | `stripTrackNumber()`, `index.js:1108` |

What is stored is canonical *text* keys only (`canonText(title) + "||" + canonArtist(artist)`).

### Why that matters, in numbers

[`spotify2qobuz`](https://github.com/lievencardoen/spotify2qobuz) is the only project found
publishing real counts rather than marketing claims: **89.25% resolved across 5,016 tracks** —
**4,847 matched by ISRC**, 169 by fuzzy fallback. Strip the ISRCs and the 3% path carries
everything. Soundiiz and SongShift both advertise ~95%, but those are vendor figures and are
treated here as unverified.

ISRC is a strong positive signal but is neither unique nor complete: reissues, remasters and
regional releases routinely get [fresh ISRCs](https://help.soundcharts.com/en/articles/10757483),
and the [same recording can carry several](https://community.metabrainz.org/t/same-recordings-with-multiple-isrc/473370).
**ISRC hit ⇒ near-certainly right. ISRC miss ⇒ says nothing.** Hence a waterfall, not a key.

### Capture order (cheapest first)

1. **Track numbers — free.** Already in `t.title` as Roon's `"N. "` prefix; `stripTrackNumber()`
   discards it at `index.js:1108`.
2. **Qobuz/TIDAL album ids — small.** Stop discarding at two call sites; widen
   `stream-albums.json` past `SOURCE_KEY_VERSION = 2`.
3. **ISRC / MBID / duration from file tags — medium.** `music-metadata` already exposes
   `isrc`, `musicbrainz_recordingid`, `musicbrainz_albumid`, `track.no`, `format.duration`. The
   blocker is that the scanner reads one file per directory; this needs a per-track walk.
4. **MB normalisation at export only.** [`/ws/2/isrc/<isrc>`](https://musicbrainz.org/doc/MusicBrainz_API)
   is public, core data is CC0, **1 request/second** with a mandatory identifying User-Agent.
   Acceptable as a one-off pass when *creating* a share file. Never in an import loop.

### Resolution waterfall (import)

1. Same-service id present and the importer has that service → exact hit
2. ISRC → service lookup, or against ISRCs harvested from local file tags → high confidence
3. UPC → album, then `trackNum` → track (catches the multi-ISRC-per-reissue case)
4. Normalised text **gated on duration within ±3 s** — duration is the cheapest defence against
   the studio-vs-live substitution that sinks the weaker transfer services
5. Fuzzy, threshold ≥85, surfaced as **"probable match, confirm"** — never silently accepted

Reuse, do not reimplement. The matching stack already exists and is test-pinned:

| Function | index.js | Does |
|---|---|---|
| `canonText` / `canonArtist` | 2431 / 2436 | drops `"and"` tokens ⇒ the `&`/`and` tolerance |
| `albumKeys(title, subtitle)` | 2457 | every identity one album can match under |
| `addFavouriteKeys` | 2477 | edition tolerance — indexes both `Album` and `Album (Deluxe)` |
| `creditHasArtist(credit, artist)` | 4438 | v1.6.56 whole-name artist match; **never** substring |
| `findAlbumViaSearch` | 904 | text → album via Roon's search hierarchy, artist-gated (4 Core calls) |
| `relocateAlbumOffset` / `albumIdentityMatches` | 1128 / 1120 | in-memory resolve, zero Core calls |
| `ambiguousAlbumKeys` | 2747 | identities held by >1 album — refuse a coin-flip rather than guess |
| `searchAlbums` / `scoreAlbum` | 4759 / 4666 | ranked fuzzy search over the snapshot, zero Core calls |

## 5. Costs and shape

**No track index exists.** `albumIndex` stores nothing below album level; the SQLite schema has no
track table. Locating a named track means opening its album: `loadAlbumSession()` is **5 Core
calls**, `invokeTrackAction()` is **8** (it re-opens the album every time).

For a 50-track shared playlist over ~40 distinct albums:

- album-granularity output: **~320 Core calls**
- true track-granularity: **~600** (or ~350 with a session-reusing helper that does not yet exist)

Calibrating against v1.7.18 (400 albums ≈ 2,800 calls ≈ "minutes"), that is roughly 30–90 seconds.
Technically it fits in one HTTP request; practically it must not. v1.7.18 established why: there is
no server timeout, no client `AbortController`, and a dropped fetch leaves a run that nothing can
cancel — which is what forced the per-zone lock and the "Lost contact" message.

**So: page the resolution**, mirroring `/api/smart-playlist`'s `SMART_ALBUM_PAGE = 8` batching.
Every request stays seconds long, progress is live, and the resolved list goes to `/api/play-multi`
in one short final call.

**One unexploited hook:** `findAlbumViaSearch` reads only the Albums section of Roon's search
results (`index.js:934`). Roon almost certainly returns a Tracks section too. That is the cheapest
available route to track resolution and it is currently unused.

## 6. Import cannot be atomic

When a shared track is not in the importer's library, we can favourite the album on Qobuz/TIDAL —
that is the documented mechanism that makes it appear in Roon. But then Roon's Core must sync it,
and the snapshot model **deliberately** will not rebuild during an import (v1.6.47). Realistically:
minutes plus a manual Rescan, or up to 12 hours on the automatic cycle.

Therefore the primary deliverable of an import is **a resolution report**, not a playing playlist:

> 42 of 45 resolved · 2 low-confidence, confirm · 1 not found ·
> 6 albums added to your Qobuz favourites — Rescan after Roon syncs them

Every tool in this space silently produces wrong-version matches. Showing the misses is the
difference between a feature that is trusted and one that is not.

## 7. Storage

An imported playlist is an **ordered list of specific entries**. A smart playlist is a *query*
(`sanitizeLibView` over a `libraryView`) — that is what makes it smart, and it structurally cannot
hold one. This needs a new record type.

It must **not** live in `settings.json`:

- `savePersistedSettings` is `Object.assign(cur, patch)` with **no key whitelist**
  (`index.js:1491`), and `loadPersistedSettings` returns the **live mutable cache**
  (`index.js:1483`)
- that file holds `qobuzPasswordMd5`, `tidalRefreshToken`, `discogsToken`, `youtubeKey`
- it is written with a plain `writeFileSync` — **not atomic**, unlike `writeJsonAtomic`
  (`index.js:2326`) used by every other data file

Imported playlists go in **`data/playlists.json`, written via `writeJsonAtomic`, with a `v:` stamp**
— matching `local-albums.json` / `stream-albums.json`. Third-party content stays out of the file
holding credentials.

## 8. Security

This feature accepts a document authored by a stranger and acts on it, on a server that
**has no authentication of any kind** — no auth, no CORS policy, no CSRF token, bound to
`0.0.0.0:3399` under `--network host`, holding the credentials listed above. That is a pre-existing
property of the design and is acceptable for a trusted home LAN; it is the backdrop against which
every decision below is made.

| # | Risk | Mitigation |
|---|---|---|
| S1 | Settings pollution / credential overwrite via unwhitelisted keys | Fresh-object-literal normaliser (the `sanitizeLibView` / `smartPlaylistRecord` pattern); store outside settings.json |
| S2 | Unbounded arrays driving Roon calls — **`/api/play-multi` has no server-side cap today**; the 400 ceiling is client-side only. 1 MB body ≈ 4,000 items ≈ 28,000 Core calls | Clamp server-side. Fix independently of this feature |
| S3 | XSS — the artist view interpolates names into `innerHTML` unescaped (`app.js:7956`, `7962`, `8002`). Inert today because names come only from the user's own library; an imported playlist makes that string attacker-controlled | Escape, or rebuild as `textContent`. **Pre-flight step 4 does not catch this** — it hunts innerHTML *reads*, not unescaped writes |
| S4 | CSRF on a no-auth origin | Import is **POST + JSON only**. Never GET, never "import from URL" |
| S5 | Prototype pollution via `__proto__` in parsed JSON | Eliminated by the fresh-object-literal normaliser (never `Object.assign` parsed input into live state) |
| S6 | Path traversal via a filename from the file | Never put an imported name into `path.join`. Key on a generated id; sanitise `Content-Disposition` |
| S7 | Storage exhaustion | Cap imported playlists and entries per playlist, as `SMART_MAX = 50` already does |
| S8 | Information disclosure through export | Build the payload field-by-field. Never serialise a settings subtree |
| S9 | Confidently wrong matches | Require artist, consult `ambiguousAlbumKeys`, report unresolved rather than dropping (the v1.7.17 "silently queued 100" lesson) |

## 9. Phasing

- **1a — export.** JSPF serialiser, optional ID slots present from day one, track numbers
  recovered. Export from a Roon playlist and from a smart playlist. Copy blob + file download.
- **1b — identity capture.** Stop discarding Qobuz/TIDAL album ids; `stream-albums.json` schema
  bump. Optional: file-tag ISRC/MBID/duration via a per-track scanner walk.
- **2 — import.** New persisted record type in `data/playlists.json`, resolution waterfall, paged
  like `/api/smart-playlist`, opens as a playlist screen (the v1.7.12 shape).
- **3 — resolution report** + favourite-the-missing on Qobuz/TIDAL.
- **4 — Qobuz playlist creation** (decision required; the only route to a real Roon playlist).

Expect **~85–90%** resolution for pop/rock between two well-stocked accounts, materially worse for
classical, niche and regionally-gapped catalogue. No tool in this space documents any handling of
classical work/movement/performer structure. Do not promise better.

## 10. Legal / ToS

- **TIDAL developer terms are non-commercial only** and prohibit circumventing API restrictions
  ([terms](https://developer.tidal.com/documentation/guidelines-developer-terms-1_0)). Fine for a
  free extension.
- **Qobuz has no public API.** Our favourites integration (v1.5.79+) already depends on the
  undocumented one. Phase 4 would put a headline feature on that footing — an explicit decision,
  not a drift.
- **MusicBrainz**: free non-commercial, 1 req/s, mandatory identifying User-Agent; core data CC0,
  so caching MBIDs/ISRCs locally is clean.
- **The shared document is metadata, not audio** — no distribution issue. Keep it that way.

## 11. Open questions

- Does Roon's XSPF importer honour `<identifier>` or a non-`file:` `<location>`? Undocumented; the
  one forum question went unanswered. **One hand-written XSPF in a watched folder settles it**, and
  a yes would revive path B.
- Does Roon's search hierarchy expose a Tracks section we can drill (`index.js:934`)?
- Do Roon browse items expose any stable Qobuz/TIDAL identifier? Item keys are session-scoped and
  opaque, so probably not.
