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

// ── 2.0: countries ──────────────────────────────────────────────────────────
check("country codes pass through, upper-cased", T.countryCode("cz") === "CZ" && T.countryCode("US") === "US");
check("country names become codes", T.countryCode("United States") === "US" && T.countryCode("czech republic") === "CZ" && T.countryCode("Germany") === "DE");
check("no country, no code; unknown text kept", T.countryCode("") === null && T.countryCode("Atlantis") === "Atlantis");

// ── 2.0: files ──────────────────────────────────────────────────────────────
check("codec names", T.codecName("h264") === "H.264" && T.codecName("hevc") === "HEVC" && T.codecName("wmv3") === "WMV" &&
  T.codecName("msmpeg4v3") === "MPEG-4" && T.codecName("prores") === "ProRes" && T.codecName("weird") === "WEIRD" && T.codecName("") === "unknown");
check("audio codec names", T.codecName("aac", true) === "AAC" && T.codecName("pcm_s16le", true) === "PCM" && T.codecName("", true) === "none");
check("containers: ffprobe names and extensions", T.containerName("matroska", "a.mkv") === "mkv" && T.containerName("mp4") === "mp4" &&
  T.containerName("", "clip.WEBM") === "webm" && T.containerName("", "") === "unknown");
check("resolution by the shorter side", T.resBucket(1920, 1080) === "1080p" && T.resBucket(1080, 1920) === "1080p" && T.resBucket(3840, 2160) === "4K");
check("a cinema crop is still 1080p, VR is 5K+", T.resBucket(1920, 800) === "1080p" && T.resBucket(5760, 2880) === "5K+" && T.resBucket(640, 360) === "below 480p");
check("no size, no resolution", T.resBucket(0, 0) === null && T.resBucket(0, 720) === "720p");
check("frame rate groups", T.fpsBucket(23.976) === "24/25" && T.fpsBucket(29.97) === "30" && T.fpsBucket(59.94) === "60" && T.fpsBucket(120) === "over 60" && T.fpsBucket(0) === null);
check("shapes, VR told by size", T.shapeOf(5760, 2880) === "VR" && T.shapeOf(1920, 960) === "landscape" && T.shapeOf(1080, 1920) === "portrait" &&
  T.shapeOf(1080, 1080) === "square" && T.shapeOf(4096, 4096) === "VR");
check("percentiles", T.percentile([1, 2, 3, 4, 5], 0.5) === 3 && T.percentile([1, 2, 3, 4, 5], 0.1) === 1 && T.percentile([], 0.5) === 0);
const vf = (o) => ({ nfiles: 1, size: o.fsize, fsize: 1e9, dur: 1000, w: 1920, h: 1080, vc: "h264", ac: "aac", fps: 30, br: 8e6, fmt: "mp4", phash: true, ...o });
const FS = T.fileStats([vf({}), vf({ vc: "hevc", br: 4e6 }), vf({ nfiles: 2, size: 3e9 }), vf({ phash: false, w: 640, h: 480, vc: "wmv3" }),
                        { nfiles: 0, size: 0 }]);
check("file totals: files, multi-file, no file, no phash", FS.files === 5 && FS.multi === 1 && FS.noFile === 1 && FS.noPhash === 1);
check("codec and resolution counts", FS.vcodec.get("H.264").n === 2 && FS.vcodec.get("HEVC").n === 1 && FS.res.get("1080p").n === 3 && FS.res.get("480p").n === 1);
check("bitrate spread per resolution", FS.bitrate["1080p"].n === 3 && FS.bitrate["1080p"].p50 === 8e6);
check("the raw codec rides along for links", FS.vcodec.get("WMV").raw === "wmv3");
const UP = T.upgrades([vf({ id: "a", w: 640, h: 480, o: 0 }), vf({ id: "b", vc: "mpeg4", o: 3 }), vf({ id: "c" })]);
check("worth upgrading: below 720p or legacy, most watched first", UP.n === 2 && UP.list[0].id === "b");
const many = Array.from({ length: 20 }, (_, i) => vf({ id: `n${i}`, br: 6e6 + i * 1e5 }));
const hogScene = vf({ id: "hog", br: 40e6, fsize: 5e9 });
const HG = T.spaceHogs(many.concat([hogScene]), T.fileStats(many.concat([hogScene])));
check("space hogs: far over the usual bitrate", HG.n === 1 && HG.list[0].s.id === "hog" && HG.list[0].saving > 4e9);
check("not enough files at a resolution, no hogs", T.spaceHogs([hogScene], T.fileStats([hogScene])).n === 0);
const DP = T.dupChoose([{ id: "1", w: 1280, h: 720, vc: "h264", fsize: 2 }, { id: "2", w: 1920, h: 1080, vc: "h264", fsize: 5 }, { id: "3", w: 1920, h: 1080, vc: "hevc", fsize: 3 }], "best");
check("duplicates, best quality: keep the sharpest, then the better codec", DP.keep.id === "3" && DP.items.every((i) => i.remove) && DP.items.length === 2);

// ── 2.2: actions ────────────────────────────────────────────────────────────
const cp = (id, w, h, vc, fsize, o = 0) => ({ id, w, h, vc, fsize, o, br: fsize });
check("HEVC and AV1 both count as the target", T.isEfficient("hevc") && T.isEfficient("av1") && !T.isEfficient("h264") && !T.isEfficient(""));
const H1 = T.dupChoose([cp("a", 1920, 1080, "h264", 9), cp("b", 1920, 1080, "hevc", 3), cp("c", 1280, 720, "wmv3", 2)], "hevc");
check("HEVC mode keeps the HEVC copy and ticks the rest", H1.keep.id === "b" && !H1.review && H1.items.every((i) => i.remove));
const H2 = T.dupChoose([cp("a", 1920, 1080, "h264", 9), cp("b", 1280, 720, "hevc", 3)], "hevc");
check("a sharper non-HEVC copy is not ticked; the group needs a look", H2.keep.id === "b" && H2.review && !H2.items[0].remove && /sharper/.test(H2.reason));
check("unless that safeguard is off", T.dupChoose([cp("a", 1920, 1080, "h264", 9), cp("b", 1280, 720, "hevc", 3)], "hevc", { sharp: false }).items[0].remove);
const H3 = T.dupChoose([cp("a", 1920, 1080, "h264", 9), cp("b", 1280, 720, "h264", 3)], "hevc");
check("no HEVC or AV1 copy: nothing ticked, a look", H3.review && H3.items.every((i) => !i.remove));
const H4 = T.dupChoose([cp("a", 3840, 2160, "av1", 9), cp("b", 1920, 1080, "hevc", 3)], "hevc");
check("AV1 is kept like HEVC, the sharper of the two wins", H4.keep.id === "a" && H4.items[0].remove);
check("smallest: the smallest of the sharpest copies", T.dupChoose([cp("a", 1920, 1080, "h264", 9), cp("b", 1920, 1080, "hevc", 3), cp("c", 1280, 720, "hevc", 1)], "smallest").keep.id === "b");
const MV = T.mergeValues(
  { id: "1", title: "Kept", date: null, rating100: null, organized: false, studio: null, tags: [{ id: "t1" }], performers: [{ id: "p1" }],
    galleries: [], urls: ["u1"], groups: [{ group: { id: "g1" }, scene_index: 2 }], stash_ids: [{ endpoint: "e", stash_id: "x" }] },
  [{ id: "2", title: "Copy", date: "2020-01-01", rating100: 80, organized: true, studio: { id: "s9" }, tags: [{ id: "t2" }, { id: "t1" }],
     performers: [{ id: "p2" }], galleries: [{ id: "gal" }], urls: ["u1", "u2"], groups: [{ group: { id: "g1" }, scene_index: 5 }, { group: { id: "g2" } }],
     stash_ids: [{ endpoint: "e", stash_id: "x" }, { endpoint: "e", stash_id: "y" }] }], null);
check("merge: the kept scene's own fields win", MV.id === "1" && MV.title === "Kept");
check("merge: empty fields are filled from the copies", MV.date === "2020-01-01" && MV.rating100 === 80 && MV.studio_id === "s9" && MV.organized === true);
check("merge: lists are the union, nothing dropped", eq(MV.tag_ids, ["t1", "t2"]) && eq(MV.performer_ids, ["p1", "p2"]) && eq(MV.gallery_ids, ["gal"]) &&
  eq(MV.urls, ["u1", "u2"]) && MV.groups.length === 2 && MV.groups[0].scene_index === 2 && MV.stash_ids.length === 2);
check("merge: only fields this Stash accepts", Object.keys(T.mergeValues({ id: "1", tags: [] }, [], new Set(["id", "tag_ids"]))).sort().join() === "id,tag_ids");
const NE = T.notEfficient(many.concat([hogScene, vf({ id: "hv", vc: "hevc" })]), T.fileStats(many.concat([hogScene, vf({ id: "hv", vc: "hevc" })])));
check("not HEVC/AV1 yet: HEVC files left out, biggest gain first", NE.n === 21 && NE.list[0].s.id === "hog" && NE.gain > 0 && !NE.list.some((x) => x.s.id === "hv"));

// ── 2.2: what works, ranked ─────────────────────────────────────────────────
check("ordinal dimensions keep their order", T.isOrdinal("height") && T.isOrdinal("era") && !T.isOrdinal("country") &&
  T.ordinalKey("height", "under 155 cm") < T.ordinalKey("height", "175 cm and up") && T.ordinalKey("era", "before 2005") < T.ordinalKey("era", "2010–2014"));
check("strength weighs lift by scenes", T.strength(12, 6) < T.strength(1.7, 600) && T.strength(0.5, 100) < 0);
const RT = { total: { scenes: 1000 }, rows: [
  { value: "NZ", scenes: 6, o: 12, plays: 9, libShare: 0.006, oShare: 0.07, watchShare: 0 },
  { value: "IS", scenes: 3, o: 9, plays: 9, libShare: 0.003, oShare: 0.05, watchShare: 0 },
  { value: "DE", scenes: 300, o: 120, plays: 300, libShare: 0.3, oShare: 0.5, watchShare: 0 },
  { value: "US", scenes: 600, o: 100, plays: 300, libShare: 0.6, oShare: 0.4, watchShare: 0 },
  { value: "CZ", scenes: 50, o: 30, plays: 40, libShare: 0.05, oShare: 0.1, watchShare: 0 } ] };
const RK = T.rankTraits(RT, "country", "o");
check("a tiny group is hidden; strongest first by strength, not raw lift", RK.hidden === 1 && RK.rows[0].value === "DE" && RK.rows[0].rank === 1 && RK.rows[0].top);
check("only groups above 1.25x get the highlight", RK.rows.find((r) => r.value === "US").top === false);
check("shown on request", T.rankTraits(RT, "country", "o", { small: true }).rows.length === 5);
const RH = T.rankTraits({ total: { scenes: 100 }, rows: [
  { value: "175 cm and up", scenes: 30, o: 30, plays: 9, libShare: 0.3, oShare: 0.5 },
  { value: "under 155 cm", scenes: 30, o: 10, plays: 9, libShare: 0.3, oShare: 0.1 } ] }, "height", "o");
check("height stays in height order, ranks still by strength", RH.rows[0].value === "under 155 cm" && RH.rows[1].rank === 1);
check("lift bar: 1x in the middle, 4x and 1/4x at the ends", T.liftPos(1) === 0 && T.liftPos(4) === 1 && T.liftPos(0.25) === -1 && T.liftPos(100) === 1 && T.liftPos(0) === -1);

// ── 2.0: metadata health ────────────────────────────────────────────────────
check("health score is weighted", Math.abs(T.healthScore([{ missing: 0, total: 10, weight: 1 }, { missing: 10, total: 10, weight: 3 }]) - 0.25) < 1e-9);
check("rows with no count are left out", T.healthScore([{ missing: null, total: 10, weight: 5 }, { missing: 5, total: 10, weight: 1 }]) === 0.5 &&
  T.healthScore([]) === null);
check("grades", T.gradeOf(0.95) === "A" && T.gradeOf(0.8) === "B+" && T.gradeOf(0.55) === "C" && T.gradeOf(0.1) === "E" && T.gradeOf(null) === "–");
check("raw age keeps what ageAt drops", T.rawAge("2010-06-01", "2020-05-31") === 9 && T.ageAt("2010-06-01", "2020-05-31") === null);
const pmap = new Map([["p1", { id: "p1", name: "A", birth: "2000-06-01" }], ["p2", { id: "p2", name: "B", birth: "1990-01-01" }]]);
const DC = T.dateConflicts([{ id: "s1", date: "2017-01-01", perf: ["p1", "p2"] }, { id: "s2", date: "2019-01-01", perf: ["p1"] }, { id: "s3", perf: ["p1"] }], pmap);
check("scene before a performer turned 18 is flagged, once per pair", DC.length === 1 && DC[0].s.id === "s1" && DC[0].p.id === "p1" && DC[0].age === 16);
const SN = T.sameNames([{ name: "Mia Hart" }, { name: "mia hart " }, { name: "Mia Hart", disamb: "UK" }, { name: "Eva" }]);
check("same name, same disambiguation", SN.length === 1 && SN[0].length === 2);
check("future release dates", T.futureDates([{ date: "2026-10-11" }, { date: "2026-10-10" }, { date: null }], now).length === 1);

// ── 2.0: collection ─────────────────────────────────────────────────────────
const GR = T.growth([{ created: at(2026, 7, 5), size: 1 }, { created: at(2026, 9, 1), size: 2 }, { created: at(2026, 9, 2), size: 3 }], now);
check("growth: every month to now, running total", eq(GR.map((x) => x.key), ["2026-07", "2026-08", "2026-09", "2026-10"]) &&
  eq(GR.map((x) => x.total), [1, 1, 3, 3]) && GR[2].added === 2 && GR[3].size === 6);
check("growth of nothing", T.growth([], now).length === 0);
const tg = (ids) => ids.map((i) => [i, `t${i}`]);
const TS = [{ tags: tg(["a", "b"]) }, { tags: tg(["a", "b"]) }, { tags: tg(["a", "b", "c"]) }, { tags: tg(["c"]) }, { tags: tg(["c"]) }, { tags: tg(["b"]) }];
check("tag counts", eq(T.tagCounts(TS).map((t) => [t.id, t.n]), [["b", 4], ["a", 3], ["c", 3]]));
const CO = T.coTags(TS, "a", 1);
check("what goes with a tag, by lift", CO.n === 3 && CO.rows[0].id === "b" && Math.abs(CO.rows[0].lift - 1.5) < 1e-9 && CO.rows[1].id === "c");
check("rare pairs are left out", T.coTags(TS, "a", 3).rows.length === 1);
const NW = T.networks([{ id: "1", name: "Net" }, { id: "2", name: "Site A", parent: "1" }, { id: "3", name: "Site B", parent: "2" }, { id: "4", name: "Indie" }],
  [{ studio: { id: "2", name: "Site A" }, size: 1 }, { studio: { id: "3", name: "Site B" }, size: 1 }, { studio: { id: "1", name: "Net" }, size: 1 },
   { studio: { id: "4", name: "Indie" }, size: 1 }, { studio: null }]);
check("networks gather sites under the top parent", NW.networks.length === 1 && NW.networks[0].name === "Net" && NW.networks[0].sites === 2 && NW.networks[0].scenes === 3);
check("independents are counted apart", NW.independent.studios === 1 && NW.independent.scenes === 1 && NW.independent.list[0].name === "Indie" && NW.studios.length === 4);
const PR = T.pairs([{ perf: ["1", "2"] }, { perf: ["2", "1", "3"] }, { perf: ["1", "2", "3", "4", "5", "6", "7"] }]);
check("pairs, big casts left out", PR[0].a === "1" && PR[0].b === "2" && PR[0].n === 2 && PR.length === 3);
check("new faces by first release year", eq(T.newFaces([{ date: "2020-01-01", perf: ["1"] }, { date: "2018-01-01", perf: ["1", "2"] }, { date: null, perf: ["3"] }]),
  [{ year: 2018, n: 2 }]));
const AC = T.ageCounts([{ date: "2020-06-01", o: 2, perf: ["p2"] }], pmap);
check("age counts on the scene date", AC.get(30).n === 1 && AC.get(30).o === 2);
const NB = T.notable([{ id: "1", dur: 100, fsize: 5, date: "2001-01-01", created: 5, perf: ["a", "b"], plays: 2, tags: [1, 2], studio: { id: "s", name: "S" } },
                      { id: "2", dur: 50, fsize: 9, date: "1999-01-01", created: 9, perf: ["a"], plays: 0, tags: [], studio: { id: "s", name: "S" } }],
                     new Map([["a", { id: "a", name: "A" }]]));
check("notable: longest, shortest, biggest, oldest, newest", NB.longest.id === "1" && NB.shortest.id === "2" && NB.biggest.id === "2" && NB.oldest.id === "2" && NB.newest.id === "2");
check("notable: cast, played, tagged, performer, studio", NB.cast.id === "1" && NB.played.id === "1" && NB.tagged.id === "1" &&
  NB.performer.p.name === "A" && NB.performer.n === 2 && NB.studio.n === 2);
check("nonstop reads like speech", T.nonstop(3 * 3600) === "3 hours" && T.nonstop(86400 * 2.5) === "2 days and 12 hours" &&
  T.nonstop(86400 * 132) === "4 months and 10 days" && T.nonstop(86400 * 400) === "1 year and 1 month");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
