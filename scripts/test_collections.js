#!/usr/bin/env node
// Collections checks that need no browser: load the real file against a stub
// DOM and test the pure helpers exposed when window.__COLL_TEST__ is set.
// Run from the repo root: node scripts/test_collections.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── stub browser ────────────────────────────────────────────────────────────
function el() {
  return { style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
           appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
           addEventListener() {}, remove() {} };
}
const windowStub = { __COLL_TEST__: true, addEventListener() {} };
const sandbox = {
  window: windowStub,
  document: { head: el(), body: el(), addEventListener() {}, getElementById: () => null,
              createElement: el, querySelector: () => null, querySelectorAll: () => [],
              visibilityState: "visible" },
  location: { pathname: "/", href: "http://x/", search: "" },
  history: { pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  // never resolves: start() waits forever instead of touching the network
  fetch: () => new Promise(() => {}),
  MutationObserver: function () { this.observe = () => {}; },
  performance: { now: () => 0 }, requestAnimationFrame: () => 0,
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
  console: { log() {}, error() {}, warn() {} },
  encodeURI, encodeURIComponent, decodeURIComponent,
};
windowStub.dispatchEvent = () => {};
const file = path.join(__dirname, "..", "plugins", "Collections", "Collections.js");
try {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "Collections.js" });
  check("loads against a stub DOM", true);
} catch (e) {
  check("loads against a stub DOM", false, e.message);
  process.exit(1);
}
const T = windowStub.__CollectionsTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── settings ────────────────────────────────────────────────────────────────
let c = T.parseCollections("");
check("blank setting means the Cock Hero default",
  c.length === 1 && c[0].name === "Cock Hero" && c[0].studio === "Cock Hero" &&
  c[0].score && c[0].hide && c[0].mode === "beat" && c[0].sort === "o_counter", JSON.stringify(c));
c = T.parseCollections("CH = Cock Hero, score ; PMVs = PMV Studio, show, sort:date; VR");
check("three collections parsed", c.length === 3);
check("tab name and studio split on =", c[0].name === "CH" && c[0].studio === "Cock Hero");
check("show keeps them in the main list", c[1].hide === false && c[1].sort === "date");
check("no = means tab named after the studio", c[2].name === "VR" && c[2].studio === "VR" && !c[2].score);

// ── Stash URL encoding (must match ListFilterModel.getEncodedParams) ────────
const enc = T.encodeCriterion({ type: "studios", modifier: "INCLUDES",
  value: { items: [{ id: "12", label: "Cock Hero (Colors) & more" }], excluded: [], depth: -1 } });
check("braces become parentheses outside strings",
  enc.startsWith("(%22type%22:%22studios%22") && enc.endsWith("-1))"), enc);
check("parentheses inside strings are kept literal", enc.includes("Cock%20Hero%20(Colors)"), enc);
check("& is escaped so it cannot split the query", enc.includes("%26") && !enc.includes("&"), enc);
const url = T.tabUrl({ id: "12", name: "Cock Hero" }, "o_counter");
check("tab URL sorts by O count, highest first", url.includes("&sortby=o_counter&sortdir=desc"), url);

// ── hiding: merge into the Scenes default filter (rule 5) ───────────────────
const ch = { id: "12", name: "Cock Hero" };
let r = T.mergeHide(null, [ch], []);
check("no default filter: one is created with the exclusion",
  r.changed && r.filter.mode === "SCENES" &&
  eq(r.filter.object_filter.studios, { modifier: "EXCLUDES", value: { items: [{ id: "12", label: "Cock Hero" }], excluded: [], depth: -1 } }));
const userDefault = {
  mode: "SCENES", find_filter: { sort: "date", direction: "DESC", per_page: 40 },
  object_filter: { rating100: { modifier: "GREATER_THAN", value: { value: 60 } },
                   studios: { modifier: "EXCLUDES", value: { items: [{ id: "7", label: "Mine" }], excluded: [], depth: 0 } } },
  ui_options: { display_mode: 1 },
};
r = T.mergeHide(userDefault, [ch], []);
check("user's other criteria and sort survive", eq(r.filter.object_filter.rating100, userDefault.object_filter.rating100) &&
  eq(r.filter.find_filter, userDefault.find_filter) && eq(r.filter.ui_options, userDefault.ui_options));
check("user's own studio exclusion kept, ours added",
  eq(r.filter.object_filter.studios.value.items.map((i) => i.id), ["7", "12"]));
check("input not mutated", userDefault.object_filter.studios.value.items.length === 1);
const again = T.mergeHide(r.filter, [ch], ["12"]);
check("running again changes nothing", !again.changed);
const off = T.mergeHide(r.filter, [], ["12"]);
check("turning hide off removes only ours",
  off.changed && eq(off.filter.object_filter.studios.value.items.map((i) => i.id), ["7"]));
const offUser = T.mergeHide(r.filter, [], []);
check("never removes an exclusion it did not add", !offUser.changed);
const incl = T.mergeHide({ mode: "SCENES", object_filter: { studios: { modifier: "INCLUDES",
  value: { items: [{ id: "3", label: "A" }], excluded: [], depth: -1 } } } }, [ch], []);
check("an includes-rule gets ours as an exclusion",
  eq(incl.filter.object_filter.studios.value.items.map((i) => i.id), ["3"]) &&
  eq(incl.filter.object_filter.studios.value.excluded.map((i) => i.id), ["12"]));
const nul = T.mergeHide({ mode: "SCENES", object_filter: { studios: { modifier: "IS_NULL" } } }, [ch], []);
check("a studio IS_NULL rule is left alone and reported", nul.conflict && !nul.changed);

// ── rounds ──────────────────────────────────────────────────────────────────
// play(r, from, to, step): timeupdates every `step` s of real playback
function play(r, from, to, step = 0.25, t0 = 0) {
  let wall = t0;
  for (let p = from; p <= to + 1e-9; p += step) { T.roundTime(r, p, true, wall); wall += step * 1000; }
  return wall;
}
let rd = T.roundNew(0.2);
play(rd, 0.2, 120);
check("from the start and uninterrupted stays Hardcore", rd.mode === "hardcore");
check("score is how far it got", Math.abs(T.roundScore(rd) - 120) < 0.3, T.roundScore(rd));

rd = T.roundNew(0);
let w = play(rd, 0, 60);
T.roundTime(rd, 60, false, w);                 // pause
T.roundTime(rd, 60, false, w + 30000);         // half a minute later, still paused
rd.last = 60; rd.lastWall = null;              // what the play event does
play(rd, 60, 90, 0.25, w + 31000);
check("a pause costs nothing", rd.mode === "hardcore" && Math.abs(T.roundScore(rd) - 90) < 0.3);

rd = T.roundNew(0);
w = play(rd, 0, 30);
T.roundTime(rd, 30.3, true, w + 3000);         // buffering: 3 s of wall, 0.3 s of video
check("a buffering stall is not a seek", rd.mode === "hardcore", rd.reason);

rd = T.roundNew(0);
w = play(rd, 0, 30);
T.roundTime(rd, 300, true, w + 250);           // skip ahead
check("skipping ahead drops to Easy", rd.mode === "easy" && /skipped ahead at 0:30/.test(rd.reason), rd.reason);
play(rd, 300, 330, 0.25, w + 250);
check("the skipped gap is not scored", Math.abs(T.roundScore(rd) - 30) < 0.3, T.roundScore(rd));
rd.last = 30; rd.lastWall = null;              // user goes back to where they were
play(rd, 30, 300, 0.25, w + 60000);
check("playing the gap through joins it up",
  Math.abs(T.roundScore(rd) - 330) < 0.3, T.roundScore(rd));
check("and it stays Easy (one way)", rd.mode === "easy");

rd = T.roundNew(0);
w = play(rd, 0, 50);
T.roundTime(rd, 20, true, w + 250);            // jump back
check("going back also drops to Easy, score kept", rd.mode === "easy" && Math.abs(T.roundScore(rd) - 50) < 0.3);

rd = T.roundNew(95);
check("starting mid-video is Easy with nothing scored", rd.mode === "easy" && T.roundScore(rd) === 0 &&
  /started at 1:35/.test(rd.reason));

rd = T.roundNew(0);
play(rd, 0, 598.5);
check("near the end counts as cleared", T.roundCleared(rd, 600) && !T.roundCleared(rd, 700));

// ── records ─────────────────────────────────────────────────────────────────
let rec = T.roundRecord({}, "hardcore", 612.34, false, 1800);
check("first Hardcore loss sets both bests",
  eq(rec.out, { round_best_hardcore: 612.3, round_best_easy: 612.3 }) && rec.newBest, JSON.stringify(rec.out));
rec = T.roundRecord({ round_best_hardcore: 700, round_best_easy: 900 }, "hardcore", 650, false, 1800);
check("a worse Hardcore run writes nothing", eq(rec.out, {}) && !rec.newBest && rec.prev === 700);
rec = T.roundRecord({ round_best_hardcore: 700, round_best_easy: 900 }, "easy", 1000, false, 1800);
check("an Easy best never touches Hardcore", eq(rec.out, { round_best_easy: 1000 }));
rec = T.roundRecord({ round_best_hardcore: "700", round_clears_easy: 2 }, "hardcore", 0, true, 1800);
check("a Hardcore clear counts for both, stored values may be strings",
  eq(rec.out, { round_best_hardcore: 1800, round_clears_hardcore: 1, round_best_easy: 1800, round_clears_easy: 3 }),
  JSON.stringify(rec.out));

check("fmt", T.fmt(59.9) === "0:59" && T.fmt(3725) === "1:02:05");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
