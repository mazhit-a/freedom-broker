import test from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, formatHash, parseHash, screenTag } from "../src/routes.js";

test("empty hash is the overview", () => {
  assert.equal(parseHash("").name, "overview");
  assert.equal(parseHash("#").name, "overview");
  assert.equal(parseHash("#/").known, true);
});

test("all section hashes parse, with and without an id", () => {
  for (const name of SECTIONS) assert.deepEqual([parseHash(`#/${name}`).name, parseHash(`#/${name}`).id, parseHash(`#/${name}`).known], [name, null, true]);
  const card = parseHash("#/conversations/p1-ru-001");
  assert.deepEqual([card.name, card.id, card.path], ["conversations", "p1-ru-001", "conversations/p1-ru-001"]);
  assert.equal(parseHash("#/appeals/12").id, "12");
  assert.equal(parseHash("#/checklists/3").id, "3");
  assert.equal(parseHash("#/runs/R-0001").id, "R-0001");
});

test("unknown shapes are not routes", () => {
  assert.equal(parseHash("#/nope").known, false);
  assert.equal(parseHash("#/conversations/a/b").known, false);
  assert.equal(parseHash("#/overview/1").known, false);
  assert.equal(parseHash("#/conversations/").known, true);
});

test("ids round-trip through encoding", () => {
  const hash = formatHash("conversations", "a b/c");
  assert.equal(hash, "#/conversations/a%20b%2Fc");
  assert.equal(parseHash(hash).id, "a b/c");
  assert.equal(formatHash("nope"), "#/overview");
  assert.equal(formatHash("runs"), "#/runs");
});

test("detail routes pick the card screen", () => {
  assert.equal(screenTag(parseHash("#/conversations")), "cqa-conversation-list");
  assert.equal(screenTag(parseHash("#/conversations/x")), "cqa-conversation-card");
  assert.equal(screenTag(parseHash("#/runs")), "cqa-eval-runs");
  assert.equal(screenTag(parseHash("#/nope")), null);
});
