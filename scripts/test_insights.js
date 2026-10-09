#!/usr/bin/env node
// Insights checks that need no browser: load the real file against a stub DOM
// and test the calculations exposed when window.__INSIGHTS_TEST__ is set.
// Run from the repo root: node scripts/test_insights.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ": " + detail : ""}`); }
}

const windowStub = { __INSIGHTS_TEST__: true, addEventListener() {} };
const sandbox = {
  window: windowStub, document: { head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {},
                                  getElementById: () => null, querySelector: () => null },
  location: { pathname: "/" }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => new Promise(() => {}), setTimeout: () => 0, setInterval: () => 0,
  console: { log() {}, error() {}, warn() {} }, Intl, Date, Math, JSON,
};
const file = path.join(__dirname, "..", "plugins", "Insights", "Insights.js");
try {
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: "Insights.js" });
  check("loads against a stub DOM", true);
} catch (e) {
  check("loads against a stub DOM", false, e.message);
  process.exit(1);
}
const T = windowStub.__InsightsTest;
check("test hook exposed", !!T);
if (!T) process.exit(1);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const iso = (ms) => new Date(ms).toISOString();

// ── days are local ──────────────────────────────────────────────────────────
check("a late-evening O stays on its local day", T.dayKey(at(2026, 1, 1, 23, 30)) === "2026-01-01");
check("YYYY-MM-DD is local midnight, not UTC", new Date(T.parseDay("2026-03-01")).getDate() === 1 &&
  new Date(T.parseDay("2026-03-01")).getHours() === 0);
check("days between, across a month", T.daysBetween(at(2026, 1, 30), at(2026, 2, 2)) === 3);
check("weeks start on Monday", new Date(T.weekStart(at(2026, 10, 11))).getDay() === 1);   // a Sunday
check("time strings and numbers parse", T.toMs("2026-10-07T21:14:03+02:00") === Date.parse("2026-10-07T21:14:03+02:00") &&
  T.toMs(5) === 5 && T.toMs("") === null && T.toMs("nonsense") === null);

// ── O's over time ───────────────────────────────────────────────────────────
const now = at(2026, 10, 10, 15);
const scenesA = [
  { id: "1", o: 3, oh: [iso(at(2026, 10, 10, 9)), iso(at(2026, 10, 9, 22)), iso(at(2026, 10, 8, 21))] },
  { id: "2", o: 4, oh: [iso(at(2026, 10, 1, 20)), iso(at(2026, 9, 1, 20))] },     // 2 O's without a date
  { id: "3", o: 1, oh: [iso(at(2026, 9, 2, 20))] },
];
const C = T.collectOs(scenesA);
check("dated O's collected in time order", C.events.length === 6 && C.events[0].t < C.events[5].t);
check("O's without a date are counted, not dropped", C.undated === 2);
const byDay = T.countByDay(C.events);
const S = T.streaks(byDay, now);
check("current streak counts back from today", S.current === 3, JSON.stringify(S));
check("best streak and its dates", S.best.len === 3 && T.dayKey(S.best.from) === "2026-10-08");
check("longest break between O days", S.longestBreak === 28, String(S.longestBreak));   // Sep 3 .. Sep 30
check("not at risk when there is an O today", S.atRisk === false);
const S2 = T.streaks(byDay, at(2026, 10, 11, 9));
check("a streak is still alive the next morning, and at risk", S2.current === 3 && S2.atRisk === true);
check("a missed day ends it", T.streaks(byDay, at(2026, 10, 12, 9)).current === 0);
check("record day: the most, earliest on a tie", eq(T.recordDay(new Map([["2026-01-02", 2], ["2026-01-01", 2], ["2026-01-03", 1]])), { day: "2026-01-01", n: 2 }));

const Y = T.periodBars(byDay, "year", 0, now);
check("year: 12 months, local", Y.bars.length === 12 && Y.bars[8].value === 2 && Y.bars[9].value === 4, JSON.stringify(Y.bars.map((b) => b.value)));
const Mo = T.periodBars(byDay, "month", 0, now);
check("month: one bar a day", Mo.bars.length === 31 && Mo.bars[9].value === 1 && Mo.bars[7].value === 1);
const W = T.periodBars(byDay, "week", 0, now);
check("week: Monday to Sunday", W.bars.length === 7 && new Date(W.bars[0].from).getDay() === 1);
check("a month back is the previous month", T.periodBars(byDay, "month", -1, now).bars.length === 30);
const cal = T.calendar(byDay, now);
check("calendar: 53 Monday-start weeks", cal.cells.length === 371 && new Date(cal.cells[0].from).getDay() === 1);
check("calendar marks the future", cal.cells.some((c) => c.future) && !cal.cells.find((c) => c.key === "2026-10-10").future);
const wh = T.weekdayHour(C.events);
check("weekday x hour: Monday is row 0", wh[4][9] === 0 && wh[5][9] === 1);   // Oct 10 2026 is a Saturday

const sceneP = { id: "9", title: "x", oh: [iso(at(2026, 10, 5, 21, 10))], ph: [iso(at(2026, 10, 5, 21, 0)), iso(at(2026, 10, 5, 23, 0)), iso(at(2026, 10, 5, 23, 10))] };
const ev = T.dayEvents([sceneP], "2026-10-05");
check("a day's events: plays near an O or another play are folded in", ev.length === 2 && ev[0].o && !ev[1].o, JSON.stringify(ev.map((e) => e.o)));

// ── traits ──────────────────────────────────────────────────────────────────
check("cup from measurements", T.cupOf("34C-24-34") === "C" && T.cupOf("32DD") === "DD+" && T.cupOf("30AA") === "A" && T.cupOf("34") === null);
check("height and weight groups", T.heightGroup(160) === "155–164 cm" && T.heightGroup(176) === "175 cm and up" && T.weightGroup(null) === null);
check("age on the scene's date", T.ageAt("2000-06-15", "2020-06-14") === 19 && T.ageAt("2000-06-15", "2020-06-15") === 20 && T.ageAt(null, "2020-01-01") === null);
check("age groups", T.ageGroup(19) === "18–21" && T.ageGroup(45) === "41 and up" && T.ageGroup(null) === null);
check("career stage", T.careerGroup("2015", "2016-05-01") === "first 2 years" && T.careerGroup("2010-01-01", "2023-01-01") === "over 10 years in" &&
  T.careerGroup("2020", "2018-01-01") === null);
check("natural or enhanced", T.naturalGroup("Natural") === "natural" && T.naturalGroup("No") === "natural" && T.naturalGroup("Yes") === "enhanced" && T.naturalGroup("") === null);
check("tattoos yes, none, unknown", T.yesNo("Left arm", "y", "n") === "y" && T.yesNo("None", "y", "n") === "n" && T.yesNo(null, "y", "n") === null);
check("flags from country codes", T.flagOf("us") === "\u{1F1FA}\u{1F1F8}" && T.flagOf("Germany") === "");
check("scene groups", T.lengthGroup(1200) === "10–30 min" && T.resolutionGroup(1080) === "1080p" && T.resolutionGroup(2160) === "4K and up" &&
  T.eraGroup("2017-03-01") === "2015–2019" && T.eraGroup("1999-01-01") === "before 2005" && T.castGroup(1) === "solo" && T.castGroup(3) === "three or more");

const perfs = new Map([
  ["a", { id: "a", hair: "Blonde", country: "us", tags: [["t1", "Body ★: 5"]] }],
  ["b", { id: "b", hair: "Blonde", country: "CZ", tags: [] }],
  ["c", { id: "c", hair: "Brunette", country: "CZ", tags: [] }],
]);
const lib = [];
for (let i = 0; i < 10; i++) lib.push({ id: `s${i}`, o: 0, plays: 1, playDur: 60, perf: ["c"] });
lib.push({ id: "x1", o: 6, plays: 4, playDur: 600, perf: ["a", "b"] });          // two blondes, counted once
for (let i = 0; i < 5; i++) lib.push({ id: `y${i}`, o: 1, plays: 1, playDur: 60, perf: ["a"] });
const hair = T.PERFORMER_TRAITS.find((d) => d.id === "hair");
const H = T.traitRows(lib, perfs, hair);
const blonde = H.rows.find((r) => r.value === "Blonde"), brunette = H.rows.find((r) => r.value === "Brunette");
check("a scene counts once per value, however many performers share it", blonde.scenes === 6 && blonde.o === 11);
check("shares and lift", Math.abs(blonde.libShare - 6 / 16) < 1e-9 && Math.abs(blonde.oShare - 1) < 1e-9 && blonde.lift > 2.6);
check("a big group with no O's still shows, at lift 0 (an insight too)", brunette.lift === 0 && brunette.small === false);
check("a group too small to judge is marked small", T.traitRows([{ id: "1", o: 1, plays: 1, perf: ["a"] }], perfs, hair).rows[0].small === true);
check("country codes are folded to one case", T.traitRows(lib, perfs, T.PERFORMER_TRAITS.find((d) => d.id === "country")).rows.some((r) => r.value === "US"));
check("performer tags (rating tags too) are a dimension",
  T.traitRows(lib, perfs, T.PERFORMER_TRAITS.find((d) => d.id === "ptags")).rows[0].value === "Body ★: 5");
const stud = T.SCENE_TRAITS.find((d) => d.id === "studio");
check("scene traits read the scene", T.traitRows([{ id: "1", o: 1, studio: { id: "9", name: "Bright" }, perf: [] }], perfs, stud).rows[0].value === "Bright");
check("lift tones", T.liftTone(1.3) === "up" && T.liftTone(0.7) === "down" && T.liftTone(1) === "even");

// ── people, scenes, library, backlog ────────────────────────────────────────
const favs = new Map([["a", { id: "a", fav: true }], ["b", { id: "b", fav: true }]]);
const pt = T.performerTable([
  { id: "1", o: 2, oh: [iso(at(2025, 1, 1))], perf: ["a"], plays: 3, playDur: 100 },
  { id: "2", o: 1, oh: [iso(at(2026, 10, 1))], perf: ["b"], plays: 1, playDur: 50 },
], favs, now);
check("performers by O's", pt.byO[0].id === "a" && pt.byO[0].o === 2);
check("favourites with no O in six months are flagged to revisit", pt.neglected.length === 1 && pt.neglected[0].id === "a");
const tops = T.topScenes([{ id: "1", o: 3, plays: 1, oh: [iso(at(2026, 1, 1))] }, { id: "2", o: 1, plays: 9, oh: [iso(at(2026, 10, 1))] }], now);
check("top scenes by O's and by plays", tops.byO[0].id === "1" && tops.byPlays[0].id === "2");
check("O'd a lot, not revisited in 3 months", tops.unvisited.length === 1 && tops.unvisited[0].id === "1");
const L = T.library([{ size: 10, dur: 60, rating: 80, organized: true, plays: 1, o: 1, date: "2020-05-01", created: at(2024, 1, 1) },
                     { size: 5, dur: 30, rating: null, organized: false, plays: 0, o: 0, date: "2021-01-01", created: at(2024, 6, 1) }]);
check("library totals", L.totals.scenes === 2 && L.totals.size === 15 && L.totals.rated === 1 && L.totals.organized === 1);
check("by year released and added", eq(L.released.map((y) => y.year), [2020, 2021]) && L.added[0].n === 2);
const RB = T.ratingBands([{ rating: 95, o: 3, plays: 1 }, { rating: null, o: 0, plays: 0 }]);
check("rating bands", RB[0].perScene === 3 && RB[4].scenes === 1 && RB[4].played === 0);
const BL = T.backlog([{ plays: 0, organized: false, created: at(2025, 1, 1) }, { plays: 5, o: 0, rating: null, organized: true },
                      { plays: 1, o: 0, rating: 80, organized: true, resume: 30 }], now);
const bl = (id) => BL.find((b) => b.id === id).n;
check("backlog counts", bl("unwatched") === 1 && bl("unrated") === 1 && bl("teasers") === 1 && bl("loved") === 1 && bl("started") === 1 && bl("unorganized") === 1);
check("backlog rows say how old the oldest is", BL.find((b) => b.id === "unwatched").oldestDays > 600);
check("list URLs in Stash's encoding",
  T.listUrl("/scenes", [{ type: "play_count", modifier: "EQUALS", value: { value: 0 } }], "created_at") ===
  "/scenes?c=(%22type%22:%22play_count%22,%22modifier%22:%22EQUALS%22,%22value%22:(%22value%22:0))&sortby=created_at&sortdir=desc");

// ── watch time ──────────────────────────────────────────────────────────────
const wbd = { "2026-10-10": 1800, "2026-10-09": 600 };
check("watch per O counts only tracked days", T.watchPerO(wbd, byDay, now) === 1200);
check("no tracking, no figure", T.watchPerO({}, byDay, now) === null);
const mo = T.mergeOStats({ "2026-10-01": 100 }, { version: "2.0", data: { "2026-10-01": "50,1", "2026-10-02": "300,2", bad: "1" } });
check("O Stats import: larger per day, both formats", mo.merged["2026-10-01"] === 100 && mo.merged["2026-10-02"] === 300 && mo.days === 1);
check("O Stats old format", T.mergeOStats({}, { "2026-01-01": 42, "2026-01-02": { totalTime: 7 } }).days === 2);
check("tracked seconds add onto what is stored", eq(T.addWatch({ "2026-10-10": 60 }, { "2026-10-10": 30, "2026-10-11": 5 }), { "2026-10-10": 90, "2026-10-11": 5 }));
check("durations read well", T.fmtDur(59) === "59s" && T.fmtDur(3720) === "1h 2m" && T.fmtBytes(1536) === "1.5 KB");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
