"use strict";
/*
 * wiki-match.js — is THIS Wikipedia article about THAT album?
 *
 * fetchWikiAlbum searches Wikipedia for "<title> <artist> album" and walks the
 * results, and the search will happily return every record an act ever made.
 * Picking the wrong one is not a near miss: the card and the album view then
 * carry a confident paragraph about a different record, which reads as
 * authoritative and is simply wrong.
 *
 * THE ONE THAT GOT AWAY (v1.8.34). Airbourne's self-titled 2026 album showed
 * the article for Runnin' Wild, their 2007 debut. The title rule was
 *
 *     the page title must contain the album title as whole words
 *
 * and it was applied to the WHOLE page title, disambiguator included:
 *
 *     "Runnin' Wild (Airbourne album)"  contains  "Airbourne"
 *
 * For a SELF-TITLED record the album name IS the act's name, so the
 * parenthetical that exists to tell their albums apart matched every one of
 * them, and the first search result won. The rule now reads only the part
 * before the disambiguator, which is the album's actual name:
 *
 *     "Runnin' Wild (Airbourne album)"  ->  "Runnin' Wild"   ✗
 *     "Airbourne (Airbourne album)"     ->  "Airbourne"      ✓
 *
 * Self-titled albums are where nearly every album-matching heuristic goes
 * wrong, and they are common enough — a debut, a reinvention, a comeback — to
 * be worth a rule of their own rather than an exception to someone else's.
 *
 * Pure: no network, no cache, no Core.
 */

/*
 * The same shape as index.js's normalize(): fold accents, reduce everything
 * that is not a letter or digit to single spaces, trim. Kept here so the rule
 * and the comparison that implements it live together — this module decides
 * what "the same title" means, and that decision should not be able to change
 * from somewhere else.
 */
function normalize(s) {
  return String(s == null ? "" : s).toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A Wikipedia page title without its trailing disambiguator.
 *
 * Wikipedia disambiguates in a trailing parenthetical — "Low (David Bowie
 * album)", "Pang (album)" — and only there, so only a parenthetical that ENDS
 * the title is removed. One that is part of the name survives, which is the
 * point: "Live (Sound of Music)" or "Kid A Mnesia (Kid A)" would otherwise
 * lose half their name.
 */
function stripDisambiguator(pageTitle) {
  return String(pageTitle == null ? "" : pageTitle)
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
}

/**
 * Whether a Wikipedia page title names this album.
 *
 * Whole-word containment against the page's own name, so a short album title
 * cannot match inside a longer word ("Up" must not match "Group"), and the
 * disambiguator is never part of the haystack.
 *
 * @param {string} albumTitle the album as the library names it
 * @param {string} pageTitle  the Wikipedia article's title
 * @returns {boolean}
 */
function albumPageTitleMatches(albumTitle, pageTitle) {
  const want = normalize(albumTitle);
  // An album title with nothing alphanumeric in it — Sigur Rós's "( )" — has
  // no whole word to look for, and an empty needle matches EVERY page (the old
  // rule padded both sides, so " anything ".includes(" ") was true and the
  // first search result won). No answer beats a confident wrong one.
  if (!want) return false;

  const main = normalize(stripDisambiguator(pageTitle));
  // A page whose whole title IS a parenthetical leaves nothing after the
  // strip; fall back to the full title rather than rejecting it outright.
  const hay = main || normalize(pageTitle);
  if (!hay) return false;

  return (" " + hay + " ").includes(" " + want + " ");
}

module.exports = { normalize, stripDisambiguator, albumPageTitleMatches };
