import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIndex, search, similar, similarToText, parseQuery, resolveDate, toggleToken, hasToken, stem } from "../src/query.js";

const items = JSON.parse(readFileSync(new URL("../data/questions.sample.json", import.meta.url), "utf8"));
const index = buildIndex(items);
const ids = q => search(index, q).results.map(r => r.item.id);

test("empty query returns everything, unranked", () => {
  const r = search(index, "");
  assert.equal(r.results.length, items.length);
  assert.equal(r.ranked, false);
});

test("free text ranks the best match first", () => {
  assert.equal(ids("okta sso")[0], "s01");
});

test("synonyms widen a search", () => {
  // "sso" isn't in s01's text twice, but saml/okta are synonyms; "experian" finds the bureau question.
  assert.ok(ids("experian").includes("s03"));
  assert.ok(ids("plaid").includes("s09"));
  assert.ok(ids("bureau").includes("s03"));
});

test("prefixes match longer words", () => {
  assert.ok(ids("encrypt").includes("s12"));
  assert.ok(ids("furnish").includes("s04"));
});

test("field filters, OR values and negation", () => {
  assert.deepEqual(new Set(ids("status:partial,deferred")), new Set(items.filter(d => d.status !== "Answered").map(d => d.id)));
  assert.ok(ids("account:\"sample credit\"").every(id => items.find(d => d.id === id).account === "Sample Credit Union"));
  assert.ok(!ids("-status:answered").some(id => items.find(d => d.id === id).status === "Answered"));
  assert.ok(ids("topic:security").length >= 3);
});

test("flags", () => {
  assert.ok(ids("has:answer").every(id => items.find(d => d.id === id).referenceAnswer));
  assert.ok(ids("is:pe").every(id => items.find(d => d.id === id).answererRole === "Product/Eng"));
  assert.ok(ids("is:gap").every(id => { const d = items.find(x => x.id === id); return d.status !== "Answered" || d.needsProduct; }));
});

test("date range", () => {
  const r = ids("after:2026-07-01 before:2026-08");
  assert.deepEqual(new Set(r), new Set(["s10", "s11", "s12"]));
  assert.equal(resolveDate("30d", new Date("2026-10-02T12:00:00Z")), "2026-09-02");
  assert.equal(resolveDate("nonsense"), null);
});

test("phrases and excluded words", () => {
  assert.deepEqual(ids('"white-label"'), ["s08"]);
  assert.ok(!ids("embed -iframe").includes("s16"));
});

test("falls back to partial matches when nothing matches every word", () => {
  const r = search(index, "okta zebraword");
  assert.equal(r.partial, true);
  assert.equal(r.results[0].item.id, "s01");
});

test("parser warns on bad input instead of throwing", () => {
  const q = parseQuery("after:someday is:bogus status:");
  assert.equal(q.warnings.length, 3);
});

test("similar questions", () => {
  assert.ok(similar(index, "s05").some(r => r.item.id === "s16" || r.item.id === "s01"));
  assert.equal(similarToText(index, "do you support okta single sign-on?")[0].item.id, "s01");
});

test("facet tokens toggle on and off", () => {
  let q = toggleToken("sso", "topic", "Security & compliance");
  assert.equal(q, 'sso topic:"Security & compliance"');
  assert.ok(hasToken(q, "topic", "Security & compliance"));
  q = toggleToken(q, "topic", "Security & compliance");
  assert.equal(q, "sso");
});

test("stemmer", () => {
  assert.equal(stem("refreshing"), "refresh");
  assert.equal(stem("refreshes"), "refresh");
  assert.equal(stem("apis"), "api");
  assert.equal(stem("policies"), "policy");
});
