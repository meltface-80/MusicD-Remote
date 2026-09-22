# How MusicD Remote draws waveforms for Qobuz and TIDAL

## The constraint

A Roon extension is given metadata and control. It is never given audio. There is no
API that hands you the PCM Roon is sending to a zone, and there should not be — so
the waveform under the seek bar cannot come from the thing you are listening to.

For local files that is fine: the extension can see `/music`, so it opens the file
itself. For a Qobuz or TIDAL stream there is no file, and the extension has to go and
get its own copy of the audio from the service, independently of Roon, purely to
measure it.

That is the whole feature. Everything below is the consequence of it.

## Step 1 — work out what is playing

Roon tells you a track title, an artist, an album and a duration. It does **not** tell
you which service the audio is coming from. I checked this properly rather than
assuming it: I dumped every key Roon exposes on a `now_playing` object while streaming,
and not one of them names a source. There is no field to read.

So identity is the only signal. Every album, from any source, is reduced to a key:

```
canonicalTitle || canonicalArtist        e.g.  "zebra iv||zebra"
```

Canonicalisation is NFKD, diacritics stripped, every run of non-alphanumerics collapsed
to a single space. That last part matters more than it sounds — it is what makes
`Don't Panic` and `Don’t Panic` the same string, and getting it wrong in one place
while getting it right in another cost me a release.

One album generates several keys: one per credited artist (Roon credits collaborations
in full, the services usually credit one), and one per title variant, so
`Rumours (Deluxe Edition)` is filed under `rumours` as well as its full title. The
lookup side and the index side run the **same** builder. They have to — if the two
disagree, the source badge says an album is there and the waveform then cannot find it.

## Step 2 — turn an identity into a service album ID

You cannot ask Qobuz for a track list without its album ID, and identity alone will not
get you one. Two sources:

**Favourites.** On connect and on each library sync, the extension pages the user's
favourite albums out of `favorite/getUserFavorites` (Qobuz) and
`/users/{id}/favorites/albums` (TIDAL), and builds `identityKey → albumId`. This is the
primary route, and it is the right one, because an album in a Roon library that came
from a streaming service *is* a favourite in that service — that is how Roon's
integration works.

Page to exhaustion, driven by the `total` each API states. I had a fixed page count
here and it silently truncated at 10,000 albums: everything past it had no badge, no ID
and no waveform, forever, with no error anywhere. A capped read looks exactly like a
complete one unless you read the total back.

**Catalogue search**, as a fallback for an album genuinely played from search without
being added. `catalog/search`, then an exact identity match against the same key
builder, and **decline on ambiguity** — Qobuz answers a query it cannot place with its
nearest guess rather than with nothing, so "the top result" is never an answer.

## Step 3 — pick the track

Fetch the album's track list (`album/get`, unsigned; paged, because that endpoint
paginates too and a box set loses its tail if you ignore it). Then match:

- canonical title equality first, containment only if nothing matched exactly and only
  when it is unambiguous;
- **and the duration must agree within ±2 seconds.**

The duration gate is the important half. Remasters, radio edits, live versions and
deluxe pressings all carry the same title, and a waveform of the wrong master looks
completely authoritative while being a different recording. Both numbers round to whole
seconds from the same metadata, so ±2 separates rounding from a different take.

It is also the safety net under everything upstream: if the album ID resolved to the
wrong pressing, every track fails this check and nothing is drawn. Being wrong here
costs a blank bar, not a lie.

## Step 4 — get the audio

**Qobuz** is the awkward one. `track/getFileUrl` is the only signed endpoint in the
whole client. The signature is MD5 over the object and method, then every parameter
name immediately followed by its value sorted **by name**, then the unix timestamp,
then the app secret. Sort order is not cosmetic — the server rebuilds the string its own
way and compares, and a misordered one fails identically to a wrong secret, with no
error that distinguishes them.

The part that cost me six versions: a valid signed request needs an `app_id`, *that
app's* secret, and a `user_auth_token` minted **by that same app**. Three things that
have to agree. A username/password login mints a token under an app whose secret you do
not have, so no arrangement of what I already held could ever sign. The way out was to
stop trying: sign in on Qobuz's own page via the redirect flow, which mints a token
under the app whose secret ships — so all three agree by construction rather than by
luck. The redirect address is taken from the inbound request, so it works unchanged in
Docker and from a phone with nothing to configure.

Qobuz refuses by *answering*: HTTP 200 with `sample: true` is the 30-second preview,
meaning the account cannot stream that track. Treating "we got JSON" as success draws
30 seconds of audio across a five-minute bar, which looks like the track and is not.

It asks for format 5 (MP3 320) deliberately. The bytes are measured and discarded, so
pulling a hi-res FLAC to compute an envelope would be bandwidth spent on nothing.

**TIDAL** signs nothing — the existing device sign-in carries a Bearer token that
refreshes itself, so there is no credential to go stale and nothing for the user to
reconnect. It is harder in one respect: `playbackinfopostpaywall` does not return a URL,
it returns a base64 manifest.

- `application/vnd.tidal.bt` — "BTS", plain JSON with direct audio URLs. This is the one
  I read.
- `application/dash+xml` — the higher tiers, delivered in a protected container.
  **Refused outright.** Decrypting protected audio is a line this project does not
  cross, and that refusal is the correct outcome rather than a gap to close later.

Quality is requested as `LOW`, for the same reason as Qobuz's format 5.

## Step 5 — decode and measure

The response body is a web `ReadableStream`; it is adapted to a Node `Readable` and
piped into ffmpeg's stdin. Nothing is written to disk and nothing is buffered whole.

```
ffmpeg -i - -map 0:a:0 -f s16le -ac 2 -ar 44100 -
```

Two channels, not one. `-ac 1` *averages* the channels rather than taking the louder, so
an out-of-phase passage decodes to silence — I measured an RMS of 0 against the pair's
2896. And 44100 rather than a reduction, because nearly every file already is 44.1k, so
downsampling buys nothing and a low rate lowpasses the cymbals and snare cracks away
before they can register.

A stored value is the **RMS** of its slice. Not the peak. A limiter puts something on
the ceiling inside almost any window you can name, so "was anything loud in here?" is
yes everywhere and every bar comes out the same height — that is the brick the first
five versions drew. The reduction is RMS too, because the RMS of RMS values *is* the RMS
of the whole span: a bucket folded twice equals one computed once, so the picture does
not depend on how many bars happen to fit the screen. Measuring a level and then keeping
the loudest is the same mistake one layer down.

Levels accumulate at a fixed 10 ms stride while the audio streams, then resample to 4000
buckets, one byte each — 4 KB a track. The browser folds those to device-pixel pitch the
same way, for the same reason.

If the decode covers less than 90% of the duration Roon reported, it is **refused**. A
truncated download is indistinguishable from a short track, and stretching two thirds of
a file across the whole bar puts the playhead over the wrong music by a margin that grows
as it plays, with nothing about it looking wrong.

## Step 6 — store it

SQLite on the data volume, keyed by `qobuz:<albumId>` or `tidal:<albumId>` plus the track
title. The analysis parameters — statistic, rate, channels — are stamped beside the table,
and any change to them wipes it. A library holding two generations of measurement draws
two kinds of picture with nothing to say which is which, which is worse than either alone
because the inconsistency is invisible.

The next item in the queue is decoded while the current one plays. One ahead, never more:
the queue reshuffles constantly and anything further is CPU spent on a guess.

## What it will not do

Every decline above resolves to the same thing — the plain progress bar. No waveform is
always an acceptable answer. A wrong one never is.

If you want to see where a particular track stops, `GET /api/debug/waveform?deep=1` walks
the real chain (it shares its implementation with the playback path, so it cannot drift
from it) and names the exact step, without decoding anything.
