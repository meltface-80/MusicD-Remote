"use strict";
// ---------------------------------------------------------------------------
// HQPlayer's control protocol (v1.8.74): the XML reader that replaced
// fast-xml-parser, the reply parsers, the request builders and the
// compatibility rules. Replies are the ones hqpweb recorded from two real
// HQPlayers on 2026-10-02 (read-only, sanitised); most cases are ported from
// its parse/compat tests (MIT, (c) 2026 statelycurmudgeon — lib/hqp/LICENSE).
//
// The two facts that cost real clients most are pinned first: an OK reply
// proves nothing, and volume is a FLOAT in dB — a client that parsed it as an
// integer read 0 dB, which is full output.
// ---------------------------------------------------------------------------

require("../lib/no-real-hqplayer");
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDocument, element } = require("../../lib/hqp/xml");
const { cmd } = require("../../lib/hqp/commands");
const P = require("../../lib/hqp/parse");
const C = require("../../lib/hqp/compat");

const H = '<?xml version="1.0" encoding="utf-8"?>';
const R = {
  info: H + '<GetInfo engine="5.32.5" name="fake-mac" platform="Mac" product="Signalyst HQPlayer Desktop" version="5"/>',
  stateMac: H + '<State active_mode="1" active_rate="45158400" adaptive="0" convolution="0" filter="51" filter1x="49" filterNx="51" filter_20k="0" invert="0" matrix_profile="" mode="2" random="0" rate="0" repeat="0" shaper="35" state="2" volume="-22"/>',
  stateLinux: H + '<State active_mode="0" active_rate="384000" adaptive="0" convolution="0" filter="37" filter1x="37" filterNx="40" filter_20k="0" invert="0" matrix_profile="" mode="1" random="0" rate="0" repeat="0" shaper="3" state="0" volume="-28.00000000000000000"/>',
  statusLinux: H + '<Status active_bits="32" active_channels="2" active_filter="poly-sinc-gauss-long" active_mode="PCM" active_rate="384000" active_shaper="NS5" apod="0" clips="0" display_position="0.00000000000000000" filter_20k="0" length="0.00000000000000000" position="0.00000000000000000" queued="0" state="0" track="0" track_serial="27" tracks_total="0" transport_serial="39" volume="-28.00000000000000000"/>',
  statusPlaying: H + '<Status active_filter="poly-sinc-gauss-xla" active_mode="SDM (DSD)" active_rate="45158400" active_shaper="AHM7EC8B" length="0" position="12.5" state="2" track="1" tracks_total="1" volume="-22"><metadata bits="24" channels="2" samplerate="44100" sdm="0" song="Roon"/></Status>',
  modes: H + '<GetModes><ModesItem index="0" name="[source]" value="-1"/><ModesItem index="1" name="PCM" value="0"/><ModesItem index="2" name="SDM (DSD)" value="1"/></GetModes>',
  filters: H + '<GetFilters><FiltersItem arg="1" index="0" name="IIR" value="64"/><FiltersItem arg="2" index="6" name="poly-sinc-lp" value="0"/></GetFilters>',
  vrMac: H + '<VolumeRange adaptive="0" enabled="1" max="-3" min="-60"/>',
  vrLinux: H + '<VolumeRange adaptive="0" enabled="1" max="0.00000000000000000" min="-60.00000000000000000"/>',
  set20k: H + "<Set20kFilter/>",
  setConv: H + '<SetConvolution result="OK" value="0"/>',
  unknown: H + '<NoSuchCommandXyz result="Error">Unknown command</NoSuchCommandXyz>',
  cfgLoad: H + '<ConfigurationLoad result="Error">missing data or not authorized</ConfigurationLoad>',
};
const doc = (k) => parseDocument(R[k]);

test("the XML reader (fast-xml-parser's job in hqpweb)", async (t) => {
  await t.test("elements, attributes as strings, children and text", () => {
    const el = parseDocument(H + '<A x="1" y="two"><B z="3"/>hello<C>in c</C> world</A>');
    assert.equal(el.name, "A");
    assert.deepEqual(el.attrs, { x: "1", y: "two" });
    assert.equal(typeof el.attrs.x, "string", "an attribute was converted — volume must stay a string until it is parsed as a float");
    assert.deepEqual(el.children.map((c) => c.name), ["B", "C"]);
    assert.equal(el.text, "hello world");
    assert.equal(el.children[1].text, "in c");
  });

  await t.test("entity and character references are decoded, in attributes and text", () => {
    const el = parseDocument('<A n="Tom &amp; Jerry &quot;Q&quot; &lt;x&gt; &#39;s &#x2019;">a &amp;&#65; b</A>');
    assert.equal(el.attrs.n, "Tom & Jerry \"Q\" <x> 's ’");
    assert.equal(el.text, "a &A b");
  });

  await t.test("single-quoted attributes, comments, CDATA and a byte-order mark", () => {
    const el = parseDocument("﻿" + H + "<!-- hi --><A v='1'><![CDATA[<raw>]]><!-- c --></A>");
    assert.equal(el.attrs.v, "1");
    assert.equal(el.text, "<raw>");
  });

  await t.test("malformed replies throw instead of half-parsing", () => {
    for (const bad of ["", H, "<A", '<A x="1>', "<A x=1/>", "<A><B></A>", "<A>", "just text", "<A x></A>"]) {
      assert.throws(() => parseDocument(bad), Error, "accepted: " + JSON.stringify(bad));
    }
  });

  await t.test("an attribute named __proto__ cannot reach the prototype", () => {
    const el = parseDocument('<A __proto__="x" ok="1"/>');
    assert.equal(Object.getPrototypeOf(el.attrs), Object.prototype);
    assert.equal(el.attrs.ok, "1");
  });

  await t.test("the builder escapes, and writes booleans as 1/0", () => {
    assert.equal(element("X", { a: 'he said "hi" & <left>', on: true, off: false, n: -22.5 }),
      '<X a="he said &quot;hi&quot; &amp; &lt;left&gt;" on="1" off="0" n="-22.5"/>');
    assert.equal(element("Y", {}, "a<b"), "<Y>a&lt;b</Y>");
    assert.deepEqual(parseDocument(element("X", { a: 'q"&<>' })).attrs, { a: 'q"&<>' }, "the builder and the reader disagree");
  });
});

test("outcome: OK is one case of three", async (t) => {
  await t.test("a missing result is its own case, not OK (Set20kFilter, measured)", () => {
    assert.deepEqual(P.outcome(doc("set20k")), { kind: "none" });
  });
  await t.test("convolution says OK while nothing changes (measured)", () => {
    assert.deepEqual(P.outcome(doc("setConv")), { kind: "ok" });
  });
  await t.test("errors carry their text", () => {
    assert.deepEqual(P.outcome(doc("unknown")), { kind: "error", message: "Unknown command" });
    assert.deepEqual(P.outcome(doc("cfgLoad")), { kind: "error", message: "missing data or not authorized" });
  });
});

test("volume is a float in dB", async (t) => {
  await t.test("the macOS short form and the Linux long form", () => {
    assert.equal(P.parseState(doc("stateMac")).volume, -22);
    assert.equal(P.parseState(doc("stateLinux")).volume, -28);
    assert.equal(P.parseStatus(doc("statusLinux")).volume, -28);
  });
  await t.test("both VolumeRange maxima: -3 on the Mac, 0 on Linux", () => {
    assert.deepEqual(P.parseVolumeRange(doc("vrMac")), { min: -60, max: -3, enabled: true, adaptive: false });
    assert.equal(P.parseVolumeRange(doc("vrLinux")).max, 0);
  });
  await t.test("THE one: a fractional value never becomes 0 dB", () => {
    const el = parseDocument(H + '<State active_mode="1" active_rate="0" filter="0" filter1x="0" filterNx="0" mode="0" rate="0" shaper="0" state="0" volume="-0.5"/>');
    assert.equal(P.parseState(el).volume, -0.5);
  });
  await t.test("an empty or non-numeric volume throws rather than reading as 0 dB", () => {
    for (const v of ["", " ", "loud", "NaN", "Infinity"]) {
      const el = parseDocument(H + '<State active_mode="1" active_rate="0" filter="0" filter1x="0" filterNx="0" mode="0" rate="0" shaper="0" state="0" volume="' + v + '"/>');
      assert.throws(() => P.parseState(el), /volume/, "volume=" + JSON.stringify(v) + " was accepted");
    }
  });
  await t.test("a non-finite Volume command is refused", () => {
    assert.throws(() => cmd.volume(NaN));
    assert.throws(() => cmd.volume(Infinity));
    assert.equal(cmd.volume(-22.5), '<Volume value="-22.5"/>');
  });
});

test("State, Status and the lists", async (t) => {
  await t.test("the mode INDEX is not the active mode VALUE", () => {
    const s = P.parseState(doc("stateMac"));
    assert.equal(s.mode, 2);         // the index of "SDM (DSD)" in GetModes
    assert.equal(s.activeMode, 1);   // its value
    assert.equal(s.filterInUse, 51);
    assert.equal(s.rate, 0);         // auto
  });
  await t.test("Status reads the source from its metadata child, and Roon as the feeder", () => {
    const st = P.parseStatus(doc("statusPlaying"));
    assert.deepEqual(st.source, { sampleRate: 44100, bits: 24, channels: 2, song: "Roon" });
    assert.equal(st.position, 12.5);
    assert.equal(P.parseStatus(doc("statusLinux")).source, null);
  });
  await t.test("an unknown playback state is refused", () => {
    assert.throws(() => P.parseStatus(parseDocument('<Status active_rate="0" state="7" volume="-1"/>')), /playback state/);
  });
  await t.test("GetInfo, modes and filters", () => {
    assert.deepEqual(P.parseInfo(doc("info")), { name: "fake-mac", product: "Signalyst HQPlayer Desktop", platform: "Mac", version: "5", engine: "5.32.5" });
    assert.deepEqual(P.parseModes(doc("modes")).map((m) => m.name), ["[source]", "PCM", "SDM (DSD)"]);
    assert.deepEqual(P.parseFilters(doc("filters"))[1], { index: 6, name: "poly-sinc-lp", value: 0, arg: 2 });
  });
  await t.test("matrix profiles, and the measured empty list", () => {
    assert.deepEqual(P.parseMatrixProfiles(parseDocument(H + '<MatrixListProfiles result="OK"/>')), []);
    assert.deepEqual(P.parseMatrixProfiles(parseDocument(H + '<MatrixListProfiles result="OK"><MatrixProfile name="Headphones"/><MatrixProfile name="Room EQ"/></MatrixListProfiles>')),
      ["Headphones", "Room EQ"]);
  });
});

test("request builders send the shapes hqpweb sent live", async (t) => {
  await t.test("shapes", () => {
    assert.equal(cmd.setFilter(53, 49), '<SetFilter value="53" value1x="49"/>');
    assert.equal(cmd.set20kFilter(true), '<Set20kFilter value="1"/>');
    assert.equal(cmd.status(), '<Status subscribe="0"/>');
    assert.equal(cmd.matrixSetProfile("Room EQ"), '<MatrixSetProfile value="Room EQ"/>');
  });
  await t.test("a setter takes a list index and nothing else", () => {
    assert.throws(() => cmd.setRate(-1));
    assert.throws(() => cmd.setMode(1.5));
    assert.throws(() => cmd.setShaping("3"));
  });
});

test("the compatibility rules (HQPlayer manual §4.4–§4.6, as hqpweb restated them)", async (t) => {
  await t.test("ratio classes, -2s variants, and silence for names newer than the manual", () => {
    assert.equal(C.ratioClass("sinc-M"), "integer");
    assert.equal(C.ratioClass("closed-form-M"), "pow2-up");
    assert.equal(C.ratioClass("poly-sinc-long-lp-2s"), "any");
    assert.equal(C.ratioClass("poly-sinc-ext2-xla"), undefined);
    assert.equal(C.ratioClass("constructor"), undefined, "a name on Object.prototype was given a class");
  });
  await t.test("the measured sinc-M stop: 44.1k → 192k is not a whole-number ratio", () => {
    const h = C.ratioHint("sinc-M", 44100, 192000);
    assert.equal(h.level, "hard");
    assert.match(h.text, /whole-number.*4\.35×/);
    assert.equal(C.ratioHint("sinc-M", 44100, 176400), undefined);
    assert.equal(C.ratioHint("sinc-M", 192000, 96000), undefined, "integer DOWN is fine");
  });
  await t.test("power-of-two and integer-up filters", () => {
    assert.equal(C.ratioHint("closed-form", 44100, 352800), undefined);       // 8×
    assert.equal(C.ratioHint("closed-form", 44100, 264600).level, "hard");    // 6×
    assert.equal(C.ratioHint("polynomial-1", 96000, 48000).level, "hard");    // down
    assert.equal(C.ratioHint("poly-sinc-mqa/mp3-lp", 44100, 22579200, true), undefined); // SDM: any
  });
  await t.test("nothing for 'any' filters or unknown names", () => {
    assert.equal(C.ratioHint("poly-sinc-gauss-long", 44100, 192000), undefined);
    assert.equal(C.ratioHint("mystery-filter", 44100, 192000), undefined);
  });
  await t.test("sources below 50 kHz use the 1x filter", () => {
    assert.equal(C.filterSlot(48000), "1x");
    assert.equal(C.filterSlot(88200), "Nx");
  });
  await t.test("modulators: AHM below DSD1024 is hard (measured for AHM7EC8B)", () => {
    assert.equal(C.modulatorHint("AHM7EC8B", 22579200).level, "hard");
    assert.equal(C.modulatorHint("AHM7EC8B", 45158400), undefined);
    assert.equal(C.modulatorHint("ASDM7EC-fast 512+fs", 11289600).level, "soft");
    assert.equal(C.modulatorHint("ASDM7EC", 2822400), undefined);
  });
  await t.test("dither advice is soft and by rate", () => {
    assert.equal(C.ditherHint("NS5", 96000).level, "soft");
    assert.equal(C.ditherHint("NS5", 384000), undefined);
    assert.equal(C.ditherHint("TPDF", 44100), undefined);
  });
  await t.test("a stop is predicted only from a hard rule", () => {
    assert.ok(C.predictedStop({ mode: "PCM", filter: "sinc-M", shaper: "NS5", sourceRate: 44100, outputRate: 192000 }));
    assert.equal(C.predictedStop({ mode: "PCM", filter: "poly-sinc-gauss-long", shaper: "NS5", sourceRate: 44100, outputRate: 96000 }), undefined);
    assert.ok(C.predictedStop({ mode: "SDM (DSD)", filter: "poly-sinc-gauss-xla", shaper: "AHM7EC8B", sourceRate: 44100, outputRate: 11289600 }));
  });
});
