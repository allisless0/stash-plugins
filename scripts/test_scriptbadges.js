#!/usr/bin/env node
// ScriptBadges checks: load the real file against a stub DOM, test its helpers.
// Run from the repo root: node scripts/test_scriptbadges.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const windowStub = { __SB_TEST__: true };
const sandbox = {
  window: windowStub,
  document: { head: { appendChild() {} }, body: {}, getElementById: () => null,
              createElement: () => ({}), querySelectorAll: () => [] },
  localStorage: { getItem: () => null },
  fetch: () => new Promise(() => {}),
  MutationObserver: function () { this.observe = () => {}; },
  setTimeout: () => 0, clearTimeout() {}, console: { log() {}, error() {} },
};
try {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "plugins", "ScriptBadges", "ScriptBadges.js"), "utf8"),
                     sandbox, { filename: "ScriptBadges.js" });
  check("loads against a stub DOM", true);
} catch (e) { check("loads against a stub DOM", false, e.message); process.exit(1); }
const T = windowStub.__ScriptBadgesTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);

check("scene id from a card link", T.sceneIdFromHref("/scenes/123?t=5") === "123");
check("queue links carry the id too", T.sceneIdFromHref("/scenes/77?qfp=1&sceneIndex=2") === "77");
check("non-scene links give nothing", T.sceneIdFromHref("/performers/4") === null && T.sceneIdFromHref(null) === null);

let b = T.badgeFor({ interactive: true, speed: 250 }, false);
check("scene with a script shows it, with speed", b && b.cls === "has" && b.text === "Script · 250");
b = T.badgeFor({ interactive: true, speed: 0 }, false);
check("no speed measured: just Script", b && b.text === "Script");
check("scene without a script: no badge by default", T.badgeFor({ interactive: false }, false) === null);
b = T.badgeFor({ interactive: false }, true);
check("with showMissing it says so, and how to fix it", b && b.cls === "none" && /rescan/.test(b.title));
check("showMissing does not hide scenes that have one", T.badgeFor({ interactive: true, speed: 9 }, true)?.cls === "has");
check("unknown scene: no badge", T.badgeFor(undefined, false) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
