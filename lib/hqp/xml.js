"use strict";
// ---------------------------------------------------------------------------
// HQPlayer's control protocol: one XML document per request, and one
// newline-terminated XML document per reply.
//
// Ported from hqpweb (packages/protocol/src/xml.ts), MIT, (c) 2026
// statelycurmudgeon — see ./LICENSE. hqpweb reads replies with fast-xml-parser.
// This port reads them itself instead of adding that package: every new
// dependency is one more `npm install` inside the one-tap update, which runs on
// the user's own machine with nobody watching. HQPlayer's replies use a small,
// regular part of XML (elements, quoted attributes, text, entity references),
// and that is all this reads. Anything else throws, and the caller reports the
// reply as unreadable rather than guessing at it.
//
// The shape returned is hqpweb's own: { name, attrs, text, children }, with
// every attribute value kept as a STRING. Converting is the caller's job, and
// it is done explicitly, because HQPlayer's volume is a float in dB that one
// platform prints as "-22" and another as "-28.00000000000000000" (measured):
// a reader that guessed at types is how a client once read 0 dB, full output.
// ---------------------------------------------------------------------------

const PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s) {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref) => {
    if (ref[0] === "#") {
      const hex = ref[1] === "x" || ref[1] === "X";
      const n = hex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITY, ref) ? ENTITY[ref] : whole;
  });
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** Parse one XML document and return its root element. Throws on anything malformed. */
function parseDocument(xml) {
  const s = String(xml);
  let i = 0;
  const fail = (why) => {
    throw new Error(why + " in reply: " + s.slice(0, 120));
  };
  const skipSpace = () => { while (i < s.length && isSpace(s[i])) i++; };
  const skipPast = (end, what) => {
    const at = s.indexOf(end, i);
    if (at < 0) fail("unterminated " + what);
    i = at + end.length;
  };
  const name = () => {
    NAME.lastIndex = i;
    const m = NAME.exec(s);
    if (!m) fail("expected a name at " + i);
    i = NAME.lastIndex;
    return m[0];
  };

  function element() {
    i++; // the "<"
    const el = { name: name(), attrs: {}, text: "", children: [] };
    for (;;) {
      skipSpace();
      if (s[i] === "/" && s[i + 1] === ">") { i += 2; return el; }
      if (s[i] === ">") { i++; break; }
      if (i >= s.length) fail("unterminated <" + el.name + ">");
      const key = name();
      skipSpace();
      if (s[i] !== "=") fail("attribute " + key + " has no value");
      i++;
      skipSpace();
      const q = s[i];
      if (q !== '"' && q !== "'") fail("attribute " + key + " is not quoted");
      const end = s.indexOf(q, i + 1);
      if (end < 0) fail("unterminated attribute " + key);
      // An attribute called __proto__ would land on the prototype slot of a
      // plain object; no HQPlayer reply has one, so it is simply not kept.
      if (key !== "__proto__") el.attrs[key] = decode(s.slice(i + 1, end));
      i = end + 1;
    }
    for (;;) {
      if (i >= s.length) fail("unclosed <" + el.name + ">");
      if (s[i] !== "<") {
        const next = s.indexOf("<", i);
        const end = next < 0 ? s.length : next;
        el.text += decode(s.slice(i, end));
        i = end;
        continue;
      }
      if (s.startsWith("</", i)) {
        i += 2;
        const closing = name();
        if (closing !== el.name) fail("</" + closing + "> closes <" + el.name + ">");
        skipSpace();
        if (s[i] !== ">") fail("unterminated </" + closing + ">");
        i++;
        return el;
      }
      if (s.startsWith("<!--", i)) { skipPast("-->", "comment"); continue; }
      if (s.startsWith("<![CDATA[", i)) {
        const end = s.indexOf("]]>", i + 9);
        if (end < 0) fail("unterminated CDATA");
        el.text += s.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (s.startsWith("<?", i)) { skipPast("?>", "processing instruction"); continue; }
      el.children.push(element());
    }
  }

  // Before the root: the declaration, comments, a doctype, whitespace.
  for (;;) {
    skipSpace();
    if (s.charCodeAt(i) === 0xfeff) { i++; continue; }
    if (s.startsWith("<?", i)) { skipPast("?>", "declaration"); continue; }
    if (s.startsWith("<!--", i)) { skipPast("-->", "comment"); continue; }
    if (s.startsWith("<!", i)) { skipPast(">", "doctype"); continue; }
    break;
  }
  if (s[i] !== "<") fail("no root element");
  return element();
}

function escapeAttr(v) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeText(v) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Serialise a single element, e.g. `<SetFilter value="51" value1x="49"/>`. Booleans are 1/0. */
function element(name, attrs, text) {
  const a = Object.entries(attrs || {})
    .map(([k, v]) => " " + k + '="' + escapeAttr(typeof v === "boolean" ? (v ? "1" : "0") : String(v)) + '"')
    .join("");
  return text === undefined ? "<" + name + a + "/>" : "<" + name + a + ">" + escapeText(text) + "</" + name + ">";
}

module.exports = { PROLOG, parseDocument, element, escapeText };
