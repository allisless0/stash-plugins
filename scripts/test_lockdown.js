#!/usr/bin/env node
// Lockdown checks that need no browser: load the real file against a stub DOM
// and test the pure helpers exposed when window.__LOCKDOWN_TEST__ is set.
// Run from the repo root: node scripts/test_lockdown.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const windowStub = { __LOCKDOWN_TEST__: true, addEventListener() {} };
const sandbox = {
  window: windowStub,
  document: { head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {},
              getElementById: () => null, querySelector: () => null },
  location: { pathname: "/" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => new Promise(() => {}),
  setTimeout: () => 0, setInterval: () => 0,
  console: { log() {}, error() {}, warn() {} },
};
const file = path.join(__dirname, "..", "plugins", "Lockdown", "Lockdown.js");
try {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "Lockdown.js" });
  check("loads against a stub DOM", true);
} catch (e) {
  check("loads against a stub DOM", false, e.message);
  process.exit(1);
}
const T = windowStub.__LockdownTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── what the lock lets through ──────────────────────────────────────────────
const rc = (p, roulette) => T.routeCheck(p, "7", roulette);
check("their page is allowed", eq(rc("/performers/7"), { ok: true }));
check("their scenes, galleries and images tabs are allowed",
  eq(rc("/performers/7/scenes"), { ok: true }) && eq(rc("/performers/7/galleries/"), { ok: true }) &&
  eq(rc("/performers/7/images"), { ok: true }));
check("their other tabs bounce", eq(rc("/performers/7/groups"), { bounce: true }) &&
  eq(rc("/performers/7/appearswith"), { bounce: true }));
check("another performer bounces", eq(rc("/performers/8/scenes"), { bounce: true }));
check("a scene, image or gallery is checked against them",
  eq(rc("/scenes/42"), { check: "scene", id: "42" }) && eq(rc("/images/5"), { check: "image", id: "5" }) &&
  eq(rc("/galleries/9/add"), { check: "gallery", id: "9" }));
check("lists, settings and everything else bounce",
  ["/", "/scenes", "/performers", "/settings", "/scenes/markers", "/studios/2", "/tags/1"]
    .every((p) => eq(rc(p), { bounce: true })));
check("roulette: their scene list bounces (scenes come at random)",
  eq(rc("/performers/7", true), { bounce: true }) && eq(rc("/performers/7/scenes", true), { bounce: true }));
check("roulette: galleries, images and a scene still work",
  eq(rc("/performers/7/images", true), { ok: true }) && eq(rc("/scenes/42", true), { check: "scene", id: "42" }));

// ── saved performer filter -> GraphQL filter (Stash's toCriterionInput) ────
const types = {
  tags: "HierarchicalMultiCriterionInput", studios: "HierarchicalMultiCriterionInput",
  performers: "MultiCriterionInput", age: "IntCriterionInput", rating100: "IntCriterionInput",
  gender: "GenderCriterionInput", circumcised: "CircumcisionCriterionInput",
  name: "StringCriterionInput", country: "StringCriterionInput", birthdate: "DateCriterionInput",
  filter_favorites: "Boolean", is_missing: "String", stash_id_endpoint: "StashIDCriterionInput",
  scenes_filter: "SceneFilterType",
};
const g = (of) => T.toGraphQLFilter(of, types);
check("tags: ids, excludes and depth",
  eq(g({ tags: { modifier: "INCLUDES_ALL", value: { items: [{ id: "1", label: "a" }], excluded: [{ id: "2", label: "b" }], depth: -1 } } }),
     { tags: { modifier: "INCLUDES_ALL", value: ["1"], excludes: ["2"], depth: -1 } }));
check("tags with EQUALS use depth 0", g({ tags: { modifier: "EQUALS", value: { items: [], excluded: [], depth: 3 } } }).tags.depth === 0);
check("a plain multi has no depth",
  eq(g({ performers: { modifier: "INCLUDES", value: { items: [{ id: "4" }] } } }),
     { performers: { modifier: "INCLUDES", value: ["4"], excludes: [] } }));
check("numbers: value and value2", eq(g({ age: { modifier: "BETWEEN", value: { value: 20, value2: 29 } } }),
  { age: { modifier: "BETWEEN", value: 20, value2: 29 } }));
check("old bare-number form", eq(g({ rating100: { modifier: "GREATER_THAN", value: 60 } }).rating100,
  { modifier: "GREATER_THAN", value: 60, value2: undefined }));
check("IS_NULL number still sends a value", eq(g({ rating100: { modifier: "IS_NULL", value: { value: 0 } } }).rating100,
  { modifier: "IS_NULL", value: 0, value2: undefined }));
check("gender labels become enums",
  eq(g({ gender: { modifier: "INCLUDES", value: ["Female", "Transgender Female", "Non-Binary"] } }),
     { gender: { modifier: "INCLUDES", value_list: ["FEMALE", "TRANSGENDER_FEMALE", "NON_BINARY"] } }));
check("old single gender string", eq(g({ gender: { modifier: "INCLUDES", value: "Male" } }).gender.value_list, ["MALE"]));
check("circumcised uses value", eq(g({ circumcised: { modifier: "INCLUDES", value: ["Uncut"] } }),
  { circumcised: { modifier: "INCLUDES", value: ["UNCUT"] } }));
check("strings pass through", eq(g({ country: { modifier: "EQUALS", value: "US" } }), { country: { modifier: "EQUALS", value: "US" } }));
check("favourites flag is a boolean", g({ filter_favorites: { modifier: "EQUALS", value: "true" } }).filter_favorites === true &&
  g({ filter_favorites: { modifier: "EQUALS", value: "false" } }).filter_favorites === false);
check("is_missing is a plain string", g({ is_missing: { modifier: "EQUALS", value: "image" } }).is_missing === "image");
check("stash id", eq(g({ stash_id_endpoint: { modifier: "NOT_NULL", value: { endpoint: "e", stashID: "" } } }).stash_id_endpoint,
  { modifier: "NOT_NULL", endpoint: "e", stash_id: "" }));
let threw = null;
try { g({ scenes_filter: { modifier: "EQUALS", value: {} } }); } catch (e) { threw = e.message; }
check("an unsupported field refuses rather than dropping it", threw && /not supported/.test(threw), threw);
threw = null;
try { g({ made_up: { modifier: "EQUALS", value: 1 } }); } catch (e) { threw = e.message; }
check("an unknown field refuses", threw && /unknown/.test(threw), threw);
check("enum helper", T.enumOf(" transgender male ") === "TRANSGENDER_MALE" && T.enumOf("FEMALE") === "FEMALE");

// ── spin, time, history ─────────────────────────────────────────────────────
const sch = T.spinSchedule(20);
check("spin has the asked number of steps", sch.length === 20);
check("spin slows down", sch.every((d, i) => i === 0 || d >= sch[i - 1]) && sch[0] < 80 && sch[19] > 400);
check("durations read well", T.fmtDuration(9000) === "9s" && T.fmtDuration(754000) === "12m 34s" && T.fmtDuration(3720000) === "1h 2m");
const h = [
  { result: "done", ms: 600000 }, { result: "gaveup", ms: 120000 },
  { result: "done", ms: 300000 }, { future: "entry" }, { result: "done", ms: 900000 },
];
check("summary counts", eq(T.historySummary(h), { done: 3, gaveUp: 1, fastest: 300000, streak: 2 }));
check("empty summary", eq(T.historySummary([]), { done: 0, gaveUp: 0, fastest: null, streak: 0 }));
check("history that does not parse is untrusted", T.parseHistory("[{") === null && T.parseHistory('{"a":1}') === null);
check("nothing stored is an empty history", eq(T.parseHistory(undefined), []));
check("unknown entries are kept in storage", T.parseHistory(JSON.stringify(h)).length === 5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
