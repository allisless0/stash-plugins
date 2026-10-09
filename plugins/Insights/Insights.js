/**
 * Insights - Stash UI plugin
 *
 * A stats dashboard on Stash's Stats page, below Stash's own numbers:
 * Overview, Activity (O's, streaks, a calendar, a day's timeline, watch
 * time), People (who and what works for you, by performer traits and
 * scene traits), Library (what you have) and Backlog (what you have not got
 * to). Everything is computed in the browser from one paged read of the
 * library; every bar, day and row leads into Stash.
 *
 * Watch time per day is tracked here, while the scene player plays (not
 * card previews), and saved into this plugin's Stash config, so it is the
 * same on every device. History from the O Stats plugin can be imported.
 *
 * Replaces the O Stats and Stats Enhancer plugins; see the README.
 */
(function () {
  "use strict";
  if (window.__InsightsLoaded) return;
  window.__InsightsLoaded = true;

  const PLUGIN_ID = "Insights";
  const DEBUG = (() => { try { return localStorage.getItem("insightsDebug") === "1"; } catch (_) { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  const DAY = 86400000;

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════
  // Every day is a LOCAL calendar day. O Stats parsed "YYYY-MM-DD" with
  // new Date(), which is UTC, and filed O's under the wrong month and year
  // for anyone west of UTC; nothing here does that.

  const pad2 = (n) => String(n).padStart(2, "0");
  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // "YYYY-MM-DD" as local midnight.
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
  }
  // Calendar days between two day starts, safe across DST changes.
  function daysBetween(a, b) { return Math.round((dayStart(b) - dayStart(a)) / DAY); }
  function addDays(ms, n) { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); }
  // Monday-start week containing ms.
  function weekStart(ms) { const d = new Date(dayStart(ms)); const wd = (d.getDay() + 6) % 7; return addDays(d.getTime(), -wd); }
  function toMs(t) {
    if (t === null || t === undefined || t === "") return null;
    const v = typeof t === "number" ? t : Date.parse(t);
    return Number.isFinite(v) ? v : null;
  }

  function fmtDur(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h >= 100) return `${h.toLocaleString()}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${s}s`;
  }
  function fmtBytes(b) {
    const u = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = b || 0, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }
  const pct = (x) => `${Math.round((x || 0) * 100)}%`;

  // ── O's over time ─────────────────────────────────────────────────────────

  // Every dated O as { t, scene }, plus the O's Stash counts that have no
  // date (older Stash versions, imports). Those still count in totals and
  // per-scene figures; day-based charts say how many they could not place.
  function collectOs(scenes) {
    const events = [];
    let undated = 0;
    for (const s of scenes) {
      const times = (s.oh || []).map(toMs).filter((x) => x !== null);
      for (const t of times) events.push({ t, scene: s.id });
      undated += Math.max(0, (s.o || 0) - times.length);
    }
    events.sort((a, b) => a.t - b.t);
    return { events, undated };
  }

  function countByDay(events) {
    const m = new Map();
    for (const e of events) { const k = dayKey(e.t); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  }

  // Current streak (consecutive days with an O, ending today, or yesterday
  // if today has none yet: still alive), best streak with its dates, and
  // the longest break between O days.
  function streaks(byDay, now) {
    const days = [...byDay.keys()].map(parseDay).sort((a, b) => a - b);
    let best = { len: 0, from: null, to: null }, run = 0, runFrom = null, prev = null, longestBreak = 0, gaps = [];
    for (const d of days) {
      if (prev !== null && daysBetween(prev, d) === 1) run += 1;
      else {
        if (prev !== null) { const gap = daysBetween(prev, d) - 1; longestBreak = Math.max(longestBreak, gap); gaps.push(gap + 1); }
        run = 1; runFrom = d;
      }
      if (run > best.len) best = { len: run, from: runFrom, to: d };
      prev = d;
    }
    const today = dayStart(now);
    let current = 0;
    if (days.length) {
      const last = days[days.length - 1];
      const since = daysBetween(last, today);
      if (since <= 1) {
        current = 1;
        for (let i = days.length - 2; i >= 0 && daysBetween(days[i], days[i + 1]) === 1; i--) current += 1;
      }
    }
    const lastDay = days.length ? days[days.length - 1] : null;
    return {
      current,
      atRisk: current > 0 && lastDay !== null && daysBetween(lastDay, today) === 1,
      best,
      longestBreak,
      daysSinceLast: lastDay === null ? null : daysBetween(lastDay, today),
      avgGapDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    };
  }

  function recordDay(byDay) {
    let best = null;
    for (const [k, n] of byDay) if (!best || n > best.n || (n === best.n && k < best.day)) best = { day: k, n };
    return best;
  }

  // Bars for a period: { label, key, value, from, to } in order. kind:
  // "week" (7 days), "month" (its days), "year" (12 months). offset 0 is the
  // current one, -1 the one before.
  function periodBars(byDay, kind, offset, now) {
    const out = [];
    if (kind === "year") {
      const y = new Date(now).getFullYear() + offset;
      for (let m = 0; m < 12; m++) {
        const from = new Date(y, m, 1).getTime(), to = new Date(y, m + 1, 1).getTime();
        let v = 0;
        for (let d = from; d < to; d = addDays(d, 1)) v += byDay.get(dayKey(d)) || 0;
        out.push({ key: `${y}-${pad2(m + 1)}`, label: new Date(y, m, 1).toLocaleDateString(undefined, { month: "short" }), value: v, from, to });
      }
      return { title: String(y), bars: out };
    }
    if (kind === "month") {
      const base = new Date(now); const y = base.getFullYear(), m = base.getMonth() + offset;
      const first = new Date(y, m, 1).getTime(), next = new Date(y, m + 1, 1).getTime();
      for (let d = first; d < next; d = addDays(d, 1)) {
        out.push({ key: dayKey(d), label: String(new Date(d).getDate()), value: byDay.get(dayKey(d)) || 0, from: d, to: addDays(d, 1) });
      }
      return { title: new Date(first).toLocaleDateString(undefined, { month: "long", year: "numeric" }), bars: out };
    }
    const ws = addDays(weekStart(now), offset * 7);
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      out.push({ key: dayKey(d), label: new Date(d).toLocaleDateString(undefined, { weekday: "short" }), value: byDay.get(dayKey(d)) || 0, from: d, to: addDays(d, 1) });
    }
    const end = addDays(ws, 6);
    const f = (x) => new Date(x).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { title: `${f(ws)} – ${f(end)}`, bars: out };
  }

  // GitHub-style year: 53 Monday-start columns ending this week.
  function calendar(byDay, now, weeks = 53) {
    const start = addDays(weekStart(now), -(weeks - 1) * 7);
    const cells = [];
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i);
      cells.push({ key: dayKey(d), value: byDay.get(dayKey(d)) || 0, future: d > dayStart(now), from: d });
    }
    return { start, cells, max: Math.max(1, ...cells.map((c) => c.value)) };
  }

  // 7 x 24: Monday first, local hours.
  function weekdayHour(events) {
    const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const e of events) { const d = new Date(e.t); m[(d.getDay() + 6) % 7][d.getHours()] += 1; }
    return m;
  }

  // A day's events for the timeline: O's, and plays not already explained
  // by an O on the same scene or another play of it within 30 minutes (O
  // Stats' rule, kept).
  function dayEvents(scenes, key) {
    const os = [], plays = [];
    for (const s of scenes) {
      for (const t of (s.oh || []).map(toMs)) if (t !== null && dayKey(t) === key) os.push({ t, scene: s, o: true });
      for (const t of (s.ph || []).map(toMs)) if (t !== null && dayKey(t) === key) plays.push({ t, scene: s, o: false });
    }
    const near = (a, b) => Math.abs(a - b) < 30 * 60000;
    const kept = [];
    for (const p of plays.sort((a, b) => a.t - b.t)) {
      if (os.some((o) => o.scene === p.scene && near(o.t, p.t))) continue;
      if (kept.some((k) => k.scene === p.scene && near(k.t, p.t))) continue;
      kept.push(p);
    }
    return os.concat(kept).sort((a, b) => a.t - b.t);
  }

  // ── Traits: what works for you ────────────────────────────────────────────

  // "34C-24-34", "32DD", "34 E" -> cup group. Band-only or nonsense -> null.
  function cupOf(measurements) {
    const m = /\b(\d{2,3})\s*([A-K]{1,3})\b/i.exec(measurements || "");
    if (!m) return null;
    const c = m[2].toUpperCase();
    if (c === "AA" || c === "A") return "A";
    if (c === "B" || c === "C" || c === "D") return c;
    return "DD+";
  }
  function heightGroup(cm) {
    if (!cm) return null;
    if (cm < 155) return "under 155 cm";
    if (cm < 165) return "155–164 cm";
    if (cm < 175) return "165–174 cm";
    return "175 cm and up";
  }
  function weightGroup(kg) {
    if (!kg) return null;
    if (kg < 50) return "under 50 kg";
    if (kg < 60) return "50–59 kg";
    if (kg < 70) return "60–69 kg";
    return "70 kg and up";
  }
  // Whole years old on the day of the scene.
  function ageAt(birth, onDay) {
    const b = parseDay(birth), d = parseDay(onDay);
    if (b === null || d === null) return null;
    const bd = new Date(b), dd = new Date(d);
    let a = dd.getFullYear() - bd.getFullYear();
    if (dd.getMonth() < bd.getMonth() || (dd.getMonth() === bd.getMonth() && dd.getDate() < bd.getDate())) a -= 1;
    return a >= 16 && a < 100 ? a : null;
  }
  function ageGroup(a) {
    if (a === null || a === undefined) return null;
    if (a < 22) return "18–21";
    if (a < 26) return "22–25";
    if (a < 31) return "26–30";
    if (a < 36) return "31–35";
    if (a < 41) return "36–40";
    return "41 and up";
  }
  // Years into a career when the scene came out.
  function careerGroup(careerStart, onDay) {
    const cs = parseInt(String(careerStart || "").slice(0, 4), 10);
    const y = parseInt(String(onDay || "").slice(0, 4), 10);
    if (!cs || !y || y < cs) return null;
    const n = y - cs;
    if (n < 2) return "first 2 years";
    if (n < 6) return "years 3–5";
    if (n < 11) return "years 6–10";
    return "over 10 years in";
  }
  const yesNo = (s, yes, no) => (s === null || s === undefined ? null : String(s).trim() && !/^(no|none|n\/a)$/i.test(String(s).trim()) ? yes : no);
  function naturalGroup(fake) {
    const f = String(fake || "").trim().toLowerCase();
    if (!f) return null;
    return /^(n|no|natural)/.test(f) ? "natural" : "enhanced";
  }
  // ISO country code -> regional indicator flag. Names stay as they are.
  function flagOf(code) {
    const c = String(code || "").trim().toUpperCase();
    return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 127397 + ch.charCodeAt(0))) : "";
  }
  function lengthGroup(sec) {
    if (!sec) return null;
    if (sec < 600) return "under 10 min";
    if (sec < 1800) return "10–30 min";
    if (sec < 3600) return "30–60 min";
    return "over an hour";
  }
  function resolutionGroup(h) {
    if (!h) return null;
    if (h >= 2000) return "4K and up";
    if (h >= 1000) return "1080p";
    if (h >= 700) return "720p";
    return "SD";
  }
  function eraGroup(date) {
    const y = parseInt(String(date || "").slice(0, 4), 10);
    if (!y) return null;
    if (y < 2005) return "before 2005";
    const from = y - ((y - 2005) % 5);
    return `${from}–${from + 4}`;
  }
  function castGroup(n) {
    if (!n) return null;
    return n === 1 ? "solo" : n === 2 ? "two performers" : "three or more";
  }

  // The trait each performer dimension reads, per (performer, scene).
  const PERFORMER_TRAITS = [
    { id: "country", label: "Nationality", get: (p) => (p.country ? String(p.country).trim().toUpperCase() : null) },
    { id: "ethnicity", label: "Ethnicity", get: (p) => p.ethnicity || null },
    { id: "hair", label: "Hair", get: (p) => p.hair || null },
    { id: "eyes", label: "Eyes", get: (p) => p.eyes || null },
    { id: "height", label: "Height", get: (p) => heightGroup(p.height) },
    { id: "weight", label: "Weight", get: (p) => weightGroup(p.weight) },
    { id: "cup", label: "Cup size", get: (p) => cupOf(p.measurements) },
    { id: "natural", label: "Natural or enhanced", get: (p) => naturalGroup(p.fake) },
    { id: "tattoos", label: "Tattoos", get: (p) => yesNo(p.tattoos, "tattoos", "no tattoos") },
    { id: "piercings", label: "Piercings", get: (p) => yesNo(p.piercings, "piercings", "no piercings") },
    { id: "age", label: "Age in the scene", get: (p, s) => ageGroup(ageAt(p.birth, s.date)) },
    { id: "career", label: "Career stage in the scene", get: (p, s) => careerGroup(p.careerStart, s.date) },
    { id: "favourite", label: "Favourites", get: (p) => (p.fav ? "favourites" : "not favourites") },
    { id: "ptags", label: "Performer tags", multi: (p) => (p.tags || []).map((t) => t[1]) },
  ];
  const SCENE_TRAITS = [
    { scene: true, id: "tags", label: "Scene tags", multi: (s) => (s.tags || []).map((t) => t[1]) },
    { scene: true, id: "studio", label: "Studios", get: (s) => (s.studio ? s.studio.name : null) },
    { scene: true, id: "cast", label: "Cast", get: (s) => castGroup((s.perf || []).length) },
    { scene: true, id: "length", label: "Length", get: (s) => lengthGroup(s.dur) },
    { scene: true, id: "resolution", label: "Resolution", get: (s) => resolutionGroup(s.h) },
    { scene: true, id: "era", label: "Released", get: (s) => eraGroup(s.date) },
    { scene: true, id: "interactive", label: "Interactive", get: (s) => (s.interactive ? "interactive" : "not interactive") },
  ];

  // One dimension's rows. A scene counts once per value, however many of
  // its performers share it. Shares are of the library's scenes, O's,
  // plays and watch time; lift = share of O's / share of scenes (and the
  // same for plays). Rows under the sample size are marked `small`.
  function traitRows(scenes, perfById, dim, opts = {}) {
    const minScenes = opts.minScenes ?? 5;
    const tot = { scenes: 0, o: 0, plays: 0, watch: 0 };
    const rows = new Map();
    for (const s of scenes) {
      tot.scenes += 1; tot.o += s.o || 0; tot.plays += s.plays || 0; tot.watch += s.playDur || 0;
      const vals = new Set();
      if (dim.scene) {
        if (dim.multi) for (const v of dim.multi(s)) vals.add(v);
        else { const v = dim.get(s); if (v) vals.add(v); }
      } else {
        for (const pid of s.perf || []) {
          const p = perfById.get(pid);
          if (!p) continue;
          if (dim.multi) for (const v of dim.multi(p, s)) vals.add(v);
          else { const v = dim.get(p, s); if (v) vals.add(v); }
        }
      }
      for (const v of vals) {
        let r = rows.get(v);
        if (!r) rows.set(v, (r = { value: v, scenes: 0, o: 0, plays: 0, watch: 0 }));
        r.scenes += 1; r.o += s.o || 0; r.plays += s.plays || 0; r.watch += s.playDur || 0;
      }
    }
    const out = [...rows.values()].map((r) => {
      const libShare = tot.scenes ? r.scenes / tot.scenes : 0;
      const oShare = tot.o ? r.o / tot.o : 0;
      const playShare = tot.plays ? r.plays / tot.plays : 0;
      const watchShare = tot.watch ? r.watch / tot.watch : 0;
      return { ...r, libShare, oShare, playShare, watchShare,
               lift: libShare ? oShare / libShare : 0, playLift: libShare ? playShare / libShare : 0,
               small: r.scenes < minScenes || (r.o < 2 && r.plays < 3) };
    });
    return { rows: out, total: tot };
  }

  // Green above 1.25, coral below 0.8, neutral between.
  function liftTone(lift) { return lift >= 1.25 ? "up" : lift <= 0.8 ? "down" : "even"; }

  // ── People and scenes ─────────────────────────────────────────────────────

  function performerTable(scenes, perfById, now) {
    const m = new Map();
    for (const s of scenes) {
      const lastO = Math.max(0, ...(s.oh || []).map(toMs).filter((x) => x !== null));
      for (const pid of s.perf || []) {
        let r = m.get(pid);
        if (!r) m.set(pid, (r = { id: pid, o: 0, scenes: 0, plays: 0, watch: 0, lastO: 0 }));
        r.o += s.o || 0; r.scenes += 1; r.plays += s.plays || 0; r.watch += s.playDur || 0;
        if (lastO > r.lastO) r.lastO = lastO;
      }
    }
    const rows = [...m.values()].map((r) => ({ ...r, p: perfById.get(r.id) || null, perScene: r.scenes ? r.o / r.scenes : 0 }));
    const sixMonths = 182 * DAY;
    return {
      byO: rows.filter((r) => r.o > 0).sort((a, b) => b.o - a.o || b.scenes - a.scenes),
      byRate: rows.filter((r) => r.scenes >= 3 && r.o > 0).sort((a, b) => b.perScene - a.perScene || b.o - a.o),
      byWatch: rows.filter((r) => r.watch > 0).sort((a, b) => b.watch - a.watch),
      neglected: rows.filter((r) => r.p && r.p.fav && (r.lastO === 0 || now - r.lastO > sixMonths))
        .sort((a, b) => (a.lastO || 0) - (b.lastO || 0)),
    };
  }

  function topScenes(scenes, now) {
    const lastOf = (s) => Math.max(0, ...(s.oh || []).map(toMs).filter((x) => x !== null));
    return {
      byO: scenes.filter((s) => s.o > 0).sort((a, b) => b.o - a.o).slice(0, 10),
      byPlays: scenes.filter((s) => s.plays > 0).sort((a, b) => b.plays - a.plays || b.playDur - a.playDur).slice(0, 10),
      unvisited: scenes.filter((s) => s.o >= 2 && lastOf(s) && now - lastOf(s) > 90 * DAY)
        .sort((a, b) => b.o - a.o).slice(0, 10).map((s) => ({ ...s, lastO: lastOf(s) })),
    };
  }

  // ── Library ───────────────────────────────────────────────────────────────

  function library(scenes) {
    const t = { scenes: scenes.length, size: 0, secs: 0, rated: 0, organized: 0, played: 0, withO: 0 };
    const released = new Map(), added = new Map();
    for (const s of scenes) {
      t.size += s.size || 0; t.secs += s.dur || 0;
      if (s.rating !== null && s.rating !== undefined) t.rated += 1;
      if (s.organized) t.organized += 1;
      if (s.plays > 0) t.played += 1;
      if (s.o > 0) t.withO += 1;
      const ry = parseInt(String(s.date || "").slice(0, 4), 10);
      if (ry > 1900) released.set(ry, (released.get(ry) || 0) + 1);
      if (s.created) { const ay = new Date(s.created).getFullYear(); added.set(ay, (added.get(ay) || 0) + 1); }
    }
    const years = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }));
    return { totals: t, released: years(released), added: years(added) };
  }

  // O's per scene and share played, by rating band.
  function ratingBands(scenes) {
    const bands = [
      { label: "5 stars", test: (r) => r >= 90 }, { label: "4 stars", test: (r) => r >= 70 && r < 90 },
      { label: "3 stars", test: (r) => r >= 50 && r < 70 }, { label: "2 stars and below", test: (r) => r < 50 },
      { label: "not rated", test: (r) => r === null || r === undefined },
    ];
    return bands.map((b) => {
      const ss = scenes.filter((s) => b.test(s.rating));
      const o = ss.reduce((a, s) => a + (s.o || 0), 0);
      return { label: b.label, scenes: ss.length, o, perScene: ss.length ? o / ss.length : 0,
               played: ss.length ? ss.filter((s) => s.plays > 0).length / ss.length : 0 };
    });
  }

  // ── Backlog ───────────────────────────────────────────────────────────────
  // Each row carries the scene-list filter that shows the same scenes, so a
  // click lands on exactly what was counted.
  const BACKLOG = [
    { id: "unwatched", label: "Never watched", icon: "eye-off", test: (s) => !s.plays,
      criteria: [{ type: "play_count", modifier: "EQUALS", value: { value: 0 } }], sort: "created_at" },
    { id: "unrated", label: "Watched, not rated", icon: "star", test: (s) => s.plays > 0 && (s.rating === null || s.rating === undefined),
      criteria: [{ type: "play_count", modifier: "GREATER_THAN", value: { value: 0 } }, { type: "rating100", modifier: "IS_NULL" }], sort: "last_played_at" },
    { id: "started", label: "Started, not finished", icon: "player-pause", test: (s) => s.resume > 0,
      criteria: [{ type: "resume_time", modifier: "GREATER_THAN", value: { value: 0 } }], sort: "last_played_at" },
    { id: "teasers", label: "Played 3+ times, no O", icon: "drop-off", test: (s) => s.plays >= 3 && !s.o,
      criteria: [{ type: "play_count", modifier: "GREATER_THAN", value: { value: 2 } }, { type: "o_counter", modifier: "EQUALS", value: { value: 0 } }], sort: "play_count" },
    { id: "loved", label: "Rated 4 stars and up, never an O", icon: "heart", test: (s) => s.rating >= 70 && !s.o,
      criteria: [{ type: "rating100", modifier: "GREATER_THAN", value: { value: 69 } }, { type: "o_counter", modifier: "EQUALS", value: { value: 0 } }], sort: "rating" },
    { id: "unorganized", label: "Not organized", icon: "folder", test: (s) => !s.organized,
      criteria: [{ type: "organized", value: "false" }], sort: "created_at" },
  ];
  function backlog(scenes, now) {
    return BACKLOG.map((b) => {
      const hits = scenes.filter(b.test);
      const oldest = hits.reduce((m, s) => (s.created && (!m || s.created < m) ? s.created : m), null);
      return { ...b, n: hits.length, oldestDays: oldest ? daysBetween(oldest, now) : null };
    });
  }

  // Stash's list URLs carry each criterion as JSON with { } swapped for ( )
  // outside strings, URL-encoded with ?#&;=+ escaped (the same encoding
  // QuickTools and Collections use).
  function encodeCriterion(obj) {
    let inString = false, escaped = false, out = "";
    for (const ch of JSON.stringify(obj)) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\" && inString) { escaped = true; out += ch; continue; }
      if (ch === '"') inString = !inString;
      out += (!inString && ch === "{") ? "(" : (!inString && ch === "}") ? ")" : ch;
    }
    let s = encodeURI(out);
    for (const c of "?#&;=+") s = s.split(c).join(encodeURIComponent(c));
    return s;
  }
  function listUrl(base, criteria, sort, dir = "desc") {
    return `${base}?${criteria.map((c) => "c=" + encodeCriterion(c)).join("&")}${sort ? `&sortby=${sort}&sortdir=${dir}` : ""}`;
  }

  // Watch per O over the last `days`: tracked seconds / dated O's on the
  // days that have tracking (so days before tracking began do not count).
  function watchPerO(watchByDay, byDay, now, days = 30) {
    let secs = 0, os = 0;
    for (let i = 0; i < days; i++) {
      const k = dayKey(addDays(now, -i));
      if (!watchByDay[k]) continue;
      secs += watchByDay[k];
      os += byDay.get(k) || 0;
    }
    return os ? secs / os : null;
  }

  // Merge O Stats' watch_data.json into ours: per day, the larger of the
  // two (both trackers may have run on the same day; adding would count it
  // twice). Accepts its two formats.
  function mergeOStats(ours, theirs) {
    const out = { ...(ours || {}) };
    const src = theirs && theirs.data && typeof theirs.data === "object" ? theirs.data : theirs || {};
    let days = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      const secs = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.split(",")[0]) : v && typeof v.totalTime === "number" ? v.totalTime : NaN;
      if (!Number.isFinite(secs) || secs <= 0) continue;
      if (!out[k] || secs > out[k]) { out[k] = Math.round(secs); days += 1; }
    }
    return { merged: out, days };
  }

  // Add pending seconds per day onto what is stored (read-merge-write: two
  // devices both add, neither overwrites).
  function addWatch(stored, pending) {
    const out = { ...(stored || {}) };
    for (const [k, v] of Object.entries(pending || {})) out[k] = Math.round((out[k] || 0) + v);
    return out;
  }

  if (window.__INSIGHTS_TEST__) {
    window.__InsightsTest = { dayKey, parseDay, daysBetween, weekStart, toMs, fmtDur, fmtBytes, collectOs, countByDay,
      streaks, recordDay, periodBars, calendar, weekdayHour, dayEvents, cupOf, heightGroup, weightGroup, ageAt,
      ageGroup, careerGroup, naturalGroup, flagOf, lengthGroup, resolutionGroup, eraGroup, castGroup,
      PERFORMER_TRAITS, SCENE_TRAITS, traitRows, liftTone, performerTable, topScenes, library, ratingBands,
      backlog, BACKLOG, encodeCriterion, listUrl, watchPerO, mergeOStats, addWatch, yesNo };
    return;
  }

  // ═══ Stash ═════════════════════════════════════════════════════════════════

  async function gql(query, variables, keepalive) {
    const res = await fetch("/graphql", {
      method: "POST", credentials: "same-origin", keepalive: !!keepalive,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }

  // Ask Stash which fields it has and request only those, so an older or
  // newer Stash without, say, career_start still loads.
  const typeFields = new Map();
  async function fieldsOf(type) {
    if (typeFields.has(type)) return typeFields.get(type);
    let names = new Set();
    try {
      const d = await gql(`query ($t: String!) { __type(name: $t) { fields { name } } }`, { t: type });
      names = new Set((d?.__type?.fields || []).map((f) => f.name));
    } catch (e) { log(`Schema read failed for ${type}: ${e.message}`); }
    typeFields.set(type, names);
    return names;
  }
  const pick = (have, list) => list.filter((f) => have.has(f.split(/[\s{]/)[0])).join(" ");

  const SCENE_WANT = ["id", "title", "date", "created_at", "rating100", "organized", "o_counter", "o_history",
    "play_count", "play_duration", "play_history", "last_played_at", "resume_time", "interactive",
    "files { duration size height basename }", "paths { screenshot }", "studio { id name }", "tags { id name }",
    "performers { id }"];
  const PERF_WANT = ["id", "name", "gender", "birthdate", "country", "ethnicity", "hair_color", "eye_color",
    "height_cm", "weight", "measurements", "fake_tits", "tattoos", "piercings", "career_start", "career_length",
    "favorite", "rating100", "image_path", "scene_count", "tags { id name }"];

  function compactScene(s) {
    const f = (s.files || [])[0] || {};
    return {
      id: String(s.id), title: s.title || f.basename || `Scene ${s.id}`, date: s.date || null,
      created: toMs(s.created_at), rating: s.rating100 ?? null, organized: !!s.organized, o: s.o_counter || 0,
      oh: s.o_history || [], plays: s.play_count || 0, playDur: s.play_duration || 0, ph: s.play_history || [],
      last: toMs(s.last_played_at), resume: s.resume_time || 0, interactive: !!s.interactive,
      dur: f.duration || 0, size: f.size || 0, h: f.height || 0, shot: s.paths?.screenshot || null,
      studio: s.studio ? { id: String(s.studio.id), name: s.studio.name } : null,
      tags: (s.tags || []).map((t) => [String(t.id), t.name]), perf: (s.performers || []).map((p) => String(p.id)),
    };
  }
  function compactPerformer(p) {
    return {
      id: String(p.id), name: p.name, gender: p.gender || null, birth: p.birthdate || null,
      country: p.country || null, ethnicity: p.ethnicity || null, hair: p.hair_color || null, eyes: p.eye_color || null,
      height: p.height_cm || null, weight: p.weight || null, measurements: p.measurements || null,
      fake: p.fake_tits || null, tattoos: p.tattoos ?? null, piercings: p.piercings ?? null,
      careerStart: p.career_start || (p.career_length ? String(p.career_length).slice(0, 4) : null),
      fav: !!p.favorite, rating: p.rating100 ?? null, image: p.image_path || null, sceneCount: p.scene_count || 0,
      tags: (p.tags || []).map((t) => [String(t.id), t.name]),
    };
  }

  // One paged pass over each list, with progress. Pages of 500 scenes keep
  // each response modest even with long histories.
  async function loadLibrary(progress) {
    const sf = pick(await fieldsOf("Scene"), SCENE_WANT);
    const pf = pick(await fieldsOf("Performer"), PERF_WANT);
    const scenes = [];
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findScenes(filter: $f) { count scenes { ${sf} } } }`,
                          { f: { page, per_page: 500, sort: "id", direction: "ASC" } });
      const r = d?.findScenes;
      for (const s of r?.scenes || []) scenes.push(compactScene(s));
      progress(`Reading your scenes… ${scenes.length.toLocaleString()} of ${(r?.count || 0).toLocaleString()}`);
      if (!r || !r.scenes.length || scenes.length >= r.count) break;
    }
    const performers = [];
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findPerformers(filter: $f) { count performers { ${pf} } } }`,
                          { f: { page, per_page: 1000, sort: "id", direction: "ASC" } });
      const r = d?.findPerformers;
      for (const p of r?.performers || []) performers.push(compactPerformer(p));
      progress(`Reading performers… ${performers.length.toLocaleString()} of ${(r?.count || 0).toLocaleString()}`);
      if (!r || !r.performers.length || performers.length >= r.count) break;
    }
    return { at: Date.now(), scenes, performers };
  }

  // ── Cache: IndexedDB, 30 minutes; Refresh skips it ────────────────────────
  // localStorage is too small for a library with its histories (O Stats hit
  // the quota); IndexedDB is not. Any failure just means no cache.
  const CACHE_MS = 30 * 60000;
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("insights", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("lib");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function cacheGet() {
    try {
      const db = await idb();
      return await new Promise((resolve) => {
        const r = db.transaction("lib").objectStore("lib").get("v1");
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }
  async function cachePut(v) {
    try {
      const db = await idb();
      db.transaction("lib", "readwrite").objectStore("lib").put(v, "v1");
    } catch (e) { log(`Cache write failed: ${e.message}`); }
  }

  // ── Plugin config: watch time and flags ───────────────────────────────────
  // configurePlugin replaces the plugin's whole map: read, change, write back
  // with every other key (rule 5). A stored watch map that does not parse
  // stops the write.
  function parseWatch(raw) {
    if (raw === undefined || raw === null || raw === "") return {};
    try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch (_) { return null; }
  }
  let configChain = Promise.resolve();
  function updateConfig(fn) {
    const run = configChain.then(async () => {
      const d = await gql(`query { configuration { plugins } }`);
      const plugins = d?.configuration?.plugins;
      if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
      const mine = plugins[PLUGIN_ID] || {};
      const next = fn(mine);
      if (!next) return mine;
      await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                { id: PLUGIN_ID, input: { ...mine, ...next } });
      return { ...mine, ...next };
    });
    configChain = run.catch((e) => log(`Config write failed: ${e.message}`, "error"));
    return run;
  }
  async function readConfig() {
    try { return (await gql(`query { configuration { plugins } }`))?.configuration?.plugins?.[PLUGIN_ID] || {}; }
    catch (_) { return {}; }
  }

  // ═══ Watch-time tracker ════════════════════════════════════════════════════
  // Counts a second for each second the scene page's own player is playing:
  // not card hover previews, not a wall (O Stats counted every <video> on
  // the page, multiplied by how many played). Seconds wait in localStorage,
  // per tab, so a closed tab loses nothing, and go to Stash once a minute
  // added onto what is stored (never a whole-map overwrite).

  const TAB = Math.random().toString(36).slice(2, 10);
  const PENDING = `insightsWatch:${TAB}`;
  let pending = {};

  function mainVideo() {
    if (!/^\/scenes\/\d+/.test(location.pathname)) return null;
    return document.querySelector("#VideoJsPlayer video, .video-js video.vjs-tech");
  }

  function trackTick() {
    const v = mainVideo();
    if (!v || v.paused || v.ended || v.readyState < 3 || v.playbackRate === 0) return;
    const k = dayKey(Date.now());
    pending[k] = (pending[k] || 0) + 1;
    try { localStorage.setItem(PENDING, JSON.stringify(pending)); } catch (_) {}
  }

  // Sends this tab's seconds, and any left by tabs that closed before they
  // could (their keys are claimed by deleting them first).
  async function flushWatch() {
    const batch = {};
    const take = (key) => {
      try {
        const v = JSON.parse(localStorage.getItem(key) || "{}");
        for (const [k, n] of Object.entries(v)) batch[k] = (batch[k] || 0) + n;
        localStorage.removeItem(key);
      } catch (_) {}
    };
    take(PENDING);
    pending = {};
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith("insightsWatch:") && key !== PENDING && orphan(key)) take(key);
      }
    } catch (_) {}
    if (!Object.keys(batch).length) return;
    try {
      await updateConfig((mine) => {
        const stored = parseWatch(mine.watch);
        if (stored === null) throw new Error("stored watch time could not be read; left as it was");
        return { watch: JSON.stringify(addWatch(stored, batch)) };
      });
    } catch (e) {
      // Put it back for the next try rather than lose it.
      for (const [k, n] of Object.entries(batch)) pending[k] = (pending[k] || 0) + n;
      try { localStorage.setItem(PENDING, JSON.stringify(pending)); } catch (_) {}
    }
  }

  // Another tab's key is an orphan once that tab stops refreshing it.
  const ALIVE = `insightsAlive:${TAB}`;
  function orphan(key) {
    const tab = key.split(":")[1];
    try { return Date.now() - (parseInt(localStorage.getItem(`insightsAlive:${tab}`) || "0", 10)) > 3 * 60000; }
    catch (_) { return false; }
  }

  // ═══ UI ════════════════════════════════════════════════════════════════════

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function navigate(url) {
    // React Router listens for popstate; a full reload would lose the SPA.
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  const ICON = {
    drop: '<path d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5z"/>',
    flame: '<path d="M8 1.5c.5 2.5 3.8 4 3.8 7.6A3.8 3.8 0 0 1 4.2 9.1c0-1.8 1-2.8 1.8-3.6.1 1.3.7 2.1 1.4 2.4C7.2 5.6 7.6 3.5 8 1.5z"/>',
    trophy: '<path d="M4.5 2.5h7v3a3.5 3.5 0 0 1-7 0zM4.5 3.5H2.5a2 2 0 0 0 2 2.5M11.5 3.5h2a2 2 0 0 1-2 2.5M8 9v2.5M5.5 13.5h5M6.5 11.5h3v2h-3z" fill="none"/>',
    clock: '<circle cx="8" cy="8" r="5.8" fill="none"/><path d="M8 4.8V8l2.2 1.4" fill="none"/>',
    eyeoff: '<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM2.5 2.5l11 11" fill="none"/><circle cx="8" cy="8" r="1.8" fill="none"/>',
    star: '<path d="M8 2l1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.8 4.1-.5z" fill="none"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9" fill="none"/>',
    dropoff: '<path d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5zM2.5 2.5l11 11" fill="none"/>',
    heart: '<path d="M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3c0 3.9-5.5 7.2-5.5 7.2z" fill="none"/>',
    folder: '<path d="M2 4.5h4l1.2 1.5H14v6.5H2z" fill="none"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none"/>',
    play: '<path d="M6 4.5v7l5.5-3.5z"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" fill="none"/>',
  };
  const ic = (name, cls = "") => `<svg class="ins-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] || ""}</svg>`;

  function injectStyles() {
    if (document.getElementById("insights-styles")) return;
    const s = document.createElement("style");
    s.id = "insights-styles";
    s.textContent = `
#insights { --bg: #1b2229; --card: #232b33; --line: #33404d; --text: #e6e9ec; --muted: #8b97a3; --dim: #6e7b88;
  --o: #4fa3ff; --watch: #3ecf8e; --play: #f5a623; --up: #3ecf8e; --down: #e8806b; --even: #8b97a3; --perf: #a78bfa;
  --h0: #222c36; --h1: #1d3a5c; --h2: #2563a3; --h3: #4fa3ff; --h4: #a9d4ff;
  max-width: 1400px; margin: 28px auto 40px; padding: 0 16px; color: var(--text); font-size: 14px; text-align: left; }
#insights * { box-sizing: border-box; }
#insights button { font: inherit; }
.ins-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.ins-title { font-size: 22px; font-weight: 700; margin-right: 8px; }
.ins-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.ins-tab { background: none; border: 1px solid #44525f; color: #c6ced6; border-radius: 999px; padding: 5px 14px; cursor: pointer; }
.ins-tab:hover { border-color: var(--muted); color: #fff; }
.ins-tab.on { background: rgba(79,163,255,.16); border-color: rgba(79,163,255,.6); color: #fff; }
.ins-meta { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.ins-meta button { background: none; border: 1px solid #44525f; color: #c6ced6; border-radius: 6px; padding: 3px 9px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 5px; }
.ins-meta button:hover { color: #fff; border-color: var(--muted); }
.ins-ic { width: 16px; height: 16px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; fill: currentColor; flex: none; }
.ins-ic.line { fill: none; }
.ins-progress { padding: 40px 0; text-align: center; color: var(--muted); }
.ins-progress .bar { width: 260px; max-width: 80%; height: 4px; margin: 12px auto 0; background: var(--line); border-radius: 2px; overflow: hidden; }
.ins-progress .bar i { display: block; width: 40%; height: 100%; background: var(--o); animation: insSlide 1.1s ease-in-out infinite; }
@keyframes insSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.ins-error { padding: 14px 16px; border: 1px solid #a3403a; background: rgba(226,87,76,.12); border-radius: 8px; color: #f0d3d0; }
.ins-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ins-tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.ins-tile .l { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.ins-tile .v { font-size: 26px; font-weight: 700; line-height: 1.2; margin: 3px 0 2px; font-variant-numeric: tabular-nums; }
.ins-tile .s { color: var(--muted); font-size: 12px; }
.ins-tile.o .l .ins-ic { color: var(--o); } .ins-tile.flame .l .ins-ic { color: #f0884a; }
.ins-tile.trophy .l .ins-ic { color: var(--play); } .ins-tile.watch .l .ins-ic { color: var(--watch); }
.ins-tile .s .warn { color: var(--play); }
.ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ins-card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; margin-bottom: 14px; }
.ins-grid .ins-card { margin-bottom: 0; }
.ins-ch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.ins-ch b { font-size: 15px; }
.ins-ch .r { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
.ins-note { color: var(--muted); font-size: 12px; margin-top: 8px; line-height: 1.5; }
.ins-chip { background: none; border: 1px solid #44525f; color: #c6ced6; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.ins-chip:hover { color: #fff; }
.ins-chip.on { background: rgba(79,163,255,.16); border-color: rgba(79,163,255,.6); color: #fff; }
.ins-nav { background: none; border: 1px solid #44525f; color: #c6ced6; border-radius: 6px; width: 26px; height: 24px; cursor: pointer; line-height: 1; }
.ins-nav:disabled { opacity: .35; cursor: default; }
.ins-bars { display: flex; align-items: flex-end; gap: 3px; height: 150px; padding-top: 16px; }
.ins-bar { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; cursor: default; position: relative; }
.ins-bar i { display: block; width: 100%; border-radius: 3px 3px 0 0; background: var(--o); min-height: 2px; transition: filter .12s; }
.ins-bar.zero i { background: var(--line); }
.ins-bar.click { cursor: pointer; }
.ins-bar.click:hover i { filter: brightness(1.25); }
.ins-bar em { position: absolute; top: -2px; font-style: normal; font-size: 10px; color: var(--muted); transform: translateY(-100%); }
.ins-xl { display: flex; gap: 3px; margin-top: 4px; }
.ins-xl span { flex: 1; min-width: 0; text-align: center; font-size: 10px; color: var(--dim); overflow: visible; white-space: nowrap; }
/* Windows has no flag emoji (they show as two letters), so countries get a code badge everywhere */
.ins-cc { display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 22px; padding: 0 5px;
  border-radius: 4px; border: 1px solid #44525f; background: #2e3944; color: #cfe3f7; font-size: 11px; font-weight: 700; letter-spacing: .05em; }
.ins-cal { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 1fr); gap: 3px; }
.ins-cal i { display: block; aspect-ratio: 1; border-radius: 2px; background: var(--h0); cursor: pointer; }
.ins-cal i.f { background: transparent; cursor: default; }
.ins-cal i.today { outline: 1px solid #fff; outline-offset: -1px; }
.ins-cal i:hover:not(.f) { outline: 1px solid var(--h4); outline-offset: -1px; }
.ins-calm { display: grid; grid-auto-flow: column; gap: 3px; font-size: 10px; color: var(--dim); margin-bottom: 4px; }
.ins-legend { display: flex; align-items: center; justify-content: flex-end; gap: 3px; font-size: 11px; color: var(--muted); margin-top: 8px; }
.ins-legend i { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
.ins-hm { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)); gap: 2px; align-items: center; font-size: 10px; color: var(--dim); }
.ins-hm i { display: block; height: 14px; border-radius: 2px; background: var(--h0); }
.ins-r { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; column-gap: 12px; align-items: center; min-height: 40px;
  padding: 0 8px; margin: 0 -8px; border-radius: 6px; }
.ins-r.click { cursor: pointer; }
.ins-r.click:hover { background: #2b353f; }
.ins-r .m { display: flex; align-items: center; justify-content: center; }
.ins-r .t { min-width: 0; }
.ins-r .t .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-r .t .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-r .v { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
.ins-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: #3a4754; display: flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 700; color: #cfe3f7; overflow: hidden; }
.ins-th { width: 40px; height: 24px; border-radius: 4px; object-fit: cover; background: #3a4754; display: block; }
.ins-sq { width: 32px; height: 32px; border-radius: 6px; background: #2e3944; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 18px; }
.ins-meter { height: 6px; border-radius: 3px; background: var(--line); margin-top: 4px; overflow: hidden; }
.ins-meter i { display: block; height: 100%; border-radius: 3px; background: var(--o); }
.ins-meter.perf i { background: var(--perf); } .ins-meter.watch i { background: var(--watch); }
.ins-split { position: relative; height: 8px; border-radius: 4px; background: var(--line); margin-top: 5px; }
.ins-split .lib { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: #56636f; }
.ins-split .me { position: absolute; left: 0; top: 2px; height: 4px; border-radius: 2px; }
.ins-lift { display: inline-block; min-width: 52px; text-align: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
.ins-lift.up { background: rgba(62,207,142,.16); color: #6ee7b0; }
.ins-lift.down { background: rgba(232,128,107,.16); color: #f2a593; }
.ins-lift.even { background: rgba(139,151,163,.14); color: #c6ced6; }
.ins-pulls { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.ins-pull { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; }
.ins-pull:hover { border-color: #56636f; }
.ins-pull .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.ins-pull .n { font-size: 15px; font-weight: 600; margin: 3px 0; }
.ins-pull .d { color: var(--muted); font-size: 12px; }
.ins-dims { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; align-items: center; }
.ins-dims .g { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin: 0 2px 0 6px; }
.ins-day { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 0; position: relative; height: 34px; margin: 4px 0 10px; }
.ins-day .axis { position: absolute; left: 0; right: 0; top: 15px; height: 4px; border-radius: 2px; background: var(--line); }
.ins-day .dot { position: absolute; top: 10px; width: 14px; height: 14px; margin-left: -7px; border-radius: 50%; border: 2px solid var(--card); cursor: pointer; }
.ins-day .dot.o { background: var(--o); } .ins-day .dot.p { background: #6e7b88; width: 10px; height: 10px; top: 12px; margin-left: -5px; }
.ins-hours { display: flex; justify-content: space-between; font-size: 10px; color: var(--dim); }
.ins-stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 6px 0 4px; }
.ins-stats span { color: var(--muted); font-size: 12px; } .ins-stats b { display: block; color: var(--text); font-size: 18px; }
.ins-banner { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px;
  background: rgba(62,207,142,.1); border: 1px solid rgba(62,207,142,.4); }
.ins-banner button { margin-left: auto; background: var(--watch); color: #0d2a1c; border: 0; border-radius: 6px; padding: 5px 12px; font-weight: 700; cursor: pointer; }
.ins-empty { color: var(--muted); padding: 10px 0; }
/* rows keep their -8px hover bleed inside a scroll box */
.ins-scroll { max-height: 420px; overflow-y: auto; overflow-x: hidden; padding: 0 8px; margin: 0 -8px;
  scrollbar-width: thin; scrollbar-color: #44525f transparent; }
.ins-scroll::-webkit-scrollbar { width: 8px; } .ins-scroll::-webkit-scrollbar-thumb { background: #44525f; border-radius: 4px; }
#ins-tip { position: fixed; z-index: 2000; pointer-events: none; background: #11161b; border: 1px solid #44525f; color: #e6e9ec;
  border-radius: 6px; padding: 6px 9px; font-size: 12px; line-height: 1.45; max-width: 300px; box-shadow: 0 6px 20px rgba(0,0,0,.5);
  display: none; white-space: pre-line; }
`;
    document.head.appendChild(s);
  }

  // One tooltip for everything: any element with data-tip.
  function wireTips(root) {
    let tip = document.getElementById("ins-tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "ins-tip"; document.body.appendChild(tip); }
    const place = (ev) => {
      const w = tip.offsetWidth, h = tip.offsetHeight;
      let x = ev.clientX + 14, y = ev.clientY + 14;
      if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
      if (y + h > innerHeight - 8) y = ev.clientY - h - 14;
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    root.addEventListener("mouseover", (ev) => {
      const el = ev.target.closest && ev.target.closest("[data-tip]");
      if (!el || !root.contains(el)) { tip.style.display = "none"; return; }
      tip.textContent = el.dataset.tip;
      tip.style.display = "block";
      place(ev);
    });
    root.addEventListener("mousemove", (ev) => { if (tip.style.display === "block") place(ev); });
    root.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  const heat = (v, max) => (v <= 0 ? "var(--h0)" : v / max < 0.25 ? "var(--h1)" : v / max < 0.5 ? "var(--h2)" : v / max < 0.8 ? "var(--h3)" : "var(--h4)");
  const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const avatar = (p) => (p && p.image ? `<img class="ins-av" src="${esc(p.image)}" alt="">` : `<span class="ins-av">${esc(initials(p && p.name))}</span>`);
  const thumb = (s) => (s.shot ? `<img class="ins-th" src="${esc(s.shot)}" alt="" loading="lazy">` : `<span class="ins-th"></span>`);
  const fmtDate = (ms, o = { month: "short", day: "numeric", year: "numeric" }) => new Date(ms).toLocaleDateString(undefined, o);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  function regionName(code) {
    try { return /^[A-Z]{2}$/.test(code) ? new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code : code; }
    catch (_) { return code; }
  }

  // A bar chart: bars [{label, value, key, tip, click}], colour.
  function barChart(bars, color, fmt = (v) => String(v), labelEvery = 1) {
    const max = Math.max(1, ...bars.map((b) => b.value));
    const cols = bars.map((b, i) => {
      const h = b.value ? Math.max(3, Math.round((b.value / max) * 100)) : 2;
      return `<div class="ins-bar${b.value ? "" : " zero"}${b.click ? " click" : ""}" data-i="${i}" data-tip="${esc(b.tip || `${b.label}: ${fmt(b.value)}`)}">` +
        (b.value && bars.length <= 31 ? `<em>${esc(fmt(b.value))}</em>` : "") +
        `<i style="height:${h}%;${b.value ? `background:${color}` : ""}"></i></div>`;
    }).join("");
    const labels = bars.map((b, i) => `<span>${i % labelEvery === 0 ? esc(b.label) : ""}</span>`).join("");
    return `<div class="ins-bars">${cols}</div><div class="ins-xl">${labels}</div>`;
  }
  function wireBars(el, bars) {
    el.querySelectorAll(".ins-bar.click").forEach((b) => b.addEventListener("click", () => bars[+b.dataset.i].click()));
  }

  // ═══ App ═══════════════════════════════════════════════════════════════════

  const PREF_KEY = "insightsPrefs";
  const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (_) { return {}; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {} };

  const app = {
    root: null, data: null, model: null, watch: {}, config: {}, loading: false, error: "", progress: "",
    ostats: null, tab: prefs().tab || "overview",
    act: { metric: "o", kind: "month", offset: 0, day: null, top: "byO" },
    ppl: { mode: "byO", dim: prefs().dim || "country", metric: "o", sort: "pull", small: false, gender: prefs().gender || "FEMALE" },
    lib: { timeline: "released", year: null },
  };

  function buildModel(data, watch) {
    const now = Date.now();
    const scenes = data.scenes;
    const perfById = new Map(data.performers.map((p) => [p.id, p]));
    const { events, undated } = collectOs(scenes);
    const byDay = countByDay(events);
    const tagIds = new Map(), ptagIds = new Map();
    for (const s of scenes) for (const [id, name] of s.tags) tagIds.set(name, id);
    for (const p of data.performers) for (const [id, name] of p.tags) ptagIds.set(name, id);
    return {
      now, scenes, perfById, events, undated, byDay, tagIds, ptagIds,
      st: streaks(byDay, now), record: recordDay(byDay), cal: calendar(byDay, now), wh: weekdayHour(events),
      people: performerTable(scenes, perfById, now), top: topScenes(scenes, now), lib: library(scenes),
      ratings: ratingBands(scenes), backlog: backlog(scenes, now), traits: new Map(),
      watchByDay: new Map(Object.entries(watch || {}).map(([k, v]) => [k, v])), watch: watch || {},
    };
  }

  const ALL_DIMS = PERFORMER_TRAITS.concat(SCENE_TRAITS);
  function traits(dimId) {
    const m = app.model;
    if (!m.traits.has(dimId)) m.traits.set(dimId, traitRows(m.scenes, m.perfById, ALL_DIMS.find((d) => d.id === dimId)));
    return m.traits.get(dimId);
  }

  // Where a trait row leads: a filtered performer or scene list, or nowhere.
  function traitLink(dimId, value) {
    const m = app.model;
    const P = (c) => listUrl("/performers", [c], "scenes_count");
    const S = (c) => listUrl("/scenes", [c], "o_counter");
    const range = (txt) => { const n = (txt.match(/\d+/g) || []).map(Number); return n; };
    switch (dimId) {
      case "country": return P({ type: "country", modifier: "EQUALS", value });
      case "ethnicity": return P({ type: "ethnicity", modifier: "EQUALS", value });
      case "hair": return P({ type: "hair_color", modifier: "EQUALS", value });
      case "eyes": return P({ type: "eye_color", modifier: "EQUALS", value });
      case "tattoos": return P({ type: "tattoos", modifier: value === "tattoos" ? "NOT_NULL" : "IS_NULL" });
      case "piercings": return P({ type: "piercings", modifier: value === "piercings" ? "NOT_NULL" : "IS_NULL" });
      case "favourite": return P({ type: "filter_favorites", value: value === "favourites" ? "true" : "false" });
      case "height": { const n = range(value); return P(n.length === 2 ? { type: "height_cm", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                      : /under/.test(value) ? { type: "height_cm", modifier: "LESS_THAN", value: { value: n[0] } }
                                                      : { type: "height_cm", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }); }
      case "ptags": { const id = m.ptagIds.get(value); return id ? P({ type: "tags", modifier: "INCLUDES", value: { items: [{ id, label: value }], excluded: [], depth: 0 } }) : null; }
      case "age": { const n = range(value); return S(n.length === 2 ? { type: "performer_age", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                   : { type: "performer_age", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }); }
      case "tags": { const id = m.tagIds.get(value); return id ? S({ type: "tags", modifier: "INCLUDES", value: { items: [{ id, label: value }], excluded: [], depth: 0 } }) : null; }
      case "studio": { const st = m.scenes.find((s) => s.studio && s.studio.name === value); return st ? S({ type: "studios", modifier: "INCLUDES", value: { items: [{ id: st.studio.id, label: value }], excluded: [], depth: 0 } }) : null; }
      case "cast": return S(value === "solo" ? { type: "performer_count", modifier: "EQUALS", value: { value: 1 } }
                          : value === "two performers" ? { type: "performer_count", modifier: "EQUALS", value: { value: 2 } }
                          : { type: "performer_count", modifier: "GREATER_THAN", value: { value: 2 } });
      case "era": { const n = range(value); return S(n.length === 2 ? { type: "date", modifier: "BETWEEN", value: { value: `${n[0]}-01-01`, value2: `${n[1]}-12-31` } }
                                                   : { type: "date", modifier: "LESS_THAN", value: { value: "2005-01-01" } }); }
      case "interactive": return S({ type: "interactive", value: value === "interactive" ? "true" : "false" });
      default: return null;
    }
  }

  function traitLabel(dimId, value) {
    return dimId === "country" ? regionName(value) : value;
  }
  const cc = (code) => `<span class="ins-cc">${esc(code || "?")}</span>`;

  // ── Render ─────────────────────────────────────────────────────────────────

  const TABS = [["overview", "Overview"], ["activity", "Activity"], ["people", "People"], ["library", "Library"], ["backlog", "Backlog"]];

  function render() {
    const root = app.root;
    if (!root) return;
    const ago = app.data ? Math.max(0, Math.round((Date.now() - app.data.at) / 60000)) : null;
    root.innerHTML = `
      <div class="ins-head"><span class="ins-title">Insights</span>
        <div class="ins-tabs">${TABS.map(([id, label]) => `<button class="ins-tab${app.tab === id ? " on" : ""}" data-tab="${id}">${label}</button>`).join("")}</div>
        <div class="ins-meta">${ago === null ? "" : `updated ${ago ? `${ago} min ago` : "just now"}`}
          <button data-act="refresh" data-tip="Read the library again">${ic("refresh", "line")} Refresh</button></div></div>
      <div class="ins-body"></div>`;
    const body = root.querySelector(".ins-body");
    if (app.error) { body.innerHTML = `<div class="ins-error">Insights could not load your library: ${esc(app.error)}. <button data-act="refresh">Try again</button></div>`; return; }
    if (!app.model) { body.innerHTML = `<div class="ins-progress">${esc(app.progress || "Getting ready…")}<div class="bar"><i></i></div></div>`; return; }
    ({ overview: renderOverview, activity: renderActivity, people: renderPeople, library: renderLibrary, backlog: renderBacklog }[app.tab] || renderOverview)(body);
  }

  function tile(cls, icon, label, value, sub) {
    return `<div class="ins-tile ${cls}"><div class="l">${ic(icon, icon === "trophy" || icon === "clock" ? "line" : "")}${esc(label)}</div>` +
      `<div class="v">${value}</div><div class="s">${sub}</div></div>`;
  }

  function importBanner() {
    if (!app.ostats || app.config.ostatsImported === "true") return "";
    return `<div class="ins-banner">${ic("clock", "line")}<span>Found <b>${app.ostats.days}</b> days of watch time from the O Stats plugin.
      Bring them in so your watch history starts where it left off.</span><button data-act="import">Import</button></div>`;
  }

  function weeklyBars(m, weeks) {
    const out = [];
    const ws = weekStart(m.now);
    for (let i = weeks - 1; i >= 0; i--) {
      const from = addDays(ws, -i * 7);
      let v = 0;
      for (let d = 0; d < 7; d++) v += m.byDay.get(dayKey(addDays(from, d))) || 0;
      out.push({ value: v, label: fmtDate(from, { month: "short", day: "numeric" }), offset: -i,
                 tip: `Week of ${fmtDate(from, { month: "short", day: "numeric" })}: ${v} O${v === 1 ? "" : "'s"}` });
    }
    return out;
  }

  function calendarHtml(m) {
    const cal = m.cal, today = dayKey(m.now);
    const weeks = cal.cells.length / 7;
    let months = "";
    for (let w = 0; w < weeks; w++) {
      const d = new Date(cal.cells[w * 7].from);
      const first = w === 0 || new Date(cal.cells[(w - 1) * 7].from).getMonth() !== d.getMonth();
      months += `<span>${first ? esc(d.toLocaleDateString(undefined, { month: "short" })) : ""}</span>`;
    }
    const cells = cal.cells.map((c) => c.future ? `<i class="f"></i>`
      : `<i class="${c.key === today ? "today" : ""}" style="background:${heat(c.value, cal.max)}" data-day="${c.key}" data-tip="${esc(fmtDate(c.from, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}: ${c.value} O${c.value === 1 ? "" : "'s"}"></i>`).join("");
    const total = cal.cells.reduce((a, c) => a + c.value, 0);
    return `<div class="ins-calm" style="grid-template-columns:repeat(${weeks},1fr)">${months}</div>
      <div class="ins-cal" style="grid-template-columns:repeat(${weeks},1fr)">${cells}</div>
      <div class="ins-legend"><span style="margin-right:auto">${total} O's in the last year${m.undated ? ` · ${m.undated} more without a date` : ""}</span>
        less <i style="background:var(--h0)"></i><i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i> more</div>`;
  }

  function heatmapHtml(m) {
    const max = Math.max(1, ...m.wh.flat());
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let h = `<span></span>${Array.from({ length: 24 }, (_, i) => `<span style="text-align:center">${i % 3 === 0 ? (i === 0 ? "12a" : i < 12 ? `${i}a` : i === 12 ? "12p" : `${i - 12}p`) : ""}</span>`).join("")}`;
    m.wh.forEach((row, d) => {
      h += `<span>${days[d]}</span>` + row.map((v, hr) => `<i style="background:${heat(v, max)}" data-tip="${days[d]} ${hr}:00–${hr + 1}:00: ${v} O${v === 1 ? "" : "'s"}"></i>`).join("");
    });
    return `<div class="ins-hm">${h}</div>`;
  }

  function perfRow(r, value, sub, max, cls = "") {
    const p = r.p || { name: `Performer ${r.id}` };
    return `<div class="ins-r click" data-go="/performers/${esc(r.id)}" data-tip="${esc(p.name)}: ${r.o} O's in ${r.scenes} scene${r.scenes === 1 ? "" : "s"}, played ${r.plays}×, watched ${fmtDur(r.watch)}">
      <div class="m">${avatar(p)}</div><div class="t"><div class="n">${esc(p.name)}</div><div class="sub">${sub}</div>
      <div class="ins-meter ${cls}"><i style="width:${Math.max(2, Math.round((value / max) * 100))}%"></i></div></div><div class="v">${esc(typeof value === "number" && value % 1 ? value.toFixed(2) : value)}</div></div>`;
  }

  function renderOverview(el) {
    const m = app.model, st = m.st;
    const today = m.byDay.get(dayKey(m.now)) || 0;
    const wk = (off) => { let v = 0; const ws = addDays(weekStart(m.now), off * 7); for (let i = 0; i < 7; i++) v += m.byDay.get(dayKey(addDays(ws, i))) || 0; return v; };
    const wpo = watchPerO(m.watch, m.byDay, m.now);
    const trackedToday = m.watch[dayKey(m.now)] || 0;
    const top = m.people.byO.slice(0, 5);
    const bars = weeklyBars(m, 26);
    el.innerHTML = importBanner() + `
      <div class="ins-tiles">
        ${tile("o", "drop", "Today", today, `this week ${wk(0)} · last week ${wk(-1)}`)}
        ${tile("flame", "flame", "Streak", `${st.current} day${st.current === 1 ? "" : "s"}`,
               st.atRisk ? `<span class="warn">an O today keeps it going</span>` : st.best.len ? `best ${st.best.len} · ${fmtDate(st.best.from, { month: "short", day: "numeric" })} to ${fmtDate(st.best.to, { month: "short", day: "numeric", year: "numeric" })}` : "no O's with a date yet")}
        ${tile("trophy", "trophy", "Record day", m.record ? m.record.n : "–", m.record ? fmtDate(parseDay(m.record.day)) : "")}
        ${tile("watch", "clock", "Watch time per O", wpo ? fmtDur(wpo) : "–", wpo ? "last 30 days" : trackedToday ? `${fmtDur(trackedToday)} watched today, counting` : "counting from your next scene")}
      </div>
      <div class="ins-card"><div class="ins-ch"><b>Your year</b><span class="r">click a day to see it</span></div>${calendarHtml(m)}</div>
      <div class="ins-grid">
        <div class="ins-card"><div class="ins-ch"><b>O's per week</b><span class="r">last 26 weeks</span></div><div data-k="weeks"></div></div>
        <div class="ins-card"><div class="ins-ch"><b>When</b><span class="r">weekday and hour</span></div>${heatmapHtml(m)}</div>
      </div>
      <div class="ins-grid">
        <div class="ins-card"><div class="ins-ch"><b>Top performers</b><span class="r"><button class="ins-chip" data-tab="people">all →</button></span></div>
          ${top.length ? top.map((r) => perfRow(r, r.o, `${r.scenes} scene${r.scenes === 1 ? "" : "s"}`, top[0].o)).join("") : `<div class="ins-empty">No O's yet.</div>`}</div>
        <div class="ins-card"><div class="ins-ch"><b>Backlog</b><span class="r"><button class="ins-chip" data-tab="backlog">all →</button></span></div>
          ${m.backlog.slice(0, 4).map(backlogRow).join("")}</div>
      </div>`;
    const wEl = el.querySelector('[data-k="weeks"]');
    const wb = bars.map((b) => ({ ...b, click: () => { app.tab = "activity"; app.act.kind = "week"; app.act.offset = b.offset; render(); } }));
    wEl.innerHTML = barChart(wb, "var(--o)", String, 4);
    wireBars(wEl, wb);
  }

  function renderActivity(el) {
    const m = app.model, a = app.act, st = m.st;
    const source = a.metric === "watch" ? m.watchByDay : m.byDay;
    const per = periodBars(source, a.kind, a.offset, m.now);
    const fmt = a.metric === "watch" ? fmtDur : String;
    const color = a.metric === "watch" ? "var(--watch)" : "var(--o)";
    const bars = per.bars.map((b, i) => ({ ...b, tip: `${a.kind === "year" ? fmtDate(b.from, { month: "long", year: "numeric" }) : fmtDate(b.from, { weekday: "short", month: "short", day: "numeric" })}: ${fmt(b.value)}`,
      click: a.kind === "year" ? () => { a.kind = "month"; a.offset = (new Date(b.from).getFullYear() - new Date(m.now).getFullYear()) * 12 + new Date(b.from).getMonth() - new Date(m.now).getMonth(); render(); }
                               : () => { a.day = b.key; render(); document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" }); } }));
    const total = per.bars.reduce((x, b) => x + b.value, 0);
    const chip = (path, v, label) => `<button class="ins-chip${app.act[path] === v ? " on" : ""}" data-set="act.${path}=${v}">${label}</button>`;
    const day = a.day || dayKey(m.now);
    const ev = dayEvents(m.scenes, day);
    const dayO = ev.filter((e) => e.o).length, dayScenes = new Set(ev.map((e) => e.scene.id)).size;
    const isToday = day === dayKey(m.now);
    const tops = { byO: m.top.byO, byPlays: m.top.byPlays, unvisited: m.top.unvisited }[a.top] || [];
    el.innerHTML = importBanner() + `
      <div class="ins-card"><div class="ins-ch"><b>${a.metric === "watch" ? "Watch time" : "O's"}</b>
        <span class="r">${chip("metric", "o", "O's")}${chip("metric", "watch", "Watch time")} &nbsp; ${chip("kind", "week", "Week")}${chip("kind", "month", "Month")}${chip("kind", "year", "Year")}
        &nbsp;<button class="ins-nav" data-nav="-1" aria-label="Earlier">‹</button> <b style="min-width:150px;text-align:center;color:var(--text)">${esc(per.title)}</b>
        <button class="ins-nav" data-nav="1" aria-label="Later" ${a.offset >= 0 ? "disabled" : ""}>›</button></span></div>
        <div data-k="chart"></div>
        <div class="ins-note">${a.metric === "watch" ? `${fmtDur(total)} watched in this ${a.kind}. Watch time counts while a scene's player plays${Object.keys(m.watch).length ? "" : "; nothing is counted yet"}.`
                                                      : `${total} O${total === 1 ? "" : "'s"} in this ${a.kind}.`} ${a.kind === "year" ? "Click a month to open it." : "Click a day to see it below."}</div></div>
      <div class="ins-grid">
        <div class="ins-card"><div class="ins-ch"><b>Streaks and gaps</b></div>
          ${statRow("flame", "Current streak", `${st.current} day${st.current === 1 ? "" : "s"}`, st.atRisk ? "an O today keeps it going" : st.current ? "going" : st.daysSinceLast !== null ? `${st.daysSinceLast} days since the last O` : "")}
          ${statRow("trophy", "Best streak", `${st.best.len} day${st.best.len === 1 ? "" : "s"}`, st.best.len ? `${fmtDate(st.best.from)} to ${fmtDate(st.best.to)}` : "")}
          ${statRow("calendar", "Longest break", `${st.longestBreak} day${st.longestBreak === 1 ? "" : "s"}`, "between two days with an O")}
          ${statRow("clock", "Usually", st.avgGapDays ? `every ${st.avgGapDays.toFixed(1)} days` : "–", "average from one O day to the next")}
          ${statRow("drop", "Record day", m.record ? m.record.n : "–", m.record ? fmtDate(parseDay(m.record.day)) : "")}</div>
        <div class="ins-card" id="ins-otd"><div class="ins-ch"><b>${isToday ? "Today" : esc(fmtDate(parseDay(day), { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}</b>
          <span class="r"><button class="ins-nav" data-daynav="-1" aria-label="Day before">‹</button><button class="ins-nav" data-daynav="1" aria-label="Day after" ${isToday ? "disabled" : ""}>›</button></span></div>
          <div class="ins-stats"><span><b style="color:var(--o)">${dayO}</b>O's</span><span><b style="color:var(--watch)">${fmtDur(m.watch[day] || 0)}</b>watched</span><span><b>${dayScenes}</b>scenes</span></div>
          <div class="ins-day"><span></span><div style="position:relative"><div class="axis"></div>${ev.map((e) => {
            const d = new Date(e.t), x = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
            return `<span class="dot ${e.o ? "o" : "p"}" style="left:${x.toFixed(2)}%" data-go="/scenes/${esc(e.scene.id)}" data-tip="${esc(fmtTime(e.t))} · ${esc(e.scene.title)}${e.o ? " · O" : " · played"}"></span>`; }).join("")}</div></div>
          <div class="ins-hours" style="margin-left:34px"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
          <div style="margin-top:8px">${ev.length ? ev.slice(0, 12).map((e) => `<div class="ins-r click" data-go="/scenes/${esc(e.scene.id)}"><div class="m">${thumb(e.scene)}</div>
            <div class="t"><div class="n">${esc(e.scene.title)}</div><div class="sub">${esc(fmtTime(e.t))}${e.o ? "" : " · played"}</div></div>
            <div class="v">${e.o ? `<span style="color:var(--o)">${ic("drop")}</span>` : ""}</div></div>`).join("") : `<div class="ins-empty">Nothing recorded on this day.</div>`}</div></div>
      </div>
      <div class="ins-card"><div class="ins-ch"><b>Top scenes</b><span class="r">${chip("top", "byO", "Most O's")}${chip("top", "byPlays", "Most played")}${chip("top", "unvisited", "Not revisited in 3 months")}</span></div>
        ${tops.length ? tops.map((s) => `<div class="ins-r click" data-go="/scenes/${esc(s.id)}"><div class="m">${thumb(s)}</div>
          <div class="t"><div class="n">${esc(s.title)}</div><div class="sub">${s.o} O${s.o === 1 ? "" : "'s"} · played ${s.plays}×${s.lastO ? ` · last O ${fmtDate(s.lastO)}` : ""}</div></div>
          <div class="v">${a.top === "byPlays" ? `${s.plays}×` : s.o}</div></div>`).join("") : `<div class="ins-empty">Nothing here yet.</div>`}</div>`;
    const cEl = el.querySelector('[data-k="chart"]');
    cEl.innerHTML = barChart(bars, color, fmt, a.kind === "month" ? 2 : 1);
    wireBars(cEl, bars);
  }

  function statRow(icon, label, value, sub) {
    return `<div class="ins-r"><div class="m"><span class="ins-sq">${ic(icon, icon === "trophy" || icon === "clock" || icon === "calendar" ? "line" : "")}</span></div>
      <div class="t"><div class="n">${esc(label)}</div><div class="sub">${esc(sub || "")}</div></div><div class="v">${esc(value)}</div></div>`;
  }

  function strongestPulls() {
    const out = [];
    for (const d of PERFORMER_TRAITS.concat(SCENE_TRAITS.filter((x) => x.id === "tags" || x.id === "studio"))) {
      for (const r of traits(d.id).rows) {
        if (r.small || r.lift < 1.25 || r.scenes < 8) continue;
        out.push({ d, r, score: (r.lift - 1) * Math.sqrt(r.scenes) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 6);
  }

  function renderPeople(el) {
    const m = app.model, p = app.ppl;
    const chip = (path, v, label) => `<button class="ins-chip${p[path] === v ? " on" : ""}" data-set="ppl.${path}=${v}">${label}</button>`;
    const list = { byO: m.people.byO, byRate: m.people.byRate, byWatch: m.people.byWatch, neglected: m.people.neglected }[p.mode].slice(0, 12);
    const max = list.length ? (p.mode === "byRate" ? list[0].perScene : p.mode === "byWatch" ? list[0].watch : Math.max(1, list[0].o)) : 1;
    const pulls = strongestPulls();
    const dim = ALL_DIMS.find((d) => d.id === p.dim) || ALL_DIMS[0];
    const T = traits(dim.id);
    const metricShare = (r) => (p.metric === "watch" ? r.watchShare : r.oShare);
    const metricLift = (r) => (r.libShare ? metricShare(r) / r.libShare : 0);
    let rows = T.rows.filter((r) => p.small || !r.small);
    rows.sort(p.sort === "size" ? (a, b) => b.scenes - a.scenes : (a, b) => metricLift(b) - metricLift(a) || b.scenes - a.scenes);
    const hiddenSmall = T.rows.filter((r) => r.small).length;
    const dimChips = (list) => list.map((d) => `<button class="ins-chip${p.dim === d.id ? " on" : ""}" data-set="ppl.dim=${d.id}">${esc(d.label)}</button>`).join("");
    const color = p.metric === "watch" ? "var(--watch)" : "var(--o)";

    // countries: performers with scenes, by the gender filter
    const genders = { FEMALE: ["FEMALE"], MALE: ["MALE"], TRANS: ["TRANSGENDER_FEMALE", "TRANSGENDER_MALE", "INTERSEX", "NON_BINARY"], ALL: null };
    const allow = genders[p.gender];
    const countries = new Map();
    const perfO = new Map(m.people.byO.map((r) => [r.id, r.o]));
    for (const pf of m.perfById.values()) {
      if (!pf.sceneCount || (allow && !allow.includes(pf.gender))) continue;
      const c = pf.country ? String(pf.country).trim().toUpperCase() : "";
      const r = countries.get(c) || { code: c, n: 0, o: 0 };
      r.n += 1; r.o += perfO.get(pf.id) || 0;
      countries.set(c, r);
    }
    const cRows = [...countries.values()].filter((r) => r.code).sort((a, b) => b.n - a.n);
    const unknown = countries.get("")?.n || 0;
    const cMax = Math.max(1, ...cRows.map((r) => r.n));

    // age in the scene, one bar per year 18 to 50
    const ages = new Map();
    for (const s of m.scenes) for (const pid of s.perf) {
      const a = ageAt(m.perfById.get(pid)?.birth, s.date);
      if (a === null || a < 18 || a > 50) continue;
      const r = ages.get(a) || { n: 0, o: 0 }; r.n += 1; r.o += s.o || 0; ages.set(a, r);
    }
    const ageBars = [];
    for (let a = 18; a <= 50; a++) {
      const r = ages.get(a) || { n: 0, o: 0 };
      ageBars.push({ value: r.n, label: a % 4 === 2 ? String(a) : "", tip: `Age ${a}: ${r.n} scene appearances, ${r.o} O's${r.n ? ` (${(r.o / r.n).toFixed(2)} per scene)` : ""}`,
                     click: r.n ? () => navigate(listUrl("/scenes", [{ type: "performer_age", modifier: "EQUALS", value: { value: a } }], "o_counter")) : null });
    }

    el.innerHTML = `
      ${pulls.length ? `<div class="ins-card"><div class="ins-ch"><b>Your strongest pulls</b><span class="r">what gets you there more often than its share of the library</span></div>
        <div class="ins-pulls">${pulls.map(({ d, r }) => `<div class="ins-pull" data-set="ppl.dim=${d.id}" data-tip="${esc(`${r.scenes} scenes (${pct(r.libShare)} of the library)\n${r.o} O's (${pct(r.oShare)} of yours)\nwatched ${pct(r.watchShare)} of your time`)}">
          <div class="k">${esc(d.label)}</div><div class="n">${esc(traitLabel(d.id, r.value))}</div>
          <div class="d"><span class="ins-lift up">${r.lift.toFixed(1)}×</span> &nbsp;${pct(r.oShare)} of O's from ${pct(r.libShare)} of scenes</div></div>`).join("")}</div></div>` : ""}
      <div class="ins-card" id="ins-works"><div class="ins-ch"><b>What works for you</b>
        <span class="r">${chip("metric", "o", "O's")}${chip("metric", "watch", "Watched")} &nbsp; ${chip("sort", "pull", "Strongest")}${chip("sort", "size", "Biggest")}</span></div>
        <div class="ins-dims"><span class="g">Performers</span>${dimChips(PERFORMER_TRAITS)}</div>
        <div class="ins-dims"><span class="g">Scenes</span>${dimChips(SCENE_TRAITS)}</div>
        ${rows.length ? rows.slice(0, 40).map((r) => {
          const lift = metricLift(r), tone = liftTone(lift), link = traitLink(dim.id, r.value);
          return `<div class="ins-r${link ? " click" : ""}" ${link ? `data-go="${esc(link)}"` : ""}
            data-tip="${esc(`${traitLabel(dim.id, r.value)}\n${r.scenes} scenes · ${pct(r.libShare)} of the library\n${r.o} O's · ${pct(r.oShare)} of yours\nplayed ${r.plays}× · watched ${fmtDur(r.watch)} (${pct(r.watchShare)})`)}">
            <div class="m">${dim.id === "country" ? cc(r.value) : `<span class="ins-sq" style="color:${tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--even)"};font-size:14px">●</span>`}</div>
            <div class="t"><div class="n">${esc(dim.id === "country" ? regionName(r.value) : r.value)}</div>
              <div class="ins-split" ><span class="lib" style="width:${Math.min(100, r.libShare * 100 * 2.5).toFixed(1)}%"></span><span class="me" style="width:${Math.min(100, metricShare(r) * 100 * 2.5).toFixed(1)}%;background:${color}"></span></div>
              <div class="sub">${pct(metricShare(r))} of your ${p.metric === "watch" ? "watching" : "O's"} · ${pct(r.libShare)} of scenes · ${r.scenes} scenes</div></div>
            <div class="v"><span class="ins-lift ${tone}">${lift.toFixed(1)}×</span></div></div>`; }).join("")
          : `<div class="ins-empty">Nothing to compare yet for ${esc(dim.label.toLowerCase())}${hiddenSmall ? "; the groups are all small" : ""}.</div>`}
        <div class="ins-note"><span class="ins-lift up">1.3×</span> and up: more than its share of the library. <span class="ins-lift down">0.8×</span> and down: less.
          Grey bar: share of scenes; ${p.metric === "watch" ? "green: share of your watching" : "blue: share of your O's"}.
          ${hiddenSmall ? `<button class="ins-chip" data-set="ppl.small=${p.small ? "false" : "true"}">${p.small ? "hide" : "show"} ${hiddenSmall} small group${hiddenSmall === 1 ? "" : "s"}</button>` : ""}</div></div>
      <div class="ins-card"><div class="ins-ch"><b>Performers</b><span class="r">${chip("mode", "byO", "O's")}${chip("mode", "byRate", "O's per scene")}${chip("mode", "byWatch", "Watched")}${chip("mode", "neglected", "Favourites to revisit")}</span></div>
        ${list.length ? list.map((r) => p.mode === "byRate" ? perfRow(r, r.perScene, `${r.o} O's in ${r.scenes} scenes`, max, "perf")
          : p.mode === "byWatch" ? perfRow({ ...r }, Math.round(r.watch / 60), `${fmtDur(r.watch)} watched · ${r.o} O's`, Math.round(max / 60), "watch")
          : p.mode === "neglected" ? perfRow(r, r.o, r.lastO ? `last O ${fmtDate(r.lastO)}` : "no O yet", Math.max(1, ...list.map((x) => x.o)))
          : perfRow(r, r.o, `${r.scenes} scene${r.scenes === 1 ? "" : "s"} · played ${r.plays}×`, max)).join("")
          : `<div class="ins-empty">${p.mode === "neglected" ? "Every favourite has had an O in the last six months." : "Nothing here yet."}</div>`}
        ${p.mode === "byWatch" ? `<div class="ins-note">Minutes watched, from Stash's play time per scene.</div>` : ""}</div>
      <div class="ins-grid">
        <div class="ins-card"><div class="ins-ch"><b>Countries</b><span class="r">${["FEMALE", "MALE", "TRANS", "ALL"].map((g) => `<button class="ins-chip${p.gender === g ? " on" : ""}" data-set="ppl.gender=${g}">${{ FEMALE: "Women", MALE: "Men", TRANS: "Trans and more", ALL: "Everyone" }[g]}</button>`).join("")}</span></div>
          <div class="ins-scroll">${cRows.slice(0, 60).map((r) => `<div class="ins-r click" data-go="${esc(listUrl("/performers", [{ type: "country", modifier: "EQUALS", value: r.code }], "scenes_count"))}" data-tip="${esc(regionName(r.code))}: ${r.n} performers with scenes, ${r.o} O's from their scenes">
            <div class="m">${cc(r.code)}</div><div class="t"><div class="n">${esc(regionName(r.code))}</div>
            <div class="ins-meter perf"><i style="width:${Math.max(3, Math.round((Math.log(r.n + 1) / Math.log(cMax + 1)) * 100))}%"></i></div></div><div class="v">${r.n}</div></div>`).join("") || `<div class="ins-empty">No countries set.</div>`}</div>
          <div class="ins-note">${cRows.length} countries · ${unknown} performer${unknown === 1 ? "" : "s"} without one. Performers with at least one scene.</div></div>
        <div class="ins-card"><div class="ins-ch"><b>Age in the scene</b><span class="r">age on the scene's date</span></div><div data-k="ages"></div>
          <div class="ins-note">Each performer in each scene counts once. Click an age to list those scenes.</div></div>
      </div>`;
    const aEl = el.querySelector('[data-k="ages"]');
    aEl.innerHTML = barChart(ageBars, "var(--perf)");
    wireBars(aEl, ageBars);
  }

  function backlogRow(b) {
    const icons = { "eye-off": "eyeoff", star: "star", "player-pause": "pause", "drop-off": "dropoff", heart: "heart", folder: "folder" };
    return `<div class="ins-r click" data-go="${esc(listUrl("/scenes", b.criteria, b.sort))}">
      <div class="m"><span class="ins-sq">${ic(icons[b.icon] || "folder", "line")}</span></div>
      <div class="t"><div class="n">${esc(b.label)}</div><div class="sub">${b.oldestDays !== null && b.n ? `oldest added ${b.oldestDays > 365 ? `${(b.oldestDays / 365).toFixed(1)} years` : `${b.oldestDays} days`} ago` : ""}</div></div>
      <div class="v">${b.n.toLocaleString()}</div></div>`;
  }

  function renderBacklog(el) {
    el.innerHTML = `<div class="ins-card"><div class="ins-ch"><b>Backlog</b><span class="r">each opens the matching list in Stash</span></div>
      ${app.model.backlog.map(backlogRow).join("")}
      <div class="ins-note">Counts are from the library as it was read; Refresh to update after working through some.</div></div>`;
  }

  function renderLibrary(el) {
    const m = app.model, L = m.lib.totals, l = app.lib;
    const share = (n) => (L.scenes ? n / L.scenes : 0);
    const source = l.timeline === "added" ? m.lib.added : m.lib.released;
    let bars;
    if (l.year === null) {
      bars = source.map((y) => ({ value: y.n, label: String(y.year), tip: `${y.year}: ${y.n} scenes ${l.timeline === "added" ? "added" : "released"}`,
        click: () => { l.year = y.year; render(); } }));
    } else {
      const counts = new Array(12).fill(0);
      for (const s of m.scenes) {
        const when = l.timeline === "added" ? (s.created ? new Date(s.created) : null) : (parseDay(s.date) !== null ? new Date(parseDay(s.date)) : null);
        if (when && when.getFullYear() === l.year) counts[when.getMonth()] += 1;
      }
      bars = counts.map((n, i) => {
        const from = `${l.year}-${pad2(i + 1)}-01`, to = dayKey(new Date(l.year, i + 1, 0).getTime());
        return { value: n, label: new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "short" }), tip: `${new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${n} scenes`,
                 click: n ? () => navigate(listUrl("/scenes", [l.timeline === "added"
                   ? { type: "created_at", modifier: "BETWEEN", value: { value: `${from} 00:00`, value2: `${to} 23:59` } }
                   : { type: "date", modifier: "BETWEEN", value: { value: from, value2: to } }], "date", "asc")) : null };
      });
    }
    const chip = (v, label) => `<button class="ins-chip${l.timeline === v ? " on" : ""}" data-set="lib.timeline=${v}">${label}</button>`;
    const groupCard = (title, dimId) => {
      const rows = traits(dimId).rows.slice().sort((a, b) => b.scenes - a.scenes);
      const mx = Math.max(1, ...rows.map((r) => r.o / Math.max(1, r.scenes)));
      return `<div class="ins-card"><div class="ins-ch"><b>${esc(title)}</b><span class="r">share · O's per scene</span></div>
        ${rows.map((r) => { const link = traitLink(dimId, r.value); return `<div class="ins-r${link ? " click" : ""}" ${link ? `data-go="${esc(link)}"` : ""} data-tip="${esc(`${r.value}: ${r.scenes} scenes, ${r.o} O's, played ${r.plays}×`)}">
          <div class="m"><b style="color:var(--muted);font-size:12px">${pct(r.libShare)}</b></div><div class="t"><div class="n">${esc(r.value)}</div>
          <div class="ins-meter"><i style="width:${Math.max(2, Math.round(((r.o / Math.max(1, r.scenes)) / mx) * 100))}%"></i></div></div>
          <div class="v">${(r.o / Math.max(1, r.scenes)).toFixed(2)}</div></div>`; }).join("") || `<div class="ins-empty">No data.</div>`}</div>`;
    };
    const rmx = Math.max(0.01, ...m.ratings.map((r) => r.perScene));
    el.innerHTML = `
      <div class="ins-tiles">
        ${tile("", "play", "Scenes", L.scenes.toLocaleString(), `${pct(share(L.played))} played · ${pct(share(L.withO))} with an O`)}
        ${tile("", "folder", "Size", fmtBytes(L.size), `${fmtDur(L.secs)} of video`)}
        ${tile("", "star", "Rated", pct(share(L.rated)), `${(L.scenes - L.rated).toLocaleString()} not rated`)}
        ${tile("", "folder", "Organized", pct(share(L.organized)), `${(L.scenes - L.organized).toLocaleString()} to go`)}
      </div>
      <div class="ins-card"><div class="ins-ch"><b>${l.year === null ? "Timeline" : `${l.year}, by month`}</b>
        <span class="r">${chip("released", "Released")}${chip("added", "Added to Stash")}${l.year !== null ? ` <button class="ins-chip" data-set="lib.year=null">← all years</button>` : ""}</span></div>
        <div data-k="tl"></div><div class="ins-note">${l.year === null ? "Click a year to see its months." : "Click a month to list those scenes."}</div></div>
      <div class="ins-grid">${groupCard("Length", "length")}${groupCard("Resolution", "resolution")}</div>
      <div class="ins-grid">
        <div class="ins-card"><div class="ins-ch"><b>Rating and O's</b><span class="r">O's per scene · share played</span></div>
          ${m.ratings.map((r) => `<div class="ins-r" data-tip="${esc(`${r.label}: ${r.scenes} scenes, ${r.o} O's, ${pct(r.played)} played`)}"><div class="m"><b style="color:var(--muted);font-size:12px">${pct(r.played)}</b></div>
            <div class="t"><div class="n">${esc(r.label)}</div><div class="ins-meter"><i style="width:${Math.max(2, Math.round((r.perScene / rmx) * 100))}%"></i></div></div>
            <div class="v">${r.perScene.toFixed(2)}</div></div>`).join("")}</div>
        ${groupCard("Cast", "cast")}
      </div>`;
    const tEl = el.querySelector('[data-k="tl"]');
    tEl.innerHTML = barChart(bars, l.timeline === "added" ? "var(--watch)" : "var(--perf)", String, bars.length > 30 ? 5 : 1);
    wireBars(tEl, bars);
  }

  // ── Controls (one delegated click handler on the root) ────────────────────

  function onClick(ev) {
    const t = ev.target.closest && ev.target.closest("[data-tab],[data-set],[data-nav],[data-daynav],[data-day],[data-go],[data-act]");
    if (!t || !app.root.contains(t)) return;
    if (t.dataset.tab) { app.tab = t.dataset.tab; setPref("tab", app.tab); render(); return; }
    if (t.dataset.set) {
      const [path, raw] = t.dataset.set.split("=");
      const [grp, key] = path.split(".");
      const val = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
      app[grp][key] = val;
      if (grp === "act" && key === "kind") app.act.offset = 0;
      if (grp === "ppl" && (key === "dim" || key === "gender")) setPref(key, val);
      if (grp === "lib" && key === "timeline") app.lib.year = null;
      render();
      if (grp === "ppl" && key === "dim") document.getElementById("ins-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (t.dataset.nav) { app.act.offset = Math.min(0, app.act.offset + Number(t.dataset.nav)); render(); return; }
    if (t.dataset.daynav) {
      const d = parseDay(app.act.day || dayKey(Date.now()));
      const next = addDays(d, Number(t.dataset.daynav));
      if (next <= dayStart(Date.now())) app.act.day = dayKey(next);
      render(); document.getElementById("ins-otd")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (t.dataset.day) {
      app.tab = "activity"; app.act.day = t.dataset.day; render();
      document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (t.dataset.go) { navigate(t.dataset.go); return; }
    if (t.dataset.act === "refresh") { load(true); return; }
    if (t.dataset.act === "import") { importOStats(t); return; }
  }

  async function importOStats(btn) {
    btn.disabled = true; btn.textContent = "Importing…";
    try {
      const saved = await updateConfig((mine) => {
        const stored = parseWatch(mine.watch);
        if (stored === null) throw new Error("stored watch time could not be read");
        return { watch: JSON.stringify(mergeOStats(stored, app.ostats.data).merged), ostatsImported: "true" };
      });
      app.config = saved;
      app.watch = parseWatch(saved.watch) || {};
      app.model = buildModel(app.data, app.watch);
      render();
    } catch (e) { btn.textContent = `Failed: ${e.message}`; }
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  async function load(force) {
    if (app.loading) return;
    app.loading = true; app.error = "";
    try {
      app.config = await readConfig();
      app.watch = parseWatch(app.config.watch) || {};
      let data = force ? null : await cacheGet();
      if (!data || Date.now() - data.at > CACHE_MS) {
        app.model = null;
        app.progress = "Reading your library…";
        render();
        data = await loadLibrary((t) => { app.progress = t; const p = app.root?.querySelector(".ins-progress"); if (p) p.firstChild.textContent = t; });
        cachePut(data);
      }
      app.data = data;
      app.model = buildModel(data, app.watch);
      checkOStats();
    } catch (e) {
      log(`Load failed: ${e.message}`, "error");
      app.error = e.message;
    } finally {
      app.loading = false;
      render();
    }
  }

  async function checkOStats() {
    if (app.ostats || app.config.ostatsImported === "true") return;
    try {
      const r = await fetch(`/plugin/ostats/assets/watch_data.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      const { days } = mergeOStats({}, data);
      if (days) { app.ostats = { data, days }; render(); }
    } catch (_) {}
  }

  // ── Mounting on the Stats page ────────────────────────────────────────────
  // Below Stash's own numbers; nothing of Stash's is hidden or restyled
  // (Stats Enhancer hid a native tile by position and resized the rest).

  const onStats = () => /^\/stats\/?$/.test(location.pathname);
  function mount() {
    if (!onStats()) return;
    if (app.root && app.root.isConnected) return;
    const native = document.querySelector(".stats");
    if (!native) return;
    injectStyles();
    if (!app.root) {
      app.root = document.createElement("div");
      app.root.id = "insights";
      app.root.addEventListener("click", onClick);
      wireTips(app.root);
    }
    native.insertAdjacentElement("afterend", app.root);
    if (app.model || app.loading) render(); else load(false);
  }

  // ═══ Start ═════════════════════════════════════════════════════════════════
  // One 1 s timer does everything that runs off the Stats page: the
  // watch-time tick (a cheap check of one element on scene pages, nothing
  // elsewhere), a once-a-minute flush, and noticing the Stats page. O Stats
  // ran two page-wide observers and two intervals on every page.

  let ticks = 0;
  setInterval(() => {
    ticks += 1;
    trackTick();
    if (ticks % 30 === 0) { try { localStorage.setItem(ALIVE, String(Date.now())); } catch (_) {} }
    if (ticks % 60 === 0) flushWatch();
    if (onStats()) mount();
  }, 1000);

  // React redraws the Stats page after data loads; put the dashboard back
  // at once rather than up to a second later. Only observes on that page.
  let obs = null;
  setInterval(() => {
    if (onStats() && !obs) {
      obs = new MutationObserver(() => { if (!app.root || !app.root.isConnected) mount(); });
      obs.observe(document.body, { childList: true, subtree: true });
    } else if (!onStats() && obs) { obs.disconnect(); obs = null; }
  }, 500);

  try { localStorage.setItem(ALIVE, String(Date.now())); } catch (_) {}
  setTimeout(flushWatch, 5000);      // anything a closed tab left behind
  window.addEventListener("pagehide", () => { try { localStorage.setItem(ALIVE, "0"); } catch (_) {} });
  mount();
})();
