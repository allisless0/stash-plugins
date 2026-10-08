#!/usr/bin/env node
// QuickTools checks that need no browser: load the real file against a stub
// DOM, then test the pure helpers it exposes when window.__QT_TEST__ is set.
// Run from the repo root: node scripts/test_quicktools.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

// ── stub browser ────────────────────────────────────────────────────────────
const listeners = [];   // [target, type]
function target(name) {
  return {
    addEventListener(type) { listeners.push([name, type]); },
    removeEventListener() {},
  };
}
function el() {
  return {
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}
const body = el();
const documentStub = Object.assign(target("document"), {
  body, head: el(), fullscreenElement: null, visibilityState: "visible",
  getElementById: () => null, createElement: el, querySelector: () => null,
  querySelectorAll: () => [], activeElement: null,
});
const windowStub = Object.assign(target("window"), {
  __QT_TEST__: true, innerWidth: 1280, innerHeight: 720,
  location: { pathname: "/scenes/1", href: "http://x/scenes/1" },
});
const sandbox = {
  window: windowStub, document: documentStub, location: windowStub.location,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: { configuration: { plugins: {} } } }) }),
  performance: { now: () => 0 },
  setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 0, console: { log() {}, error() {}, warn() {} },
  HTMLMediaElement: function () {}, Element: function () {},
  KeyboardEvent: function () {}, URLSearchParams,
};
sandbox.globalThis = sandbox;

const file = path.join(__dirname, "..", "plugins", "QuickTools", "QuickTools.js");
try {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "QuickTools.js" });
  check("loads against a stub DOM", true);
} catch (e) {
  check("loads against a stub DOM", false, e.message);
  process.exit(1);
}

// ── the merge's one rule: one of each global handler ────────────────────────
// dblclick has two by design: queue navigation, plus the click-swallow guard
// that eats every mouse event type for 600 ms after a panel is dismissed by a
// click on the video. A third means a feature added its own listener.
// Middle-click navigation (1.4.0) rides the one pointerdown handler; auxclick
// is only the swallow guard.
const expected = { keydown: 1, pointerdown: 1, dblclick: 2, auxclick: 1 };
for (const [type, want] of Object.entries(expected)) {
  const n = listeners.filter(([, t]) => t === type).length;
  check(`${want} global ${type} handler(s)`, n === want, `found ${n}`);
}

const T = windowStub.__QuickToolsTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);

// ── rating keypad ───────────────────────────────────────────────────────────
function typeAll(keys) {
  let buf = "", val = 0;
  for (const k of keys) {
    const r = T.typeDigit(buf, k);
    if (r) { buf = r.buffer; val = r.value; }
  }
  return val;
}
const cases = [
  [["8", "5"], 8.5], [["1", "0"], 10], [["0", "5"], 0.5], [["7"], 7],
  [["9", ".", "5"], 9.5], [["6", ",", "2"], 6.2], [["3", ".", ".", "4"], 3.4],
  [["1", "0", "5"], 10.5],   // clamped to 10 by setValue, not by the keypad
];
for (const [keys, want] of cases) {
  const got = typeAll(keys);
  check(`keypad ${keys.join(" ")} -> ${want}`, Math.abs(got - want) < 1e-9, `got ${got}`);
}
check("second decimal point is ignored", T.typeDigit("3.", ".") === null);

// ── queue side (double-click and middle-click) ─────────────────────────────
check("right half is next", T.sideOf(0.75, 0) === "next");
check("left half is previous", T.sideOf(0.2, 0) === "previous");
check("centre line counts as next", T.sideOf(0.5, 0) === "next");
check("outside the video is not navigation", T.sideOf(1.2, 0) === null && T.sideOf(-0.1, 0) === null);
check("dead zone is not navigation", T.sideOf(0.52, 0.2) === null && T.sideOf(0.8, 0.2) === "next");
check("NaN (zero-width video) is not navigation", T.sideOf(NaN, 0) === null);

// ── quick tags (T) ──────────────────────────────────────────────────────────
const sc = T.targetFromPath("/scenes/42");
check("T on a scene page tags the scene", sc && sc.kind === "scene" && sc.id === "42");
const pf = T.targetFromPath("/performers/7/scenes");
check("T on a performer page (any tab) tags the performer", pf && pf.kind === "performer" && pf.id === "7");
check("T does nothing on list pages", T.targetFromPath("/scenes") === null && T.targetFromPath("/performers") === null);
check("T does nothing on other pages", T.targetFromPath("/studios/3") === null && T.targetFromPath("/scenes/markers") === null);
check("fallback add keeps every other tag", JSON.stringify(T.nextTagIds(["1", "2"], "3", true)) === '["1","2","3"]');
check("fallback add of a tag already there changes nothing", JSON.stringify(T.nextTagIds(["1", 2], 2, true)) === '["1","2"]');
check("fallback remove takes only that tag", JSON.stringify(T.nextTagIds(["1", "2", "3"], "2", false)) === '["1","3"]');

// ── hovered cards (T and D in grids and lists) ─────────────────────────────
const eqj = (x, y) => JSON.stringify(x) === JSON.stringify(y);
check("performer card is the performer",
  eqj(T.cardTarget("card performer-card grid-card", ["/performers/12?sortby=x", "/tags/3"], "/performers"), { kind: "performer", id: "12" }));
check("scene card is the scene, not a performer it links",
  eqj(T.cardTarget("scene-card grid-card", ["/performers/9", "/scenes/77", "/studios/2"], "/scenes"), { kind: "scene", id: "77" }));
check("scene card on a performer's scenes tab is still the scene",
  eqj(T.cardTarget("scene-card", ["/scenes/5"], "/performers/9/scenes"), { kind: "scene", id: "5" }));
check("scene wall item is the scene", eqj(T.cardTarget("wall-item", ["/scenes/31"], "/scenes"), { kind: "scene", id: "31" }));
check("scene list row: the scene, not its performer column",
  eqj(T.cardTarget("", ["/performers/4", "/scenes/88"], "/scenes"), { kind: "scene", id: "88" }));
check("performer list row is the performer",
  eqj(T.cardTarget("", ["/performers/4"], "/performers"), { kind: "performer", id: "4" }));
check("absolute links work", eqj(T.cardTarget("scene-card", ["http://tower:6969/scenes/6"], "/scenes"), { kind: "scene", id: "6" }));
check("scene markers link is not a scene", T.cardTarget("scene-card", ["/scenes/markers"], "/scenes") === null);
check("a row with no matching link is nothing", T.cardTarget("", ["/tags/1"], "/scenes") === null);

// ── Advanced Rating tags can be hidden in the T panel ──────────────────────
check("Advanced Rating tag is a rating tag", T.isRatingTag("Body \u2605: 5") && T.isRatingTag("Range \u2606: 4"));
check("ordinary tags are not", !T.isRatingTag("Blonde") && !T.isRatingTag("5 stars") && !T.isRatingTag(null));

// ── saved filters (F) ───────────────────────────────────────────────────────
check("F works on the Scenes page", T.filterListPath("/scenes") === "/scenes");
check("F on a performer page applies to its Scenes tab", T.filterListPath("/performers/7") === "/performers/7/scenes");
check("F on a studio's Scenes tab", T.filterListPath("/studios/3/scenes") === "/studios/3/scenes");
check("F does nothing on other tabs, a scene, markers or lists of other things",
  T.filterListPath("/performers/7/galleries") === null && T.filterListPath("/scenes/12") === null &&
  T.filterListPath("/scenes/markers") === null && T.filterListPath("/performers") === null);

// Expected strings are what Stash 0.31's own saved-filter menu writes to the
// URL for the same saved filters (captured from a real instance, names changed).
const sfTags = { find_filter: { q: "", sort: "date", direction: "DESC", per_page: 40 },
  object_filter: { tags: { modifier: "INCLUDES_ALL", value: { depth: 0, excluded: [], items: [{ id: "23", label: "Outdoor" }] } } },
  ui_options: { display_mode: 0, zoom_index: 1 } };
const qTags = T.savedFilterQuery(sfTags);
check("tags rule: items, excluded, depth in Stash's order",
  qTags.split("&")[0] === "c=(%22type%22:%22tags%22,%22modifier%22:%22INCLUDES_ALL%22,%22value%22:(%22items%22:%5B(%22id%22:%2223%22,%22label%22:%22Outdoor%22)%5D,%22excluded%22:%5B%5D,%22depth%22:0))", qTags);
check("sort and direction follow", /&sortby=date&sortdir=desc/.test(qTags));
const sfNull = { find_filter: { sort: "random_65185796", direction: "DESC" },
  object_filter: { rating100: { modifier: "IS_NULL", value: { value: 0 } } } };
check("IS_NULL carries no value", T.savedFilterQuery(sfNull).split("&")[0] === "c=(%22type%22:%22rating100%22,%22modifier%22:%22IS_NULL%22)");
const sfRate = { find_filter: { sort: "date", direction: "ASC" }, object_filter: { rating100: { modifier: "EQUALS", value: { value: 20 } } },
  ui_options: { display_mode: 1, zoom_index: 2 } };
check("number rule and display options",
  T.savedFilterQuery(sfRate) === "c=(%22type%22:%22rating100%22,%22modifier%22:%22EQUALS%22,%22value%22:(%22value%22:20))&sortby=date&sortdir=asc&disp=1&z=2", T.savedFilterQuery(sfRate));
check("a search term and special characters are escaped",
  /^q=a%26b&c=/.test(T.savedFilterQuery({ find_filter: { q: "a&b" }, object_filter: { title: { modifier: "INCLUDES", value: "x=1+2?" } } })) &&
  T.savedFilterQuery({ object_filter: { title: { modifier: "INCLUDES", value: "x=1+2?" } } }).includes("x%3D1%2B2%3F"));
check("empty filter is an empty query", T.savedFilterQuery({}) === "");

// which saved filter is showing: same criteria, any order, any key order
const url = "?" + T.savedFilterQuery(sfTags);
check("current filter recognised from the URL", T.criteriaKey(T.currentCriteria(url)) === T.criteriaKey(T.savedCriteria(sfTags)));
check("a different filter is not current", T.criteriaKey(T.currentCriteria(url)) !== T.criteriaKey(T.savedCriteria(sfRate)));
check("no criteria is no match for an empty list", T.criteriaKey(T.currentCriteria("")) === "");

// the delete-tag filter, by id or name, whatever the filter is called
const delTag = { id: "2143", name: "Marked for Delete" };
const sfDel = (items, modifier = "INCLUDES_ALL") => ({ name: "anything", object_filter: { tags: { modifier, value: { items } } } });
check("delete filter found by tag id", T.isDeleteFilter(sfDel([{ id: "2143", label: "renamed" }]), delTag));
check("delete filter found by tag name", T.isDeleteFilter(sfDel([{ id: "9", label: "marked for delete" }]), { id: null, name: "Marked for Delete" }));
check("excluding the delete tag is not the delete filter", !T.isDeleteFilter(sfDel([{ id: "2143" }], "EXCLUDES"), delTag));
check("other tag filters are not", !T.isDeleteFilter(sfTags, delTag) && !T.isDeleteFilter(sfRate, delTag));

// ── range markers ───────────────────────────────────────────────────────────
check("range in order", JSON.stringify(T.orderRange(10, 20)) === "[10,20]");
check("range pressed end-first", JSON.stringify(T.orderRange(20, 10)) === "[10,20]");

// ── time formatting ─────────────────────────────────────────────────────────
check("fmtTime rounds before splitting (59.95)", T.fmtTime(59.95) === "1:00.0", T.fmtTime(59.95));
check("fmtTime hours", T.fmtTime(3661.2) === "1:01:01.2", T.fmtTime(3661.2));
check("fmtTime negative clamps", T.fmtTime(-3) === "0:00.0", T.fmtTime(-3));

// ── errors a person can read ────────────────────────────────────────────────
check("401 says logged out", /logged out/.test(T.httpErrorText(401)));
check("500 says server error", /server error/.test(T.httpErrorText(500)));

// ── fullscreen host ─────────────────────────────────────────────────────────
documentStub.fullscreenElement = null;
check("host is the body normally", T.uiHost() === body);
const fsDiv = { tagName: "DIV" };
documentStub.fullscreenElement = fsDiv;
check("host is the fullscreen element", T.uiHost() === fsDiv);
documentStub.fullscreenElement = { tagName: "VIDEO" };
check("a fullscreen <video> cannot host, body instead", T.uiHost() === body);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
