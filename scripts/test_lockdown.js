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
  location: { pathname: "/" }, URLSearchParams,
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

// ── cards: which item each one shows ────────────────────────────────────────
check("scene card is its scene, not a gallery it links",
  eq(T.cardItem("scene-card grid-card card", ["/galleries/3", "/scenes/12", "/performers/7"]), { kind: "scene", id: "12" }));
check("image card", eq(T.cardItem("image-card grid-card", ["/images/40?x=1"]), { kind: "image", id: "40" }));
check("gallery card", eq(T.cardItem("gallery-card", ["/scenes/1", "/galleries/8"]), { kind: "gallery", id: "8" }));
check("wall item or queue row: first item link",
  eq(T.cardItem("wall-item", ["/performers/2", "/scenes/5"]), { kind: "scene", id: "5" }) &&
  eq(T.cardItem("queue-scene-details", ["http://h/scenes/9"]), { kind: "scene", id: "9" }));
check("a card with no item link is nothing", T.cardItem("scene-card", ["/performers/2"]) === null);
check("scene markers link is not a scene", T.cardItem("wall-item", ["/scenes/markers"]) === null);

// ── performer rules come out of their tabs' URLs ────────────────────────────
const enc = (o) => {           // Stash's own encoding of one criterion
  let inS = false, esc = false, out = "";
  for (const ch of JSON.stringify(o)) {
    if (esc) { esc = false; out += ch; continue; }
    if (ch === "\\" && inS) { esc = true; out += ch; continue; }
    if (ch === '"') inS = !inS;
    out += (!inS && ch === "{") ? "(" : (!inS && ch === "}") ? ")" : ch;
  }
  let s = encodeURI(out);
  for (const c of "?#&;=+") s = s.split(c).join(encodeURIComponent(c));
  return s;
};
const perfRule = enc({ type: "performers", modifier: "INCLUDES", value: { items: [{ id: "9", label: "Other (x+y)" }], excluded: [] } });
const tagRule = enc({ type: "tags", modifier: "INCLUDES_ALL", value: { items: [{ id: "3", label: "A&B" }], excluded: [], depth: 0 } });
check("a performers rule is removed, the rest kept exactly",
  T.stripPerformerRules(`?c=${perfRule}&c=${tagRule}&sortby=date`) === `?c=${tagRule}&sortby=date`,
  T.stripPerformerRules(`?c=${perfRule}&c=${tagRule}&sortby=date`));
check("only a performers rule leaves an empty query", T.stripPerformerRules(`?c=${perfRule}`) === "");
check("nothing to remove is null", T.stripPerformerRules(`?c=${tagRule}&sortby=date`) === null && T.stripPerformerRules("") === null);

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
  { result: "done", ms: 600000, name: "A", pid: "1" }, { result: "gaveup", ms: 120000, name: "B", pid: "2" },
  { result: "done", ms: 300000, name: "A", pid: "1" }, { future: "entry" }, { result: "done", ms: 900000, name: "C", pid: "3" },
];
const st = T.statsFromHistory(h);
check("totals from an old history", st.done === 3 && st.gaveUp === 1 && st.totalMs === 1920000 &&
  st.streak === 2 && st.bestStreak === 2, JSON.stringify(st));
check("per-performer counts", st.perf["1"].n === 2 && st.perf["2"].n === 1 && st.perf["3"].n === 1);
check("most locked", eq(T.mostLocked(st), { name: "A", n: 2 }));
check("most locked ties go to the first name", T.mostLocked({ perf: { x: { name: "Zoe", n: 3 }, y: { name: "Amy", n: 3 } } }).name === "Amy");
check("nobody locked yet", T.mostLocked({ perf: {} }) === null && T.mostLocked({}) === null);
check("empty totals", eq(T.statsFromHistory([]), { v: 2, done: 0, gaveUp: 0, totalMs: 0, streak: 0, bestStreak: 0, perf: {} }));
// totals keep counting past the list cap: 250 done, the list would hold 200
let run = T.statsFromHistory([]);
for (let i = 0; i < 250; i++) run = T.addToStats(run, { result: "done", ms: 1000 + i, name: "x", pid: "9" });
check("totals do not shrink when the list is capped", run.done === 250 && run.bestStreak === 250 && run.perf["9"].n === 250);
run = T.addToStats(run, { result: "gaveup", ms: 5, pid: "9" });
check("giving up ends the streak, keeps the best", run.streak === 0 && run.bestStreak === 250 && run.gaveUp === 1);
check("unknown keys in stored totals ride through (1.2's fastest too)",
  T.addToStats({ done: 1, fastestMs: 5, later: "x" }, { result: "done", ms: 1 }).later === "x" &&
  T.addToStats({ done: 1, fastestMs: 5 }, { result: "done", ms: 1 }).fastestMs === 5);
check("an entry it does not understand changes nothing", eq(T.addToStats(st, { odd: 1 }), { ...st }));
check("stored totals: missing, unreadable, fine",
  T.parseStats(undefined) === undefined && T.parseStats("{") === null && T.parseStats("[1]") === null &&
  T.parseStats('{"done":2}').done === 2);

// removing one entry
const L = [
  { id: "a", result: "done", ms: 10, name: "A", pid: "1" }, { id: "b", result: "done", ms: 20, name: "A", pid: "1" },
  { id: "c", result: "gaveup", ms: 5, name: "B", pid: "2" }, { id: "d", result: "done", ms: 30, name: "C", pid: "3" },
];
const S = T.statsFromHistory(L);
const restB = L.filter((e) => e.id !== "b");
const S2 = T.removeFromStats(S, L[1], restB);
check("removing a done lockdown takes it off the totals", S2.done === 2 && S2.gaveUp === 1 && S2.totalMs === 45 && S2.perf["1"].n === 1);
check("streaks are recounted when the list is complete", S2.bestStreak === 1 && S2.streak === 1, JSON.stringify(S2));
const restC = L.filter((e) => e.id !== "c");
const S3 = T.removeFromStats(S, L[2], restC);
check("removing the give-up joins the streaks back up", S3.gaveUp === 0 && S3.streak === 3 && S3.bestStreak === 3);
check("a performer with no lockdowns left drops out of most locked", !("2" in S3.perf));
// past the cap the best streak cannot shrink: it may include entries no longer in the list
const capped = { ...S, done: 300, bestStreak: 40 };
check("past the cap the best streak is kept", T.removeFromStats(capped, L[1], restB).bestStreak === 40);
check("entry keys: id, or a fingerprint for older entries",
  T.entryKey({ id: "x1" }) === "x1" && T.entryKey({ pid: "4", at: 5, ms: 6, result: "done" }) === "4|5|6|done");

// the full view
const M = [
  { result: "done", ms: 1, name: "Ann", at: new Date(2026, 9, 3).getTime() },
  { result: "gaveup", ms: 1, name: "Bob", at: new Date(2026, 9, 8).getTime() },
  { result: "done", ms: 1, name: "Ann", at: new Date(2026, 8, 20).getTime() },
  { odd: true },
];
const G = T.groupByMonth(M);
check("months, newest first, with counts",
  G.length === 2 && G[0].key === "2026-10" && G[0].done === 1 && G[0].gaveUp === 1 && G[1].key === "2026-09" &&
  G[0].items[0].name === "Bob", JSON.stringify(G.map((g) => g.key)));
check("filter by result", T.filterEntries(M, "done").length === 2 && T.filterEntries(M, "gaveup").length === 1 &&
  T.filterEntries(M, "all").length === 3);
check("filter by name", T.filterEntries(M, "all", "an").length === 2 && T.filterEntries(M, "done", "bob").length === 0);
const now = new Date(2026, 9, 9, 15, 0).getTime();
check("when: today, yesterday, days",
  T.fmtWhen(new Date(2026, 9, 9, 1, 0).getTime(), now) === "today" &&
  T.fmtWhen(new Date(2026, 9, 8, 23, 0).getTime(), now) === "yesterday" &&
  T.fmtWhen(new Date(2026, 9, 5, 12, 0).getTime(), now) === "4d ago");
check("when: older is a date", /\d/.test(T.fmtWhen(new Date(2026, 8, 1).getTime(), now)));
check("history that does not parse is untrusted", T.parseHistory("[{") === null && T.parseHistory('{"a":1}') === null);
check("nothing stored is an empty history", eq(T.parseHistory(undefined), []));
check("unknown entries are kept in storage", T.parseHistory(JSON.stringify(h)).length === 5);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
