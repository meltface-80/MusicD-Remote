// roon-random-albums  —  random-album wall extension for Roon
// Runs alongside Roon Server, exposes a web UI on http://<host>:3399
//
// Copyright (c) 2026 Lewis Menzies (Music Duck / MusicD)
// Released under the MIT License. See the LICENSE file for details.

const path = require("path");
const fs   = require("fs");
const express = require("express");

const RoonApi          = require("node-roon-api");
const RoonApiStatus    = require("node-roon-api-status");
const RoonApiBrowse    = require("node-roon-api-browse");
const RoonApiImage     = require("node-roon-api-image");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiSettings  = require("node-roon-api-settings");

const { createUpdater } = require("./lib/updater");
const { radioDecision } = require("./lib/radio");
const pkg = require("./package.json");

const PORT       = parseInt(process.env.PORT || "3399", 10);
const ALBUM_COUNT_DEFAULT = 24;
const DEBUG      = process.env.RRA_DEBUG === "1";

// ---------------------------------------------------------------------------
// Self-updater (checks GitHub; install offered in the web UI and Roon settings)
// ---------------------------------------------------------------------------
const REPO = (() => {
  const src = (pkg.repository && pkg.repository.url) || pkg.homepage || "";
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/i.exec(src);
  return m ? { owner: m[1], repo: m[2] }
           : { owner: "meltface-80", repo: "Roon-Random-Albums-Extension" };
})();
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // re-check GitHub every 6 hours
const updater = createUpdater({
  owner: REPO.owner, repo: REPO.repo,
  currentVersion: pkg.version,
  dir: __dirname,
  viaLauncher: process.env.RRA_VIA_LAUNCHER === "1",
  token: process.env.RRA_GITHUB_TOKEN || null,
  debug: DEBUG
});

// ---------------------------------------------------------------------------
// Roon extension setup
// ---------------------------------------------------------------------------
let core      = null;
let zones     = {};
let outputs   = {};
const scrobbleState = new Map();

const roon = new RoonApi({
  extension_id:        "com.local.roon.random-albums",
  display_name:        "Random Albums",
  display_version:     pkg.version,
  publisher:           "self",
  email:               "you@example.com",
  log_level:           "none",

  core_paired: function (c) {
    core = c;
    _statusPair = "Paired with " + c.core_id; _statusPairErr = false; pushStatus();
    c.services.RoonApiTransport.subscribe_zones((cmd, data) => {
      if (cmd === "Subscribed") {
        zones = {}; outputs = {};
        (data.zones || []).forEach(z => {
          zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; });
          handleRadioZone(z);
          scrobbleUpdate(z);
        });
      } else if (cmd === "Changed") {
        (data.zones_added   || []).forEach(z => { zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; }); handleRadioZone(z); scrobbleUpdate(z); });
        (data.zones_changed || []).forEach(z => { zones[z.zone_id] = z;
          (z.outputs || []).forEach(o => { outputs[o.output_id] = o; }); handleRadioZone(z); scrobbleUpdate(z); });
        (data.zones_removed || []).forEach(zid => {
          const z = zones[zid];
          if (z) (z.outputs || []).forEach(o => delete outputs[o.output_id]);
          delete zones[zid];
        });
      }
    });
    // Build the local search index in the background and keep it fresh.
    startIndexMaintenance();
  },
  core_unpaired: function () {
    core = null; zones = {}; outputs = {};
    stopIndexMaintenance();
    albumIndex.albums = []; albumIndex.count = 0;
    albumIndex.builtAt = 0; albumIndex.progress = 0;
    _statusPair = "Not paired with any Roon Core"; _statusPairErr = true; pushStatus();
  }
});

// ---- Roon status line (pairing state + any update notice) ----
let _statusPair = "Starting\u2026";
let _statusPairErr = false;
function pushStatus() {
  const st = updater.getStatus();
  let extra = "";
  if (st.apply.phase === "downloading" || st.apply.phase === "extracting") extra = "  \u2022  Updating\u2026";
  else if (st.apply.phase === "restarting") extra = "  \u2022  Restarting to update\u2026";
  else if (st.available) extra = `  \u2022  Update available: v${st.latest} \u2014 install from the web app or this Settings page`;
  try { svc_status.set_status(_statusPair + extra, _statusPairErr); } catch (e) {}
}
async function updateCheckTick() {
  try { await updater.checkNow(); } catch (e) {}
  pushStatus();
}

// ---- Roon Settings: show version + offer to install an update ----
function makeSettingsLayout() {
  const st = updater.getStatus();
  const layout = [];
  const values  = { do_update: "no", do_check: "no" };

  // --- Random Album Radio per zone ---
  layout.push({ type: "label", title: "\u2500\u2500\u2500 Random Album Radio \u2500\u2500\u2500" });
  const knownZones = Object.values(zones || {}).sort((a, b) =>
    (a.display_name || "").localeCompare(b.display_name || ""));
  if (knownZones.length === 0) {
    layout.push({ type: "label", title: "No zones visible yet \u2014 open the Roon app first." });
  } else {
    for (const z of knownZones) {
      const settingKey = "radio_" + z.zone_id;
      values[settingKey] = radioZones.has(z.zone_id) ? "yes" : "no";
      layout.push({
        type: "dropdown", title: z.display_name,
        setting: settingKey,
        values: [
          { title: "Off", value: "no" },
          { title: "On \u2014 random album radio", value: "yes" }
        ]
      });
    }
  }

  // --- Updates ---
  layout.push({ type: "label", title: "\u2500\u2500\u2500 Updates \u2500\u2500\u2500" });
  if (st.apply.phase === "downloading" || st.apply.phase === "extracting" || st.apply.phase === "restarting") {
    layout.push({ type: "label", title: "Installing update\u2026 the extension will restart shortly." });
  } else if (st.checking) {
    layout.push({ type: "label", title: "Checking GitHub for updates\u2026" });
  } else if (st.error) {
    layout.push({ type: "label", title: "Update check problem: " + st.error });
  } else if (st.available) {
    layout.push({ type: "label", title: "An update is available: v" + st.latest + "." });
    if (st.notes) layout.push({ type: "label", title: "Notes: " + st.notes.slice(0, 280) });
    layout.push({
      type: "dropdown", title: "Install update", setting: "do_update",
      values: [
        { title: "Keep v" + pkg.version, value: "no" },
        { title: "Install v" + st.latest + " now (restarts the extension)", value: "yes" }
      ]
    });
  } else {
    layout.push({ type: "label", title: "You're on the latest version." });
    layout.push({
      type: "dropdown", title: "Check for updates", setting: "do_check",
      values: [
        { title: "No action", value: "no" },
        { title: "Check now", value: "yes" }
      ]
    });
  }

  return { values, layout, has_error: false };
}

const svc_status = new RoonApiStatus(roon);
const svc_settings = new RoonApiSettings(roon, {
  get_settings: function (cb) { cb(makeSettingsLayout()); },
  save_settings: function (req, isdryrun, settings) {
    const vals = settings.values || {};
    const l = makeSettingsLayout();

    // Apply radio zone toggles immediately (even on dry run for live preview).
    for (const [k, v] of Object.entries(vals)) {
      if (!k.startsWith("radio_")) continue;
      const zoneId = k.slice(6);
      if (v === "yes") radioZones.add(zoneId);
      else radioZones.delete(zoneId);
    }
    if (!isdryrun) persistRadio();

    l.values.do_update = vals.do_update || "no";
    l.values.do_check  = vals.do_check  || "no";
    req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

    if (!isdryrun) {
      if (l.values.do_update === "yes") {
        svc_settings.update_settings(makeSettingsLayout());
        updater.apply().then(() => { pushStatus(); refreshSettings(); }).catch(() => {});
      }
      if (l.values.do_check === "yes") {
        svc_settings.update_settings(makeSettingsLayout());
        updater.checkNow().then(() => { pushStatus(); refreshSettings(); }).catch(() => {});
      }
    }
  }
});
function refreshSettings() { try { svc_settings.update_settings(makeSettingsLayout()); } catch (e) {} }

roon.init_services({
  required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
  provided_services: [svc_status, svc_settings]
});
_statusPair = "Starting\u2026"; pushStatus();
roon.start_discovery();

// Begin background update checks (independent of Roon pairing).
updateCheckTick();
const _updTimer = setInterval(() => { updateCheckTick(); refreshSettings(); }, UPDATE_CHECK_MS);
if (_updTimer.unref) _updTimer.unref();

// ---------------------------------------------------------------------------
// Promisified Roon calls
// ---------------------------------------------------------------------------
function browse(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    if (DEBUG) console.log("[browse]", JSON.stringify(opts));
    core.services.RoonApiBrowse.browse(opts, (err, body) => {
      if (err) return reject(new Error(typeof err === "string" ? err : JSON.stringify(err)));
      if (DEBUG) console.log("[browse:res]", body && body.action, body && body.list && body.list.title);
      resolve(body);
    });
  });
}
function load(opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    if (DEBUG) console.log("[load]", JSON.stringify(opts));
    core.services.RoonApiBrowse.load(opts, (err, body) => {
      if (err) return reject(new Error(typeof err === "string" ? err : JSON.stringify(err)));
      if (DEBUG) console.log("[load:res]", body && body.list && body.list.title,
                            "items:", (body && body.items || []).length);
      resolve(body);
    });
  });
}
function getImage(image_key, opts) {
  return new Promise((resolve, reject) => {
    if (!core) return reject(new Error("Not paired with a Roon Core yet"));
    core.services.RoonApiImage.get_image(image_key, opts, (err, content_type, body) =>
      err ? reject(new Error(typeof err === "string" ? err : JSON.stringify(err)))
          : resolve({ content_type, body }));
  });
}


// ---------------------------------------------------------------------------
// Filtered album lists (genre / tag).
//
// The Browse API has no native Focus, so filtering works by navigating to a
// list that already contains only the wanted albums:
//   - genre: hierarchy "genres" → [genre] → its "Albums" child list
//   - tag:   hierarchy "browse" → Library → Tags → [tag] (→ "Albums" child
//            if the tag mixes item types)
// Roon's exact tree labels aren't formally documented, so the walkers below
// discover children by title at runtime and fail with a descriptive error
// (see /api/debug/filter to dump what a level actually contains).
// ---------------------------------------------------------------------------

// Page through the current list level of `hierarchy` looking for an item
// whose title matches (case-insensitive). Returns the item or null.
async function findItemByTitle(sessionKey, hierarchy, title, maxScan) {
  const want = String(title).trim().toLowerCase();
  const limit = maxScan || 3000;
  const page = 100;
  for (let off = 0; off < limit; off += page) {
    const r = await load({ hierarchy, offset: off, count: page, multi_session_key: sessionKey });
    const items = r.items || [];
    for (const it of items) {
      if ((it.title || "").trim().toLowerCase() === want) return it;
    }
    const total = r.list && r.list.count ? r.list.count : 0;
    if (off + page >= total || items.length === 0) break;
  }
  return null;
}

// Load every item at the current level (small lists: genres, tags, children).
async function loadLevel(sessionKey, hierarchy, max) {
  const out = [];
  const page = 100;
  const limit = max || 2000;
  let total = 0;
  for (let off = 0; off < limit; off += page) {
    const r = await load({ hierarchy, offset: off, count: page, multi_session_key: sessionKey });
    total = r.list && r.list.count ? r.list.count : 0;
    out.push(...(r.items || []));
    if (off + page >= total || (r.items || []).length === 0) break;
  }
  return { items: out, total };
}

// Locate the "Labels" node in the browse tree. Roon doesn't formally document
// where labels live, so discover at runtime: try Library → Labels first, then
// the browse root. Throws descriptively if no such list exists (see
// /api/debug/labels to dump what the tree actually contains).
async function findLabelsNode(sessionKey) {
  const hierarchy = "browse";
  await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
  const lib = await findItemByTitle(sessionKey, hierarchy, "Library", 50);
  if (lib) {
    await browse({ hierarchy, item_key: lib.item_key, multi_session_key: sessionKey });
    const node = await findItemByTitle(sessionKey, hierarchy, "Labels", 200);
    if (node) return node;
  }
  // Fall back to a top-level "Labels" entry.
  await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
  const atRoot = await findItemByTitle(sessionKey, hierarchy, "Labels", 200);
  if (atRoot) return atRoot;
  throw new Error('Couldn\'t find a "Labels" list in the Roon browse tree');
}

// Navigate the session to the level that lists albums for the given filter.
// filter: null | { type: "genre"|"tag"|"label", value: "<title>" }
// Returns { hierarchy, total } with the session positioned on the album list.
async function navigateToAlbumList(sessionKey, filter) {
  if (!filter) {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
    return { hierarchy: "albums", total: (head.list && head.list.count) || 0 };
  }

  if (filter.type === "genre") {
    const hierarchy = "genres";
    await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
    const genre = await findItemByTitle(sessionKey, hierarchy, filter.value);
    if (!genre) throw new Error(`Genre "${filter.value}" not found`);
    await browse({ hierarchy, item_key: genre.item_key, multi_session_key: sessionKey });
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (!albumsChild) {
      throw new Error(`Couldn't find an "Albums" list inside genre "${filter.value}". ` +
        `Level contains: ` + lvl.items.map(i => i.title).slice(0, 12).join(", "));
    }
    const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
    let total = (into.list && into.list.count) || 0;
    if (!total) {
      const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
      total = (head.list && head.list.count) || 0;
    }
    return { hierarchy, total };
  }

  if (filter.type === "tag") {
    const hierarchy = "browse";
    await browse({ hierarchy, pop_all: true, multi_session_key: sessionKey });
    const lib = await findItemByTitle(sessionKey, hierarchy, "Library", 50);
    if (!lib) throw new Error('Couldn\'t find "Library" in the browse tree');
    await browse({ hierarchy, item_key: lib.item_key, multi_session_key: sessionKey });
    const tagsNode = await findItemByTitle(sessionKey, hierarchy, "Tags", 100);
    if (!tagsNode) throw new Error('Couldn\'t find "Tags" under Library');
    await browse({ hierarchy, item_key: tagsNode.item_key, multi_session_key: sessionKey });
    const tag = await findItemByTitle(sessionKey, hierarchy, filter.value);
    if (!tag) throw new Error(`Tag "${filter.value}" not found`);
    const intoTag = await browse({ hierarchy, item_key: tag.item_key, multi_session_key: sessionKey });
    // Mixed-content tags expose an "Albums" child; album-only tags list albums
    // directly at this level.
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (albumsChild) {
      const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
      let total = (into.list && into.list.count) || 0;
      if (!total) {
        const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
        total = (head.list && head.list.count) || 0;
      }
      return { hierarchy, total };
    }
    // Flat tag: we've already consumed the level via loadLevel; the session is
    // still positioned on it, and load() by offset re-reads it fine.
    const total = lvl.total || (intoTag.list && intoTag.list.count) || lvl.items.length;
    return { hierarchy, total };
  }

  if (filter.type === "label") {
    const hierarchy = "browse";
    const labelsNode = await findLabelsNode(sessionKey);
    await browse({ hierarchy, item_key: labelsNode.item_key, multi_session_key: sessionKey });
    const label = await findItemByTitle(sessionKey, hierarchy, filter.value, 20000);
    if (!label) throw new Error(`Label "${filter.value}" not found`);
    const intoLabel = await browse({ hierarchy, item_key: label.item_key, multi_session_key: sessionKey });
    // A label may list its albums directly, or nest them under an "Albums"
    // child when it mixes item types.
    const lvl = await loadLevel(sessionKey, hierarchy, 300);
    const albumsChild = lvl.items.find(i => /^albums$/i.test((i.title || "").trim()));
    if (albumsChild) {
      const into = await browse({ hierarchy, item_key: albumsChild.item_key, multi_session_key: sessionKey });
      let total = (into.list && into.list.count) || 0;
      if (!total) {
        const head = await load({ hierarchy, offset: 0, count: 1, multi_session_key: sessionKey });
        total = (head.list && head.list.count) || 0;
      }
      return { hierarchy, total };
    }
    const total = lvl.total || (intoLabel.list && intoLabel.list.count) || lvl.items.length;
    return { hierarchy, total };
  }

  throw new Error("Unknown filter type: " + filter.type);
}

// ---------------------------------------------------------------------------
// Pick N random albums.  Each session is dedicated to one operation so
// item_keys never leak across requests — instead we always re-resolve from
// the album offset, which is stable as long as the library isn't changing.
// Optionally constrained to a genre or tag (see navigateToAlbumList).
// ---------------------------------------------------------------------------
async function pickRandomAlbums(count, filter) {
  const sessionKey = "rra_pick_" + Math.random().toString(36).slice(2, 10);

  const nav = await navigateToAlbumList(sessionKey, filter || null);
  const total = nav.total;
  if (total === 0) return { albums: [], total: 0 };

  const want = Math.min(count, total);
  const picked = new Set();
  while (picked.size < want) picked.add(Math.floor(Math.random() * total));
  const offsets = [...picked];

  const albums = [];
  for (const off of offsets) {
    try {
      const r = await load({
        hierarchy: nav.hierarchy, offset: off, count: 1, multi_session_key: sessionKey
      });
      const item = r.items && r.items[0];
      if (item && item.hint !== "header") {
        albums.push({
          offset:    off,
          title:     item.title || "",
          subtitle:  item.subtitle || "",
          image_key: item.image_key || null
        });
      }
    } catch (e) {
      if (DEBUG) console.error("load offset", off, "failed:", e.message);
    }
  }
  return { albums, total };
}

// ---------------------------------------------------------------------------
// Resolve an album by offset, drill in, and return action menu + tracks.
// Optionally invokes one of the actions (kind) against a zone.
// ---------------------------------------------------------------------------
async function openAlbumByOffset(offset, zoneOrOutputId, invokeKind, filter) {
  const sessionKey = "rra_open_" + Math.random().toString(36).slice(2, 10);

  // 1) Navigate to the album list this offset belongs to (full library, or a
  //    genre/tag list when a filter is active — offsets are per-list).
  const nav = await navigateToAlbumList(sessionKey, filter || null);
  const hierarchy = nav.hierarchy;

  // 2) Re-resolve THIS session's item_key for the album at `offset`
  const albumLoad = await load({
    hierarchy, offset, count: 1, multi_session_key: sessionKey
  });
  const albumItem = albumLoad.items && albumLoad.items[0];
  if (!albumItem) throw new Error("Album not found at offset " + offset);

  const albumInfo = {
    title:     albumItem.title || "",
    subtitle:  albumItem.subtitle || "",
    image_key: albumItem.image_key || null
  };

  // 3) Drill into the album
  const drill = await browse({
    hierarchy,
    item_key:  albumItem.item_key,
    multi_session_key: sessionKey
  });
  if (drill.action !== "list") {
    throw new Error("Unexpected browse action: " + drill.action);
  }

  // 4) Load contents (tracks + action_list).  Explicit count for big albums.
  const inside = await load({
    hierarchy,
    offset: 0,
    count: 500,
    multi_session_key: sessionKey
  });

  const items = inside.items || [];
  if (DEBUG) {
    console.log("[album items]");
    for (const it of items) {
      console.log("  - hint=" + (it.hint || "<none>") + "  title=" + JSON.stringify(it.title));
    }
  }

  // 5) Find the Play submenu.  In Roon's "albums" hierarchy, BOTH the Play
  //    Album action AND each track come back with hint "action_list" (tapping
  //    a track opens its own submenu).  We tell them apart by the subtitle:
  //    tracks have an artist/composer credit; submenu actions do not.
  const playMenu = items.find(i =>
       i.hint === "action_list" && !i.subtitle && /^play/i.test(i.title || "")
  ) || items.find(i =>
       i.hint === "action_list" && !i.subtitle
  );

  // 6) Tracks = items that aren't the play menu, a no-subtitle submenu
  //    (e.g. "Add to Library"), or a section header.  Strip Roon's leading
  //    "N. " from titles because the UI renders its own counter.
  const tracks = items
    .filter(t => {
      if (t === playMenu)                          return false;
      if (t.hint === "action_list" && !t.subtitle) return false;
      if (t.hint === "header")                     return false;
      return true;
    })
    .map(t => ({
      title:    (t.title || "").replace(/^\d+\.\s+/, ""),
      subtitle: t.subtitle || ""
    }));

  let actions = [];
  if (playMenu) {
    // Drill into Play menu
    await browse({
      hierarchy,
      item_key:  playMenu.item_key,
      multi_session_key: sessionKey
    });
    const acts = await load({ hierarchy, multi_session_key: sessionKey });
    actions = (acts.items || []).map(a => ({
      item_key: a.item_key,
      title:    a.title || "",
      hint:     a.hint  || "",
      kind:     classifyAction(a.title)
    }));
  }

  // 7) Optionally invoke one
  let invoked = null;
  if (invokeKind) {
    const action = matchAction(actions, invokeKind);
    if (!action) {
      throw new Error("No matching action for '" + invokeKind +
                      "'. Available: " + actions.map(a => a.title).join(", "));
    }
    if (!zoneOrOutputId) throw new Error("zone_or_output_id required to invoke an action");
    await browse({
      hierarchy,
      item_key:  action.item_key,
      zone_or_output_id: zoneOrOutputId,
      multi_session_key: sessionKey
    });
    invoked = action.title;
  }

  return { album: albumInfo, tracks, actions, invoked };
}

function classifyAction(title) {
  const t = (title || "").toLowerCase();
  if (/play\s*now/.test(t))            return "play_now";
  if (/add\s*next|play\s*next/.test(t))return "play_next";
  if (/queue/.test(t))                 return "queue";
  if (/shuffle/.test(t))               return "shuffle";
  if (/radio/.test(t))                 return "radio";
  return "other";
}
function matchAction(actions, kind) {
  return actions.find(a => a.kind === kind)
      || (kind === "play_now" ? actions.find(a => /^play/i.test(a.title)) : null);
}

// ---------------------------------------------------------------------------
// External metadata: MusicBrainz (release year), Qobuz + Wikipedia (bios).
// Qobuz is preferred (rich editorial reviews) with Wikipedia as fallback.
// Both candidates are verified against the album+artist name before display.
// No API keys required.
// ---------------------------------------------------------------------------
const MB_USER_AGENT = process.env.MB_USER_AGENT ||
  "RoonRandomAlbums/1.1.0 (Roon extension)";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const mbCache    = new Map();
const qobuzCache = new Map();
const wikiCache  = new Map();
let mbLastReq      = 0;
let qobuzLastReq   = 0;
let discogsLastReq = 0;

// Discogs OAuth app credentials — embedded so the extension works for all users.
const DISCOGS_KEY    = "KFbYgRaYdpnKkHBRB0lV";
const DISCOGS_SECRET = "UzDPIrwYxEZkIRtvncPoOYovwvvKHQHf";

// ---------------------------------------------------------------------------
// Record-label index — built from Qobuz-scraped data.
//
// Three layers, applied fastest-first:
//   1. Disk cache  (labels-cache.json) — persists across restarts; instant load.
//   2. In-memory qobuzCache — populated as album modals are opened.
//   3. Background Qobuz scan — 5 parallel workers; runs once per session.
//
// Because results are saved to disk, the full scan only has to happen once.
// Subsequent restarts seed from the file in milliseconds.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Labels database — SQLite via better-sqlite3.
// Single file: data/cache/labels.db
// Three tables: label_names, label_mbids, label_logos.
// In-memory Maps mirror the DB for O(1) lookups; every write updates both.
// ---------------------------------------------------------------------------
let Database;
try { Database = require("better-sqlite3"); } catch (e) { Database = null; }

const LABELS_DB_DIR  = path.join(__dirname, "data", "cache");
const LABELS_DB_FILE = path.join(LABELS_DB_DIR, "labels.db");
const SETTINGS_FILE  = path.join(LABELS_DB_DIR, "settings.json");

function loadPersistedSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {}; } catch (e) { return {}; }
}
function savePersistedSettings(patch) {
  try {
    const cur = loadPersistedSettings();
    fs.mkdirSync(LABELS_DB_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...cur, ...patch }, null, 2));
  } catch (e) {}
}

// In-memory Maps — primary lookup path.
const labelDiskCache = new Map();  // album key → label name
const labelMbidCache = new Map();  // group key → MusicBrainz MBID
const labelLogoCache = new Map();  // group key → logo URL | null (null = tried, not found)

let labelsDb = null;
let stmtInsertName, stmtInsertMbid, stmtInsertLogo;
let stmtInsertPlay, stmtCompletePlay, stmtInsertMeta;

function openLabelsDb() {
  if (!Database) {
    console.warn("[labels] better-sqlite3 not available — cache in memory only (data won't persist)");
    return;
  }
  try {
    fs.mkdirSync(LABELS_DB_DIR, { recursive: true });
    labelsDb = new Database(LABELS_DB_FILE);
    labelsDb.pragma("journal_mode = WAL");
    labelsDb.exec(`
      CREATE TABLE IF NOT EXISTS label_names (
        key   TEXT PRIMARY KEY,
        label TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS label_mbids (
        group_key TEXT PRIMARY KEY,
        mbid      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS label_logos (
        group_key TEXT PRIMARY KEY,
        logo_url  TEXT
      );
      CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        zone TEXT,
        track TEXT,
        artist TEXT,
        album TEXT,
        image_key TEXT,
        duration INTEGER,
        completed INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS album_meta (
        album_key TEXT PRIMARY KEY,
        genre TEXT,
        year INTEGER
      );
    `);
    stmtInsertName = labelsDb.prepare("INSERT OR REPLACE INTO label_names (key, label) VALUES (?, ?)");
    stmtInsertMbid = labelsDb.prepare("INSERT OR REPLACE INTO label_mbids (group_key, mbid) VALUES (?, ?)");
    stmtInsertLogo = labelsDb.prepare("INSERT OR REPLACE INTO label_logos (group_key, logo_url) VALUES (?, ?)");
    stmtInsertPlay  = labelsDb.prepare("INSERT INTO plays (ts, zone, track, artist, album, image_key, duration) VALUES (?,?,?,?,?,?,?)");
    stmtCompletePlay = labelsDb.prepare("UPDATE plays SET completed=1 WHERE id=?");
    stmtInsertMeta  = labelsDb.prepare("INSERT OR IGNORE INTO album_meta (album_key, genre, year) VALUES (?,?,?)");
    for (const r of labelsDb.prepare("SELECT key, label FROM label_names").all()) {
      if (r.label) labelDiskCache.set(r.key, r.label);
    }
    for (const r of labelsDb.prepare("SELECT group_key, mbid FROM label_mbids").all()) {
      labelMbidCache.set(r.group_key, r.mbid);
    }
    for (const r of labelsDb.prepare("SELECT group_key, logo_url FROM label_logos").all()) {
      labelLogoCache.set(r.group_key, r.logo_url);
    }
    migrateOldJsonCaches();
    if (DEBUG) console.log(
      "[labels] db ready:", labelDiskCache.size, "names,",
      labelMbidCache.size, "mbids,", labelLogoCache.size, "logos"
    );
  } catch (e) {
    console.error("[labels] db open failed:", e.message, "— in-memory only");
    labelsDb = null;
  }
}

function migrateOldJsonCaches() {
  const files = [
    { file: path.join(LABELS_DB_DIR, "labels-cache.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (e.key && e.label && !labelDiskCache.has(e.key)) {
              stmtInsertName.run(e.key, e.label);
              labelDiskCache.set(e.key, e.label);
            }
          }
        });
        ins();
      }
    },
    { file: path.join(LABELS_DB_DIR, "labels-mbid.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (e.groupKey && e.mbid && !labelMbidCache.has(e.groupKey)) {
              stmtInsertMbid.run(e.groupKey, e.mbid);
              labelMbidCache.set(e.groupKey, e.mbid);
            }
          }
        });
        ins();
      }
    },
    { file: path.join(LABELS_DB_DIR, "labels-logo.json"),
      load(data) {
        if (!Array.isArray(data && data.entries)) return;
        const ins = labelsDb.transaction(() => {
          for (const e of data.entries) {
            if (typeof e.groupKey === "string" && !labelLogoCache.has(e.groupKey)) {
              stmtInsertLogo.run(e.groupKey, e.logoUrl || null);
              labelLogoCache.set(e.groupKey, e.logoUrl || null);
            }
          }
        });
        ins();
      }
    }
  ];
  for (const { file, load } of files) {
    try {
      if (!fs.existsSync(file)) continue;
      load(JSON.parse(fs.readFileSync(file, "utf8")));
      fs.unlinkSync(file);
      if (DEBUG) console.log("[labels] migrated", path.basename(file), "→ labels.db");
    } catch (e) { /* ignore corrupt old files */ }
  }
}

// Write helpers — update Map and DB together.
function setLabelName(key, label) {
  labelDiskCache.set(key, label);
  if (labelsDb) stmtInsertName.run(key, label);
}
function setLabelMbid(groupKey, mbid) {
  labelMbidCache.set(groupKey, mbid);
  if (labelsDb) stmtInsertMbid.run(groupKey, mbid);
}
function setLabelLogo(groupKey, logoUrl) {
  labelLogoCache.set(groupKey, logoUrl);
  if (labelsDb) stmtInsertLogo.run(groupKey, logoUrl);
}

openLabelsDb();

// ---------------------------------------------------------------------------
// Fan Art TV — label logo images. Free API key required.
// ---------------------------------------------------------------------------
const FANART_TV_KEY = "6c2ebc118ae8d196cd1b35b3d8f6912d";

const labelsIndex = {
  map:      new Map(),   // groupKey → { display, image_key, albums: [{offset,title,subtitle,image_key}] }
  count:    0,
  builtAt:  0,
  progress: 0,           // 0..1 while scanning
  building: false
};

// Strip common corporate suffixes so "ACT Music" and "ACT", "Blue Note Records" and
// "Blue Note" all map to the same group key. Applied twice to catch "XYZ Music Records".
const LABEL_SUFFIX_RE = /\s+(Records?|Recordings?|Music|Label|Labels|Group|Entertainment|Productions?|Publishing|Inc\.?|Ltd\.?|LLC|GmbH|S\.A\.?|s\.r\.l\.?|Verlag|Editions?|Edition)\.?\s*$/i;

function labelGroupKey(name) {
  if (!name) return "";
  let s = name.trim().replace(LABEL_SUFFIX_RE, "").trim().replace(LABEL_SUFFIX_RE, "").trim();
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function canonicalLabelName(name) {
  if (!name) return name;
  return name.trim().replace(LABEL_SUFFIX_RE, "").trim().replace(LABEL_SUFFIX_RE, "").trim();
}

function labelsIndexAddAlbum(labelName, album) {
  if (!labelName || !album) return;
  const groupKey = labelGroupKey(labelName);
  if (!groupKey) return;
  let entry = labelsIndex.map.get(groupKey);
  if (!entry) {
    entry = {
      display:   canonicalLabelName(labelName),
      image_key: album.image_key || null,
      mbid:      labelMbidCache.get(groupKey) || null,
      logo_url:  labelLogoCache.has(groupKey) ? (labelLogoCache.get(groupKey) || null) : null,
      albums:    []
    };
    labelsIndex.map.set(groupKey, entry);
    labelsIndex.count = labelsIndex.map.size;
  }
  if (!entry.mbid && labelMbidCache.has(groupKey)) entry.mbid = labelMbidCache.get(groupKey);
  if (!entry.logo_url && labelLogoCache.has(groupKey)) entry.logo_url = labelLogoCache.get(groupKey) || null;
  if (!entry.image_key && album.image_key) entry.image_key = album.image_key;
  if (!entry.albums.some(a => a.offset === album.offset)) {
    entry.albums.push({
      offset:    album.offset,
      title:     album.title,
      subtitle:  album.subtitle,
      image_key: album.image_key
    });
  }
}

// Seed from disk cache + in-memory qobuzCache — no network calls.
// Overrides file (data/labels-override.json) takes highest priority.
const labelsOverrideFile = path.join(__dirname, "data", "labels-override.json");
const labelsOverride = new Map(); // key → label (loaded once at startup)

(function loadLabelsOverride() {
  try {
    const raw  = fs.readFileSync(labelsOverrideFile, "utf8");
    const data = JSON.parse(raw);
    const albums = Array.isArray(data) ? data : (data && data.albums ? data.albums : []);
    for (const e of albums) {
      if (e.label) {
        const key = normalize(e.title || "") + "||" + normalize(e.artist || "");
        labelsOverride.set(key, e.label);
      }
    }
    if (DEBUG) console.log("[labels] override file loaded:", labelsOverride.size, "entries");
  } catch (e) { /* file optional */ }
})();

function seedLabelsFromCache() {
  for (const al of albumIndex.albums) {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    // Priority: override file → disk cache → qobuzCache
    const override = labelsOverride.get(key);
    if (override) { labelsIndexAddAlbum(override, al); continue; }
    const diskLabel = labelDiskCache.get(key);
    if (diskLabel) { labelsIndexAddAlbum(diskLabel, al); continue; }
    const q = qobuzCache.get(key);
    if (q && q.label) {
      labelsIndexAddAlbum(q.label, al);
      setLabelName(key, q.label);
    }
  }
  labelsIndex.count = labelsIndex.map.size;
  if (DEBUG) console.log("[labels] seeded:", labelsIndex.count, "labels");
  // Kick off logo fetches for any labels already in the mbid cache.
  kickFanArtFetches().catch(e => { if (DEBUG) console.error("[labels] fanart error:", e.message); });
}

// ---------------------------------------------------------------------------
// iTunes Search API — primary label source. Free, no key, returns recordLabel
// directly. Parallelisable (no strict rate limit at moderate concurrency).
// ---------------------------------------------------------------------------
async function fetchLabelFromiTunes(title, artist) {
  if (!title) return null;
  const term = [title, artist].filter(Boolean).join(" ");
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&media=music&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT }, 10000);
    const results = json && json.results;
    if (!Array.isArray(results) || !results.length) return null;
    const normTitle = normalize(title);
    let match = results.find(r => normalize(r.collectionName || "") === normTitle);
    if (!match && artist) {
      const normArtist = normalize(artist);
      match = results.find(r =>
        normalize(r.collectionName || "") === normTitle ||
        normalize(r.artistName || "") === normArtist
      );
    }
    if (!match) match = results[0];
    const label = match && match.recordLabel;
    if (stmtInsertMeta && match && match.primaryGenreName) {
      const metaKey = normalize(title) + "||" + normalize(artist || "");
      const yr = match.releaseDate ? parseInt(match.releaseDate.slice(0, 4), 10) : null;
      try { stmtInsertMeta.run(metaKey, match.primaryGenreName, yr || null); } catch (e) {}
    }
    if (!label || /self.released|independent|self-released/i.test(label)) return null;
    return label;
  } catch (e) {
    if (DEBUG) console.error("[labels:itunes]", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discogs label lookup — primary source.  60 req/min authenticated.
// Returns the label name string, or null if not found / self-released.
// ---------------------------------------------------------------------------
async function fetchLabelFromDiscogs(title, artist) {
  if (!title) return null;
  await discogsWait();
  const params = new URLSearchParams({ type: "release", release_title: title });
  if (artist) params.set("artist", artist);
  const url = `https://api.discogs.com/database/search?${params}`;
  try {
    const json = await httpJson(url, {
      "Authorization": `Discogs key=${DISCOGS_KEY}, secret=${DISCOGS_SECRET}`,
      "User-Agent": MB_USER_AGENT
    });
    const results = json && json.results;
    if (Array.isArray(results) && results.length) {
      const labels = results[0].label;
      if (Array.isArray(labels) && labels.length) {
        const name = labels[0];
        // Skip self-released / unknown — let MusicBrainz try instead.
        if (/not on label|self.?released/i.test(name)) return null;
        return name;
      }
    }
  } catch (e) {
    if (DEBUG) console.error("[labels:discogs]", e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// MusicBrainz label lookup — fallback for albums Discogs misses.
// Returns { label, mbid } for a release, or null if not found.
// Rate limited via the shared mbWait() (1.1 s between requests).
// ---------------------------------------------------------------------------
async function fetchLabelFromMusicBrainz(title, artist) {
  if (!title) return null;
  await mbWait();
  let q = `release:"${mbQuote(title)}"`;
  if (artist) q += ` AND artist:"${mbQuote(artist)}"`;
  const url =
    `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    for (const r of json.releases || []) {
      const li = (r["label-info"] || [])[0];
      const labelObj = li && li.label;
      if (labelObj && labelObj.name) {
        return { label: labelObj.name, mbid: labelObj.id || null };
      }
    }
  } catch (e) {
    if (DEBUG) console.error("[labels:mb]", e.message);
  }
  return null;
}

// Resolve a label name to a MusicBrainz label MBID — called once per unique
// label group key, not once per album. Far more efficient than release lookup.
async function fetchLabelMbidFromMusicBrainz(labelName) {
  if (!labelName) return null;
  await mbWait();
  const q = `label:"${mbQuote(labelName)}"`;
  const url = `https://musicbrainz.org/ws/2/label/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const labels = json && json.labels;
    if (Array.isArray(labels) && labels.length) return labels[0].id || null;
  } catch (e) {
    if (DEBUG) console.error("[labels:mb:label]", e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Background scan — uses Discogs (primary) + MusicBrainz (fallback).
// Rate limited to ~1 req/sec each. Results saved to disk — scan only
// needs to run once; restarts load instantly from labels-cache.json.
// ---------------------------------------------------------------------------
async function runLabelsIndexScan() {
  if (labelsIndex.building) return;
  if (albumIndex.count === 0) {
    if (albumIndex.building) { try { await albumIndex.building; } catch (e) {} }
    if (albumIndex.count === 0) return;
  }
  seedLabelsFromCache();

  // Scan albums not yet in the disk cache (empty-string entries are excluded
  // from the cache on load, so they'll be retried here).
  const toScan = albumIndex.albums.filter(al => {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    return !labelsOverride.has(key) && !labelDiskCache.has(key);
  });

  if (!toScan.length) {
    labelsIndex.builtAt = Date.now();
    if (DEBUG) console.log("[labels] scan: all albums already cached");
    return;
  }

  labelsIndex.building = true;
  labelsIndex.progress = 0;
  const alreadyDone = albumIndex.albums.length - toScan.length;
  const total = albumIndex.albums.length;
  let done = 0;

  if (DEBUG) console.log("[labels] iTunes+MusicBrainz scan:", toScan.length, "albums to look up");

  const processAlbum = async (al) => {
    const key = normalize(al.title) + "||" + normalize(al.subtitle);
    try {
      let label = null, mbid = null;

      // Primary: iTunes — fast, no rate limit, returns recordLabel directly.
      label = await fetchLabelFromiTunes(al.title, al.subtitle);

      if (!label) {
        // Fallback: MusicBrainz — also gives us the MBID directly.
        const mbResult = await fetchLabelFromMusicBrainz(al.title, al.subtitle);
        if (mbResult) { label = mbResult.label; mbid = mbResult.mbid; }
      }

      if (label) {
        setLabelName(key, label);
        labelsIndexAddAlbum(label, al);

        // Resolve MBID for Fan Art TV — once per unique label, not per album.
        const gk = labelGroupKey(label);
        if (gk && !labelMbidCache.has(gk)) {
          const resolvedMbid = mbid || await fetchLabelMbidFromMusicBrainz(label);
          if (resolvedMbid) {
            setLabelMbid(gk, resolvedMbid);
            const entry = labelsIndex.map.get(gk);
            if (entry && !entry.mbid) entry.mbid = resolvedMbid;
          }
        }
      }
    } catch (e) { /* keep scanning */ }
    done++;
    labelsIndex.progress = (alreadyDone + done) / total;
  };

  // Run 6 albums concurrently — iTunes handles this fine.
  // MusicBrainz fallback serialises itself via mbWait(), so no overload risk.
  const SCAN_BATCH = 6;
  for (let i = 0; i < toScan.length; i += SCAN_BATCH) {
    await Promise.allSettled(toScan.slice(i, i + SCAN_BATCH).map(processAlbum));
  }

  labelsIndex.building = false;
  labelsIndex.builtAt  = Date.now();
  labelsIndex.count    = labelsIndex.map.size;
  if (DEBUG) console.log("[labels] scan complete:", labelsIndex.count, "labels found");
  kickFanArtFetches().catch(e => { if (DEBUG) console.error("[labels] fanart error:", e.message); });
}

// Fetch label logo from Fan Art TV for a single label group key.
// Results (including "no logo found" = null) are persisted so we don't re-query.
async function fetchFanArtLogo(groupKey, mbid) {
  if (!mbid || !FANART_TV_KEY) return;
  if (labelLogoCache.has(groupKey)) return; // already tried
  const url = `https://webservice.fanart.tv/v3/music/labels/${encodeURIComponent(mbid)}?api_key=${FANART_TV_KEY}`;
  try {
    const json = await httpJson(url);
    const logos = json && json.musiclabel;
    const logoUrl = Array.isArray(logos) && logos.length ? logos[0].url : null;
    setLabelLogo(groupKey, logoUrl);
    const entry = labelsIndex.map.get(groupKey);
    if (entry) entry.logo_url = logoUrl;
    if (DEBUG) console.log("[labels:fanart]", groupKey, "→", logoUrl || "(no logo)");
  } catch (e) {
    // Don't cache on network error — retry next restart. 404 = no logo, cache null.
    if (e.message && e.message.includes("404")) {
      setLabelLogo(groupKey, null);
    }
    if (DEBUG) console.error("[labels:fanart]", groupKey, e.message);
  }
}

// Kick off Fan Art TV logo fetches for all labels that have an MBID but no cached logo result.
// Runs in batches of 5 concurrent requests — Fan Art TV has no strict rate limit.
async function kickFanArtFetches() {
  if (!FANART_TV_KEY) return;
  const pending = [];
  for (const [groupKey, entry] of labelsIndex.map) {
    if (!entry.mbid) continue;
    if (labelLogoCache.has(groupKey)) continue;
    pending.push({ groupKey, mbid: entry.mbid });
  }
  if (!pending.length) return;
  if (DEBUG) console.log("[labels:fanart] fetching logos for", pending.length, "labels");
  const BATCH = 5;
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.allSettled(
      pending.slice(i, i + BATCH).map(({ groupKey, mbid }) => fetchFanArtLogo(groupKey, mbid))
    );
  }
}

async function mbWait() {
  const elapsed = Date.now() - mbLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  mbLastReq = Date.now();
}
async function discogsWait() {
  const elapsed = Date.now() - discogsLastReq;
  if (elapsed < 1100) await new Promise(r => setTimeout(r, 1100 - elapsed));
  discogsLastReq = Date.now();
}
async function qobuzWait() {
  const elapsed = Date.now() - qobuzLastReq;
  if (elapsed < 700) await new Promise(r => setTimeout(r, 700 - elapsed));
  qobuzLastReq = Date.now();
}

async function httpJson(url, headers, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function httpText(url, headers, timeoutMs = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalize(s) {
  return String(s || "").toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Decode HTML entities — named (incl. &copy; &reg; &trade;) and numeric
// (&#169; / &#xA9;), with or without the trailing semicolon. Unknown entities
// are left untouched. NOTE: "&copy" reached a share card before because the old
// stripHtml decoded a handful of entities by hand but not this one.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122",
  nbsp: " ", hellip: "...", mdash: "\u2014", ndash: "\u2013",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
  deg: "\u00B0"
};
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ""; }
}
function decodeEntities(input) {
  if (!input) return "";
  return String(input)
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g,        (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);?/gi, (m, name) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v !== undefined ? v : m;
    });
}

// --- artist guard ----------------------------------------------------------
// Why this exists: a review/page was matched to the WRONG act because the only
// check was "the slug contains the artist's first token" — and the first token
// of "The Who" is "the", which matches almost any slug (e.g.
// "greatest-hits-the-guess-who"). These helpers verify that the text we got
// back actually belongs to the requested artist. Failing safe = drop the bio.

function escapeReg(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// First significant token, skipping a leading article ("the who" -> "who").
function firstSignificantToken(s) {
  const toks = normalize(s).split(" ").filter(Boolean);
  if (toks.length > 1 && /^(the|a|an)$/.test(toks[0])) return toks[1];
  return toks[0] || "";
}

// Whole-phrase overlap in either direction, tolerant of a leading "the".
// "the who" vs "the guess who" -> false (correctly rejects the mismatch);
// "jay z" vs "jay z feat alicia keys" -> true (keeps a correct match).
function namesOverlap(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return false;
  const pad = s => " " + s + " ";
  if (pad(a).includes(pad(b)) || pad(b).includes(pad(a))) return true;
  const strip = s => s.replace(/^the /, "");
  return strip(a) === strip(b);
}

// Pull the artist out of a leading "Artist - Album …" dateline, if present.
function leadArtistOf(text) {
  const m = String(text || "").trim().match(/^(.{2,60}?)\s[-\u2013\u2014]\s/);
  return m ? m[1].trim() : null;
}

function stripHtml(html) {
  const s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/?p[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s)            // named + numeric, semicolon optional
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// MusicBrainz: release year
function mbQuote(s) {
  return String(s).replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, "\\$&");
}
async function fetchAlbumYear(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (mbCache.has(key)) return mbCache.get(key);
  await mbWait();
  let q = `release:"${mbQuote(title)}"`;
  if (artist) q += ` AND artist:"${mbQuote(artist)}"`;
  const url = `https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
  try {
    const json = await httpJson(url, { "User-Agent": MB_USER_AGENT });
    const rgs = json["release-groups"] || [];
    rgs.sort((a, b) =>
      (a["first-release-date"] || "9999").localeCompare(b["first-release-date"] || "9999"));
    const date = rgs[0] && rgs[0]["first-release-date"] || null;
    const year = date ? date.slice(0, 4) : null;
    mbCache.set(key, year);
    return year;
  } catch (e) {
    if (DEBUG) console.error("[mb]", e.message);
    mbCache.set(key, null);
    return null;
  }
}

// Qobuz: search the public site, scrape the editorial review off the album page.
async function fetchQobuz(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (qobuzCache.has(key)) return qobuzCache.get(key);

  let out = null;
  try {
    // 1) Search
    const q = `${title} ${artist || ""}`.trim();
    await qobuzWait();
    const searchHtml = await httpText(
      `https://www.qobuz.com/us-en/search?q=${encodeURIComponent(q)}`,
      { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
    );

    // 2) Find first album link whose URL slug contains both the album title
    //    word AND the artist word. Slug shape: /us-en/album/{slug}/{id}
    const linkRe = /\/(?:us-en\/)?album\/([^"'\/\s]+)\/([a-z0-9]+)/g;
    const seen = new Map();
    let m;
    while ((m = linkRe.exec(searchHtml)) !== null) {
      if (!seen.has(m[2])) seen.set(m[2], m[1]);
    }
    if (seen.size === 0) { qobuzCache.set(key, null); return null; }

    const titleFirst  = firstSignificantToken(title);
    const artistFirst = firstSignificantToken(artist || "");
    let chosenSlug = null, chosenId = null;
    for (const [id, slug] of seen) {
      const sn = slug.toLowerCase();
      if (titleFirst  && !sn.includes(titleFirst))  continue;
      if (artistFirst && !sn.includes(artistFirst)) continue;
      chosenSlug = slug; chosenId = id; break;
    }
    if (!chosenSlug) { qobuzCache.set(key, null); return null; }

    // 3) Fetch the album page
    await qobuzWait();
    const albumUrl = `https://www.qobuz.com/us-en/album/${chosenSlug}/${chosenId}`;
    const albumHtml = await httpText(albumUrl, {
      "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9"
    });

    // 4) Editorial review.  Page has "Album Review: ..." heading, then the
    //    body, ending around "About the album" or "Improve album information".
    let review = null;
    const startMatch = /Album Review[:\s]/i.exec(albumHtml);
    if (startMatch) {
      const start = startMatch.index;
      const ends = [
        albumHtml.indexOf("About the album",          start),
        albumHtml.indexOf("Improve album information", start),
        albumHtml.indexOf("Why buy on Qobuz",          start),
        start + 8000
      ].filter(n => n > start);
      const end = Math.min(...ends);
      let text = stripHtml(albumHtml.substring(start, end));

      // Qobuz's heading reads "Album Review: <Artist> - <Album>". Capture it
      // for an artist sanity-check before stripping it off.
      const headingMatch = text.match(/^Album Review[:\s]+([^\n]+)/i);
      const headingLine  = headingMatch ? headingMatch[1].trim() : "";
      text = text.replace(/^Album Review[^\n]*\n?/i, "").trim();

      // Drop a trailing attribution line: "© Author /TiVo", "… /AllMusic",
      // "… /Qobuz", or "Review by Author". Entities are already decoded, so a
      // raw "&copy" is now "©". The old code only matched "/Qobuz", which is
      // why "&copy … /TiVo" survived onto the card.
      text = text.replace(/\s*©\s*[^\n]*\/(?:tivo|rovi|allmusic|qobuz)\s*$/i, "").trim();
      text = text.replace(/\s*Review by\s+[^\n]+$/i, "").trim();

      // VERIFY THE ARTIST. The search/scrape can land on the wrong act — e.g.
      // "Greatest Hits / The Who" matching The Guess Who. Trust Qobuz's own
      // heading artist, falling back to the "Artist - Album" dateline the
      // review body opens with. On a mismatch, discard the whole Qobuz result
      // so the caller cleanly falls back to Wikipedia (or to no bio).
      const leadArtist = leadArtistOf(headingLine) || leadArtistOf(text);
      if (artist && leadArtist && !namesOverlap(leadArtist, artist)) {
        if (DEBUG) console.error(`[qobuz] artist mismatch: wanted "${artist}", got "${leadArtist}" — discarding`);
        qobuzCache.set(key, null);
        return null;
      }

      // Tidy: AllMusic reviews open with an "<Artist> - <Album>" dateline. Now
      // that the artist is confirmed, strip that exact prefix so the card opens
      // with the prose rather than a repeated title line.
      if (leadArtist) {
        const dateline = new RegExp(
          "^\\s*" + escapeReg(leadArtist) + "\\s*[-\\u2013\\u2014]\\s*" + escapeReg(title) + "\\s*",
          "i"
        );
        text = text.replace(dateline, "").trim();
      }

      if (text.length > 60) review = text;
    }

    // 5) Year + label
    let year = null, label = null;
    const rel = albumHtml.match(/Released\s+on\s+([\d\/]+)\s*by\s*<[^>]*>([^<]+)</i);
    if (rel) {
      const parts = rel[1].split("/");
      const yp = parts[parts.length - 1];
      if (yp.length === 2) {
        // Qobuz sometimes renders a 2-digit year. Pivot on the current year so
        // "80" -> 1980 (not 2080) while recent reissues like "08" -> 2008.
        const n = parseInt(yp, 10);
        const cur2 = new Date().getFullYear() % 100;
        year = String(n <= cur2 ? 2000 + n : 1900 + n);
      } else {
        year = yp;
      }
      label = rel[2].trim();
    }

    if (review || year || label) {
      out = {
        description: review,
        year, label,
        url: albumUrl,
        source: "Qobuz"
      };
    }
  } catch (e) {
    if (DEBUG) console.error("[qobuz]", e.message);
  }

  qobuzCache.set(key, out);

  // Keep the disk label cache in sync — persists across restarts so the
  // background scan can skip this album next time.
  if (out && out.label && !labelDiskCache.has(key)) {
    setLabelName(key, out.label);
    // Also enrich the live labelsIndex (in case the scan hasn't reached this album yet).
    const al = albumIndex.albums.find(
      a => normalize(a.title) + "||" + normalize(a.subtitle) === key
    );
    if (al) labelsIndexAddAlbum(out.label, al);
  }

  return out;
}

// Wikipedia: search + first-paragraph extract via the MediaWiki API.
async function wikiSearch(query, limit = 5) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  return (data && data.query && data.query.search) || [];
}
async function wikiExtract(pageTitle) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts|info` +
    `&exintro=true&explaintext=true&redirects=1&inprop=url` +
    `&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const data = await httpJson(url, { "User-Agent": MB_USER_AGENT });
  const pages = (data && data.query && data.query.pages) || {};
  const page = pages[Object.keys(pages)[0]];
  if (!page || !page.extract) return null;
  return {
    title:       page.title,
    description: page.extract,
    url:         page.fullurl ||
                 `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, "_"))}`
  };
}

async function fetchWikiAlbum(title, artist) {
  if (!title) return null;
  const titleN      = normalize(title);
  const artistFirst = normalize(artist || "").split(" ")[0];
  const candidates  = await wikiSearch(`${title} ${artist || ""} album`);

  for (const c of candidates) {
    const ext = await wikiExtract(c.title);
    if (!ext) continue;

    const lead     = ext.description.slice(0, 400);
    const headNorm = normalize(ext.description.slice(0, 800));
    const titleNorm = normalize(c.title);

    // (1) The article must actually be about THIS album: its Wikipedia title
    //     should contain the album name as whole words (e.g. "Pang (album)",
    //     "Everything Forever (Victories at Sea album)").  Padding with spaces
    //     makes this a whole-word check so a short title like "Up" doesn't
    //     match "Group" / "Setup".
    const pad = s => " " + s + " ";
    if (!pad(titleNorm).includes(pad(titleN))) continue;

    // (2) Reject person biographies.  These slipped through before because a
    //     musician's bio mentions "albums" ("recorded five studio albums").
    //     Tell-tale signs: a birth/death date in parentheses, or "is/was a …
    //     singer/musician/band" in the lead.
    const personBirthDeath = /\(\s*(born\s+)?\d{1,2}\s+\w+\s+\d{4}\b/i.test(lead)
                          || /\b\d{4}\s*[–—-]\s*\d{4}\b/.test(lead);
    const personDescriptor = /\b(is|was)\s+(an?\s+)?(scottish|american|english|british|irish|welsh|canadian|australian|[a-z]+)?\s*(singer|songwriter|musician|guitarist|drummer|rapper|composer|producer|vocalist|bassist|pianist|dj|band|duo)\b/i.test(lead);
    if (personBirthDeath || personDescriptor) continue;

    // (3) Confirm it reads like a release: "… is/was the … album/EP/record …"
    if (!/\b(is|was)\b[^.]{0,80}\b(album|ep|record|mixtape|soundtrack|single)\b/i.test(lead)) continue;

    // (4) If we know the artist, prefer an article that mentions them.
    if (artistFirst && artistFirst.length > 2 && !headNorm.includes(artistFirst)) continue;

    return { ...ext, source: "Wikipedia" };
  }
  return null;
}
async function fetchWikiArtist(name) {
  if (!name) return null;
  const primary = name.split(",")[0].trim();
  const candidates = await wikiSearch(`${primary} band musician singer`);
  for (const c of candidates) {
    if (/\b(album|song|tour|discography)\b/i.test(c.title)) continue;
    const ext = await wikiExtract(c.title);
    if (!ext) continue;
    const head = ext.description.slice(0, 800);
    if (!/\b(band|musician|singer|songwriter|group|musical|guitarist|drummer|pianist|composer|rapper|vocalist|recording artist|duo|trio|quartet|ensemble|orchestra)\b/i.test(head)) continue;
    return { ...ext, name: ext.title, source: "Wikipedia" };
  }
  return null;
}

async function fetchWikipedia(title, artist) {
  if (!title) return null;
  const key = normalize(title) + "||" + normalize(artist || "");
  if (wikiCache.has(key)) return wikiCache.get(key);
  let result = null;
  try {
    const [album, artistInfo] = await Promise.all([
      fetchWikiAlbum(title, artist).catch(() => null),
      artist ? fetchWikiArtist(artist).catch(() => null) : Promise.resolve(null)
    ]);
    if (album || artistInfo) result = { album, artist: artistInfo };
  } catch (e) {
    if (DEBUG) console.error("[wiki]", e.message);
  }
  wikiCache.set(key, result);
  return result;
}

// Combine: Qobuz preferred for the album review; Wikipedia for the artist
// (and as fallback for the album when Qobuz has nothing).
async function fetchAlbumBios(title, artist) {
  if (!title) return null;
  const [qobuz, wiki] = await Promise.all([
    fetchQobuz(title, artist).catch(() => null),
    fetchWikipedia(title, artist).catch(() => null)
  ]);

  let album = null;
  if (qobuz && qobuz.description) {
    album = {
      description: qobuz.description,
      year:        qobuz.year  || (wiki && wiki.album && /(\d{4})/.exec(wiki.album.description || "") || [])[1] || null,
      label:       qobuz.label || null,
      url:         qobuz.url,
      source:      "Qobuz"
    };
  } else if (wiki && wiki.album) {
    album = {
      description: wiki.album.description,
      year:        null,
      label:       qobuz && qobuz.label ? qobuz.label : null,
      url:         wiki.album.url,
      source:      "Wikipedia"
    };
  } else if (qobuz) {
    // Qobuz had year/label but no review
    album = {
      description: null,
      year:  qobuz.year, label: qobuz.label,
      url:   qobuz.url,  source: "Qobuz"
    };
  }

  const artistObj = (wiki && wiki.artist) ? {
    name:        wiki.artist.name || artist || null,
    description: wiki.artist.description,
    url:         wiki.artist.url,
    source:      "Wikipedia"
  } : null;

  // Final safety net, source-agnostic (covers Wikipedia and anything added
  // later, not just Qobuz). Decode entities once more and confirm a leading
  // "Artist -" dateline, if any, matches the requested artist. A blank bio
  // beats a wrong one, so drop only the description — the card and the in-app
  // bio both read this single field.
  if (album && album.description) {
    album.description = decodeEntities(album.description).trim();
    const lead = leadArtistOf(album.description);
    if (artist && lead && !namesOverlap(lead, artist)) {
      if (DEBUG) console.error(`[bios] description artist mismatch: wanted "${artist}", got "${lead}" — dropping`);
      album.description = null;
    }
    if (!album.description) album.description = null;
  }

  return { album, artist: artistObj };
}

// ---------------------------------------------------------------------------
// In-memory library search index
//
// Roon's own browse "search" is server-driven, relevance-tuned, and unhappy
// with very short or common-word queries (e.g. typing "the t" for the band
// "The The").  To give instant, prefix-aware, typo-tolerant search across the
// WHOLE library, we walk the "albums" hierarchy once, cache a lightweight
// record per album in memory, and match locally on every keystroke.
//
// The album's position (offset) in the albums hierarchy is the stable handle —
// exactly what pickRandomAlbums()/openAlbumByOffset() already rely on — so a
// search hit plugs straight into the existing open/play machinery with no new
// playback code.
// ---------------------------------------------------------------------------
const SEARCH_PAGE      = 500;              // albums per Roon load() page
const INDEX_MAX_AGE_MS = 10 * 60 * 1000;   // rebuild if older than this
const INDEX_CHECK_MS   = 5  * 60 * 1000;   // how often to check for library edits

const albumIndex = {
  albums:   [],     // [{ offset, title, subtitle, image_key, nTitle, nArtist, tTitle[], tArtist[], jTitle, jArtist }]
  count:    0,
  builtAt:  0,
  progress: 0,      // 0..1 while building
  building: null    // Promise while a build is in flight
};
let indexMaintTimer = null;

function indexRecord(item, offset) {
  const title    = item.title    || "";
  const subtitle = item.subtitle || "";
  const nTitle   = normalize(title);
  const nArtist  = normalize(subtitle);
  return {
    offset,
    title, subtitle,
    image_key: item.image_key || null,
    nTitle, nArtist,
    tTitle:  nTitle  ? nTitle.split(" ")  : [],
    tArtist: nArtist ? nArtist.split(" ") : [],
    jTitle:  nTitle.replace(/ /g, ""),
    jArtist: nArtist.replace(/ /g, "")
  };
}

// Walk the whole albums hierarchy once and cache a record per album.
// Concurrent callers share the same in-flight build promise.
async function buildAlbumIndex() {
  if (albumIndex.building) return albumIndex.building;

  albumIndex.progress = 0;
  albumIndex.building = (async () => {
    const sessionKey = "rra_idx_" + Math.random().toString(36).slice(2, 10);
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
    const total = head.list && head.list.count ? head.list.count : 0;

    const albums = new Array(total);
    let loaded = 0;
    for (let off = 0; off < total; off += SEARCH_PAGE) {
      const page = await load({
        hierarchy: "albums", offset: off, count: SEARCH_PAGE, multi_session_key: sessionKey
      });
      const items = page.items || [];
      if (items.length === 0) break;             // safety: stop on a short read
      for (let i = 0; i < items.length; i++) {
        albums[off + i] = indexRecord(items[i], off + i);
      }
      loaded += items.length;
      albumIndex.progress = total ? Math.min(1, loaded / total) : 1;
    }

    albumIndex.albums   = albums.filter(Boolean);  // drop any holes
    albumIndex.count    = albumIndex.albums.length;
    albumIndex.builtAt  = Date.now();
    albumIndex.progress = 1;
    if (DEBUG) console.log("[index] built", albumIndex.count, "albums");
    return albumIndex;
  })();

  try {
    return await albumIndex.building;
  } finally {
    albumIndex.building = null;
  }
}

// Ensure a usable index exists; (re)build if empty or stale. Awaits only the
// very first build (so the first search returns results); a stale rebuild
// happens in the background while the current index keeps serving.
async function ensureAlbumIndex() {
  const stale = !albumIndex.builtAt || (Date.now() - albumIndex.builtAt) > INDEX_MAX_AGE_MS;
  if ((albumIndex.count === 0 || stale) && !albumIndex.building) {
    buildAlbumIndex().catch(e => { if (DEBUG) console.error("[index] build failed:", e.message); });
  }
  if (albumIndex.count === 0 && albumIndex.building) {
    await albumIndex.building.catch(() => {});
  }
}

// Background maintenance: build now, then periodically check the album count.
// If it changed, the library was edited and offsets may have shifted, so we
// rebuild. Started on pairing, stopped on unpairing.
function startIndexMaintenance() {
  stopIndexMaintenance();
  buildAlbumIndex()
    .then(() => seedLabelsFromCache())
    .catch(e => { if (DEBUG) console.error("[index] initial build:", e.message); });
  indexMaintTimer = setInterval(async () => {
    if (!core || albumIndex.building) return;
    try {
      const sessionKey = "rra_idxchk_" + Math.random().toString(36).slice(2, 10);
      await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
      const head = await load({ hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey });
      const total = head.list && head.list.count ? head.list.count : 0;
      if (total !== albumIndex.count) {
        if (DEBUG) console.log("[index] count changed", albumIndex.count, "->", total, "- rebuilding");
        buildAlbumIndex().catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }, INDEX_CHECK_MS);
}
function stopIndexMaintenance() {
  if (indexMaintTimer) { clearInterval(indexMaintTimer); indexMaintTimer = null; }
}

// ---- Matching -------------------------------------------------------------
// Earliest index i where qTokens[k] is a prefix of tokens[i+k] for every k
// (a consecutive run). Returns that start index, or -1.
//   tokens=["the","the"], qTokens=["the","t"]  -> 0   (this is the "The The" case)
function consecutivePrefixStart(tokens, qTokens) {
  const last = tokens.length - qTokens.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let k = 0; k < qTokens.length; k++) {
      if (!tokens[i + k].startsWith(qTokens[k])) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}
// Every query token is a prefix of some distinct title token (order-independent),
// so "dark moon" still finds "Dark Side of the Moon".
function allTokensPrefixSomewhere(tokens, qTokens) {
  const used = new Array(tokens.length).fill(false);
  for (const qt of qTokens) {
    let found = false;
    for (let i = 0; i < tokens.length; i++) {
      if (!used[i] && tokens[i].startsWith(qt)) { used[i] = true; found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}
// Loose typo tolerance: all chars of q appear in order within s.
function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

// Higher score = better match. Title hits outrank artist hits of similar
// quality; exact/prefix outrank substring; fuzzy is a last resort.
function scoreAlbum(al, q, qTokens, qJoined, singleChar) {
  let s = 0;

  // ---- Title (primary) ----
  if (al.nTitle === q) return 1000;
  if (al.nTitle.startsWith(q)) {
    s = Math.max(s, 920 - Math.min(al.nTitle.length - q.length, 60));
  }
  {
    const start = consecutivePrefixStart(al.tTitle, qTokens);
    if (start === 0)                   s = Math.max(s, 900 - Math.min(al.tTitle.length, 40));
    else if (start > 0 && !singleChar) s = Math.max(s, 820 - start * 4);
  }
  if (al.jTitle.startsWith(qJoined)) {
    s = Math.max(s, 870 - Math.min(al.jTitle.length - qJoined.length, 60));
  }
  if (!singleChar) {
    if (s < 760 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tTitle, qTokens)) {
      s = Math.max(s, 760);
    }
    if (s < 650 && al.nTitle.includes(q)) {
      s = Math.max(s, 650 - Math.min(al.nTitle.indexOf(q), 40));
    }
  }

  // ---- Artist (secondary) ----
  if (al.nArtist) {
    if (al.nArtist === q)         s = Math.max(s, 770);
    if (al.nArtist.startsWith(q)) s = Math.max(s, 740 - Math.min(al.nArtist.length - q.length, 60));
    {
      const start = consecutivePrefixStart(al.tArtist, qTokens);
      if (start === 0)                   s = Math.max(s, 720 - Math.min(al.tArtist.length, 40));
      else if (start > 0 && !singleChar) s = Math.max(s, 660 - start * 4);
    }
    if (al.jArtist.startsWith(qJoined)) s = Math.max(s, 700 - Math.min(al.jArtist.length - qJoined.length, 60));
    if (!singleChar) {
      if (s < 600 && qTokens.length > 1 && allTokensPrefixSomewhere(al.tArtist, qTokens)) s = Math.max(s, 600);
      if (s < 520 && al.nArtist.includes(q)) s = Math.max(s, 520 - Math.min(al.nArtist.indexOf(q), 40));
    }
  }

  // ---- Fuzzy fallback (typos), only for longer queries with no real hit ----
  if (s === 0 && !singleChar && qJoined.length >= 4) {
    if (isSubsequence(qJoined, al.jTitle))       s = 300;
    else if (isSubsequence(qJoined, al.jArtist)) s = 260;
  }

  return s;
}

function searchAlbums(query, limit) {
  const q = normalize(query);
  if (!q) return [];
  const qTokens    = q.split(" ").filter(Boolean);
  const qJoined    = q.replace(/ /g, "");
  const singleChar = qJoined.length <= 1;

  const out = [];
  for (const al of albumIndex.albums) {
    const score = scoreAlbum(al, q, qTokens, qJoined, singleChar);
    if (score > 0) out.push({ al, score });
  }
  out.sort((a, b) =>
    b.score - a.score ||
    a.al.nTitle.localeCompare(b.al.nTitle) ||
    a.al.nArtist.localeCompare(b.al.nArtist)
  );
  return out.slice(0, limit).map(({ al, score }) => ({
    offset:    al.offset,
    title:     al.title,
    subtitle:  al.subtitle,
    image_key: al.image_key,
    score
  }));
}

// ---------------------------------------------------------------------------
// Express HTTP API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    paired:    !!core,
    core_id:   core ? core.core_id      : null,
    core_name: core ? core.display_name : null,
    zone_count: Object.keys(zones).length
  });
});

app.get("/api/zones", (req, res) => {
  const list = Object.values(zones).map(z => ({
    zone_id:      z.zone_id,
    display_name: z.display_name,
    state:        z.state,
    outputs: (z.outputs || []).map(o => ({
      output_id: o.output_id, display_name: o.display_name
    }))
  })).sort((a, b) => a.display_name.localeCompare(b.display_name));
  res.json({ zones: list });
});

// Read an optional genre/tag filter from query params (or POST body).
function parseFilter(src) {
  const type  = (src.filter_type  || "").trim();
  const value = (src.filter_value || "").trim();
  if (!type || !value) return null;
  if (type !== "genre" && type !== "tag" && type !== "label") return null;
  return { type, value };
}

app.get("/api/artist-albums", (req, res) => {
  const artist = (req.query.artist || "").trim();
  if (!artist) return res.status(400).json({ error: "artist required" });
  if (!albumIndex.count) return res.json({ artist, primary: [], featured: [] });
  const norm = normalize(artist);
  const primary = [], featured = [];
  for (const al of albumIndex.albums) {
    const sub = normalize(al.subtitle || "");
    if (!sub) continue;
    if (sub === norm) primary.push(al);
    else if (sub.includes(norm)) featured.push(al);
  }
  primary.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  featured.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  res.json({ artist, primary, featured });
});

app.get("/api/random-albums", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const count = Math.max(1, Math.min(96, parseInt(req.query.count || ALBUM_COUNT_DEFAULT, 10)));
  const filter = parseFilter(req.query);
  try {
    const r = await pickRandomAlbums(count, filter);
    res.json({ albums: r.albums, total: r.total, filtered: !!filter });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Available genres (top level of the "genres" hierarchy).
app.get("/api/filters/genres", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const sessionKey = "rra_gen_" + Math.random().toString(36).slice(2, 10);
  try {
    await browse({ hierarchy: "genres", pop_all: true, multi_session_key: sessionKey });
    const lvl = await loadLevel(sessionKey, "genres", 1000);
    // Keep only genres that actually contain albums, biggest first — Roon
    // reports the count in the subtitle (e.g. "12 Albums"). If no subtitle
    // parses (format differs from expected), fall back to the raw list so
    // the feature degrades instead of going empty.
    const parsed = lvl.items
      .filter(i => i.hint !== "header" && i.title)
      .map(i => {
        const m = /(\d[\d,]*)\s*albums?/i.exec(i.subtitle || "");
        return {
          title: i.title,
          subtitle: i.subtitle || "",
          count: m ? parseInt(m[1].replace(/,/g, ""), 10) : null
        };
      });
    const anyParsed = parsed.some(g => g.count !== null);
    const genres = (anyParsed
      ? parsed.filter(g => g.count !== null && g.count > 0)
              .sort((a, b) => b.count - a.count)
      : parsed
    ).map(g => ({ title: g.title, subtitle: g.subtitle }));
    res.json({ genres });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Available tags (browse tree: Library → Tags).
app.get("/api/filters/tags", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const sessionKey = "rra_tag_" + Math.random().toString(36).slice(2, 10);
  try {
    await browse({ hierarchy: "browse", pop_all: true, multi_session_key: sessionKey });
    const lib = await findItemByTitle(sessionKey, "browse", "Library", 50);
    if (!lib) return res.json({ tags: [] });
    await browse({ hierarchy: "browse", item_key: lib.item_key, multi_session_key: sessionKey });
    const tagsNode = await findItemByTitle(sessionKey, "browse", "Tags", 100);
    if (!tagsNode) return res.json({ tags: [] });
    await browse({ hierarchy: "browse", item_key: tagsNode.item_key, multi_session_key: sessionKey });
    const lvl = await loadLevel(sessionKey, "browse", 1000);
    const tags = lvl.items
      .filter(i => i.hint !== "header" && i.title)
      .map(i => ({ title: i.title, subtitle: i.subtitle || "" }));
    res.json({ tags });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record labels — built from Qobuz-scraped data (no Roon "Labels" node needed).
// Triggers a background scan on first call so the list grows over time.
app.get("/api/filters/labels", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  // Kick off a scan if one hasn't been done yet.
  if (!labelsIndex.building && labelsIndex.builtAt === 0) {
    runLabelsIndexScan().catch(e => {
      if (DEBUG) console.error("[labels] scan error:", e.message);
    });
  }
  const labels = [];
  for (const [, entry] of labelsIndex.map) {
    labels.push({
      title:      entry.display,
      subtitle:   entry.albums.length + " album" + (entry.albums.length === 1 ? "" : "s"),
      albumCount: entry.albums.length,
      image_key:  entry.image_key || null,
      logo_url:   entry.logo_url  || null
    });
  }
  labels.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  res.json({
    labels,
    scanning:  labelsIndex.building,
    progress:  labelsIndex.progress,
    count:     labelsIndex.count
  });
});

// All albums for one label, ordered. ?label=NAME&order=alpha|random
// Albums are served from the Qobuz-derived labelsIndex; offsets are positions
// in the full "albums" hierarchy so open/play work without any filter.
app.get("/api/label-albums", (req, res) => {
  const name  = String(req.query.label || "").trim();
  const order = req.query.order === "random" ? "random" : "alpha";
  if (!name) return res.status(400).json({ error: "label query parameter required" });
  const entry = labelsIndex.map.get(labelGroupKey(name));
  if (!entry) {
    return res.json({ albums: [], total: 0, label: name, order,
      scanning: labelsIndex.building });
  }
  let albums = entry.albums.slice();
  if (order === "random") {
    for (let i = albums.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [albums[i], albums[j]] = [albums[j], albums[i]];
    }
  } else {
    albums.sort((a, b) =>
      (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  }
  res.json({ albums, total: albums.length, label: name, order });
});

// Labels scan status — lets the UI poll while the background Qobuz scan runs.
app.get("/api/labels-scan-status", (req, res) => {
  res.json({
    scanning:  labelsIndex.building,
    progress:  labelsIndex.progress,
    count:     labelsIndex.count,
    builtAt:   labelsIndex.builtAt
  });
});

// Debug: dump the browse root + Library contents so we can see whether (and
// where) a "Labels" list exists on a live Core.
app.get("/api/debug/labels", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const sessionKey = "rra_lbldbg_" + Math.random().toString(36).slice(2, 10);
  try {
    await browse({ hierarchy: "browse", pop_all: true, multi_session_key: sessionKey });
    const root = await loadLevel(sessionKey, "browse", 100);
    let library = null;
    const lib = root.items.find(i => /^library$/i.test((i.title || "").trim()));
    if (lib) {
      await browse({ hierarchy: "browse", item_key: lib.item_key, multi_session_key: sessionKey });
      library = (await loadLevel(sessionKey, "browse", 100)).items.map(i => i.title);
    }
    res.json({ root: root.items.map(i => i.title), library });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: dump what a filter navigation actually finds, level by level —
// for fixing tree-walking assumptions against a live Core.
app.get("/api/debug/filter", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const filter = parseFilter(req.query);
  const sessionKey = "rra_fdbg_" + Math.random().toString(36).slice(2, 10);
  try {
    const nav = await navigateToAlbumList(sessionKey, filter);
    const sample = await load({
      hierarchy: nav.hierarchy, offset: 0, count: 10, multi_session_key: sessionKey
    });
    res.json({
      filter, hierarchy: nav.hierarchy, total: nav.total,
      sample: (sample.items || []).map(i => ({
        title: i.title, subtitle: i.subtitle, hint: i.hint || null
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/image/:image_key", async (req, res) => {
  if (!core) return res.status(503).end();
  const size = Math.max(64, Math.min(1200, parseInt(req.query.size || "400", 10)));
  try {
    const { content_type, body } = await getImage(req.params.image_key, {
      scale: "fit", width: size, height: size, format: "image/jpeg"
    });
    res.set("Content-Type", content_type || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(body);
  } catch (e) {
    res.status(404).end();
  }
});

// Album detail: requires ?offset=N
app.get("/api/album", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  try {
    const r = await openAlbumByOffset(offset, null, null, parseFilter(req.query));
    res.json({
      album:  r.album,
      tracks: r.tracks,
      actions: r.actions.map(a => ({ kind: a.kind, title: a.title }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Album love (heart) — read or toggle via Roon browse API.
// Roon exposes the heart as an action_list item inside the album browse level.
// Title is "Love Album" when not loved, "Unlove Album" when currently loved.
// ---------------------------------------------------------------------------
const LOVE_RE = /\blove\b|\bheart\b|\bfavouri?te\b|\bliked?\b/i;
const UNLOVE_RE = /\bunlove\b/i;

async function invokeFoundLoveItem(hierarchy, loveItem, sessionKey) {
  await browse({ hierarchy, item_key: loveItem.item_key, multi_session_key: sessionKey });
  const sub = await load({ hierarchy, offset: 0, count: 10, multi_session_key: sessionKey }).catch(() => null);
  if (sub && sub.items && sub.items.length) {
    const ci = sub.items.find(i => LOVE_RE.test(i.title || "")) || sub.items[0];
    if (ci && ci.item_key) {
      await browse({ hierarchy, item_key: ci.item_key, multi_session_key: sessionKey }).catch(() => {});
    }
  }
}

async function getOrToggleAlbumLove(offset, doToggle, filter) {
  const sessionKey = "rra_love_" + Math.random().toString(36).slice(2, 10);
  const nav = await navigateToAlbumList(sessionKey, filter || null);
  const hierarchy = nav.hierarchy;

  const albumLoad = await load({ hierarchy, offset, count: 1, multi_session_key: sessionKey });
  const albumItem = albumLoad.items && albumLoad.items[0];
  if (!albumItem) throw new Error("Album not found at offset " + offset);

  await browse({ hierarchy, item_key: albumItem.item_key, multi_session_key: sessionKey });
  const inside = await load({ hierarchy, offset: 0, count: 300, multi_session_key: sessionKey });
  const items = inside.items || [];

  // Always log so docker logs reveal the actual browse structure
  console.log("[love] album offset=" + offset + " title=" + JSON.stringify(albumItem.title) + " → " + items.length + " items");
  items.forEach(i => console.log("  hint=" + (i.hint || "none") + "  title=" + JSON.stringify(i.title)));

  let loveItem = items.find(i => LOVE_RE.test(i.title || ""));

  // Not found at top level — dive into each nested action_list (each gets its own session)
  if (!loveItem) {
    for (const candidate of items.filter(i => i.hint === "action_list" && i.item_key)) {
      const nk = "rra_love_n_" + Math.random().toString(36).slice(2, 10);
      const navN = await navigateToAlbumList(nk, filter || null);
      const alN = await load({ hierarchy: navN.hierarchy, offset, count: 1, multi_session_key: nk });
      const aN = alN.items && alN.items[0];
      if (!aN) continue;
      await browse({ hierarchy: navN.hierarchy, item_key: aN.item_key, multi_session_key: nk });
      await browse({ hierarchy: navN.hierarchy, item_key: candidate.item_key, multi_session_key: nk });
      const subLoad = await load({ hierarchy: navN.hierarchy, offset: 0, count: 100, multi_session_key: nk });
      const subItems = subLoad.items || [];
      console.log("[love] inside '" + (candidate.title || "") + "': " + subItems.length + " items");
      subItems.forEach(i => console.log("  hint=" + (i.hint || "none") + "  title=" + JSON.stringify(i.title)));
      const nested = subItems.find(i => LOVE_RE.test(i.title || ""));
      if (nested) {
        console.log("[love] found in nested list:", JSON.stringify(nested.title));
        const loved = UNLOVE_RE.test(nested.title || "");
        if (!doToggle) return { found: true, loved };
        await invokeFoundLoveItem(navN.hierarchy, nested, nk);
        return { found: true, loved: !loved };
      }
    }
    console.log("[love] love action not found for offset=" + offset);
    return { found: false, loved: null };
  }

  const currentlyLoved = UNLOVE_RE.test(loveItem.title || "");
  if (!doToggle) return { found: true, loved: currentlyLoved };

  await invokeFoundLoveItem(hierarchy, loveItem, sessionKey);
  return { found: true, loved: !currentlyLoved };
}

// GET /api/album/love?offset=... — check love state
app.get("/api/album/love", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: "Valid offset required" });
  try {
    const result = await getOrToggleAlbumLove(offset, false, parseFilter(req.query));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/album/love?offset=... — toggle love
app.post("/api/album/love", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: "Valid offset required" });
  try {
    const result = await getOrToggleAlbumLove(offset, true, parseFilter(req.query));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug/album-items?offset=N — dump raw browse items for diagnostic
app.get("/api/debug/album-items", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: "Valid offset required" });
  try {
    const sessionKey = "rra_dbg_" + Math.random().toString(36).slice(2, 10);
    const nav = await navigateToAlbumList(sessionKey, null);
    const hierarchy = nav.hierarchy;
    const albumLoad = await load({ hierarchy, offset, count: 1, multi_session_key: sessionKey });
    const albumItem = albumLoad.items && albumLoad.items[0];
    if (!albumItem) return res.json({ error: "No album at offset " + offset, items: [] });
    await browse({ hierarchy, item_key: albumItem.item_key, multi_session_key: sessionKey });
    const inside = await load({ hierarchy, offset: 0, count: 300, multi_session_key: sessionKey });
    const items = (inside.items || []).map(i => ({
      hint: i.hint, title: i.title, subtitle: i.subtitle, has_key: !!i.item_key
    }));
    res.json({ album: albumItem.title, offset, total_items: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Library stats — currently just the total album count Roon reports for the
// "albums" hierarchy.  Shown in the header so you know the size of the pool
// random picks are drawn from.
let _albumCountCache = { value: null, at: 0 };
app.get("/api/library-stats", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    // Cache for 60s so repeated header loads don't re-walk the hierarchy.
    const now = Date.now();
    if (_albumCountCache.value != null && now - _albumCountCache.at < 60000) {
      return res.json({ albums: _albumCountCache.value, cached: true });
    }
    const sessionKey = "rra_stats_" + Math.random().toString(36).slice(2, 10);
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const head = await load({
      hierarchy: "albums", offset: 0, count: 1, multi_session_key: sessionKey
    });
    const total = head.list && head.list.count ? head.list.count : 0;
    _albumCountCache = { value: total, at: now };
    res.json({ albums: total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Library search (instant, prefix-aware, typo-tolerant — see albumIndex above)
// ---------------------------------------------------------------------------

// Lightweight status so the UI can show "Building search index… NN%".
app.get("/api/search-status", (req, res) => {
  res.json({
    indexed:  albumIndex.count,
    building: !!albumIndex.building,
    progress: albumIndex.progress,
    builtAt:  albumIndex.builtAt
  });
});

// GET /api/search?q=...&limit=60
app.get("/api/search", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const q     = String(req.query.q || "");
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "60", 10)));
  if (!q.trim()) return res.json({ query: q, results: [], indexed: albumIndex.count });
  try {
    await ensureAlbumIndex();
    // If the very first build is still running, ask the client to wait & retry.
    if (albumIndex.count === 0 && albumIndex.building) {
      return res.json({ query: q, results: [], building: true, progress: albumIndex.progress });
    }
    const results = searchAlbums(q, limit);
    res.json({ query: q, count: results.length, indexed: albumIndex.count, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force a rebuild (e.g. after importing music). Returns when done.
app.post("/api/reindex", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  try {
    await buildAlbumIndex();
    res.json({ ok: true, indexed: albumIndex.count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Self-update endpoints (does not require a paired Core)
// ---------------------------------------------------------------------------
app.get("/api/update/status", (req, res) => {
  res.json({ ...updater.getStatus(), is_docker: process.env.DOCKER === "1" });
});

app.post("/api/update/check", async (req, res) => {
  const s = await updater.checkNow();
  pushStatus(); refreshSettings();
  res.json(s);
});

app.post("/api/update/apply", async (req, res) => {
  let st = updater.getStatus();
  if (!st.available) {
    st = await updater.checkNow();
    if (!st.available) return res.status(409).json({ error: "No update available", status: st });
  }
  // Respond first; apply() downloads + stages, then exits with code 75 so the
  // launcher (or a process supervisor) restarts into the new version.
  res.json({ ok: true, status: updater.getStatus() });
  updater.apply().then(() => { pushStatus(); refreshSettings(); }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Random Album Radio
// Keeps a zone playing whole random albums when its queue runs dry — but only
// while Roon Radio (auto_radio) is OFF for that zone, so the two never fight.
// While a zone is playing we top up gaplessly as it reaches its last track;
// if it ever stops with an empty queue (or you enable radio while idle) we
// start a fresh random album. Enabled per zone and persisted across restarts.
// ---------------------------------------------------------------------------
const radioZones = new Set();
// Prefer the volume-backed settings.json (survives container recreation).
// Fall back to roon.load_config for backward compatibility.
try {
  const s = loadPersistedSettings();
  if (Array.isArray(s.radioZones)) s.radioZones.forEach(z => radioZones.add(z));
} catch (e) {}
if (!radioZones.size) {
  try {
    const saved = (roon.load_config && roon.load_config("rra_settings")) || {};
    if (Array.isArray(saved.radioZones)) saved.radioZones.forEach(z => radioZones.add(z));
  } catch (e) {}
}
function persistRadio() {
  const zones = [...radioZones];
  try { roon.save_config && roon.save_config("rra_settings", { radioZones: zones }); } catch (e) {}
  savePersistedSettings({ radioZones: zones });
}
const radioBusy = {}; // zone_id -> { active: bool, ts: number }

async function radioTopUp(zoneId, mode) {
  const st = radioBusy[zoneId] || (radioBusy[zoneId] = { active: false, ts: 0 });
  if (st.active && (Date.now() - st.ts) < 30000) return; // already working; 30s safety
  st.active = true; st.ts = Date.now();
  try {
    const picks = (await pickRandomAlbums(1)).albums;
    if (!picks.length) { st.active = false; return; }
    await openAlbumByOffset(picks[0].offset, zoneId, mode === "play" ? "play_now" : "queue");
    if (DEBUG) console.log("[radio] " + mode + " '" + picks[0].title + "' -> " + zoneId);
    // st.active clears when the queue grows (handleRadioZone sees remaining > 1)
    // or via the 30s timeout above if the queue never reflects the add.
  } catch (e) {
    if (DEBUG) console.error("[radio] top-up failed:", e.message);
    st.active = false; // allow a retry on the next zone update
  }
}

function handleRadioZone(z) {
  if (!z || !radioZones.has(z.zone_id)) return;
  const st = radioBusy[z.zone_id] || (radioBusy[z.zone_id] = { active: false, ts: 0 });

  // Clear the "working" guard once the queue is healthy again (our added album
  // landed), so we'll top up afresh when it next reaches the last track.
  if ((z.state === "playing" || z.state === "loading") &&
      typeof z.queue_items_remaining === "number" && z.queue_items_remaining > 1) {
    st.active = false;
  }

  const decision = radioDecision(z, true);
  if (decision === "queue") radioTopUp(z.zone_id, "queue");
  else if (decision === "play") radioTopUp(z.zone_id, "play");
}

// ---------------------------------------------------------------------------
// Scrobble / play tracking — records plays into SQLite for stats.
// ---------------------------------------------------------------------------
function scrobbleUpdate(z) {
  if (!labelsDb || !stmtInsertPlay) return;
  const np    = z && z.now_playing;
  const state = z && z.state;
  const zid   = z && z.zone_id;
  if (!zid) return;

  const prev = scrobbleState.get(zid);

  if (state === "playing" && np && np.line1) {
    if (!prev || prev.track !== np.line1 || prev.album !== (np.line3 || "")) {
      // New track — complete previous if it qualifies
      if (prev && prev.playId && prev.elapsed >= 30 &&
          (prev.elapsed >= (prev.duration || 0) * 0.5 || prev.elapsed >= 240)) {
        try { stmtCompletePlay.run(prev.playId); } catch (e) {}
      }
      // Insert new play record
      let playId = null;
      try {
        const info = stmtInsertPlay.run(
          Date.now(), z.display_name || zid,
          np.line1 || "", np.line2 || "", np.line3 || "",
          np.image_key || "", np.length || 0
        );
        playId = info.lastInsertRowid;
      } catch (e) {}
      scrobbleState.set(zid, {
        track: np.line1, artist: np.line2 || "", album: np.line3 || "",
        image_key: np.image_key || "", duration: np.length || 0,
        playId, elapsed: 0, lastSeekPos: np.seek_position || 0
      });
    } else if (prev) {
      // Same track — accumulate elapsed via seek_position delta
      const seekDelta = (np.seek_position || 0) - prev.lastSeekPos;
      if (seekDelta > 0 && seekDelta < 30) prev.elapsed += seekDelta;
      prev.lastSeekPos = np.seek_position || 0;
    }
  } else if (prev && prev.playId) {
    // Not playing (paused/stopped) — finalise if eligible
    if (prev.elapsed >= 30 &&
        (prev.elapsed >= (prev.duration || 0) * 0.5 || prev.elapsed >= 240)) {
      try { stmtCompletePlay.run(prev.playId); } catch (e) {}
    }
    scrobbleState.delete(zid);
  }
}

app.get("/api/radio", (req, res) => {
  const zoneId = req.query.zone;
  res.json({ enabled: zoneId ? radioZones.has(zoneId) : false, zones: [...radioZones] });
});
app.post("/api/radio", (req, res) => {
  const zoneId  = (req.body && req.body.zone) || null;
  const enabled = !!(req.body && req.body.enabled);
  if (!zoneId) return res.status(400).json({ error: "zone required" });
  if (enabled) {
    radioZones.add(zoneId);
  } else {
    radioZones.delete(zoneId);
    if (radioBusy[zoneId]) radioBusy[zoneId].active = false;
  }
  persistRadio();
  res.json({ ok: true, enabled });
  // React immediately: start if idle, or top up if already on the last track.
  if (enabled && core && zones[zoneId]) {
    try { handleRadioZone(zones[zoneId]); } catch (e) {}
  }
});

// Album metadata extras: release year (MusicBrainz) + bios (Discogs).
// Frontend passes title and artist so we don't hit Roon twice per modal open.
app.get("/api/album/extras", async (req, res) => {
  const title  = String(req.query.title  || "");
  const artist = String(req.query.artist || "");
  if (!title) return res.status(400).json({ error: "title query parameter required" });
  try {
    const [year, bios] = await Promise.all([
      fetchAlbumYear(title, artist),
      fetchAlbumBios(title, artist)
    ]);
    // Prefer MusicBrainz's first-release year (the album's original release)
    // over Qobuz's edition date, which can be a later reissue.
    if (bios && bios.album && year) bios.album.year = year;
    res.json({
      year,
      album:  bios ? bios.album  : null,
      artist: bios ? bios.artist : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint: dumps the raw items returned by Roon when drilling into an
// album.  Visit http://<host>:3399/api/debug/album?offset=N in your browser.
app.get("/api/debug/album", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  const sessionKey = "rra_dbg_" + Math.random().toString(36).slice(2, 10);
  try {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const albumLoad = await load({
      hierarchy: "albums", offset, count: 1, multi_session_key: sessionKey
    });
    const albumItem = albumLoad.items && albumLoad.items[0];
    if (!albumItem) return res.status(404).json({ error: "Album not found at offset" });

    await browse({
      hierarchy: "albums",
      item_key:  albumItem.item_key,
      multi_session_key: sessionKey
    });
    const inside = await load({
      hierarchy: "albums",
      offset: 0,
      count: 500,
      multi_session_key: sessionKey
    });
    res.json({
      album: { title: albumItem.title, subtitle: albumItem.subtitle },
      list:  inside.list,
      item_count_returned: (inside.items || []).length,
      items: (inside.items || []).map(it => ({
        title: it.title,
        subtitle: it.subtitle,
        hint: it.hint || null,
        has_image: !!it.image_key,
        item_key_present: !!it.item_key
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug: test Roon-native label detection on a single album by offset.
// Visit /api/debug/label-scan?offset=N to see every item Roon returns and
// which one (if any) is detected as the label.
app.get("/api/debug/label-scan", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) {
    return res.status(400).json({ error: "Valid offset query parameter required" });
  }
  const sessionKey = "rra_lbldbg2_" + Math.random().toString(36).slice(2, 10);
  try {
    await browse({ hierarchy: "albums", pop_all: true, multi_session_key: sessionKey });
    const albumLoad = await load({ hierarchy: "albums", offset, count: 1, multi_session_key: sessionKey });
    const albumItem = albumLoad.items && albumLoad.items[0];
    if (!albumItem) return res.status(404).json({ error: "Album not found at offset" });
    await browse({ hierarchy: "albums", item_key: albumItem.item_key, multi_session_key: sessionKey });
    const inside = await load({ hierarchy: "albums", offset: 0, count: 300, multi_session_key: sessionKey });
    const items = inside.items || [];
    res.json({
      album:    { title: albumItem.title, subtitle: albumItem.subtitle, offset },
      detected_label: null,
      all_items: items.map(i => ({
        title:   i.title,
        hint:    i.hint || null,
        has_key: !!i.item_key
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Play an album: body { offset, zone_or_output_id, kind }
app.post("/api/play", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core yet" });
  const { offset, zone_or_output_id, kind } = req.body || {};
  const filter = parseFilter(req.body || {});
  if (!Number.isFinite(offset)) return res.status(400).json({ error: "offset required" });
  if (!zone_or_output_id)       return res.status(400).json({ error: "zone_or_output_id required" });
  if (!kind)                    return res.status(400).json({ error: "kind required" });
  try {
    await openAlbumByOffset(offset, zone_or_output_id, kind, filter);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Mini-transport: live now-playing for a zone + playback / volume control
// ---------------------------------------------------------------------------

// Resolve the currently playing album for a zone, via Roon's browse hierarchy
// (search → Albums → matching item). Returns tracks + the bio shape used by
// the album modal.  If anything fails, returns the basic info we already have
// from now_playing so the modal still works (no tracks but no error either).
async function findNowPlayingAlbum(zoneId) {
  if (!core) throw new Error("Not paired with Roon Core");
  const zone = zones[zoneId];
  if (!zone || !zone.now_playing) throw new Error("Nothing playing in this zone");

  const tl    = zone.now_playing.three_line || {};
  const title = tl.line3 || (zone.now_playing.one_line && zone.now_playing.one_line.line1) || "";
  const artist= tl.line2 || "";
  const image = zone.now_playing.image_key || null;

  const fallback = {
    album:  { title, subtitle: artist, image_key: image },
    tracks: []
  };
  if (!title) return fallback;

  const sessionKey = "rra_np_" + Math.random().toString(36).slice(2, 10);
  const hier = "browse";

  try {
    // Root with EXPLICIT count: 100 — without this the search entry can be on
    // a later page and we never see it.
    await browse({ hierarchy: hier, pop_all: true, multi_session_key: sessionKey, zone_or_output_id: zoneId });
    const root = await load({ hierarchy: hier, offset: 0, count: 100, multi_session_key: sessionKey });
    const items0 = root.items || [];

    const searchItem = items0.find(i => i.input_prompt)
                    || items0.find(i => /search/i.test(i.title || ""));
    if (!searchItem) {
      if (DEBUG) console.log("[np] no search at root, items were:",
        items0.map(i => ({ title: i.title, hint: i.hint })));
      return fallback;
    }

    const query = `${title} ${artist}`.trim();
    await browse({
      hierarchy: hier, multi_session_key: sessionKey,
      item_key: searchItem.item_key, input: query, zone_or_output_id: zoneId
    });
    const results = await load({ hierarchy: hier, offset: 0, count: 100, multi_session_key: sessionKey });
    const sections = results.items || [];

    const albumsSection = sections.find(s => /album/i.test(s.title || "") && s.item_key);
    if (!albumsSection) return fallback;

    await browse({ hierarchy: hier, multi_session_key: sessionKey, item_key: albumsSection.item_key });
    const albs = await load({ hierarchy: hier, offset: 0, count: 50, multi_session_key: sessionKey });

    const titleN  = title.toLowerCase().trim();
    const artistN = artist.toLowerCase().trim();
    const albumItem =
         (albs.items || []).find(i => (i.title || "").toLowerCase() === titleN
                                    && (i.subtitle || "").toLowerCase().includes(artistN))
      || (albs.items || []).find(i => (i.title || "").toLowerCase() === titleN)
      || (albs.items || []).find(i => (i.title || "").toLowerCase().includes(titleN))
      || (albs.items || [])[0];
    if (!albumItem || !albumItem.item_key) return fallback;

    await browse({ hierarchy: hier, multi_session_key: sessionKey, item_key: albumItem.item_key });
    const inside = await load({ hierarchy: hier, multi_session_key: sessionKey, offset: 0, count: 500 });
    const items = inside.items || [];

    const playMenu = items.find(i => i.hint === "action_list" && !i.subtitle && /^play/i.test(i.title || ""))
                  || items.find(i => i.hint === "action_list" && !i.subtitle);
    const tracks = items
      .filter(t => {
        if (t === playMenu) return false;
        if (t.hint === "action_list" && !t.subtitle) return false;
        if (t.hint === "header") return false;
        return true;
      })
      .map(t => ({
        title:    (t.title || "").replace(/^\d+\.\s+/, ""),
        subtitle: t.subtitle || ""
      }));

    return {
      album: {
        title:     albumItem.title    || title,
        subtitle:  albumItem.subtitle || artist,
        image_key: albumItem.image_key || image
      },
      tracks
    };
  } catch (e) {
    if (DEBUG) console.error("[np lookup]", e.message);
    return fallback;
  }
}

app.get("/api/album/now-playing", async (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  if (!zoneId) return res.status(400).json({ error: "zone required" });
  try {
    const r = await findNowPlayingAlbum(zoneId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Queue for a zone
// RoonApiTransport doesn't expose a one-shot get_queue — only subscribe_queue.
// We subscribe, respond on the first "Subscribed" payload, and accept that the
// subscription leaks for the lifetime of the process (acceptable for occasional
// modal opens; a future revision could keep one persistent subscription per zone).
app.get("/api/queue", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  if (!zoneId) return res.status(400).json({ error: "zone required" });

  let responded = false;
  const timeout = setTimeout(() => {
    if (responded) return;
    responded = true;
    res.status(504).json({ error: "queue subscription timed out" });
  }, 5000);

  try {
    core.services.RoonApiTransport.subscribe_queue(zoneId, 100, (response, msg) => {
      if (responded) return;
      if (response === "Subscribed") {
        responded = true;
        clearTimeout(timeout);
        const items = ((msg && msg.items) || []).map(it => ({
          queue_item_id: it.queue_item_id,
          title:    (it.one_line && it.one_line.line1) || (it.three_line && it.three_line.line1) || "",
          subtitle: (it.three_line && it.three_line.line2) || "",
          image_key: it.image_key || null,
          length:    it.length || null
        }));
        res.json({ items });
      }
    });
  } catch (e) {
    if (!responded) {
      responded = true;
      clearTimeout(timeout);
      res.status(500).json({ error: e.message || String(e) });
    }
  }
});

app.get("/api/zone-state", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const zoneId = req.query.zone;
  const zone   = zoneId && zones[zoneId];
  if (!zone) return res.json({ zone: null });

  const np = zone.now_playing || null;
  const tl = (np && np.three_line) || {};
  const ol = (np && np.one_line)   || {};

  res.json({
    zone: {
      zone_id:             zone.zone_id,
      display_name:        zone.display_name,
      state:               zone.state,  // "playing" | "paused" | "loading" | "stopped"
      is_play_allowed:     !!zone.is_play_allowed,
      is_pause_allowed:    !!zone.is_pause_allowed,
      is_next_allowed:     !!zone.is_next_allowed,
      is_previous_allowed: !!zone.is_previous_allowed,
      is_seek_allowed:     !!zone.is_seek_allowed,
      outputs: (zone.outputs || []).map(o => ({
        output_id:    o.output_id,
        display_name: o.display_name,
        is_muted:     !!o.is_muted,
        volume:       o.volume ? {
          value:      o.volume.value,
          min:        o.volume.min,
          max:        o.volume.max,
          step:       o.volume.step,
          soft_limit: o.volume.soft_limit,
          type:       o.volume.type
        } : null
      })),
      now_playing: np ? {
        line1:     tl.line1 || ol.line1 || "",   // track
        line2:     tl.line2 || "",               // artist
        line3:     tl.line3 || "",               // album
        image_key: np.image_key || null,
        length:    np.length || null,
        seek_position: np.seek_position || null
      } : null
    }
  });
});

// Playback control.  body: { zone_or_output_id, command }
// command ∈ play | pause | playpause | stop | previous | next
app.post("/api/control", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id, command } = req.body || {};
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  const allowed = ["play", "pause", "playpause", "stop", "previous", "next"];
  if (!allowed.includes(command)) {
    return res.status(400).json({ error: "invalid command, allowed: " + allowed.join(", ") });
  }
  core.services.RoonApiTransport.control(zone_or_output_id, command, (err) => {
    if (err) return res.status(500).json({ error: typeof err === "string" ? err : JSON.stringify(err) });
    res.json({ ok: true });
  });
});

// Seek within the current track.  body: { zone_or_output_id, seconds }
// Absolute seek to a position in seconds from the start of the track.
app.post("/api/seek", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id } = req.body || {};
  const seconds = Number(req.body && req.body.seconds);
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });
  if (!Number.isFinite(seconds) || seconds < 0) return res.status(400).json({ error: "seconds must be a non-negative number" });
  core.services.RoonApiTransport.seek(zone_or_output_id, "absolute", Math.round(seconds), (err) => {
    if (err) return res.status(500).json({ error: typeof err === "string" ? err : JSON.stringify(err) });
    res.json({ ok: true });
  });
});

// Transfer zone: move the currently playing queue from one zone to another.
// body: { from_zone, to_zone }
app.post("/api/transfer-zone", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { from_zone, to_zone } = req.body || {};
  if (!from_zone || !to_zone) return res.status(400).json({ error: "from_zone and to_zone required" });
  if (from_zone === to_zone) return res.json({ ok: true, noop: true });

  const fromName = (zones[from_zone] && zones[from_zone].display_name) || from_zone;
  const toName   = (zones[to_zone]   && zones[to_zone].display_name)   || to_zone;
  console.log(`[transfer-zone] ${fromName} → ${toName}`);

  core.services.RoonApiTransport.transfer_zone(from_zone, to_zone, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[transfer-zone] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    console.log(`[transfer-zone] ok`);
    res.json({ ok: true });
  });
});

// Play from a specific queue item onwards.
// body: { zone_or_output_id, queue_item_id }
app.post("/api/play-from-here", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id, queue_item_id } = req.body || {};
  if (!zone_or_output_id || queue_item_id === undefined || queue_item_id === null) {
    return res.status(400).json({ error: "zone_or_output_id and queue_item_id required" });
  }
  core.services.RoonApiTransport.play_from_here(zone_or_output_id, queue_item_id, (err) => {
    if (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.warn(`[play-from-here] failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
    res.json({ ok: true });
  });
});

// Volume.  body: { zone_or_output_id, value?, mute?, relative? }
//   value:    absolute volume to set (uses output's native scale)
//   relative: signed delta to add (e.g. +5, -5)
//   mute:     true/false
// For a zone, applies to every output in the zone.
app.post("/api/volume", (req, res) => {
  if (!core) return res.status(503).json({ error: "Not paired with Roon Core" });
  const { zone_or_output_id } = req.body || {};
  if (!zone_or_output_id) return res.status(400).json({ error: "zone_or_output_id required" });

  // Figure out which outputs to target
  const zone = zones[zone_or_output_id];
  const targetOutputs = zone
    ? (zone.outputs || []).map(o => o)
    : (outputs[zone_or_output_id] ? [outputs[zone_or_output_id]] : []);
  if (targetOutputs.length === 0) return res.status(404).json({ error: "no outputs found" });

  const t = core.services.RoonApiTransport;
  const tasks = [];

  if (req.body.mute !== undefined) {
    const how = req.body.mute ? "mute" : "unmute";
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.mute(o.output_id, how, err => err ? reject(err) : resolve())));
    }
  } else if (req.body.value !== undefined) {
    const v = parseFloat(req.body.value);
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.change_volume(o.output_id, "absolute", v, err => err ? reject(err) : resolve())));
    }
  } else if (req.body.relative !== undefined) {
    const v = parseFloat(req.body.relative);
    for (const o of targetOutputs) {
      tasks.push(new Promise((resolve, reject) =>
        t.change_volume(o.output_id, "relative", v, err => err ? reject(err) : resolve())));
    }
  } else {
    return res.status(400).json({ error: "value, relative, or mute required" });
  }

  Promise.all(tasks)
    .then(() => res.json({ ok: true }))
    .catch(err => res.status(500).json({
      error: typeof err === "string" ? err : JSON.stringify(err)
    }));
});

// ---------------------------------------------------------------------------
// GET /api/stats — listening statistics from the plays table.
// ---------------------------------------------------------------------------
app.get("/api/stats", (req, res) => {
  if (!labelsDb) return res.json({ available: false });

  const total = labelsDb.prepare("SELECT COUNT(*) as n FROM plays WHERE completed=1").get().n;
  if (total === 0) return res.json({ available: true, total: 0, message: "No plays recorded yet — keep listening!" });

  // Top 10 albums by play count
  const topAlbums = labelsDb.prepare(`
    SELECT album, artist, image_key, COUNT(*) as plays
    FROM plays WHERE completed=1 AND album != ''
    GROUP BY album, artist ORDER BY plays DESC LIMIT 10
  `).all();

  // Top 10 tracks by play count
  const topTracks = labelsDb.prepare(`
    SELECT track, artist, album, COUNT(*) as plays
    FROM plays WHERE completed=1 AND track != ''
    GROUP BY track, artist, album ORDER BY plays DESC LIMIT 10
  `).all();

  // Top artists by play count (with percentage)
  const artistRows = labelsDb.prepare(`
    SELECT artist, COUNT(*) as plays
    FROM plays WHERE completed=1 AND artist != ''
    GROUP BY artist ORDER BY plays DESC LIMIT 10
  `).all();
  const artists = artistRows.map(r => ({ ...r, pct: Math.round(r.plays / total * 100) }));

  // Plays by decade
  const byDecade = labelsDb.prepare(`
    SELECT (m.year / 10 * 10) as decade, COUNT(*) as plays
    FROM plays p
    JOIN album_meta m ON m.album_key = (lower(trim(p.album)) || '||' || lower(trim(p.artist)))
    WHERE p.completed=1 AND m.year IS NOT NULL
    GROUP BY decade ORDER BY decade
  `).all();

  // Plays by genre
  const byGenre = labelsDb.prepare(`
    SELECT m.genre, COUNT(*) as plays
    FROM plays p
    JOIN album_meta m ON m.album_key = (lower(trim(p.album)) || '||' || lower(trim(p.artist)))
    WHERE p.completed=1 AND m.genre IS NOT NULL AND m.genre != ''
    GROUP BY m.genre ORDER BY plays DESC LIMIT 12
  `).all();

  // Listening by hour of day (UTC)
  const byHour = labelsDb.prepare(`
    SELECT ((ts / 3600000) % 24) as hour, COUNT(*) as plays
    FROM plays WHERE completed=1
    GROUP BY hour ORDER BY hour
  `).all();

  // Listening by day of week
  const byDay = labelsDb.prepare(`
    SELECT ((ts / 86400000 + 4) % 7) as dow, COUNT(*) as plays
    FROM plays WHERE completed=1
    GROUP BY dow ORDER BY dow
  `).all();
  const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // Library stats from album index
  const libTotal = albumIndex.count;

  // Summary stats
  const uniqueArtists = labelsDb.prepare("SELECT COUNT(DISTINCT artist) as n FROM plays WHERE completed=1 AND artist!=''").get().n;
  const uniqueAlbums  = labelsDb.prepare("SELECT COUNT(DISTINCT album||artist) as n FROM plays WHERE completed=1 AND album!=''").get().n;
  const mostActiveDay = byDay.reduce((a, b) => b.plays > a.plays ? b : a, byDay[0] || { dow: 0, plays: 0 });
  const peakHour      = byHour.reduce((a, b) => b.plays > a.plays ? b : a, byHour[0] || { hour: 0, plays: 0 });
  const hLabel        = h => { const a = h % 12 || 12; return a + (h < 12 ? "am" : "pm"); };

  // Repeat listener ratio
  const multiPlay = labelsDb.prepare("SELECT COUNT(*) as n FROM (SELECT album,artist FROM plays WHERE completed=1 GROUP BY album,artist HAVING COUNT(*)>1)").get().n;
  const repeatPct = uniqueAlbums > 0 ? Math.round(multiPlay / uniqueAlbums * 100) : 0;

  res.json({
    available: true,
    total,
    topAlbums,
    topTracks,
    artists,
    byDecade,
    byGenre,
    byHour: byHour.map(r => ({ hour: r.hour, label: hLabel(r.hour), plays: r.plays })),
    byDay:  byDay.map(r => ({ dow: r.dow, label: DOW[r.dow] || "?", plays: r.plays })),
    libTotal,
    surprises: {
      uniqueArtists,
      uniqueAlbums,
      mostActiveDay: DOW[mostActiveDay.dow] || "?",
      peakHour: hLabel(peakHour.hour),
      repeatPct,
    }
  });
});

app.listen(PORT, () => {
  console.log("Roon Random Albums UI listening on http://0.0.0.0:" + PORT);
  console.log("Make sure to authorise the extension in Roon → Settings → Extensions.");
  if (DEBUG) console.log("Debug logging enabled (RRA_DEBUG=1).");
});
