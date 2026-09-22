"use strict";
// ---------------------------------------------------------------------------
// v1.8.56 — TIDAL's favourites were never paged at all.
//
// One call with `limit: 5000`, and `pagedSection(r).items` returned. TIDAL
// states totalNumberOfItems in the same response and nothing read it, so a
// library past that limit came back short with no error and no way for the
// caller to tell. Same defect as Qobuz's ten-thousand ceiling, one service
// over, and worse: there was no loop to raise a limit on.
//
// Nobody had reported it. That is the point — a truncated read has no symptom
// that points at the read. It shows up as particular albums having no badge
// and no waveform, for ever, with everything else working perfectly.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const TD = require("../../lib/tidal");

// A fake TIDAL that pages the way the real one does.
function pager(total, cap) {
  const calls = [];
  return {
    calls,
    fetch: async (url) => {
      const u = new URL(url, "https://api.tidal.com");
      const limit  = Number(u.searchParams.get("limit"));
      const offset = Number(u.searchParams.get("offset") || 0);
      calls.push({ limit, offset });
      const n = Math.min(cap === undefined ? limit : cap, Math.max(0, total - offset));
      // tidalRequest reads res.text() and JSON.parses it, so a stub offering
      // only .json() never gets there — and every assertion below would be
      // about the stub rather than about the paging.
      const body = JSON.stringify({
        totalNumberOfItems: total,
        items: Array.from({ length: n }, (_, i) => ({ item: { id: offset + i + 1,
                                                              title: "A" + (offset + i + 1) } })),
      });
      return { ok: true, status: 200, text: async () => body };
    },
  };
}

test("a library bigger than one page comes back WHOLE", async () => {
  const realFetch = global.fetch;
  const p = pager(12500, 1000);
  global.fetch = p.fetch;
  try {
    const got = await TD.getFavoriteAlbumsAll("tok", "GB", "user-1");
    assert.equal(got.items.length, 12500,
      `only ${got.items.length} of 12500 favourites came back — everything past ` +
      `the first page is invisible to badges and waveforms`);
    assert.equal(got.total, 12500);
    assert.equal(got.truncated, false);
  } finally { global.fetch = realFetch; }
  assert.ok(p.calls.length > 1, "nothing was paged");
  assert.equal(p.calls[0].offset, 0);
  assert.equal(p.calls[1].offset, 1000, "the second page did not start where the first ended");
});

test("a library that fits costs exactly one call", async () => {
  const realFetch = global.fetch;
  const p = pager(120, 1000);
  global.fetch = p.fetch;
  try {
    const got = await TD.getFavoriteAlbumsAll("tok", "GB", "user-1");
    assert.equal(got.items.length, 120);
  } finally { global.fetch = realFetch; }
  assert.equal(p.calls.length, 1, `${p.calls.length} calls for a 120-album library`);
});

test("it stops when the stated total is reached", async () => {
  // A server that keeps answering past its own total must not be looped on.
  const realFetch = global.fetch;
  const p = pager(2000, 1000);
  global.fetch = p.fetch;
  try {
    const got = await TD.getFavoriteAlbumsAll("tok", "GB", "user-1");
    assert.equal(got.items.length, 2000);
  } finally { global.fetch = realFetch; }
  assert.equal(p.calls.length, 2);
});

test("an empty page ends the loop rather than spinning", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    const body = JSON.stringify({ totalNumberOfItems: 99999, items: [] });
    return { ok: true, status: 200, text: async () => body };
  };
  try {
    const got = await TD.getFavoriteAlbumsAll("tok", "GB", "user-1");
    assert.equal(got.items.length, 0);
  } finally { global.fetch = realFetch; }
  assert.ok(calls <= 2, `${calls} calls against a server returning nothing`);
});

test("the old accessor still returns a plain array", async () => {
  const realFetch = global.fetch;
  global.fetch = pager(30, 1000).fetch;
  try {
    const items = await TD.getFavoriteAlbums("tok", "GB", "user-1");
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 30);
  } finally { global.fetch = realFetch; }
});

test("no user id is refused before any call", async () => {
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("should not be called"); };
  try {
    await assert.rejects(() => TD.getFavoriteAlbumsAll("tok", "GB", ""));
    assert.equal(called, false);
  } finally { global.fetch = realFetch; }
});
