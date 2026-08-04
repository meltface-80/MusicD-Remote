"use strict";
// ---------------------------------------------------------------------------
// v1.7.40: makeTtlCache gained in-flight de-duplication.
//
// The genre lists are cached against the Core, and the Home screen fetches two
// of them at once. The old cache only wrote the map AFTER the fetch resolved,
// so two callers arriving on a cold key both ran the fetch — each one a Roon
// walk. On a cold start with several clients waking together that multiplies.
//
// The dangerous half of the fix is the failure path. The obvious way to share
// a promise is to store it in the same map as the values, and that caches the
// REJECTION for the whole TTL — turning a one-second Core blip into a
// half-hour outage that looks exactly like the Core being down. So:
//
//   1. concurrent callers share ONE fetch;
//   2. a rejection is never stored, and the very next caller retries;
//   3. a resolved value is still cached for the TTL.
// ---------------------------------------------------------------------------

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadIndexFunctions } = require("../lib/extract");

const { makeTtlCache } = loadIndexFunctions(["makeTtlCache"], {});

// A fetch that resolves after a real turn of the event loop, counting calls.
function counter(opts) {
  opts = opts || {};
  let calls = 0;
  const fn = async () => {
    calls++;
    await new Promise(r => setTimeout(r, 5));
    if (opts.throws) throw new Error("core blip");
    return opts.value !== undefined ? opts.value : "v" + calls;
  };
  return { fn, calls: () => calls };
}

test("concurrent callers share one fetch", async (t) => {
  await t.test("three simultaneous misses run the fetch once", async () => {
    const c = counter();
    const cache = makeTtlCache(60000);
    const [a, b, d] = await Promise.all([
      cache.get("k", c.fn), cache.get("k", c.fn), cache.get("k", c.fn),
    ]);
    assert.equal(c.calls(), 1,
      "each caller ran its own Roon walk — that is the duplication this removes");
    assert.equal(a, "v1"); assert.equal(b, "v1"); assert.equal(d, "v1");
  });

  await t.test("a later caller is served from the cache, not a second fetch", async () => {
    const c = counter();
    const cache = makeTtlCache(60000);
    await cache.get("k", c.fn);
    await cache.get("k", c.fn);
    assert.equal(c.calls(), 1);
  });

  await t.test("different keys do not share a fetch", async () => {
    const c = counter();
    const cache = makeTtlCache(60000);
    await Promise.all([cache.get("a", c.fn), cache.get("b", c.fn)]);
    assert.equal(c.calls(), 2);
  });
});

test("a failed fetch is never cached", async (t) => {
  await t.test("the rejection reaches every concurrent caller", async () => {
    const c = counter({ throws: true });
    const cache = makeTtlCache(60000);
    const results = await Promise.allSettled([cache.get("k", c.fn), cache.get("k", c.fn)]);
    assert.deepEqual(results.map(r => r.status), ["rejected", "rejected"],
      "a caller must not silently receive undefined when the fetch failed");
    assert.equal(c.calls(), 1, "they still shared the one attempt");
  });

  await t.test("the NEXT caller retries rather than getting the stored failure", async () => {
    // THE one. Storing the rejected promise would make a transient Core blip
    // look like a half-hour outage, and nothing in the logs would say why.
    const cache = makeTtlCache(60000);
    const bad = counter({ throws: true });
    await assert.rejects(() => cache.get("k", bad.fn));
    const good = counter({ value: "recovered" });
    assert.equal(await cache.get("k", good.fn), "recovered",
      "the failure was cached — a one-second blip became a TTL-long outage");
    assert.equal(good.calls(), 1);
  });

  await t.test("a success after a failure is cached normally", async () => {
    const cache = makeTtlCache(60000);
    await assert.rejects(() => cache.get("k", counter({ throws: true }).fn));
    const good = counter({ value: "ok" });
    await cache.get("k", good.fn);
    await cache.get("k", good.fn);
    assert.equal(good.calls(), 1, "the recovered value must still be cached");
  });
});

test("the TTL and clear() still behave", async (t) => {
  await t.test("an expired entry refetches", async () => {
    const c = counter();
    const cache = makeTtlCache(1);          // 1 ms
    await cache.get("k", c.fn);
    await new Promise(r => setTimeout(r, 10));
    await cache.get("k", c.fn);
    assert.equal(c.calls(), 2);
  });

  await t.test("clear() forces a refetch", async () => {
    // This is what bumpLibraryMeta relies on: a genre added to the library must
    // appear at once rather than waiting out a thirty-minute clock.
    const c = counter();
    const cache = makeTtlCache(60000);
    await cache.get("k", c.fn);
    cache.clear();
    await cache.get("k", c.fn);
    assert.equal(c.calls(), 2);
  });

  await t.test("clear() during a fetch does not strand the caller", async () => {
    const c = counter();
    const cache = makeTtlCache(60000);
    const p = cache.get("k", c.fn);
    cache.clear();
    assert.equal(await p, "v1", "the in-flight caller must still get its value");
  });
});
