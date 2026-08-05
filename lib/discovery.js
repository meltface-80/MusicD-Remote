/*
 * Discovery data sources for Smart Picks — artist similarity and genre rosters.
 *
 * Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
 * Released under the MIT License.
 *
 * Three keyless, public reads. None of them touches the Roon Core: Smart Picks
 * costs the Core exactly nothing beyond the sync it already runs.
 *
 *   1. ListenBrainz Labs similar-artists (CC0). The primary graph. Takes
 *      MusicBrainz artist MBIDs and returns similar artists WITH their own
 *      MBIDs and a score, so candidates carry a stable identity and never have
 *      to be re-matched by name.
 *   2. ListenBrainz sitewide top artists. The hub list — see topArtists.
 *   3. MusicBrainz artist search by tag. The roster for the stretch pick —
 *      it returns a genre's canonical names first (flamenco => Camarón de la
 *      Isla, Paco de Lucía), which is what keeps the daily stretch defensible
 *      rather than a random unknown.
 *
 * A NOTE ON SEED CHOICE, because it decides whether this feature is any good:
 * similarity quality INVERTS with seed popularity. Seeding from a library's
 * biggest names returns the airport bookshop of music (Radiohead => Nirvana,
 * RHCP, Coldplay). Seeding from its obscure end returns real discoveries
 * (Bark Psychosis => Mogwai, Talk Talk, Tortoise, Slint, Labradford). The
 * seed policy lives in index.js; this module just has to not get in its way,
 * which is why nothing here re-sorts by score.
 */

// The similar-artists endpoint validates `algorithm` against a fixed enum and
// rejects anything else with a 400. This is one of the published values; it is
// the widest window (days_9000) with the tightest contribution threshold, which
// is the combination that most favours durable associations over recent noise.
const LB_ALGORITHM =
  "session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30";

const LB_BASE = "https://labs.api.listenbrainz.org/similar-artists/json";
const LB_STATS = "https://api.listenbrainz.org/1/stats/sitewide/artists";
const MB_BASE = "https://musicbrainz.org/ws/2/artist";
const DEEZER_BASE = "https://api.deezer.com";

// The sitewide chart caps at 1000 however many are asked for.
const LB_TOP_MAX = 1000;

// Seeds per similar-artists request. The endpoint accepts any number of
// REPEATED artist_mbids params (a comma-joined list is rejected — it validates
// the whole string as one UUID), and returns every seed's neighbours in a
// single response. Batching is therefore free, but a batch is also the unit of
// failure: at 10 a timeout costs ten seeds' worth of candidates, not forty.
const LB_BATCH = 10;

async function getJson(url, headers, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctl.signal });
    if (!res.ok) {
      const e = new Error("HTTP " + res.status);
      e.code = res.status;
      throw e;
    }
    try {
      return await res.json();
    } catch (e) {
      // A 200 carrying HTML — ListenBrainz serves a maintenance page this way,
      // and MusicBrainz an error page. Surface it as a plain message rather
      // than leaking a JSON SyntaxError to the caller.
      throw new Error("non-JSON response");
    }
  } finally {
    clearTimeout(timer);
  }
}

// Similar artists for a batch of seed MBIDs.
//
// Returns [{ mbid, name, comment, type, score, seed }] where `seed` is the
// MBID of the library artist this candidate came from — the endpoint reports
// it as reference_mbid, and it is the whole basis of distance ranking: a
// candidate reachable from ONE obscure seed is a better find than one
// reachable from twelve, and without this field that is not computable.
//
// Rows are returned in the endpoint's own order, deliberately unsorted.
async function similarArtists(mbids, opts) {
  opts = opts || {};
  const seeds = (mbids || []).filter(Boolean);
  if (!seeds.length) return [];
  const qs = new URLSearchParams();
  for (const id of seeds) qs.append("artist_mbids", id);
  qs.append("algorithm", opts.algorithm || LB_ALGORITHM);
  const rows = await getJson(LB_BASE + "?" + qs.toString(), {}, opts.timeoutMs || 25000);
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.artist_mbid || !r.name) continue;
    out.push({
      mbid:    String(r.artist_mbid),
      name:    String(r.name),
      comment: r.comment ? String(r.comment) : "",
      type:    r.type ? String(r.type) : "",
      score:   Number(r.score) || 0,
      seed:    r.reference_mbid ? String(r.reference_mbid) : ""
    });
  }
  return out;
}

// Same, for any number of seeds — batched, and tolerant of a batch failing.
//
// One dead batch must not empty the whole candidate pool, so a rejection is
// reported through onError and the remaining batches still run. Returns the
// concatenated rows.
async function similarArtistsBatched(mbids, opts) {
  opts = opts || {};
  const seeds = (mbids || []).filter(Boolean);
  const out = [];
  for (let i = 0; i < seeds.length; i += LB_BATCH) {
    const batch = seeds.slice(i, i + LB_BATCH);
    try {
      const rows = await similarArtists(batch, opts);
      for (const r of rows) out.push(r);
    } catch (e) {
      if (opts.onError) opts.onError(e, batch);
    }
  }
  return out;
}

// The most-listened artists on ListenBrainz, all time — the "hub" list.
//
// One request for the world's 1000 biggest artists, which is the cheapest
// possible popularity oracle and the one thing that makes the seed policy
// implementable. It is used twice:
//
//   1. a library artist on this list is never used as a SEED (seeding from
//      Radiohead returns Nirvana, RHCP and Coldplay — the exact opposite of
//      discovery), and
//   2. a candidate on this list is not a discovery either, whatever its
//      similarity score says.
//
// Returns [{ mbid, name, listens }] in descending listen order. Rows without an
// MBID are kept: name matching is the fallback identity for the seed check.
async function topArtists(opts) {
  opts = opts || {};
  const qs = new URLSearchParams({
    count: String(Math.min(opts.count || LB_TOP_MAX, LB_TOP_MAX)),
    range: opts.range || "all_time"
  });
  const json = await getJson(LB_STATS + "?" + qs.toString(), {}, opts.timeoutMs || 25000);
  const rows = json && json.payload && json.payload.artists;
  if (!Array.isArray(rows)) return [];
  return rows.filter(a => a && a.artist_name).map(a => ({
    mbid:    a.artist_mbid ? String(a.artist_mbid) : "",
    name:    String(a.artist_name),
    listens: Number(a.listen_count) || 0
  }));
}

// Artists carrying a MusicBrainz tag, in MusicBrainz's own relevance order.
//
// Relevance order is the point: it puts a genre's canonical figures first,
// which is what makes a stretch pick defensible ("this is the record people
// point to in this genre") instead of a random unknown the user will dismiss
// without listening. Callers must NOT re-sort this.
async function artistsByTag(tag, opts) {
  opts = opts || {};
  const t = String(tag || "").trim();
  if (!t) return [];
  const qs = new URLSearchParams();
  // Lucene: quote the tag so multi-word genres ("hindustani classical") are one
  // term. A quote inside the tag would break out of it, so they are dropped —
  // no MusicBrainz tag contains one.
  qs.set("query", 'tag:"' + t.replace(/"/g, "") + '"');
  qs.set("fmt", "json");
  qs.set("limit", String(opts.limit || 25));
  if (opts.offset) qs.set("offset", String(opts.offset));
  const json = await getJson(MB_BASE + "?" + qs.toString(),
    { "User-Agent": opts.userAgent || "MusicD-Remote" }, opts.timeoutMs || 15000);
  const artists = json && json.artists;
  if (!Array.isArray(artists)) return [];
  return artists.filter(a => a && a.id && a.name).map(a => ({
    mbid:    String(a.id),
    name:    String(a.name),
    comment: a.disambiguation ? String(a.disambiguation) : "",
    type:    a.type ? String(a.type) : "",
    country: a.country ? String(a.country) : "",
    score:   Number(a.score) || 0,
    tags:    Array.isArray(a.tags)
      ? a.tags.filter(x => x && x.name).map(x => String(x.name))
      : []
  }));
}

module.exports = {
  similarArtists, similarArtistsBatched, topArtists, artistsByTag,
  LB_ALGORITHM, LB_BATCH, LB_TOP_MAX
};
