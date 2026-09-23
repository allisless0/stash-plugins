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
  KeyboardEvent: function () {},
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
const expected = { keydown: 1, pointerdown: 1, dblclick: 2 };
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
