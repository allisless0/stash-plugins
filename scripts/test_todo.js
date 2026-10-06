#!/usr/bin/env node
// Todo checks that need no browser: load the real file against a stub DOM and
// test the pure helpers exposed when window.__TODO_TEST__ is set.
// Run from the repo root: node scripts/test_todo.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const windowStub = { __TODO_TEST__: true, addEventListener() {} };
const sandbox = {
  window: windowStub,
  document: { head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {},
              getElementById: () => null, querySelector: () => null },
  location: { pathname: "/" },
  localStorage: { getItem: () => null, setItem() {} },
  fetch: () => new Promise(() => {}),
  setTimeout: () => 0, setInterval: () => 0,
  console: { log() {}, error() {}, warn() {} },
};
const file = path.join(__dirname, "..", "plugins", "Todo", "Todo.js");
try {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "Todo.js" });
  check("loads against a stub DOM", true);
} catch (e) {
  check("loads against a stub DOM", false, e.message);
  process.exit(1);
}
const T = windowStub.__TodoTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── which page a task can link to ───────────────────────────────────────────
check("scene page", eq(T.entityFromPath("/scenes/123"), { kind: "scene", id: "123" }));
check("performer sub-page", eq(T.entityFromPath("/performers/7/scenes"), { kind: "performer", id: "7" }));
check("old movies path is a group", eq(T.entityFromPath("/movies/4"), { kind: "group", id: "4" }));
check("list pages link to nothing", T.entityFromPath("/scenes") === null && T.entityFromPath("/") === null);
check("scene markers page is not a scene", T.entityFromPath("/scenes/markers") === null);
check("link back to the page", T.entityUrl({ kind: "gallery", id: "9" }) === "/galleries/9");
check("same entity across string and number ids", T.sameEntity({ kind: "scene", id: 5 }, { kind: "scene", id: "5" }));
check("different kinds are different", !T.sameEntity({ kind: "scene", id: "5" }, { kind: "tag", id: "5" }));

// ── operations replay onto whatever is stored ───────────────────────────────
const a = { id: "a", text: "one", done: false }, b = { id: "b", text: "two", done: false };
let L = T.applyOp([b], { type: "add", item: a });
check("add puts the new task on top", eq(L.map((t) => t.id), ["a", "b"]));
check("add is idempotent (a retried write)", T.applyOp(L, { type: "add", item: a }).length === 2);
L = T.applyOp(L, { type: "done", id: "a", done: true, when: 5 });
check("done sets state and time", L[0].done === true && L[0].doneAt === 5);
check("done replayed twice stays done (not a flip)", T.applyOp(L, { type: "done", id: "a", done: true, when: 6 })[0].done === true);
check("edit changes only the text", T.applyOp(L, { type: "edit", id: "b", text: "2" })[1].text === "2" &&
      T.applyOp(L, { type: "edit", id: "b", text: "2" })[0].text === "one");
// another device added c while this one cleared done tasks: c survives
const stored = [{ id: "c", text: "new elsewhere", done: false }, ...L];
const cleared = T.applyOp(stored, { type: "delete", ids: ["a"] });
check("clear done removes by id and keeps a task added elsewhere", eq(cleared.map((t) => t.id), ["c", "b"]));
check("ops do not mutate their input", stored.length === 3);
check("move reorders", eq(T.applyOp([a, b, { id: "c" }], { type: "move", id: "c", to: 0 }).map((t) => t.id), ["c", "a", "b"]));
check("move of a deleted task is a no-op", T.applyOp([a, b], { type: "move", id: "zz", to: 0 }).length === 2);
check("unknown op leaves the list alone", eq(T.applyOp([a], { type: "nope" }), [a]));

// ── never overwrite a list that did not parse (rule 5) ──────────────────────
check("nothing stored is an empty list", eq(T.parseItems(undefined), []) && eq(T.parseItems(""), []));
check("corrupt JSON is untrusted, not empty", T.parseItems("[{") === null);
check("a non-list is untrusted", T.parseItems('{"a":1}') === null);
const odd = [a, { id: 3, note: "from a future version" }, null];
const kept = T.parseItems(JSON.stringify(odd));
check("entries this version does not understand ride through", eq(kept, odd));
check("...survive an edit and a delete", eq(T.applyOp(T.applyOp(kept, { type: "edit", id: "a", text: "x" }),
      { type: "delete", ids: ["zz"] }).slice(1), odd.slice(1)));
check("...and are hidden from the list", eq(T.sortForView(kept).open.map((t) => t.id), ["a"]));

// ── view order ──────────────────────────────────────────────────────────────
const v = T.sortForView([{ id: "1", text: "", done: true, doneAt: 1 }, { id: "2", text: "", done: false },
                         { id: "3", text: "", done: true, doneAt: 9 }, { id: "4", text: "", done: false }]);
check("open tasks keep stored order", eq(v.open.map((t) => t.id), ["2", "4"]));
check("done tasks newest first", eq(v.done.map((t) => t.id), ["3", "1"]));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
