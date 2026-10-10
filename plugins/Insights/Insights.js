/**
 * Insights - Stash UI plugin
 *
 * A stats dashboard on Stash's Stats page, below Stash's own numbers:
 * You (O's, streaks, a calendar, a day's timeline, watch time, what works
 * for you, your queue), Library (what you have and its records), Files and
 * quality (codecs, resolutions, bitrates, upgrades, space hogs, duplicates),
 * Metadata health (what is filled in, what is probably wrong) and
 * Collection (growth, tags, studio networks, who is in it). Everything is
 * computed in the browser from one paged read of the library plus a few
 * counts; every bar, day and row leads into Stash.
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
    const a = rawAge(birth, onDay);
    return a !== null && a >= 16 && a < 100 ? a : null;
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
    { id: "country", label: "Nationality", get: (p) => countryCode(p.country) },
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

  // ── Countries ─────────────────────────────────────────────────────────────
  // Stash stores an ISO code, but older data and imports have names
  // ("United States", "czech republic"); both become the code.
  let regionCodes = null;
  function countryCode(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
    if (!regionCodes) {
      regionCodes = new Map();
      try {
        const dn = new Intl.DisplayNames(["en"], { type: "region" });
        for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          let name = null;
          try { name = dn.of(code); } catch (_) {}
          if (name && name !== code) regionCodes.set(name.toLowerCase(), code);
        }
      } catch (_) {}
      for (const [k, v] of [["usa", "US"], ["united states of america", "US"], ["uk", "GB"], ["england", "GB"], ["great britain", "GB"],
                            ["czech republic", "CZ"], ["russian federation", "RU"], ["holland", "NL"]]) regionCodes.set(k, v);
    }
    return regionCodes.get(s.toLowerCase()) || s;
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  const VCODEC = { h264: "H.264", avc1: "H.264", hevc: "HEVC", h265: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8",
    mpeg4: "MPEG-4", msmpeg4: "MPEG-4", msmpeg4v2: "MPEG-4", msmpeg4v3: "MPEG-4", wmv1: "WMV", wmv2: "WMV", wmv3: "WMV",
    vc1: "VC-1", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1", prores: "ProRes", h263: "H.263", flv1: "FLV",
    theora: "Theora", rv30: "RealVideo", rv40: "RealVideo" };
  const ACODEC = { aac: "AAC", opus: "Opus", ac3: "AC-3", eac3: "E-AC-3", mp3: "MP3", mp2: "MP2", flac: "FLAC",
    vorbis: "Vorbis", wmav1: "WMA", wmav2: "WMA", wmapro: "WMA", dts: "DTS", truehd: "TrueHD", alac: "ALAC" };
  function codecName(raw, audio) {
    const c = String(raw || "").trim().toLowerCase();
    if (!c) return audio ? "none" : "unknown";
    if (audio && c.startsWith("pcm")) return "PCM";
    return (audio ? ACODEC : VCODEC)[c] || c.toUpperCase();
  }
  // Big for what they show, or not playable in a browser without transcoding.
  const LEGACY = new Set(["MPEG-4", "WMV", "VC-1", "MPEG-2", "MPEG-1", "H.263", "FLV", "Theora", "RealVideo"]);
  // How well a codec packs a picture, for picking which duplicate to keep.
  const CODEC_RANK = { AV1: 5, HEVC: 4, VP9: 4, "H.264": 3, VP8: 2 };

  // Stash reports ffprobe's container names; "matroska" is an .mkv.
  function containerName(format, basename) {
    const f = String(format || "").trim().toLowerCase();
    const named = { matroska: "mkv", mpegts: "ts", "matroska,webm": "mkv", "mov,mp4,m4a,3gp,3g2,mj2": "mp4" }[f];
    if (named) return named;
    if (f && f.length <= 5) return f;
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(basename || "") || [])[1];
    return ext ? ext.toLowerCase() : f || "unknown";
  }

  // By the shorter side, or the long side as if it were 16:9, whichever is
  // more: a portrait 1080x1920 is 1080p like its landscape twin, and a
  // 1920x800 cinema crop is 1080p, not 720p.
  const RES_ORDER = ["8K", "5K+", "4K", "1440p", "1080p", "720p", "480p", "below 480p"];
  function resBucket(w, h) {
    const short = w && h ? Math.min(w, h) : h || w || 0;
    if (!short) return null;
    const s = Math.max(short, w && h ? Math.round(Math.max(w, h) * 9 / 16) : 0);
    if (s >= 4000) return "8K";
    if (s >= 2600) return "5K+";
    if (s >= 2000) return "4K";
    if (s >= 1300) return "1440p";
    if (s >= 1000) return "1080p";
    if (s >= 700) return "720p";
    if (s >= 460) return "480p";
    return "below 480p";
  }
  const FPS_ORDER = ["24/25", "30", "50", "60", "over 60"];
  function fpsBucket(f) {
    if (!f) return null;
    if (f < 26) return "24/25";
    if (f < 40) return "30";
    if (f < 55) return "50";
    if (f < 65) return "60";
    return "over 60";
  }
  // VR is told by shape and size: side-by-side 2:1 at 4K wide or more, or
  // over-under 1:1 at 2.8K or more. Phones make portrait.
  function shapeOf(w, h) {
    if (!w || !h) return null;
    const r = w / h, long = Math.max(w, h);
    if ((r >= 1.9 && r <= 2.1 && long >= 3800) || (r >= 0.95 && r <= 1.05 && long >= 2800)) return "VR";
    if (r < 0.95) return "portrait";
    if (r <= 1.05) return "square";
    return "landscape";
  }
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  }
  // Bits per second, from Stash or worked out from size and length.
  const bitrateOf = (s) => s.br || (s.fsize && s.dur ? (s.fsize * 8) / s.dur : 0);

  function fileStats(scenes) {
    const st = { scenes: scenes.length, files: 0, size: 0, secs: 0, multi: 0, noFile: 0, noPhash: 0, brSum: 0, brN: 0,
      vcodec: new Map(), acodec: new Map(), container: new Map(), res: new Map(), fps: new Map(), shape: new Map(), bitrate: {} };
    const add = (m, key, s, raw) => {
      if (key === null || key === undefined) return;
      let r = m.get(key);
      if (!r) m.set(key, (r = { key, n: 0, size: 0, secs: 0, short: 0, raw: raw || "" }));
      r.n += 1; r.size += s.fsize || 0; r.secs += s.dur || 0; r.short += Math.min(s.w || s.h, s.h || s.w) || 0;
    };
    const brs = new Map(), eff = new Map();
    for (const s of scenes) {
      st.files += s.nfiles || 0; st.size += s.size || 0;
      if (!s.nfiles) { st.noFile += 1; continue; }
      if (s.nfiles > 1) st.multi += 1;
      if (s.phash === false) st.noPhash += 1;
      st.secs += s.dur || 0;
      const vc = codecName(s.vc), res = resBucket(s.w, s.h), br = bitrateOf(s);
      add(st.vcodec, vc, s, s.vc); add(st.acodec, codecName(s.ac, true), s, s.ac); add(st.container, s.fmt || "unknown", s);
      add(st.res, res, s); add(st.fps, fpsBucket(s.fps), s); add(st.shape, shapeOf(s.w, s.h), s);
      if (br && res) {
        st.brSum += br; st.brN += 1;
        if (!brs.has(res)) brs.set(res, []);
        brs.get(res).push(br);
        if (vc === "HEVC" || vc === "AV1") { if (!eff.has(res)) eff.set(res, []); eff.get(res).push(br); }
      }
    }
    for (const [res, list] of brs) {
      list.sort((a, b) => a - b);
      const e = (eff.get(res) || []).sort((a, b) => a - b);
      st.bitrate[res] = { n: list.length, p10: percentile(list, 0.1), p50: percentile(list, 0.5), p90: percentile(list, 0.9),
                          efficient: e.length >= 5 ? percentile(e, 0.5) : percentile(list, 0.5) * 0.5 };
    }
    return st;
  }

  // Worth upgrading: below 720p or a legacy codec. The ones you watch come
  // first, since those are the ones a better copy would improve.
  function upgrades(scenes) {
    const hits = scenes.filter((s) => s.nfiles && (["480p", "below 480p"].includes(resBucket(s.w, s.h)) || LEGACY.has(codecName(s.vc))));
    hits.sort((a, b) => (b.o || 0) - (a.o || 0) || (b.plays || 0) - (a.plays || 0) || (b.fsize || 0) - (a.fsize || 0));
    return { n: hits.length, size: hits.reduce((a, s) => a + (s.fsize || 0), 0), list: hits };
  }

  // Space hogs: over 2.5x the median bitrate for their resolution and over
  // 1 GB. The saving is what the file would be at the median HEVC/AV1
  // bitrate of that resolution in this library (half the median if there
  // are too few of those to tell).
  function spaceHogs(scenes, fs) {
    const out = [];
    for (const s of scenes) {
      if (!s.nfiles || (s.fsize || 0) < 1e9 || !s.dur) continue;
      const res = resBucket(s.w, s.h), b = fs.bitrate[res], br = bitrateOf(s);
      if (!b || b.n < 10 || br <= b.p50 * 2.5) continue;
      const saving = s.fsize - (s.dur * b.efficient) / 8;
      if (saving > 0) out.push({ s, ratio: br / b.p50, saving });
    }
    out.sort((a, b) => b.saving - a.saving);
    return { n: out.length, saving: out.reduce((a, x) => a + x.saving, 0), list: out };
  }

  const resRank = (s) => { const r = resBucket(s.w, s.h); return r ? RES_ORDER.length - RES_ORDER.indexOf(r) : 0; };

  // ── Metadata health ───────────────────────────────────────────────────────

  // parts: [{ missing, total, weight }] -> 0..1 filled, weighted.
  function healthScore(parts) {
    let w = 0, have = 0;
    for (const p of parts) {
      if (!p.total || p.missing === null || p.missing === undefined) continue;
      w += p.weight; have += p.weight * (1 - Math.min(p.missing, p.total) / p.total);
    }
    return w ? have / w : null;
  }
  function gradeOf(score) {
    if (score === null || score === undefined) return "–";
    const bands = [[0.92, "A"], [0.86, "A-"], [0.8, "B+"], [0.72, "B"], [0.66, "B-"], [0.58, "C+"], [0.5, "C"], [0.4, "D"]];
    for (const [min, g] of bands) if (score >= min) return g;
    return "E";
  }

  // Whole years between a birthdate and a day, unfiltered (ageAt drops
  // implausible ages; the checks want exactly those).
  function rawAge(birth, onDay) {
    const b = parseDay(birth), d = parseDay(onDay);
    if (b === null || d === null) return null;
    const bd = new Date(b), dd = new Date(d);
    let a = dd.getFullYear() - bd.getFullYear();
    if (dd.getMonth() < bd.getMonth() || (dd.getMonth() === bd.getMonth() && dd.getDate() < bd.getDate())) a -= 1;
    return a;
  }
  // Scenes dated before one of their performers turned 18: nearly always a
  // wrong birthdate or a wrong scene date (a re-release, a typo).
  function dateConflicts(scenes, perfById) {
    const out = [];
    for (const s of scenes) {
      if (!s.date) continue;
      for (const pid of s.perf || []) {
        const p = perfById.get(pid);
        const a = p ? rawAge(p.birth, s.date) : null;
        if (a !== null && a < 18) out.push({ s, p, age: a });
      }
    }
    return out;
  }
  // Same name and the same disambiguation (or none): probably one person
  // added twice.
  function sameNames(performers) {
    const m = new Map();
    for (const p of performers) {
      const k = `${String(p.name || "").trim().toLowerCase()}|${String(p.disamb || "").trim().toLowerCase()}`;
      if (!p.name) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return [...m.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
  }
  function futureDates(scenes, now) {
    const today = dayKey(now);
    return scenes.filter((s) => s.date && s.date.slice(0, 10) > today);
  }

  // ── Collection ────────────────────────────────────────────────────────────

  // Scenes added per month from the first month to this one, and the
  // running total.
  function growth(scenes, now) {
    const m = new Map();
    let first = null;
    for (const s of scenes) {
      if (!s.created) continue;
      const d = new Date(s.created), k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const r = m.get(k) || { added: 0, size: 0 };
      r.added += 1; r.size += s.size || 0; m.set(k, r);
      if (first === null || s.created < first) first = s.created;
    }
    if (first === null) return [];
    const out = [];
    const end = new Date(now);
    let total = 0, size = 0;
    for (let d = new Date(new Date(first).getFullYear(), new Date(first).getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      const r = m.get(k) || { added: 0, size: 0 };
      total += r.added; size += r.size;
      out.push({ key: k, from: d.getTime(), added: r.added, total, size });
    }
    return out;
  }

  function tagCounts(scenes) {
    const m = new Map();
    for (const s of scenes) for (const [id, name] of s.tags || []) {
      const r = m.get(id) || { id, name, n: 0 };
      r.n += 1; m.set(id, r);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }
  // What else turns up with a tag: lift = how often B is on A's scenes,
  // over how often B is on any scene. Pairs seen fewer than `min` times say
  // nothing and are left out.
  function coTags(scenes, tagId, min = 3) {
    const n = scenes.length;
    const all = new Map(), withA = new Map();
    let a = 0;
    for (const s of scenes) {
      const ids = (s.tags || []).map((t) => t[0]);
      const has = ids.includes(tagId);
      if (has) a += 1;
      for (const [id, name] of s.tags || []) {
        if (id === tagId) continue;
        const r = all.get(id) || { id, name, n: 0 };
        r.n += 1; all.set(id, r);
        if (has) withA.set(id, (withA.get(id) || 0) + 1);
      }
    }
    if (!a) return { n: 0, rows: [] };
    const rows = [...withA.entries()].filter(([, t]) => t >= min).map(([id, together]) => {
      const b = all.get(id);
      return { id, name: b.name, together, share: together / a, lift: (together / a) / (b.n / n) };
    });
    rows.sort((x, y) => y.lift - x.lift || y.together - x.together);
    return { n: a, rows };
  }

  // Studios grouped under their top parent. A network is a parent with at
  // least one child that has scenes; everything else is independent.
  function networks(studios, scenes) {
    const byId = new Map(studios.map((s) => [s.id, s]));
    const rootOf = (id) => {
      let cur = byId.get(id), guard = 0;
      while (cur && cur.parent && byId.has(cur.parent) && guard++ < 12) cur = byId.get(cur.parent);
      return cur ? cur.id : id;
    };
    const per = new Map();
    for (const s of scenes) {
      if (!s.studio) continue;
      const r = per.get(s.studio.id) || { n: 0, size: 0, name: s.studio.name };
      r.n += 1; r.size += s.size || 0; per.set(s.studio.id, r);
    }
    const nets = new Map();
    for (const [id, r] of per) {
      const root = rootOf(id);
      const net = nets.get(root) || { id: root, name: (byId.get(root) || {}).name || r.name, sites: new Set(), scenes: 0, size: 0 };
      if (id !== root) net.sites.add(id);
      net.scenes += r.n; net.size += r.size; nets.set(root, net);
    }
    const list = [...nets.values()].map((x) => ({ ...x, sites: x.sites.size }));
    const groups = list.filter((x) => x.sites > 0).sort((a, b) => b.scenes - a.scenes);
    const indep = list.filter((x) => x.sites === 0);
    const studiosOut = [...per.entries()].map(([id, r]) => ({ id, name: r.name, scenes: r.n, size: r.size })).sort((a, b) => b.scenes - a.scenes);
    return { networks: groups, studios: studiosOut,
             independent: { studios: indep.length, scenes: indep.reduce((a, x) => a + x.scenes, 0), list: indep.sort((a, b) => b.scenes - a.scenes) } };
  }

  // Performers who share scenes. Scenes with more than six performers are
  // left out: one big cast would otherwise make dozens of "pairs".
  function pairs(scenes) {
    const m = new Map();
    for (const s of scenes) {
      const p = [...new Set(s.perf || [])].sort();
      if (p.length < 2 || p.length > 6) continue;
      for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
        const k = `${p[i]}|${p[j]}`;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    return [...m.entries()].map(([k, n]) => ({ a: k.split("|")[0], b: k.split("|")[1], n })).sort((x, y) => y.n - x.n);
  }

  // The year of each performer's first scene here (by release date).
  function newFaces(scenes) {
    const first = new Map();
    for (const s of scenes) {
      const y = parseInt(String(s.date || "").slice(0, 4), 10);
      if (!y) continue;
      for (const pid of s.perf || []) if (!first.has(pid) || y < first.get(pid)) first.set(pid, y);
    }
    const m = new Map();
    for (const y of first.values()) m.set(y, (m.get(y) || 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }));
  }

  // Each performer in each scene, by age on the scene's date (18 to 50).
  function ageCounts(scenes, perfById) {
    const m = new Map();
    for (const s of scenes) for (const pid of s.perf || []) {
      const a = ageAt(perfById.get(pid)?.birth, s.date);
      if (a === null || a < 18 || a > 50) continue;
      const r = m.get(a) || { n: 0, o: 0 };
      r.n += 1; r.o += s.o || 0; m.set(a, r);
    }
    return m;
  }

  // The records: longest, biggest and so on. Each points at a scene,
  // performer or studio.
  function notable(scenes, perfById) {
    const best = (f, ok = () => true) => scenes.reduce((m, s) => (ok(s) && (m === null || f(s) > f(m)) ? s : m), null);
    const perfN = new Map(), studioN = new Map();
    for (const s of scenes) {
      for (const pid of s.perf || []) perfN.set(pid, (perfN.get(pid) || 0) + 1);
      if (s.studio) { const r = studioN.get(s.studio.id) || { ...s.studio, n: 0 }; r.n += 1; studioN.set(s.studio.id, r); }
    }
    const topPerf = [...perfN.entries()].sort((a, b) => b[1] - a[1])[0];
    const topStudio = [...studioN.values()].sort((a, b) => b.n - a.n)[0];
    return {
      longest: best((s) => s.dur || 0, (s) => s.dur > 0),
      shortest: best((s) => -(s.dur || 0), (s) => s.dur > 0),
      biggest: best((s) => s.fsize || 0, (s) => s.fsize > 0),
      oldest: best((s) => -(parseDay(s.date) || 0), (s) => parseDay(s.date) !== null),
      newest: best((s) => s.created || 0, (s) => !!s.created),
      cast: best((s) => (s.perf || []).length, (s) => (s.perf || []).length > 1),
      played: best((s) => s.plays || 0, (s) => s.plays > 0),
      tagged: best((s) => (s.tags || []).length, (s) => (s.tags || []).length > 0),
      performer: topPerf ? { p: perfById.get(topPerf[0]) || { id: topPerf[0], name: `Performer ${topPerf[0]}` }, n: topPerf[1] } : null,
      studio: topStudio || null,
    };
  }

  // "4 months and 10 days": how long the library would take to watch.
  function nonstop(secs) {
    const days = (secs || 0) / 86400;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    if (days < 1) return plural(Math.round(secs / 3600), "hour");
    if (days < 60) { const d = Math.floor(days), h = Math.round((days - d) * 24); return h ? `${plural(d, "day")} and ${plural(h, "hour")}` : plural(d, "day"); }
    if (days < 365) { const mo = Math.floor(days / 30.44), d = Math.round(days - mo * 30.44); return d ? `${plural(mo, "month")} and ${plural(d, "day")}` : plural(mo, "month"); }
    const y = Math.floor(days / 365.25), mo = Math.round((days - y * 365.25) / 30.44);
    return mo ? `${plural(y, "year")} and ${plural(mo, "month")}` : plural(y, "year");
  }

  // ── 2.2: actions ──────────────────────────────────────────────────────────

  // HEVC and AV1 are both the target: either is a copy worth keeping.
  const isEfficient = (vc) => { const n = codecName(vc); return n === "HEVC" || n === "AV1"; };

  // Which copies of a duplicate group to keep and which to remove.
  // mode "hevc": keep the sharpest HEVC/AV1 copy; remove the others, but
  //   with `sharp` on, never one sharper than what is kept, and a group with
  //   no HEVC/AV1 copy at all is left for a look, nothing ticked.
  // mode "best": keep the sharpest, then the better codec, then more history.
  // mode "smallest": keep the smallest file among the sharpest copies.
  // Returns { keep, items: [{ s, remove, why }], review, reason }.
  function dupChoose(group, mode = "hevc", opts = {}) {
    const sharp = opts.sharp !== false;
    const hist = (s) => (s.o || 0) + (s.plays || 0);
    const byQuality = (a, b) => resRank(b) - resRank(a) || (CODEC_RANK[codecName(b.vc)] || 1) - (CODEC_RANK[codecName(a.vc)] || 1) ||
      (b.br || 0) - (a.br || 0) || hist(b) - hist(a) || (Number(a.id) || 0) - (Number(b.id) || 0);
    let keep, review = false, reason = "";
    if (mode === "smallest") {
      const top = Math.max(...group.map(resRank));
      keep = group.filter((s) => resRank(s) === top).sort((a, b) => (a.fsize || 0) - (b.fsize || 0) || byQuality(a, b))[0];
    } else if (mode === "best") {
      keep = group.slice().sort(byQuality)[0];
    } else {
      const eff = group.filter((s) => isEfficient(s.vc)).sort(byQuality);
      if (!eff.length) {
        keep = group.slice().sort(byQuality)[0];
        return { keep, items: group.filter((s) => s !== keep).map((s) => ({ s, remove: false, why: "no HEVC or AV1 copy" })),
                 review: true, reason: "No HEVC or AV1 copy in this group" };
      }
      keep = eff[0];
    }
    const items = group.filter((s) => s !== keep).map((s) => {
      if (mode === "hevc" && sharp && resRank(s) > resRank(keep)) {
        review = true;
        reason = `A ${resBucket(s.w, s.h)} copy is sharper than the ${resBucket(keep.w, keep.h)} ${codecName(keep.vc)} one`;
        return { s, remove: false, why: "sharper than the kept copy" };
      }
      return { s, remove: true, why: "" };
    });
    return { keep, items, review, reason };
  }

  // What the kept scene should look like after a merge: its own fields win;
  // empty ones are filled from the copies; lists (tags, performers,
  // galleries, groups, URLs, StashDB ids) are the union, so removing a copy
  // never loses anything set on it (rule 5). `have` is the set of
  // SceneUpdateInput fields this Stash accepts.
  function mergeValues(keep, drops, have) {
    const all = [keep].concat(drops);
    const ok = (f) => !have || have.has(f);
    const v = { id: keep.id };
    const first = (get) => { for (const s of all) { const x = get(s); if (x !== null && x !== undefined && x !== "") return x; } return undefined; };
    const uniq = (list) => [...new Set(list.map(String))];
    if (ok("title")) { const x = first((s) => s.title); if (x !== undefined) v.title = x; }
    if (ok("code")) { const x = first((s) => s.code); if (x !== undefined) v.code = x; }
    if (ok("details")) { const x = first((s) => s.details); if (x !== undefined) v.details = x; }
    if (ok("director")) { const x = first((s) => s.director); if (x !== undefined) v.director = x; }
    if (ok("date")) { const x = first((s) => s.date); if (x !== undefined) v.date = x; }
    if (ok("rating100")) { const x = first((s) => s.rating100); if (x !== undefined) v.rating100 = x; }
    if (ok("studio_id")) { const x = first((s) => s.studio && s.studio.id); if (x !== undefined) v.studio_id = String(x); }
    if (ok("organized")) v.organized = all.some((s) => s.organized);
    if (ok("tag_ids")) v.tag_ids = uniq(all.flatMap((s) => (s.tags || []).map((t) => t.id)));
    if (ok("performer_ids")) v.performer_ids = uniq(all.flatMap((s) => (s.performers || []).map((p) => p.id)));
    if (ok("gallery_ids")) v.gallery_ids = uniq(all.flatMap((s) => (s.galleries || []).map((g) => g.id)));
    if (ok("urls")) v.urls = [...new Set(all.flatMap((s) => s.urls || []))];
    if (ok("groups")) {
      const seen = new Map();
      for (const s of all) for (const g of s.groups || []) {
        const id = String(g.group ? g.group.id : g.group_id);
        if (!seen.has(id)) seen.set(id, { group_id: id, ...(g.scene_index !== null && g.scene_index !== undefined ? { scene_index: g.scene_index } : {}) });
      }
      v.groups = [...seen.values()];
    }
    if (ok("stash_ids")) {
      const seen = new Map();
      for (const s of all) for (const x of s.stash_ids || []) {
        const k = `${x.endpoint}|${x.stash_id}`;
        if (!seen.has(k)) seen.set(k, { endpoint: x.endpoint, stash_id: x.stash_id });
      }
      v.stash_ids = [...seen.values()];
    }
    return v;
  }

  // Files not in HEVC or AV1 yet, with what they would take at this
  // library's usual HEVC/AV1 bitrate for their resolution. Biggest gain first.
  function notEfficient(scenes, fs) {
    const out = [];
    for (const s of scenes) {
      if (!s.nfiles || !s.dur || isEfficient(s.vc)) continue;
      const b = fs.bitrate[resBucket(s.w, s.h)];
      const gain = b ? Math.max(0, (s.fsize || 0) - (s.dur * b.efficient) / 8) : 0;
      out.push({ s, gain });
    }
    out.sort((a, b) => b.gain - a.gain);
    return { n: out.length, gain: out.reduce((a, x) => a + x.gain, 0), size: out.reduce((a, x) => a + (x.s.fsize || 0), 0), list: out };
  }

  // ── 2.2: what works for you, read better ──────────────────────────────────

  // Dimensions with a natural order keep it (height runs short to tall);
  // the rest sort strongest first.
  const ORDER = {
    height: ["under 155 cm", "155–164 cm", "165–174 cm", "175 cm and up"],
    weight: ["under 50 kg", "50–59 kg", "60–69 kg", "70 kg and up"],
    cup: ["A", "B", "C", "D", "DD+"],
    age: ["18–21", "22–25", "26–30", "31–35", "36–40", "41 and up"],
    career: ["first 2 years", "years 3–5", "years 6–10", "over 10 years in"],
    length: ["under 10 min", "10–30 min", "30–60 min", "over an hour"],
    resolution: ["SD", "720p", "1080p", "4K and up"],
    cast: ["solo", "two performers", "three or more"],
  };
  const isOrdinal = (dimId) => !!ORDER[dimId] || dimId === "era";
  function ordinalKey(dimId, value) {
    if (dimId === "era") return value === "before 2005" ? 0 : parseInt(value, 10) || 0;
    const i = (ORDER[dimId] || []).indexOf(value);
    return i < 0 ? 999 : i;
  }

  // Strength: how far above its share a group is, on a log scale (2x and
  // 0.5x are equally far from even), weighted by how many scenes back it,
  // so six scenes at 12x do not outrank 600 at 1.7x.
  const strength = (lift, scenes) => (lift > 0 ? Math.log(lift) : -5) * Math.sqrt(scenes);

  // rows from traitRows plus the metric ("o" or "watch") -> rows with lift,
  // score and rank (1 = strongest), the top three flagged, in display order.
  // Small groups: under max(5, 0.1% of the library) scenes, or too little
  // activity to say anything.
  function rankTraits(T, dimId, metric = "o", opts = {}) {
    const minScenes = Math.max(5, Math.round((T.total.scenes || 0) * 0.001));
    const share = (r) => (metric === "watch" ? r.watchShare : r.oShare);
    const rows = T.rows.map((r) => {
      const lift = r.libShare ? share(r) / r.libShare : 0;
      return { ...r, mShare: share(r), mLift: lift, score: strength(lift, r.scenes),
               small: r.scenes < minScenes || (r.o < 2 && r.plays < 3) };
    });
    const shown = rows.filter((r) => opts.small || !r.small);
    const byScore = shown.slice().sort((a, b) => b.score - a.score || b.scenes - a.scenes);
    byScore.forEach((r, i) => { r.rank = i + 1; r.top = i < 3 && r.mLift >= 1.25; });
    let ordered;
    if (opts.sort === "size") ordered = shown.slice().sort((a, b) => b.scenes - a.scenes);
    else if (isOrdinal(dimId) && opts.sort !== "pull") ordered = shown.slice().sort((a, b) => ordinalKey(dimId, a.value) - ordinalKey(dimId, b.value));
    else ordered = byScore;
    return { rows: ordered, hidden: rows.length - shown.length, minScenes };
  }

  // Position on a log scale centred on 1x: 1/4x is -1, 4x is +1.
  const liftPos = (lift) => (lift > 0 ? Math.max(-1, Math.min(1, Math.log(lift) / Math.log(4))) : -1);

  if (window.__INSIGHTS_TEST__) {
    window.__InsightsTest = { dayKey, parseDay, daysBetween, weekStart, toMs, fmtDur, fmtBytes, collectOs, countByDay,
      streaks, recordDay, periodBars, calendar, weekdayHour, dayEvents, cupOf, heightGroup, weightGroup, ageAt,
      ageGroup, careerGroup, naturalGroup, flagOf, lengthGroup, resolutionGroup, eraGroup, castGroup,
      PERFORMER_TRAITS, SCENE_TRAITS, traitRows, liftTone, performerTable, topScenes, library, ratingBands,
      backlog, BACKLOG, encodeCriterion, listUrl, watchPerO, mergeOStats, addWatch, yesNo,
      countryCode, codecName, containerName, resBucket, fpsBucket, shapeOf, percentile, fileStats, upgrades, spaceHogs,
      healthScore, gradeOf, rawAge, dateConflicts, sameNames, futureDates, growth, tagCounts, coTags, networks,
      pairs, newFaces, ageCounts, notable, nonstop,
      isEfficient, dupChoose, mergeValues, notEfficient, isOrdinal, ordinalKey, strength, rankTraits, liftPos };
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
    "paths { screenshot }", "studio { id name }", "tags { id name }", "performers { id }"];
  // Files are asked for field by field too: frame_rate, bit_rate and
  // fingerprints are not in every Stash.
  const FILE_WANT = ["duration", "size", "width", "height", "video_codec", "audio_codec", "frame_rate", "bit_rate", "format",
    "basename", "fingerprints { type }"];
  const PERF_WANT = ["id", "name", "disambiguation", "gender", "birthdate", "country", "ethnicity", "hair_color", "eye_color",
    "height_cm", "weight", "measurements", "fake_tits", "tattoos", "piercings", "career_start", "career_length",
    "favorite", "rating100", "image_path", "scene_count", "tags { id name }"];

  function compactScene(s) {
    const files = s.files || [];
    const f = files[0] || {};
    return {
      id: String(s.id), title: s.title || f.basename || `Scene ${s.id}`, date: s.date || null,
      created: toMs(s.created_at), rating: s.rating100 ?? null, organized: !!s.organized, o: s.o_counter || 0,
      oh: s.o_history || [], plays: s.play_count || 0, playDur: s.play_duration || 0, ph: s.play_history || [],
      last: toMs(s.last_played_at), resume: s.resume_time || 0, interactive: !!s.interactive,
      dur: f.duration || 0, shot: s.paths?.screenshot || null,
      // size is every file (what the scene takes on disk); fsize and the
      // rest describe the first file, the one Stash plays.
      size: files.reduce((a, x) => a + (x.size || 0), 0), fsize: f.size || 0, nfiles: files.length,
      w: f.width || 0, h: f.height || 0, vc: f.video_codec || "", ac: f.audio_codec || "", fps: f.frame_rate || 0,
      br: f.bit_rate || 0, fmt: files.length ? containerName(f.format, f.basename) : "",
      phash: f.fingerprints ? f.fingerprints.some((x) => x.type === "phash") : null,
      studio: s.studio ? { id: String(s.studio.id), name: s.studio.name } : null,
      tags: (s.tags || []).map((t) => [String(t.id), t.name]), perf: (s.performers || []).map((p) => String(p.id)),
    };
  }
  function compactPerformer(p) {
    return {
      id: String(p.id), name: p.name, disamb: p.disambiguation || "", gender: p.gender || null, birth: p.birthdate || null,
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
    const sceneHave = await fieldsOf("Scene");
    const ff = pick(await fieldsOf("VideoFile"), FILE_WANT);
    const sf = pick(sceneHave, SCENE_WANT) + (sceneHave.has("files") && ff ? ` files { ${ff} }` : "");
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
    const studios = [];
    const stf = pick(await fieldsOf("Studio"), ["id", "name", "parent_studio { id }"]);
    for (let page = 1; ; page++) {
      const d = await gql(`query ($f: FindFilterType) { findStudios(filter: $f) { count studios { ${stf} } } }`,
                          { f: { page, per_page: 1000, sort: "id", direction: "ASC" } });
      const r = d?.findStudios;
      for (const x of r?.studios || []) studios.push({ id: String(x.id), name: x.name, parent: x.parent_studio ? String(x.parent_studio.id) : null });
      if (!r || !r.studios.length || studios.length >= r.count) break;
    }
    progress("Counting what is filled in…");
    const [counts, stats] = await Promise.all([loadCounts(), loadStats()]);
    return { at: Date.now(), scenes, performers, studios, counts, stats };
  }

  // Metadata health is counted by Stash itself, with the same "is missing"
  // filters the rows link to, so a number and the list it opens always
  // agree, and nothing like scene details has to be downloaded to count it.
  // A filter an older Stash does not know just leaves its row out.
  const COUNTS = [
    ["s.title", "Scene", '{is_missing: "title"}'], ["s.date", "Scene", '{is_missing: "date"}'],
    ["s.studio", "Scene", '{is_missing: "studio"}'], ["s.performers", "Scene", '{is_missing: "performers"}'],
    ["s.tags", "Scene", '{is_missing: "tags"}'], ["s.details", "Scene", '{is_missing: "details"}'],
    ["s.url", "Scene", '{is_missing: "url"}'], ["s.stash_id", "Scene", '{is_missing: "stash_id"}'],
    ["s.cover", "Scene", '{is_missing: "cover"}'], ["s.organized", "Scene", "{organized: false}"],
    ["s.markers", "Scene", '{has_markers: "true"}'], ["s.group", "Scene", '{is_missing: "group"}'],
    ["p.image", "Performer", '{is_missing: "image"}'], ["p.gender", "Performer", '{is_missing: "gender"}'],
    ["p.birthdate", "Performer", '{is_missing: "birthdate"}'], ["p.country", "Performer", '{is_missing: "country"}'],
    ["p.height", "Performer", '{is_missing: "height"}'], ["p.measurements", "Performer", '{is_missing: "measurements"}'],
    ["p.stash_id", "Performer", '{is_missing: "stash_id"}'], ["p.url", "Performer", '{is_missing: "url"}'],
    ["p.noscenes", "Performer", "{scene_count: {value: 0, modifier: EQUALS}}"],
    ["st.image", "Studio", '{is_missing: "image"}'], ["st.stash_id", "Studio", '{is_missing: "stash_id"}'],
    ["st.url", "Studio", '{is_missing: "url"}'], ["st.noscenes", "Studio", "{scene_count: {value: 0, modifier: EQUALS}}"],
    ["t.once", "Tag", "{scene_count: {value: 1, modifier: EQUALS}}"],
  ];
  const FIND = { Scene: ["findScenes", "scene_filter"], Performer: ["findPerformers", "performer_filter"],
                 Studio: ["findStudios", "studio_filter"], Tag: ["findTags", "tag_filter"] };
  async function loadCounts() {
    const field = ([, type, f], i) => `c${i}: ${FIND[type][0]}(${FIND[type][1]}: ${f}, filter: {per_page: 1}) { count }`;
    const out = {};
    try {
      const d = await gql(`query { ${COUNTS.map(field).join(" ")} }`);
      COUNTS.forEach(([k], i) => { out[k] = d?.[`c${i}`]?.count ?? null; });
      return out;
    } catch (e) {
      log(`Counts in one go failed (${e.message}); one at a time`);
    }
    await Promise.all(COUNTS.map(async (c, i) => {
      try { out[c[0]] = (await gql(`query { ${field(c, i)} }`))?.[`c${i}`]?.count ?? null; }
      catch (_) { out[c[0]] = null; }
    }));
    return out;
  }
  async function loadStats() {
    const f = pick(await fieldsOf("StatsResultType"), ["scene_count", "scenes_size", "scenes_duration", "image_count", "images_size",
      "gallery_count", "performer_count", "studio_count", "group_count", "movie_count", "tag_count"]);
    if (!f) return {};
    try { return (await gql(`query { stats { ${f} } }`))?.stats || {}; } catch (_) { return {}; }
  }

  // Stash's own phash match, exact, run only when asked: it is the one
  // heavy query here. duration_diff is newer than findDuplicateScenes.
  async function loadDuplicates() {
    const ff = pick(await fieldsOf("VideoFile"), ["id", "size", "width", "height", "video_codec", "bit_rate", "duration", "basename"]);
    const q = (diff) => `query { findDuplicateScenes(distance: 0${diff ? ", duration_diff: 1" : ""}) { id title o_counter play_count paths { screenshot } files { ${ff} } } }`;
    let d;
    try { d = await gql(q(true)); } catch (_) { d = await gql(q(false)); }
    return (d?.findDuplicateScenes || []).map((g) => g.map((s) => {
      const f = (s.files || [])[0] || {};
      return { id: String(s.id), title: s.title || f.basename || `Scene ${s.id}`, o: s.o_counter || 0, plays: s.play_count || 0,
               shot: s.paths?.screenshot || null, fsize: (s.files || []).reduce((a, x) => a + (x.size || 0), 0),
               w: f.width || 0, h: f.height || 0, vc: f.video_codec || "", br: f.bit_rate || 0, dur: f.duration || 0,
               fid: f.id ? String(f.id) : null, nfiles: (s.files || []).length };
    }));
  }

  // ═══ Writes (Actions tab only, each one on a click) ═══════════════════════

  // Input types list inputFields, not fields.
  const inputFields = new Map();
  async function inputFieldsOf(type) {
    if (inputFields.has(type)) return inputFields.get(type);
    let names = new Set();
    try {
      const d = await gql(`query ($t: String!) { __type(name: $t) { inputFields { name } } }`, { t: type });
      names = new Set((d?.__type?.inputFields || []).map((f) => f.name));
    } catch (e) { log(`Schema read failed for ${type}: ${e.message}`); }
    inputFields.set(type, names);
    return names;
  }

  const MERGE_WANT = ["id", "title", "code", "details", "director", "date", "rating100", "organized", "urls", "studio { id }",
    "tags { id }", "performers { id }", "galleries { id }", "groups { group { id } scene_index }", "stash_ids { endpoint stash_id }",
    "files { id }"];
  // Everything a merge carries over, read fresh at the moment of the merge
  // (not from the scan, which may be minutes old).
  async function loadForMerge(ids) {
    const sf = pick(await fieldsOf("Scene"), MERGE_WANT);
    const d = await gql(`query { ${ids.map((id, i) => `s${i}: findScene(id: ${JSON.stringify(String(id))}) { ${sf} }`).join(" ")} }`);
    return ids.map((_, i) => d?.[`s${i}`] || null);
  }

  // One duplicate group. With `merge`, the copies are merged into the kept
  // scene first (Stash's sceneMerge: their files, markers, O and play
  // history move over, the copy scenes go; tags, performers and the rest are
  // carried in `values`), then exactly the files that came from the copies
  // are deleted from disk. Without it, the copy scenes and their files are
  // deleted outright. Refuses if anything changed since the scan.
  async function removeCopies(keep, drops, merge) {
    const fresh = await loadForMerge([keep.id].concat(drops.map((s) => s.id)));
    const [k, ...ds] = fresh;
    if (!k) throw new Error("the scene to keep is gone");
    if (ds.some((x) => !x)) throw new Error("a copy is already gone");
    if (keep.fid && String((k.files || [])[0]?.id) !== keep.fid) throw new Error("the kept scene's file changed since the scan");
    const fileIds = ds.flatMap((x) => (x.files || []).map((f) => String(f.id)));
    if (!merge) {
      await gql(`mutation ($i: ScenesDestroyInput!) { scenesDestroy(input: $i) }`,
                { i: { ids: ds.map((x) => String(x.id)), delete_file: true, delete_generated: true } });
      return fileIds.length;
    }
    const have = await inputFieldsOf("SceneUpdateInput");
    const values = mergeValues(k, ds, have.size ? have : null);
    await gql(`mutation ($i: SceneMergeInput!) { sceneMerge(input: $i) { id } }`,
              { i: { source: ds.map((x) => String(x.id)), destination: String(k.id), values, play_history: true, o_history: true } });
    if (fileIds.length) await gql(`mutation ($ids: [ID!]!) { deleteFiles(ids: $ids) }`, { ids: fileIds });
    return fileIds.length;
  }

  // QuickTools' D tag, so "Marked for Delete" here is the same tag there.
  async function deleteTagName() {
    try {
      const p = (await gql(`query { configuration { plugins } }`))?.configuration?.plugins || {};
      return (p.QuickTools && String(p.QuickTools.deleteTagName || "").trim()) || "Marked for Delete";
    } catch (_) { return "Marked for Delete"; }
  }
  async function tagId(name) {
    const d = await gql(`query ($f: TagFilterType) { findTags(tag_filter: $f, filter: {per_page: 5}) { tags { id name } } }`,
                        { f: { name: { value: name, modifier: "EQUALS" } } });
    const hit = (d?.findTags?.tags || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (hit) return String(hit.id);
    const c = await gql(`mutation ($i: TagCreateInput!) { tagCreate(input: $i) { id } }`, { i: { name } });
    return String(c.tagCreate.id);
  }
  // ADD mode: every other tag on these scenes rides through (rule 5).
  async function tagScenes(ids, name) {
    const id = await tagId(name);
    for (let i = 0; i < ids.length; i += 500) {
      await gql(`mutation ($i: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $i) { id } }`,
                { i: { ids: ids.slice(i, i + 500).map(String), tag_ids: { mode: "ADD", ids: [id] } } });
    }
  }
  async function generatePhashes(ids) {
    const d = await gql(`mutation ($i: GenerateMetadataInput!) { metadataGenerate(input: $i) }`,
                        { i: { phashes: true, sceneIDs: ids.map(String) } });
    return d?.metadataGenerate || null;
  }

  // ── Cache: IndexedDB, 30 minutes; Refresh skips it ────────────────────────
  // localStorage is too small for a library with its histories (O Stats hit
  // the quota); IndexedDB is not. Any failure just means no cache.
  const CACHE_MS = 30 * 60000;
  // v2 added files, studios and counts; a v1 entry would load without them.
  const CACHE_KEY = "v2";
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
        const r = db.transaction("lib").objectStore("lib").get(CACHE_KEY);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (_) { return null; }
  }
  async function cachePut(v) {
    try {
      const db = await idb();
      db.transaction("lib", "readwrite").objectStore("lib").put(v, CACHE_KEY);
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

  // 16px line icons. Filled shapes say so; everything else is a stroke.
  const F = 'fill="currentColor" stroke="none"';
  const ICON = {
    drop: `<path ${F} d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5z"/>`,
    flame: `<path ${F} d="M8 1.5c.5 2.5 3.8 4 3.8 7.6A3.8 3.8 0 0 1 4.2 9.1c0-1.8 1-2.8 1.8-3.6.1 1.3.7 2.1 1.4 2.4C7.2 5.6 7.6 3.5 8 1.5z"/>`,
    play: `<path ${F} d="M5.5 3.8v8.4l6.5-4.2z"/>`,
    trophy: '<path d="M4.5 2.5h7v3a3.5 3.5 0 0 1-7 0zM4.5 3.5H2.5a2 2 0 0 0 2 2.5M11.5 3.5h2a2 2 0 0 1-2 2.5M8 9v2.5M5.5 13.5h5M6.5 11.5h3v2h-3z"/>',
    clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
    eyeoff: '<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM2.5 2.5l11 11"/><circle cx="8" cy="8" r="1.8"/>',
    star: '<path d="M8 2l1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.8 4.1-.5z"/>',
    pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
    dropoff: '<path d="M8 1.5C8 1.5 3.3 6.8 3.3 10.2a4.7 4.7 0 0 0 9.4 0C12.7 6.8 8 1.5 8 1.5zM2.5 2.5l11 11"/>',
    heart: '<path d="M8 13.5S2.5 10.2 2.5 6.3A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.3c0 3.9-5.5 7.2-5.5 7.2z"/>',
    folder: '<path d="M2 4.5h4l1.2 1.5H14v6.5H2z"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    user: '<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3"/>',
    users: '<circle cx="6" cy="6" r="2.4"/><path d="M1.8 13.5c.5-2.3 2.2-3.6 4.2-3.6s3.7 1.3 4.2 3.6M10.5 3.8a2.4 2.4 0 0 1 0 4.5M12 9.9c1.2.5 2 1.6 2.3 3.1"/>',
    film: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M5 2.5v11M11 2.5v11M2 6h3M2 10h3M11 6h3M11 10h3"/>',
    chip: '<rect x="4" y="4" width="8" height="8" rx="1"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
    pulse: '<path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4"/>',
    layers: '<path d="M8 2 1.8 5.2 8 8.4l6.2-3.2zM1.8 8 8 11.2 14.2 8M1.8 10.8 8 14l6.2-3.2"/>',
    disk: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.5"/><path d="M4.5 9.5h4"/><circle cx="11.5" cy="9.5" r=".6"/>',
    tag: '<path d="M2 2.5h5.3l6.7 6.7-5 4.8-7-6.7z"/><circle cx="5.2" cy="5.6" r=".9"/>',
    studio: '<path d="M2.5 14V3.5l6-1.5V14M8.5 6h5v8M1.5 14h13M4.5 6h1.5M4.5 9h1.5M10.5 9h1M10.5 11.5h1"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.8" cy="6.5" r="1.2"/><path d="m2.5 12 3.8-3.6 2.7 2.4 2-1.8 2.5 2.4"/>',
    alert: '<path d="M8 2.2 14.3 13.3H1.7zM8 6.5v3.2M8 11.6v.1"/>',
    check: '<path d="m3 8.5 3.2 3 6.8-7"/>',
    copy: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M3 10.5V3.8c0-.5.3-.8.8-.8h6.7"/>',
    up: '<path d="M8 13.5V3M3.5 7.5 8 3l4.5 4.5"/>',
    box: '<path d="M2 5 8 2l6 3v6.5L8 14.5 2 11.5zM2 5l6 3 6-3M8 8v6.5"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14C6.2 12.3 5.3 10.3 5.3 8S6.2 3.7 8 2z"/>',
    link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.8.8M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.8-.8"/>',
    spark: '<path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8l4.8-1.4z"/>',
    trend: '<path d="M1.5 12 6 7.5l3 3 5.5-6M10.5 4.5h4v4"/>',
    list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
    gauge: '<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0M8 11.5l3-4"/>',
    audio: '<path d="M2.5 6v4h2.5l3.5 3V3L5 6zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',
    frame: '<path d="M2 5.5V3h2.5M11.5 3H14v2.5M14 10.5V13h-2.5M4.5 13H2v-2.5"/>',
    expand: '<path d="M3 6.5V3h3.5M13 6.5V3H9.5M3 9.5V13h3.5M13 9.5V13H9.5"/>',
    ruler: '<path d="M2 10.5 10.5 2 14 5.5 5.5 14zM5 7.5l1.5 1.5M7 5.5l1 1M9 3.5l1.5 1.5M3 9.5l1 1"/>',
    arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  };
  const ic = (name, cls = "") => `<svg class="ins-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] || ""}</svg>`;

  // Flexoki (Steph Ango's ink-and-paper palette), dark. Each tab has its
  // own accent; cards are raised (lit top edge, shadow below), data wells
  // are sunk (dark top edge, inner shadow), so the page reads in layers.
  const ACC = { re: "#D14D41", or: "#DA702C", ye: "#D0A215", gr: "#879A39", cy: "#3AA99F", bl: "#4385BE", pu: "#8B7EC8", ma: "#CE5D97" };
  function injectStyles() {
    if (document.getElementById("insights-styles")) return;
    const s = document.createElement("style");
    s.id = "insights-styles";
    s.textContent = `
#insights { --bg: #100F0F; --bg2: #1C1B1A; --ui: #282726; --ui2: #343331; --ui3: #403E3C; --tx3: #575653; --tx2b: #6F6E69;
  --tx2: #878580; --tx1b: #B7B5AC; --tx: #CECDC3; --hi: #E6E4D9;
  --re: #D14D41; --or: #DA702C; --ye: #D0A215; --gr: #879A39; --cy: #3AA99F; --bl: #4385BE; --pu: #8B7EC8; --ma: #CE5D97;
  --up: #A9BA5A; --down: #E8705F; --acc: var(--ma);
  max-width: 1400px; margin: 28px auto 40px; padding: 18px 18px 8px; color: var(--tx); font-size: 14px; text-align: left;
  background: var(--bg); border-radius: 16px; border: 1px solid #000; border-top-color: #232120;
  box-shadow: 0 20px 50px -20px rgba(0,0,0,.7); }
#insights[data-tab="library"] { --acc: var(--or); } #insights[data-tab="files"] { --acc: var(--cy); }
#insights[data-tab="health"] { --acc: var(--ye); } #insights[data-tab="collection"] { --acc: var(--gr); }
#insights[data-tab="actions"] { --acc: var(--re); }
#insights * { box-sizing: border-box; }
#insights button { font: inherit; }
#insights a { color: inherit; }
.ins-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.ins-title { font-size: 22px; font-weight: 700; color: var(--hi); display: flex; align-items: center; gap: 8px; letter-spacing: -.01em; }
.ins-title .ins-ic { width: 20px; height: 20px; color: var(--acc); }
.ins-tabs { display: flex; gap: 4px; flex-wrap: wrap; padding: 4px; border-radius: 11px; background: var(--bg2);
  border: 1px solid #000; border-bottom-color: var(--ui2); box-shadow: inset 0 2px 4px rgba(0,0,0,.5); }
.ins-tab { display: inline-flex; align-items: center; gap: 7px; background: none; border: 1px solid transparent; color: var(--tx1b);
  border-radius: 8px; padding: 6px 13px; cursor: pointer; transition: background .12s, color .12s; }
.ins-tab .ins-ic { color: var(--tc); opacity: .75; }
.ins-tab:hover { color: var(--hi); background: rgba(255,255,255,.03); }
.ins-tab.on { color: var(--hi); background: var(--ui2); background: color-mix(in srgb, var(--tc) 24%, var(--ui));
  border-color: color-mix(in srgb, var(--tc) 55%, transparent); border-bottom-color: rgba(0,0,0,.6);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,.4); }
.ins-tab.on .ins-ic { opacity: 1; }
.ins-meta { margin-left: auto; color: var(--tx2); font-size: 12px; display: flex; align-items: center; gap: 8px; }
.ins-btn { display: inline-flex; align-items: center; gap: 6px; background: linear-gradient(180deg, var(--ui2), var(--ui)); color: var(--tx);
  border: 1px solid #0b0a0a; border-top-color: var(--ui3); border-radius: 8px; padding: 5px 11px; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0,0,0,.5); }
.ins-btn:hover { color: var(--hi); border-top-color: var(--tx3); }
.ins-btn:disabled { opacity: .6; cursor: default; }
.ins-btn.big { padding: 8px 16px; font-size: 14px; }
.ins-ic { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.ins-progress { padding: 50px 0; text-align: center; color: var(--tx2); }
.ins-progress .bar { width: 260px; max-width: 80%; height: 6px; margin: 14px auto 0; background: var(--bg2); border-radius: 3px; overflow: hidden;
  box-shadow: inset 0 1px 2px rgba(0,0,0,.6); }
.ins-progress .bar i { display: block; width: 40%; height: 100%; background: var(--acc); border-radius: 3px; animation: insSlide 1.1s ease-in-out infinite; }
@keyframes insSlide { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
.ins-error { padding: 14px 16px; border: 1px solid #6b2620; background: #2a1513; border-radius: 10px; color: #f0c9c3; }

.ins-card { position: relative; background: linear-gradient(180deg, #2D2C2A 0, var(--ui) 64px); border: 1px solid #0d0c0c; border-top-color: #48463F;
  border-radius: 13px; padding: 14px 16px 15px; min-width: 0; margin-bottom: 14px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65); }
.ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ins-grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 14px; margin-bottom: 14px; }
.ins-grid > .ins-card, .ins-grid3 > .ins-card, .ins-grid > div > .ins-card:last-child { margin-bottom: 0; }
.ins-ch { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
.ins-ch b { font-size: 15px; color: var(--hi); font-weight: 600; }
.ins-ch .r { margin-left: auto; display: flex; align-items: center; gap: 6px; color: var(--tx2); font-size: 12px; flex-wrap: wrap; }
.ins-badge { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; flex: none;
  color: var(--c, var(--acc)); background: var(--ui2); background: color-mix(in srgb, var(--c, var(--acc)) 17%, var(--ui));
  border: 1px solid color-mix(in srgb, var(--c, var(--acc)) 30%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.07); }
.ins-sub { color: var(--tx2); font-size: 12px; margin: 0 0 12px 38px; line-height: 1.45; }
.ins-note { color: var(--tx2); font-size: 12px; margin-top: 10px; line-height: 1.5; }
.ins-empty { color: var(--tx2); padding: 10px 0; }

.ins-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 22px; align-items: center; padding: 20px 22px; }
.ins-hero .k { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; letter-spacing: .08em; color: var(--c, var(--acc)); }
.ins-hero .big { font-size: 40px; font-weight: 700; line-height: 1.05; margin: 6px 0 6px; color: var(--hi); letter-spacing: -.02em; }
.ins-hero .s { color: var(--tx1b); line-height: 1.55; max-width: 720px; }
.ins-hero .s b { color: var(--hi); font-weight: 600; }
.ins-legend2 { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 12px; color: var(--tx1b); }
.ins-legend2 i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }

.ins-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ins-tile { position: relative; overflow: hidden; padding: 12px 14px 12px 18px; margin: 0; }
.ins-tile::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c); box-shadow: 0 0 12px var(--c); }
.ins-tile .l { display: flex; align-items: center; gap: 7px; color: var(--tx2); font-size: 12px; }
.ins-tile .l .ins-ic { color: var(--c); }
.ins-tile .v { font-size: 25px; font-weight: 700; line-height: 1.2; margin: 4px 0 2px; color: var(--hi); font-variant-numeric: tabular-nums; }
.ins-tile .s { color: var(--tx1b); font-size: 12px; }
.ins-tile .s .warn { color: var(--ye); }
.ins-tile.click { cursor: pointer; } .ins-tile.click:hover { border-top-color: var(--tx3); }

.ins-well { background: var(--bg2); border: 1px solid #000; border-bottom-color: var(--ui2); border-radius: 10px; padding: 10px 12px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.5); }
.ins-chip { background: var(--bg2); border: 1px solid #000; border-bottom-color: var(--ui2); color: var(--tx1b); border-radius: 7px;
  padding: 3px 10px; font-size: 12px; cursor: pointer; }
.ins-chip:hover { color: var(--hi); }
.ins-chip.on { color: var(--hi); background: color-mix(in srgb, var(--c, var(--acc)) 22%, var(--ui2)); border-color: color-mix(in srgb, var(--c, var(--acc)) 50%, transparent);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.ins-nav { background: var(--bg2); border: 1px solid #000; border-bottom-color: var(--ui2); color: var(--tx1b); border-radius: 7px; width: 28px; height: 26px; cursor: pointer; line-height: 1; }
.ins-nav:disabled { opacity: .35; cursor: default; }

/* bar charts: every bar carries its value and its label */
.ins-chart { padding: 10px 10px 6px; }
.ins-bars { display: flex; align-items: flex-end; gap: 3px; border-bottom: 1px solid var(--ui3); }
.ins-bar { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; position: relative; }
.ins-bar i { display: block; width: 100%; max-width: 46px; border-radius: 3px 3px 0 0; background: var(--c, var(--acc)); min-height: 2px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.22), inset 0 -6px 10px -6px rgba(0,0,0,.35); transition: filter .12s; }
.ins-bar.zero i { background: var(--ui3); box-shadow: none; }
.ins-bar.hi i { background: #F0A8C8; background: color-mix(in srgb, var(--c, var(--acc)) 55%, #FFFCF0); }
.ins-bar.click { cursor: pointer; } .ins-bar.click:hover i { filter: brightness(1.22); }
.ins-bar em { font-style: normal; font-size: 10.5px; color: var(--tx1b); margin-bottom: 3px; white-space: nowrap; font-variant-numeric: tabular-nums; line-height: 1; }
.ins-bar.zero em { color: var(--tx3); }
.ins-bar.future i { background: transparent; } .ins-bar.future em { visibility: hidden; }
.ins-xl { display: flex; gap: 3px; margin-top: 5px; }
.ins-xl span { flex: 1; min-width: 0; text-align: center; font-size: 10.5px; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: clip; }
.ins-chart.dense .ins-bar em { writing-mode: vertical-rl; transform: rotate(180deg); margin-bottom: 4px; font-size: 10px; }
.ins-chart.dense .ins-xl span { writing-mode: vertical-rl; transform: rotate(180deg); height: 34px; text-align: right; font-size: 10px; overflow: visible; }

/* horizontal rows: label, bar, value */
.ins-row { display: grid; grid-template-columns: var(--lw, minmax(90px, 160px)) minmax(0, 1fr) var(--vw, 72px); gap: 10px; align-items: center;
  min-height: 30px; padding: 2px 8px; margin: 0 -8px; border-radius: 7px; font-size: 13px; }
.ins-row.has-ic { grid-template-columns: 26px var(--lw, minmax(90px, 160px)) minmax(0, 1fr) var(--vw, 72px); }
.ins-row.click { cursor: pointer; } .ins-row.click:hover { background: rgba(255,255,255,.04); }
.ins-row .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 7px; min-width: 0; }
.ins-row .l span { overflow: hidden; text-overflow: ellipsis; }
.ins-row .v { text-align: right; color: var(--tx); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-row .v small { color: var(--tx2); font-size: 11px; margin-left: 4px; }
.ins-trk { height: 9px; border-radius: 5px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,.6); overflow: hidden; }
.ins-trk i { display: block; height: 100%; border-radius: 5px; background: var(--c, var(--acc)); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ins-dual { display: flex; flex-direction: column; gap: 3px; }
.ins-dual .ins-trk:first-child { height: 6px; } .ins-dual .ins-trk:first-child i { background: var(--tx3); box-shadow: none; }

/* the Files tab reads like a console */
.ins-con { font-family: ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
.ins-con .ins-row { font-size: 12px; min-height: 26px; }
.ins-con .hd { display: flex; justify-content: space-between; color: var(--tx2b); letter-spacing: .08em; font-size: 11px; margin-bottom: 4px; }
.ins-con table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.ins-con th, .ins-con td { padding: 4px 6px; text-align: right; font-weight: 400; white-space: nowrap; }
.ins-con th { color: var(--tx2b); font-size: 11px; letter-spacing: .06em; }
.ins-con td:first-child, .ins-con th:first-child { text-align: left; }
.ins-con tr + tr td { border-top: 1px solid #262524; }
.ins-con tr.click { cursor: pointer; } .ins-con tr.click:hover td { background: rgba(255,255,255,.03); }
.ins-strip { display: flex; flex-wrap: wrap; gap: 8px 26px; margin-bottom: 14px; padding: 12px 16px; }
.ins-strip span { color: var(--tx2b); margin-right: 6px; letter-spacing: .06em; font-size: 11px; }
.ins-strip b { color: var(--hi); font-weight: 500; }
.ins-strip .warn b { color: var(--ye); }
.ins-li { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 6px 8px; margin: 0 -8px;
  border-radius: 7px; min-height: 40px; }
.ins-li + .ins-li { border-top: 1px solid #222120; }
.ins-li.click { cursor: pointer; } .ins-li.click:hover { background: rgba(255,255,255,.04); }
.ins-li .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tx); }
.ins-li .sub { color: var(--tx2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-li .v { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-li.av { grid-template-columns: 36px minmax(0, 1fr) auto; }
.ins-th { width: 48px; height: 28px; border-radius: 5px; object-fit: cover; background: var(--ui2); display: block; box-shadow: 0 1px 3px rgba(0,0,0,.5); }
.ins-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; background: var(--ui3); display: flex; align-items: center; object-position: top;
  justify-content: center; font-size: 11px; font-weight: 700; color: var(--tx); overflow: hidden; box-shadow: 0 0 0 2px var(--ui), 0 0 0 3px var(--c, var(--ui3)); }
.ins-av.sm { width: 24px; height: 24px; font-size: 9px; }
.ins-sq { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--c, var(--tx1b));
  background: color-mix(in srgb, var(--c, var(--tx2)) 15%, var(--bg2)); box-shadow: inset 0 1px 2px rgba(0,0,0,.4); }

.ins-lift { display: inline-block; min-width: 48px; text-align: center; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
.ins-lift.up { background: #2B3016; color: var(--up); } .ins-lift.down { background: #3A1C19; color: var(--down); }
.ins-lift.even { background: var(--ui2); color: var(--tx1b); }
.ins-pulls { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px; }
.ins-pull { padding: 10px 12px; cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; }
.ins-pull:hover { border-bottom-color: var(--tx3); }
.ins-pull .k { color: var(--tx2b); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; grid-column: 1 / -1; }
.ins-pull .n { font-size: 14px; font-weight: 600; color: var(--hi); display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ins-pull .d { color: var(--tx2); font-size: 12px; grid-column: 1 / -1; }
.ins-dims { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; align-items: center; }
.ins-dims .g { color: var(--tx2b); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; margin-right: 4px; min-width: 76px; }

.ins-cal { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 1fr); gap: 3px; }
.ins-cal i { display: block; aspect-ratio: 1; border-radius: 3px; background: var(--h0); cursor: pointer; }
.ins-cal i.f { background: transparent; cursor: default; }
.ins-cal i.today { outline: 1.5px solid var(--hi); outline-offset: -1.5px; }
.ins-cal i:hover:not(.f) { outline: 1.5px solid #F4A4C2; outline-offset: -1.5px; }
.ins-calm { display: grid; gap: 3px; font-size: 10.5px; color: var(--tx2); margin-bottom: 4px; }
.ins-calm span { white-space: nowrap; overflow: visible; }
.ins-calm b { color: var(--tx); font-weight: 600; margin-left: 3px; }
.ins-legend { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--tx2); }
.ins-legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.ins-hm { display: grid; grid-template-columns: 34px repeat(24, minmax(0, 1fr)) 34px; gap: 2px; align-items: center; font-size: 10px; color: var(--tx2); }
.ins-hm i { display: block; height: 16px; border-radius: 3px; background: var(--h0); }
.ins-hm .t { text-align: right; color: var(--tx); font-variant-numeric: tabular-nums; }
.ins-hm .c { text-align: center; color: var(--tx1b); font-variant-numeric: tabular-nums; }
.ins-day { position: relative; height: 36px; margin: 10px 0 4px; }
.ins-day .axis { position: absolute; left: 0; right: 0; top: 16px; height: 4px; border-radius: 2px; background: var(--bg2); box-shadow: inset 0 1px 1px rgba(0,0,0,.6); }
.ins-day .dot { position: absolute; top: 10px; width: 16px; height: 16px; margin-left: -8px; border-radius: 50%; border: 2px solid var(--ui); cursor: pointer; }
.ins-day .dot.o { background: var(--ma); } .ins-day .dot.p { background: var(--cy); width: 12px; height: 12px; top: 12px; margin-left: -6px; }
.ins-hours { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--tx2); }
.ins-stats { display: flex; gap: 22px; flex-wrap: wrap; margin: 6px 0 0 38px; }
.ins-stats span { color: var(--tx2); font-size: 12px; } .ins-stats b { display: block; color: var(--hi); font-size: 19px; font-weight: 700; }
.ins-week { display: flex; align-items: flex-end; gap: 6px; height: 112px; }
.ins-week div { width: 26px; text-align: center; font-size: 11px; color: var(--tx2); display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.ins-week i { display: block; border-radius: 5px; background: var(--ma); box-shadow: inset 0 1px 0 rgba(255,255,255,.2); margin: 3px 0 4px; }
.ins-week i.z { background: var(--ui3); box-shadow: none; }
.ins-week b { color: var(--hi); font-weight: 600; }
.ins-week .today { color: var(--hi); }
.ins-ring { position: relative; flex: none; border-radius: 50%; background: var(--bg2); box-shadow: inset 0 3px 8px rgba(0,0,0,.6), 0 1px 0 rgba(255,255,255,.05); }
.ins-ring svg { position: absolute; inset: 0; }
.ins-ring .mid { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ins-ring .mid b { font-size: 26px; color: var(--hi); line-height: 1.05; }
.ins-ring .mid span { font-size: 11px; color: var(--tx2); }
.ins-notable { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
.ins-nb { margin: 0; padding: 11px 13px; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 2px 10px; align-items: center; }
.ins-nb .ins-sq { grid-row: span 3; align-self: start; }
.ins-nb .l { font-size: 11px; color: var(--tx2); text-transform: uppercase; letter-spacing: .06em; }
.ins-nb .v { font-size: 17px; font-weight: 700; color: var(--hi); }
.ins-nb .s { font-size: 12px; color: var(--tx1b); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-tm { display: flex; flex-wrap: wrap; gap: 4px; height: 168px; align-content: stretch; }
.ins-tm div { border-radius: 7px; padding: 7px 9px; font-size: 12px; color: #100F0F; overflow: hidden; cursor: pointer; min-width: 60px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.25), inset 0 -2px 0 rgba(0,0,0,.2); }
.ins-tm div:hover { filter: brightness(1.12); }
.ins-tm b { display: block; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ins-chk { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 9px 8px; margin: 0 -8px; border-radius: 7px; }
.ins-chk + .ins-chk { border-top: 1px solid #222120; }
.ins-chk.click { cursor: pointer; } .ins-chk.click:hover { background: rgba(255,255,255,.04); }
.ins-chk .n { color: var(--tx); } .ins-chk .sub { color: var(--tx2); font-size: 12px; margin-top: 1px; }
.ins-chk .v { font-variant-numeric: tabular-nums; color: var(--hi); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ins-chk .more { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 5px; }
.ins-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: var(--bg2);
  border: 1px solid #000; border-bottom-color: var(--ui2); color: var(--tx1b); cursor: pointer; }
.ins-pill:hover { color: var(--hi); }
.ins-go { color: var(--bl); font-size: 12px; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.ins-go .ins-ic { width: 13px; height: 13px; }
.ins-go:hover { color: #6FA3D6; }
.ins-cc { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 18px; padding: 0 4px; border-radius: 4px;
  background: var(--ui3); color: var(--tx); font-size: 10px; font-weight: 700; letter-spacing: .05em; flex: none; }
/* Stash positions .fi absolutely inside its own cards; ours sit in the text */
.ins-flag { position: static !important; display: inline-block !important; width: 22px !important; height: 16px !important; margin: 0 !important;
  line-height: 16px; border-radius: 3px; flex: none; background-size: cover !important; filter: none !important;
  box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.4); }
.ins-split { display: flex; height: 14px; border-radius: 7px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,.6); margin: 4px 0 8px; }
.ins-split i { display: block; height: 100%; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ins-banner { display: flex; align-items: center; gap: 12px; padding: 12px 16px; margin-bottom: 14px; --c: var(--cy); }
.ins-banner .ins-btn { margin-left: auto; }
.ins-scroll { max-height: 420px; overflow-y: auto; overflow-x: hidden; padding: 0 8px; margin: 0 -8px;
  scrollbar-width: thin; scrollbar-color: var(--ui3) transparent; }
.ins-scroll::-webkit-scrollbar { width: 8px; } .ins-scroll::-webkit-scrollbar-thumb { background: var(--ui3); border-radius: 4px; }
/* 2.2 What works: a sidebar of dimensions, rows with a bar centred on 1x */
.ins-ww { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 16px; align-items: start; }
.ins-side { display: flex; flex-direction: column; gap: 1px; position: sticky; top: 60px; }
.ins-side .h { font-size: 10.5px; color: var(--tx2b); letter-spacing: .09em; margin: 8px 8px 4px; }
.ins-side .h:first-child { margin-top: 0; }
.ins-side-b { text-align: left; background: none; border: 0; color: var(--tx1b); padding: 5px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
.ins-side-b:hover { color: var(--hi); background: rgba(255,255,255,.03); }
.ins-side-b.on { color: var(--hi); background: color-mix(in srgb, var(--gr) 18%, var(--ui)); box-shadow: inset 3px 0 0 var(--gr); }
.ins-wbody { min-width: 0; max-width: 980px; }
.ins-lr { display: grid; grid-template-columns: 26px minmax(110px, 210px) minmax(140px, 1fr) 170px 52px; gap: 12px; align-items: center;
  min-height: 32px; padding: 2px 8px; border-radius: 7px; font-size: 13px; }
.ins-lr.click { cursor: pointer; } .ins-lr.click:hover { background: rgba(255,255,255,.04); }
.ins-lr .rk { text-align: right; color: var(--tx3); font-size: 11px; font-variant-numeric: tabular-nums; }
.ins-lr .l { display: flex; align-items: center; gap: 7px; min-width: 0; overflow: hidden; white-space: nowrap; }
.ins-lr .l span { overflow: hidden; text-overflow: ellipsis; }
.ins-lr .nums { color: var(--tx2); font-size: 12px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ins-lr.top { background: color-mix(in srgb, var(--gr) 12%, transparent); box-shadow: inset 3px 0 0 var(--gr); }
.ins-lr.top .rk { color: var(--up); font-weight: 700; }
.ins-lr.top .l { color: var(--hi); font-weight: 600; }
.ins-lr.ins-axis { min-height: 22px; font-size: 11px; color: var(--tx2b); }
.ins-lr.ins-axis .l { color: var(--tx2); font-weight: 600; }
.ins-lr .ax { display: flex; justify-content: space-between; }
.ins-div { position: relative; height: 10px; border-radius: 5px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,.6); }
.ins-div::before { content: ""; position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--tx3); }
.ins-div i { position: absolute; top: 1px; bottom: 1px; border-radius: 4px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
/* 2.2 Where the space goes: a ranked list */
.ins-sr { display: grid; grid-template-columns: minmax(120px, 240px) minmax(0, 1fr) 80px 46px 96px; gap: 12px; align-items: center;
  min-height: 30px; padding: 2px 8px; border-radius: 7px; font-size: 13px; }
.ins-sr.click { cursor: pointer; } .ins-sr.click:hover { background: rgba(255,255,255,.04); }
.ins-sr .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-sr .l small { color: var(--tx2); }
.ins-sr .v { text-align: right; color: var(--hi); font-variant-numeric: tabular-nums; }
.ins-sr .p, .ins-sr .n { text-align: right; color: var(--tx2); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 2.2 Actions */
.ins-opts { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin: 4px 0 12px; font-size: 12px; color: var(--tx1b); }
.ins-seg { display: inline-flex; gap: 3px; padding: 3px; border-radius: 9px; background: var(--bg2); border: 1px solid #000; border-bottom-color: var(--ui2);
  box-shadow: inset 0 2px 4px rgba(0,0,0,.5); }
.ins-seg button { background: none; border: 0; color: var(--tx1b); padding: 4px 11px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.ins-seg button.on { color: var(--hi); background: color-mix(in srgb, var(--bl) 26%, var(--ui2)); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.4); }
.ins-tog { display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; color: var(--tx1b); cursor: pointer; font-size: 12px; padding: 0; text-align: left; }
.ins-tog i { position: relative; width: 30px; height: 16px; border-radius: 8px; background: var(--ui3); box-shadow: inset 0 1px 2px rgba(0,0,0,.5); flex: none; transition: background .12s; }
.ins-tog i::after { content: ""; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--tx1b); transition: left .12s; }
.ins-tog.on i { background: var(--gr); } .ins-tog.on i::after { left: 16px; background: var(--hi); }
.ins-tog:disabled, .ins-seg button:disabled { opacity: .5; cursor: default; }
.ins-sum { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; margin-bottom: 10px; font-size: 12px; }
.ins-sum em { font-style: normal; color: var(--tx2b); letter-spacing: .06em; margin-right: 7px; font-size: 11px; }
.ins-sum b { color: var(--hi); font-weight: 600; }
.ins-dups { max-height: 560px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--ui3) transparent; }
.ins-dg { padding: 6px 0; } .ins-dg + .ins-dg { border-top: 1px solid #262524; }
.ins-dg.review { background: color-mix(in srgb, var(--ye) 6%, transparent); border-radius: 8px; padding: 6px 6px; }
.ins-dg .why { color: var(--ye); font-size: 12px; display: flex; align-items: center; gap: 6px; margin: 0 0 4px 30px; }
.ins-cp { display: grid; grid-template-columns: 20px 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; min-height: 34px; font-size: 12.5px; }
.ins-cp .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-cp .m { color: var(--tx2); }
.ins-cp .v { text-align: right; color: var(--tx2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ins-k { display: inline-block; min-width: 54px; text-align: center; font-size: 10px; font-weight: 700; letter-spacing: .05em; padding: 1px 6px; border-radius: 4px; margin-right: 8px; }
.ins-k.keep { background: #2B3016; color: var(--up); } .ins-k.del { background: #3A1C19; color: var(--down); } .ins-k.look { background: #3A3014; color: var(--ye); }
.ins-bx { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--tx3); background: var(--bg2); cursor: pointer; padding: 0; position: relative;
  box-shadow: inset 0 1px 2px rgba(0,0,0,.6); }
.ins-bx.on { background: var(--re); border-color: #AF3029; }
.ins-bx.on::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid #100F0F; border-width: 0 2px 2px 0; transform: rotate(45deg); }
.ins-bx:disabled { cursor: default; opacity: .6; }
.ins-btns { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; align-items: center; margin-top: 12px; }
.ins-btn.danger { background: linear-gradient(180deg, #D14D41, #AF3029); color: #100F0F; font-weight: 600; border-top-color: #E8705F; }
.ins-btn.danger:hover { color: #100F0F; filter: brightness(1.08); }
.ins-btn.danger.armed { background: linear-gradient(180deg, #E8705F, #D14D41); box-shadow: 0 0 0 3px color-mix(in srgb, var(--re) 35%, transparent), 0 1px 2px rgba(0,0,0,.5); }
.ins-btn:disabled { opacity: .45; cursor: default; filter: none; }
.ins-run { display: flex; align-items: center; gap: 12px; margin-top: 12px; font-size: 12px; color: var(--tx1b); }
.ins-run .bar { flex: 0 0 220px; height: 8px; border-radius: 4px; background: var(--bg2); box-shadow: inset 0 1px 2px rgba(0,0,0,.6); overflow: hidden; }
.ins-run .bar i { display: block; height: 100%; background: var(--re); border-radius: 4px; transition: width .2s; }
@media (max-width: 900px) { .ins-ww { grid-template-columns: minmax(0, 1fr); } .ins-side { position: static; flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .ins-side .h { width: 100%; } .ins-lr { grid-template-columns: 22px minmax(90px, 140px) minmax(80px, 1fr) 48px; } .ins-lr .nums { display: none; }
  .ins-sr { grid-template-columns: minmax(90px, 150px) minmax(0, 1fr) 70px; } .ins-sr .p, .ins-sr .n { display: none; } }
.ins-foot { color: var(--tx3); font-size: 11px; text-align: center; padding: 4px 0 8px; }
#ins-tip { position: fixed; z-index: 2000; pointer-events: none; background: #1C1B1A; border: 1px solid #403E3C; color: #E6E4D9;
  border-radius: 8px; padding: 7px 10px; font-size: 12px; line-height: 1.5; max-width: 320px; box-shadow: 0 10px 28px rgba(0,0,0,.6);
  display: none; white-space: pre-line; }
@media (max-width: 700px) { .ins-hero { grid-template-columns: minmax(0, 1fr); } .ins-hero .big { font-size: 32px; }
  .ins-grid, .ins-grid3 { grid-template-columns: minmax(0, 1fr); } .ins-sub, .ins-stats { margin-left: 0; } }
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

  const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || "").toUpperCase()).join("");
  // Stash serves a placeholder for performers without an image, marked default=true.
  const hasImage = (p) => p && p.image && !/default=true/.test(p.image);
  const avatar = (p, cls = "") => (hasImage(p) ? `<img class="ins-av ${cls}" src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="ins-av ${cls}">${esc(initials(p && p.name))}</span>`);
  const thumb = (s) => (s && s.shot ? `<img class="ins-th" src="${esc(s.shot)}" alt="" loading="lazy">` : `<span class="ins-th"></span>`);
  const fmtDate = (ms, o = { month: "short", day: "numeric", year: "numeric" }) => new Date(ms).toLocaleDateString(undefined, o);
  const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtN = (n) => (n ?? 0).toLocaleString();
  const fmtMbps = (bps) => (bps ? `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)}` : "–");
  const plural = (n, w, ws = `${w}s`) => `${fmtN(n)} ${n === 1 ? w : ws}`;

  function regionName(code) {
    try { return /^[A-Z]{2}$/.test(code) ? new Intl.DisplayNames(undefined, { type: "region" }).of(code) || code : code; }
    catch (_) { return code; }
  }
  // Stash ships the flag-icons stylesheet (it shows flags on performer
  // cards), so a real flag is one class away; Windows has no flag emoji.
  // If a Stash without it turns up, a code badge stands in.
  let flagOk = null;
  function flagsAvailable() {
    if (flagOk !== null) return flagOk;
    try {
      const t = document.createElement("span");
      t.className = "fi fi-us";
      t.style.cssText = "position:absolute;visibility:hidden";
      document.body.appendChild(t);
      flagOk = /url\(/.test(getComputedStyle(t).backgroundImage || "");
      t.remove();
    } catch (_) { flagOk = false; }
    return flagOk;
  }
  const flag = (code) => (/^[A-Z]{2}$/.test(code || "") && flagsAvailable()
    ? `<span class="fi fi-${code.toLowerCase()} ins-flag" title="${esc(code)}"></span>`
    : `<span class="ins-cc">${esc(code || "?")}</span>`);

  // A card: icon badge in the card's colour, title, controls on the right.
  function card(o, body) {
    return `<section class="ins-card ${o.cls || ""}" ${o.id ? `id="${o.id}"` : ""} style="--c:var(--${o.c || "acc"})">
      <div class="ins-ch"><span class="ins-badge">${ic(o.icon || "list")}</span><b>${o.title}</b>${o.right ? `<span class="r">${o.right}</span>` : ""}</div>
      ${o.sub ? `<div class="ins-sub">${o.sub}</div>` : ""}${body}</section>`;
  }
  function tile(icon, c, label, value, sub, go, tip) {
    return `<div class="ins-card ins-tile${go ? " click" : ""}" style="--c:var(--${c})" ${go ? `data-go="${esc(go)}"` : ""} ${tip ? `data-tip="${esc(tip)}"` : ""}>
      <div class="l">${ic(icon)}${esc(label)}</div><div class="v">${value}</div><div class="s">${sub || ""}</div></div>`;
  }

  // Vertical bars, each with its value above and its label below. Past 16
  // bars both turn sideways so every one still fits and can be read.
  const CLICKS = [];
  function barChart(bars, o = {}) {
    const fmt = o.fmt || fmtN, h = o.height || 130;
    const max = Math.max(1, ...bars.map((b) => b.value));
    // Day numbers fit side by side even in a month; years, dates and
    // durations need turning once there are more than 16.
    const longest = Math.max(0, ...bars.map((b) => Math.max(String(b.label).length, String(fmt(b.value)).length)));
    const dense = (bars.length > 16 && longest > 2) || bars.length > 48;
    const cols = bars.map((b) => {
      const px = b.value ? Math.max(3, Math.round((b.value / max) * h)) : 2;
      const id = b.click ? CLICKS.push(b.click) - 1 : -1;
      return `<div class="ins-bar${b.value ? "" : " zero"}${b.hi ? " hi" : ""}${b.click && !b.future ? " click" : ""}${b.future ? " future" : ""}" ${id >= 0 && !b.future ? `data-bar="${id}"` : ""}
        data-tip="${esc(b.tip || `${b.label}: ${fmt(b.value)}`)}"><em>${b.value || o.zeros ? esc(fmt(b.value)) : ""}</em><i style="height:${px}px${b.color ? `;background:${b.color}` : ""}"></i></div>`;
    }).join("");
    const labels = bars.map((b) => `<span${b.future ? ' style="opacity:.4"' : ""}>${esc(b.label)}</span>`).join("");
    return `<div class="ins-well ins-chart${dense ? " dense" : ""}" ${o.c ? `style="--c:var(--${o.c})"` : ""}><div class="ins-bars" style="height:${h + (dense ? 34 : 18)}px">${cols}</div><div class="ins-xl">${labels}</div></div>`;
  }

  // Horizontal rows: [icon] label | bar | value. rows: {label or
  // labelHtml, value, text, icon, color, go (a link) or set (a control), tip}.
  function rows(list, o = {}) {
    const max = o.max || Math.max(1, ...list.map((r) => r.value));
    const anyIc = list.some((r) => r.icon);
    const style = `${o.lw ? `--lw:${o.lw};` : ""}${o.vw ? `--vw:${o.vw};` : ""}`;
    return list.map((r) => `<div class="ins-row${anyIc ? " has-ic" : ""}${r.go || r.set ? " click" : ""}" style="${style}${r.color ? `--c:${r.color}` : ""}"
      ${r.go ? `data-go="${esc(r.go)}"` : ""} ${r.set ? `data-set="${esc(r.set)}"` : ""} ${r.tip ? `data-tip="${esc(r.tip)}"` : ""}>${anyIc ? `<span>${r.icon || ""}</span>` : ""}
      <span class="l">${r.labelHtml || `<span>${esc(r.label)}</span>`}</span>
      <div class="ins-trk"><i style="width:${r.value ? Math.max(1.5, (r.value / max) * 100).toFixed(1) : 0}%"></i></div>
      <span class="v">${r.text !== undefined ? r.text : fmtN(r.value)}</span></div>`).join("");
  }

  // A ring of segments [{f (0..1), color}] around a centre value.
  function ring(segs, big, small, size = 140) {
    const r = size / 2 - 12, c = 2 * Math.PI * r;
    let off = 0;
    const arcs = segs.filter((sg) => sg.f > 0).map((sg) => {
      const len = sg.f * c, gap = segs.length > 1 ? Math.min(3, len / 3) : 0;
      const a = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${sg.color}" stroke-width="13"
        stroke-dasharray="${Math.max(0, len - gap).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      off += len;
      return a;
    }).join("");
    return `<div class="ins-ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#282726" stroke-width="13"/>${arcs}</svg>
      <div class="mid"><b>${big}</b><span>${small}</span></div></div>`;
  }

  // ═══ App ═══════════════════════════════════════════════════════════════════

  const PREF_KEY = "insightsPrefs";
  const prefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (_) { return {}; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {} };

  const TABS = [["you", "You", "user", "ma"], ["actions", "Actions", "check", "re"], ["library", "Library", "film", "or"], ["files", "Files and quality", "chip", "cy"],
                ["health", "Metadata health", "pulse", "ye"], ["collection", "Collection", "layers", "gr"]];
  const firstTab = TABS.some((t) => t[0] === prefs().tab) ? prefs().tab : "you";

  const app = {
    root: null, data: null, model: null, watch: {}, config: {}, loading: false, error: "", progress: "",
    ostats: null, tab: firstTab,
    you: { metric: "o", kind: "month", offset: 0, day: null, top: "byO", mode: "byO", dim: prefs().dim || "country",
           wmetric: "o", sort: "auto", small: false },
    lib: { timeline: "released", year: null },
    files: { space: "studio", spaceAll: false },
    acts: freshActs(),
    col: { tag: null, gender: prefs().gender || "FEMALE", studios: "networks" },
  };

  // Actions state: the last duplicate scan and what the user ticked. A
  // refresh starts it over (the scan would describe the old library).
  function freshActs() {
    return { dups: null, state: "idle", err: "", mode: "hevc", merge: true, sharp: true, ticks: new Map(), armed: false,
             run: null, showAll: false, scanned: 0, msg: "", tagMsg: "", phashMsg: "" };
  }

  function buildModel(data, watch) {
    const now = Date.now();
    const scenes = data.scenes;
    const perfById = new Map(data.performers.map((p) => [p.id, p]));
    const { events, undated } = collectOs(scenes);
    const byDay = countByDay(events);
    const tagIds = new Map(), ptagIds = new Map();
    for (const s of scenes) for (const [id, name] of s.tags) tagIds.set(name, id);
    for (const p of data.performers) for (const [id, name] of p.tags) ptagIds.set(name, id);
    const memo = new Map();
    return {
      now, scenes, perfById, performers: data.performers, studios: data.studios || [], counts: data.counts || {}, stats: data.stats || {},
      events, undated, byDay, tagIds, ptagIds,
      st: streaks(byDay, now), record: recordDay(byDay), cal: calendar(byDay, now), wh: weekdayHour(events),
      people: performerTable(scenes, perfById, now), top: topScenes(scenes, now), lib: library(scenes),
      ratings: ratingBands(scenes), backlog: backlog(scenes, now), traits: new Map(),
      watchByDay: new Map(Object.entries(watch || {})), watch: watch || {},
      // The rest is worked out the first time a tab needs it.
      get: (k, fn) => { if (!memo.has(k)) memo.set(k, fn()); return memo.get(k); },
    };
  }

  const ALL_DIMS = PERFORMER_TRAITS.concat(SCENE_TRAITS);
  function traits(dimId) {
    const m = app.model;
    if (!m.traits.has(dimId)) m.traits.set(dimId, traitRows(m.scenes, m.perfById, ALL_DIMS.find((d) => d.id === dimId)));
    return m.traits.get(dimId);
  }

  const S = (criteria, sort = "date", dir = "desc") => listUrl("/scenes", criteria, sort, dir);
  const P = (criteria, sort = "scenes_count") => listUrl("/performers", criteria, sort);
  const items = (id, label) => ({ items: [{ id, label }], excluded: [], depth: 0 });

  // Where a trait row leads: a filtered performer or scene list, or nowhere.
  function traitLink(dimId, value) {
    const m = app.model;
    const range = (txt) => (String(txt).match(/\d+/g) || []).map(Number);
    switch (dimId) {
      case "country": return P([{ type: "country", modifier: "EQUALS", value }]);
      case "ethnicity": return P([{ type: "ethnicity", modifier: "EQUALS", value }]);
      case "hair": return P([{ type: "hair_color", modifier: "EQUALS", value }]);
      case "eyes": return P([{ type: "eye_color", modifier: "EQUALS", value }]);
      case "tattoos": return P([{ type: "tattoos", modifier: value === "tattoos" ? "NOT_NULL" : "IS_NULL" }]);
      case "piercings": return P([{ type: "piercings", modifier: value === "piercings" ? "NOT_NULL" : "IS_NULL" }]);
      case "favourite": return P([{ type: "filter_favorites", value: value === "favourites" ? "true" : "false" }]);
      case "height": { const n = range(value); return P([n.length === 2 ? { type: "height_cm", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                      : /under/.test(value) ? { type: "height_cm", modifier: "LESS_THAN", value: { value: n[0] } }
                                                      : { type: "height_cm", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }]); }
      case "ptags": { const id = m.ptagIds.get(value); return id ? P([{ type: "tags", modifier: "INCLUDES", value: items(id, value) }]) : null; }
      case "age": { const n = range(value); return S([n.length === 2 ? { type: "performer_age", modifier: "BETWEEN", value: { value: n[0], value2: n[1] } }
                                                   : { type: "performer_age", modifier: "GREATER_THAN", value: { value: n[0] - 1 } }], "o_counter"); }
      case "tags": { const id = m.tagIds.get(value); return id ? S([{ type: "tags", modifier: "INCLUDES", value: items(id, value) }], "o_counter") : null; }
      case "studio": { const st = m.scenes.find((s) => s.studio && s.studio.name === value); return st ? S([{ type: "studios", modifier: "INCLUDES", value: items(st.studio.id, value) }], "o_counter") : null; }
      case "cast": return S([value === "solo" ? { type: "performer_count", modifier: "EQUALS", value: { value: 1 } }
                          : value === "two performers" ? { type: "performer_count", modifier: "EQUALS", value: { value: 2 } }
                          : { type: "performer_count", modifier: "GREATER_THAN", value: { value: 2 } }], "o_counter");
      case "era": { const n = range(value); return S([n.length === 2 ? { type: "date", modifier: "BETWEEN", value: { value: `${n[0]}-01-01`, value2: `${n[1]}-12-31` } }
                                                   : { type: "date", modifier: "LESS_THAN", value: { value: "2005-01-01" } }], "o_counter"); }
      case "interactive": return S([{ type: "interactive", value: value === "interactive" ? "true" : "false" }], "o_counter");
      default: return null;
    }
  }
  const traitLabel = (dimId, value) => (dimId === "country" ? regionName(value) : value);
  const traitIcon = (dimId, value) => (dimId === "country" ? flag(value) : "");

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const root = app.root;
    if (!root) return;
    CLICKS.length = 0;
    root.dataset.tab = app.tab;
    const ago = app.data ? Math.max(0, Math.round((Date.now() - app.data.at) / 60000)) : null;
    root.innerHTML = `
      <div class="ins-head"><span class="ins-title">${ic("spark")}Insights</span>
        <div class="ins-tabs">${TABS.map(([id, label, icon, c]) => `<button class="ins-tab${app.tab === id ? " on" : ""}" style="--tc:var(--${c})" data-tab="${id}">${ic(icon)}${label}</button>`).join("")}</div>
        <div class="ins-meta">${ago === null ? "" : `updated ${ago ? `${ago} min ago` : "just now"}`}
          <button class="ins-btn" data-act="refresh" data-tip="Read the library again">${ic("refresh")} Refresh</button></div></div>
      <div class="ins-body"></div>
      <div class="ins-foot">Every bar, row and tile opens the matching list in Stash. Worked out in your browser; nothing leaves it.</div>`;
    const body = root.querySelector(".ins-body");
    if (app.error) { body.innerHTML = `<div class="ins-error">Insights could not load your library: ${esc(app.error)}. <button class="ins-btn" data-act="refresh">Try again</button></div>`; return; }
    if (!app.model) { body.innerHTML = `<div class="ins-progress">${esc(app.progress || "Getting ready…")}<div class="bar"><i></i></div></div>`; return; }
    ({ you: renderYou, actions: renderActions, library: renderLibrary, files: renderFiles, health: renderHealth, collection: renderCollection }[app.tab] || renderYou)(body);
  }

  const chipFor = (grp, key, v, label, c) => `<button class="ins-chip${app[grp][key] === v ? " on" : ""}" ${c ? `style="--c:var(--${c})"` : ""} data-set="${grp}.${key}=${v}">${label}</button>`;
  const go = (url, label = "Open") => `<span class="ins-go" data-go="${esc(url)}">${esc(label)}${ic("arrow")}</span>`;

  function importBanner() {
    if (!app.ostats || app.config.ostatsImported === "true") return "";
    return `<div class="ins-card ins-banner"><span class="ins-badge">${ic("clock")}</span><span>Found <b>${app.ostats.days}</b> days of watch time from the O Stats plugin.
      Bring them in so your watch history starts where it left off.</span><button class="ins-btn" data-act="import">Import</button></div>`;
  }

  // ── You ───────────────────────────────────────────────────────────────────

  const RAMP = { o: ["#282726", "#3E1C2E", "#6B2A4C", "#A02F6F", "#CE5D97", "#F4A4C2"],
                 watch: ["#282726", "#14302D", "#1C5A54", "#24837B", "#3AA99F", "#87D3C3"],
                 hour: ["#282726", "#2A2640", "#3F3765", "#5E409D", "#8B7EC8", "#C4B9F0"] };
  function heat(v, max, ramp) {
    if (v <= 0) return ramp[0];
    const r = v / max;
    return ramp[r < 0.2 ? 1 : r < 0.4 ? 2 : r < 0.6 ? 3 : r < 0.85 ? 4 : 5];
  }
  const os = (n) => `${fmtN(n)} O${n === 1 ? "" : "'s"}`;

  function weekSum(m, off) {
    let v = 0;
    const ws = addDays(weekStart(m.now), off * 7);
    for (let i = 0; i < 7; i++) v += m.byDay.get(dayKey(addDays(ws, i))) || 0;
    return v;
  }
  function monthSum(m, off) {
    const d = new Date(m.now), from = new Date(d.getFullYear(), d.getMonth() + off, 1).getTime(), to = new Date(d.getFullYear(), d.getMonth() + off + 1, 1).getTime();
    let v = 0;
    for (let x = from; x < to; x = addDays(x, 1)) v += m.byDay.get(dayKey(x)) || 0;
    return v;
  }

  function weekMini(m) {
    const ws = weekStart(m.now), today = dayKey(m.now);
    const vals = Array.from({ length: 7 }, (_, i) => { const d = addDays(ws, i); return { d, k: dayKey(d), v: m.byDay.get(dayKey(d)) || 0 }; });
    const max = Math.max(1, ...vals.map((x) => x.v));
    return `<div class="ins-week">${vals.map((x) => `<div class="${x.k === today ? "today" : ""}" data-day="${x.k}" style="cursor:pointer"
      data-tip="${esc(fmtDate(x.d, { weekday: "long", month: "short", day: "numeric" }))}: ${os(x.v)}"><b>${x.d > m.now ? "" : x.v}</b>
      <i class="${x.v ? "" : "z"}" style="height:${x.v ? Math.max(8, Math.round((x.v / max) * 74)) : 4}px"></i>${esc(new Date(x.d).toLocaleDateString(undefined, { weekday: "narrow" }))}</div>`).join("")}</div>`;
  }

  function calendarHtml(m) {
    const cal = m.cal, today = dayKey(m.now);
    const weeks = cal.cells.length / 7;
    // month labels with that month's total, over the column its first week starts in
    const monthTotals = new Map();
    for (const c of cal.cells) if (!c.future) { const k = c.key.slice(0, 7); monthTotals.set(k, (monthTotals.get(k) || 0) + c.value); }
    let months = "";
    for (let w = 0; w < weeks; w++) {
      const d = new Date(cal.cells[w * 7].from);
      const first = w === 0 ? d.getDate() <= 7 : new Date(cal.cells[(w - 1) * 7].from).getMonth() !== d.getMonth();
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      months += `<span>${first ? `${esc(d.toLocaleDateString(undefined, { month: "short" }))}<b>${monthTotals.get(k) || 0}</b>` : ""}</span>`;
    }
    const cells = cal.cells.map((c) => c.future ? `<i class="f"></i>`
      : `<i class="${c.key === today ? "today" : ""}" style="background:${heat(c.value, cal.max, RAMP.o)}" data-day="${c.key}" data-tip="${esc(fmtDate(c.from, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}: ${os(c.value)}"></i>`).join("");
    const total = cal.cells.reduce((a, c) => a + c.value, 0);
    const legend = RAMP.o.map((col) => `<i style="background:${col}"></i>`).join("");
    return `<div class="ins-calm" style="grid-template-columns:repeat(${weeks},1fr)">${months}</div>
      <div class="ins-cal" style="grid-template-columns:repeat(${weeks},1fr)">${cells}</div>
      <div class="ins-legend" style="margin-top:10px"><span style="margin-right:auto">${os(total)} in the last 12 months${m.undated ? ` · ${fmtN(m.undated)} more without a date` : ""}</span>
        less ${legend} more</div>`;
  }

  function heatmapHtml(m) {
    const max = Math.max(1, ...m.wh.flat());
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const hl = (i) => (i === 0 ? "12a" : i < 12 ? `${i}a` : i === 12 ? "12p" : `${i - 12}p`);
    let h = `<span></span>${Array.from({ length: 24 }, (_, i) => `<span class="c">${i % 3 === 0 ? hl(i) : ""}</span>`).join("")}<span class="t">all</span>`;
    m.wh.forEach((row, d) => {
      h += `<span>${days[d]}</span>` + row.map((v, hr) => `<i style="background:${heat(v, max, RAMP.hour)}" data-tip="${days[d]} ${hl(hr)} to ${hl((hr + 1) % 24)}: ${os(v)}"></i>`).join("") +
        `<span class="t">${row.reduce((a, b) => a + b, 0)}</span>`;
    });
    const cols = Array.from({ length: 24 }, (_, hr) => m.wh.reduce((a, row) => a + row[hr], 0));
    h += `<span>all</span>${cols.map((v, hr) => `<span class="c" data-tip="${hl(hr)} to ${hl((hr + 1) % 24)}, any day: ${os(v)}">${v || ""}</span>`).join("")}<span class="t">${cols.reduce((a, b) => a + b, 0)}</span>`;
    return `<div class="ins-hm">${h}</div>`;
  }

  function statRow(icon, c, label, value, sub) {
    return `<div class="ins-chk"><span class="ins-sq" style="--c:var(--${c})">${ic(icon)}</span>
      <div><div class="n">${esc(label)}</div><div class="sub">${esc(sub || "")}</div></div><div class="v">${esc(value)}</div></div>`;
  }

  function perfRow(r, value, text, sub, max) {
    const p = r.p || { name: `Performer ${r.id}` };
    return `<div class="ins-li av click" data-go="/performers/${esc(r.id)}" data-tip="${esc(`${p.name}\n${os(r.o)} in ${plural(r.scenes, "scene")}\nplayed ${r.plays}× · watched ${fmtDur(r.watch)}`)}">
      ${avatar(p)}<div style="min-width:0"><div class="n">${esc(p.name)}</div><div class="sub">${sub}</div>
      <div class="ins-trk" style="height:5px;margin-top:4px"><i style="width:${Math.max(2, Math.round((value / Math.max(max, 1e-9)) * 100))}%"></i></div></div>
      <div class="v" style="color:var(--hi);font-weight:700">${text}</div></div>`;
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

  function renderYou(el) {
    const m = app.model, y = app.you, st = m.st;
    const today = m.byDay.get(dayKey(m.now)) || 0;
    const wk = weekSum(m, 0), lastWk = weekSum(m, -1);
    const wpo = watchPerO(m.watch, m.byDay, m.now);
    let watchWk = 0;
    for (let i = 0; i < 7; i++) watchWk += m.watch[dayKey(addDays(weekStart(m.now), i))] || 0;
    const lastToday = m.events.filter((e) => dayKey(e.t) === dayKey(m.now)).pop();
    const mo = monthSum(m, 0), lastMo = monthSum(m, -1);

    // over time
    const source = y.metric === "watch" ? m.watchByDay : m.byDay;
    const per = periodBars(source, y.kind, y.offset, m.now);
    const fmtV = y.metric === "watch" ? (v) => (v ? fmtDur(v) : "0") : fmtN;
    const pBars = per.bars.map((b) => ({ ...b, label: y.kind === "month" ? b.label : b.label,
      tip: `${y.kind === "year" ? fmtDate(b.from, { month: "long", year: "numeric" }) : fmtDate(b.from, { weekday: "short", month: "short", day: "numeric" })}: ${y.metric === "watch" ? fmtDur(b.value) : os(b.value)}`,
      hi: y.kind !== "year" && b.key === dayKey(m.now), future: b.from > m.now,
      click: y.kind === "year" ? () => { y.kind = "month"; y.offset = (new Date(b.from).getFullYear() - new Date(m.now).getFullYear()) * 12 + new Date(b.from).getMonth() - new Date(m.now).getMonth(); render(); }
                               : () => { y.day = b.key; render(); document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" }); } }));
    const pTotal = per.bars.reduce((a, b) => a + b.value, 0);

    // a day
    const day = y.day || dayKey(m.now);
    const ev = dayEvents(m.scenes, day);
    const dayO = ev.filter((e) => e.o).length, dayScenes = new Set(ev.map((e) => e.scene.id)).size;
    const isToday = day === dayKey(m.now);

    const plist = { byO: m.people.byO, byRate: m.people.byRate, byWatch: m.people.byWatch, neglected: m.people.neglected }[y.mode].slice(0, 10);
    const pmax = plist.length ? (y.mode === "byRate" ? plist[0].perScene : y.mode === "byWatch" ? plist[0].watch : Math.max(1, ...plist.map((r) => r.o))) : 1;
    const tops = { byO: m.top.byO, byPlays: m.top.byPlays, unvisited: m.top.unvisited }[y.top] || [];
    const bl = m.backlog, blMax = Math.max(1, ...bl.map((b) => b.n));
    const blIcon = { "eye-off": "eyeoff", star: "star", "player-pause": "pause", "drop-off": "dropoff", heart: "heart", folder: "folder" };
    const blColor = { unwatched: "bl", unrated: "ye", started: "cy", teasers: "or", loved: "ma", unorganized: "tx2" };

    el.innerHTML = importBanner() + `
      <section class="ins-card ins-hero" style="--c:var(--ma)">
        <div><div class="k">${ic("drop")}THIS WEEK</div><div class="big">${os(wk)}</div>
          <div class="s">${st.current ? `A <b>${st.current}-day streak</b>${st.atRisk ? ", and an O today keeps it going" : ""}. ` : st.daysSinceLast !== null ? `${plural(st.daysSinceLast, "day")} since the last O. ` : ""}
            ${st.best.len ? `Your best is <b>${plural(st.best.len, "day")}</b>. ` : ""}${lastWk || wk ? `Last week: ${os(lastWk)}. ` : ""}
            ${watchWk ? `You watched <b>${fmtDur(watchWk)}</b> this week${wpo ? `, about ${fmtDur(wpo)} per O over the last 30 days` : ""}.` : wpo ? `About <b>${fmtDur(wpo)}</b> of watching per O over the last 30 days.` : ""}</div></div>
        ${weekMini(m)}
      </section>
      <div class="ins-tiles">
        ${tile("drop", "ma", "Today", today, lastToday ? `last at ${fmtTime(lastToday.t)}` : "none yet today")}
        ${tile("calendar", "or", "This month", mo, `${os(lastMo)} last month`)}
        ${tile("flame", "ye", "Best streak", st.best.len ? plural(st.best.len, "day") : "–", st.best.len ? `${fmtDate(st.best.from, { month: "short", day: "numeric" })} to ${fmtDate(st.best.to)}` : "no dated O's yet")}
        ${tile("trophy", "cy", "Record day", m.record ? os(m.record.n) : "–", m.record ? fmtDate(parseDay(m.record.day), { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "")}
      </div>
      ${card({ title: "A year of O's", icon: "calendar", c: "ma", right: "click a day to open it" }, calendarHtml(m))}
      <div class="ins-grid">
        ${card({ title: y.metric === "watch" ? "Watch time" : "O's over time", icon: "trend", c: y.metric === "watch" ? "cy" : "ma",
          right: `${chipFor("you", "metric", "o", "O's", "ma")}${chipFor("you", "metric", "watch", "Watch time", "cy")}
            ${chipFor("you", "kind", "week", "Week")}${chipFor("you", "kind", "month", "Month")}${chipFor("you", "kind", "year", "Year")}`,
          sub: `<button class="ins-nav" data-nav="-1" aria-label="Earlier">‹</button> <b style="color:var(--hi);margin:0 8px">${esc(per.title)}</b>
            <button class="ins-nav" data-nav="1" aria-label="Later" ${y.offset >= 0 ? "disabled" : ""}>›</button>
            <span style="margin-left:10px">${y.metric === "watch" ? `${fmtDur(pTotal)} watched` : os(pTotal)} · ${y.kind === "year" ? "click a month to open it" : "click a day to see it"}</span>` },
          barChart(pBars, { fmt: fmtV, c: y.metric === "watch" ? "cy" : "ma" }) +
          (y.metric === "watch" && !Object.keys(m.watch).length ? `<div class="ins-note">Watch time counts while a scene's player plays; nothing is counted yet.</div>` : ""))}
        ${card({ title: "When", icon: "clock", c: "pu", sub: "O's by weekday and hour, with totals for each" }, heatmapHtml(m))}
      </div>
      <div class="ins-grid">
        ${card({ title: isToday ? "Today" : esc(fmtDate(parseDay(day), { weekday: "long", month: "long", day: "numeric", year: "numeric" })), icon: "calendar", c: "cy", id: "ins-otd",
          right: `<button class="ins-nav" data-daynav="-1" aria-label="Day before">‹</button><button class="ins-nav" data-daynav="1" aria-label="Day after" ${isToday ? "disabled" : ""}>›</button>` },
          `<div class="ins-stats"><span><b style="color:var(--ma)">${dayO}</b>O's</span><span><b style="color:var(--cy)">${fmtDur(m.watch[day] || 0)}</b>watched</span><span><b>${dayScenes}</b>scenes</span></div>
          <div class="ins-day"><div class="axis"></div>${ev.map((e) => {
            const d = new Date(e.t), x = ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
            return `<span class="dot ${e.o ? "o" : "p"}" style="left:${x.toFixed(2)}%" data-go="/scenes/${esc(e.scene.id)}" data-tip="${esc(fmtTime(e.t))} · ${esc(e.scene.title)}${e.o ? " · O" : " · played"}"></span>`; }).join("")}</div>
          <div class="ins-hours"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div>
          <div style="margin-top:8px">${ev.length ? ev.slice(0, 10).map((e) => `<div class="ins-li click" data-go="/scenes/${esc(e.scene.id)}">${thumb(e.scene)}
            <div style="min-width:0"><div class="n">${esc(e.scene.title)}</div><div class="sub">${esc(fmtTime(e.t))}${e.o ? "" : " · played"}</div></div>
            <div class="v">${e.o ? `<span style="color:var(--ma)">${ic("drop")}</span>` : `<span style="color:var(--cy)">${ic("play")}</span>`}</div></div>`).join("") : `<div class="ins-empty">Nothing recorded on this day.</div>`}</div>`)}
        ${card({ title: "Rhythm", icon: "flame", c: "ye" },
          statRow("flame", "or", "Current streak", plural(st.current, "day"), st.atRisk ? "an O today keeps it going" : st.current ? "still going" : st.daysSinceLast !== null ? `${plural(st.daysSinceLast, "day")} since the last O` : "") +
          statRow("trophy", "ye", "Best streak", plural(st.best.len, "day"), st.best.len ? `${fmtDate(st.best.from)} to ${fmtDate(st.best.to)}` : "") +
          statRow("calendar", "bl", "Longest break", plural(st.longestBreak, "day"), "between two days with an O") +
          statRow("clock", "cy", "Usually", st.avgGapDays ? `every ${st.avgGapDays.toFixed(1)} days` : "–", "on average, from one O day to the next") +
          statRow("drop", "ma", "Record day", m.record ? os(m.record.n) : "–", m.record ? fmtDate(parseDay(m.record.day)) : "") +
          statRow("drop", "pu", "All time", os(m.events.length + m.undated), `${fmtN(m.lib.totals.withO)} scenes have one`))}
      </div>
      ${worksCard(m, y)}
      <div class="ins-grid">
        ${card({ title: "Your performers", icon: "users", c: "ma",
          right: `${chipFor("you", "mode", "byO", "O's", "ma")}${chipFor("you", "mode", "byRate", "Per scene", "ma")}${chipFor("you", "mode", "byWatch", "Watched", "ma")}${chipFor("you", "mode", "neglected", "Gone quiet", "ma")}` },
          plist.length ? plist.map((r) => y.mode === "byRate" ? perfRow(r, r.perScene, r.perScene.toFixed(2), `${os(r.o)} in ${plural(r.scenes, "scene")}`, pmax)
            : y.mode === "byWatch" ? perfRow(r, r.watch, fmtDur(r.watch), `${os(r.o)} · ${plural(r.scenes, "scene")}`, pmax)
            : y.mode === "neglected" ? perfRow(r, r.o, r.o, r.lastO ? `favourite · last O ${fmtDate(r.lastO)}` : "favourite · no O yet", pmax)
            : perfRow(r, r.o, r.o, `${plural(r.scenes, "scene")} · played ${r.plays}×`, pmax)).join("")
            : `<div class="ins-empty">${y.mode === "neglected" ? "Every favourite has had an O in the last six months." : "Nothing here yet."}</div>`)}
        ${card({ title: "Your scenes", icon: "play", c: "or",
          right: `${chipFor("you", "top", "byO", "Most O's", "or")}${chipFor("you", "top", "byPlays", "Most played", "or")}${chipFor("you", "top", "unvisited", "Not revisited", "or")}` },
          tops.length ? tops.map((s) => `<div class="ins-li click" data-go="/scenes/${esc(s.id)}">${thumb(s)}
            <div style="min-width:0"><div class="n">${esc(s.title)}</div><div class="sub">${os(s.o)} · played ${s.plays}×${s.lastO ? ` · last O ${fmtDate(s.lastO)}` : ""}</div></div>
            <div class="v" style="color:var(--hi);font-weight:700">${y.top === "byPlays" ? `${s.plays}×` : s.o}</div></div>`).join("")
            : `<div class="ins-empty">${y.top === "unvisited" ? "No scene with two or more O's has gone three months without another." : "Nothing here yet."}</div>`)}
      </div>
      ${card({ title: "Your queue", icon: "list", c: "bl", sub: "Each opens exactly those scenes in Stash" },
        `<div class="ins-grid" style="margin:0;gap:4px 28px">${[bl.slice(0, 3), bl.slice(3)].map((half) => `<div>${rows(half.map((b) => ({
          label: b.label, value: b.n, icon: `<span class="ins-sq" style="--c:var(--${blColor[b.id]});width:26px;height:26px">${ic(blIcon[b.icon] || "folder")}</span>`,
          color: `var(--${blColor[b.id]})`, go: listUrl("/scenes", b.criteria, b.sort),
          tip: `${b.label}: ${plural(b.n, "scene")}${b.oldestDays !== null && b.n ? `\noldest added ${b.oldestDays > 365 ? `${(b.oldestDays / 365).toFixed(1)} years` : `${b.oldestDays} days`} ago` : ""}` })),
          { max: blMax, lw: "minmax(140px,200px)", vw: "64px" })}</div>`).join("")}</div>`)}`;
  }

  // ── Library ───────────────────────────────────────────────────────────────

  const RES_COLOR = { "8K": "#CE5D97", "5K+": "#8B7EC8", "4K": "#3AA99F", "1440p": "#4385BE", "1080p": "#DA702C", "720p": "#D0A215",
                      "480p": "#D14D41", "below 480p": "#AF3029" };
  const CYCLE = ["#3AA99F", "#DA702C", "#8B7EC8", "#4385BE", "#D0A215", "#879A39", "#CE5D97", "#D14D41"];
  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min} min ago`;
    if (min < 48 * 60) return plural(Math.round(min / 60), "hour") + " ago";
    if (min < 60 * 24 * 60) return plural(Math.round(min / 1440), "day") + " ago";
    return fmtDate(ms);
  }
  const resOf = (s) => resBucket(s.w, s.h) || "?";

  const LENGTHS = [[0, 300, "under 5 min"], [300, 600, "5 to 10 min"], [600, 1200, "10 to 20 min"], [1200, 1800, "20 to 30 min"],
                   [1800, 2700, "30 to 45 min"], [2700, 3600, "45 to 60 min"], [3600, 5400, "1 to 1.5 hours"], [5400, Infinity, "over 1.5 hours"]];

  function renderLibrary(el) {
    const m = app.model, L = m.lib.totals, l = app.lib, st = m.stats, c = m.counts;
    const fs = m.get("files", () => fileStats(m.scenes));
    const nb = m.get("notable", () => notable(m.scenes, m.perfById));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const share = (n) => (L.scenes ? n / L.scenes : 0);
    const imgSize = st.images_size || 0, total = L.size + imgSize;

    // where the space goes: by resolution, other copies, images
    const resSegs = RES_ORDER.filter((r) => fs.res.has(r)).map((r) => ({ label: r, size: fs.res.get(r).size, color: RES_COLOR[r] }));
    const firstFiles = resSegs.reduce((a, x) => a + x.size, 0);
    if (L.size - firstFiles > total * 0.002) resSegs.push({ label: "extra copies", size: L.size - firstFiles, color: "#6F6E69" });
    if (imgSize) resSegs.push({ label: "images", size: imgSize, color: "#879A39" });

    // release or added timeline
    const source = l.timeline === "added" ? m.lib.added : m.lib.released;
    let bars;
    if (l.year === null) {
      // fill the gaps, so a year with nothing is a visible zero, not missing
      const yrs = source.map((y) => y.year), byYear = new Map(source.map((y) => [y.year, y.n]));
      const from = yrs.length ? Math.max(Math.min(...yrs), Math.max(...yrs) - 59) : 0;
      bars = [];
      for (let yr = from; yrs.length && yr <= Math.max(...yrs); yr++) {
        const n = byYear.get(yr) || 0;
        bars.push({ value: n, label: String(yr), tip: `${yr}: ${plural(n, "scene")} ${l.timeline === "added" ? "added" : "released"}`, click: n ? () => { l.year = yr; render(); } : null });
      }
    } else {
      const counts = new Array(12).fill(0);
      for (const s of m.scenes) {
        const when = l.timeline === "added" ? (s.created ? new Date(s.created) : null) : (parseDay(s.date) !== null ? new Date(parseDay(s.date)) : null);
        if (when && when.getFullYear() === l.year) counts[when.getMonth()] += 1;
      }
      bars = counts.map((n, i) => {
        const from = `${l.year}-${pad2(i + 1)}-01`, to = dayKey(new Date(l.year, i + 1, 0).getTime());
        return { value: n, label: new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "short" }), tip: `${new Date(l.year, i, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${plural(n, "scene")}`,
                 click: n ? () => navigate(S([l.timeline === "added"
                   ? { type: "created_at", modifier: "BETWEEN", value: { value: `${from} 00:00`, value2: `${to} 23:59` } }
                   : { type: "date", modifier: "BETWEEN", value: { value: from, value2: to } }], "date", "asc")) : null };
      });
    }
    const undatedN = l.timeline === "added" ? 0 : m.scenes.filter((s) => parseDay(s.date) === null).length;

    const nbCard = (icon, cc, label, value, sub, url, tip) => value === null ? "" :
      `<div class="ins-card ins-nb${url ? " click" : ""}" style="--c:var(--${cc});${url ? "cursor:pointer" : ""}" ${url ? `data-go="${esc(url)}"` : ""} ${tip ? `data-tip="${esc(tip)}"` : ""}>
        <span class="ins-sq">${ic(icon)}</span><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
    const sc = (s) => `/scenes/${s.id}`;
    const lens = LENGTHS.map(([a, b, label]) => ({ label, value: m.scenes.filter((s) => s.dur >= a && s.dur < b && s.dur > 0).length,
      go: S([b === Infinity ? { type: "duration", modifier: "GREATER_THAN", value: { value: a } } : { type: "duration", modifier: "BETWEEN", value: { value: a, value2: b - 1 } }], "duration") }));
    const lenMax = Math.max(1, ...lens.map((x) => x.value));
    const withMarkers = c["s.markers"], inGroup = c["s.group"] === null || c["s.group"] === undefined ? null : L.scenes - c["s.group"];
    const stateRows = [
      { label: "Played", value: L.played, go: S([{ type: "play_count", modifier: "GREATER_THAN", value: { value: 0 } }], "last_played_at"), color: "var(--cy)", icon: ic("play") },
      { label: "Organized", value: L.organized, go: S([{ type: "organized", value: "true" }]), color: "var(--gr)", icon: ic("check") },
      { label: "Rated", value: L.rated, go: S([{ type: "rating100", modifier: "NOT_NULL", value: { value: 0 } }], "rating"), color: "var(--ye)", icon: ic("star") },
      { label: "With an O", value: L.withO, go: S([{ type: "o_counter", modifier: "GREATER_THAN", value: { value: 0 } }], "o_counter"), color: "var(--ma)", icon: ic("drop") },
      withMarkers === null || withMarkers === undefined ? null : { label: "With markers", value: withMarkers, go: S([{ type: "has_markers", value: "true" }]), color: "var(--pu)", icon: ic("tag") },
      inGroup === null ? null : { label: "In a group", value: inGroup, color: "var(--bl)", icon: ic("film") },
      { label: "Interactive", value: m.scenes.filter((s) => s.interactive).length, go: S([{ type: "interactive", value: "true" }]), color: "var(--or)", icon: ic("pulse") },
    ].filter(Boolean).map((r) => ({ ...r, text: `${pct(share(r.value))} <small>${fmtN(r.value)}</small>`, icon: `<span style="color:${r.color}">${r.icon}</span>` }));
    const rbands = [[90, 101, "5 stars"], [70, 90, "4 stars"], [50, 70, "3 stars"], [30, 50, "2 stars"], [0, 30, "1 star"]].map(([a, b, label]) => {
      const ss = m.scenes.filter((s) => s.rating !== null && s.rating !== undefined && s.rating >= a && s.rating < b);
      const o = ss.reduce((x, s) => x + (s.o || 0), 0);
      return { label, value: ss.length, text: `${fmtN(ss.length)} <small>${ss.length ? (o / ss.length).toFixed(2) : "0"} O/scene</small>`,
               go: S([{ type: "rating100", modifier: "BETWEEN", value: { value: a, value2: Math.min(100, b - 1) } }], "rating"), color: "var(--ye)" };
    });
    const unrated = m.scenes.filter((s) => s.rating === null || s.rating === undefined).length;
    rbands.push({ label: "not rated", value: unrated, text: `${fmtN(unrated)}`, go: S([{ type: "rating100", modifier: "IS_NULL", value: { value: 0 } }]), color: "var(--tx3)" });
    const castRows = [[1, 1, "solo"], [2, 2, "two"], [3, 3, "three"], [4, 5, "four or five"], [6, 999, "six or more"]].map(([a, b, label]) => {
      const n = m.scenes.filter((s) => s.perf.length >= a && s.perf.length <= b).length;
      return { label, value: n, go: S([a === b ? { type: "performer_count", modifier: "EQUALS", value: { value: a } }
                                          : b === 999 ? { type: "performer_count", modifier: "GREATER_THAN", value: { value: a - 1 } }
                                          : { type: "performer_count", modifier: "BETWEEN", value: { value: a, value2: b } }]), color: "var(--ma)" };
    });
    const noCast = m.scenes.filter((s) => !s.perf.length).length;
    castRows.push({ label: "nobody yet", value: noCast, go: S([{ type: "performer_count", modifier: "EQUALS", value: { value: 0 } }]), color: "var(--tx3)" });
    const perf2 = m.performers.filter((p) => p.sceneCount >= 2).length;
    const tagN = st.tag_count ?? new Set(m.scenes.flatMap((s) => s.tags.map((t) => t[0]))).size;
    const tagPer = L.scenes ? m.scenes.reduce((a, s) => a + s.tags.length, 0) / L.scenes : 0;
    const groups = st.group_count ?? st.movie_count;

    el.innerHTML = `
      <section class="ins-card ins-hero" style="--c:var(--or)">
        <div><div class="k">${ic("film")}YOUR LIBRARY</div><div class="big">${plural(L.scenes, "scene")}</div>
          <div class="s"><b>${fmtDur(L.secs)}</b> of video: <b>${nonstop(L.secs)}</b> if you watched it nonstop.
            <b>${fmtBytes(L.size)}</b> on disk${imgSize ? `, plus ${fmtBytes(imgSize)} of images` : ""}: enough to fill <b>${(total / 4e12).toFixed(1)}</b> four-terabyte drives.
            ${L.scenes ? `The average scene runs ${fmtDur(L.secs / L.scenes)} and takes ${fmtBytes(L.size / L.scenes)}.` : ""}</div>
          <div class="ins-legend2">${resSegs.map((x) => `<span data-tip="${esc(x.label)}: ${fmtBytes(x.size)} (${pct(x.size / Math.max(1, total))})"><i style="background:${x.color}"></i>${esc(x.label)} <b style="color:var(--hi);font-weight:600">${fmtBytes(x.size)}</b></span>`).join("")}</div></div>
        ${ring(resSegs.map((x) => ({ f: x.size / Math.max(1, total), color: x.color })), fmtBytes(total).split(" ")[0], `${fmtBytes(total).split(" ")[1]} in all`, 150)}
      </section>
      <div class="ins-tiles">
        ${tile("users", "ma", "Performers", fmtN(m.performers.length), `${fmtN(perf2)} in two or more scenes`, "/performers")}
        ${tile("studio", "or", "Studios", fmtN(m.studios.length || net.studios.length), `${plural(net.networks.length, "network")}`, "/studios")}
        ${tile("tag", "gr", "Tags", fmtN(tagN), `${tagPer.toFixed(1)} per scene`, "/tags")}
        ${st.gallery_count !== undefined ? tile("image", "bl", "Galleries", fmtN(st.gallery_count), `${fmtN(st.image_count || 0)} images`, "/galleries") : ""}
        ${groups !== undefined ? tile("film", "pu", "Groups", fmtN(groups), inGroup !== null ? `${fmtN(inGroup)} scenes in one` : "", "/groups") : ""}
      </div>
      <div class="ins-notable">
        ${nb.longest ? nbCard("ruler", "pu", "Longest", fmtDur(nb.longest.dur), nb.longest.title, sc(nb.longest)) : ""}
        ${nb.shortest ? nbCard("ruler", "bl", "Shortest", fmtDur(nb.shortest.dur), nb.shortest.title, sc(nb.shortest)) : ""}
        ${nb.biggest ? nbCard("disk", "or", "Biggest file", fmtBytes(nb.biggest.fsize), `${nb.biggest.title} · ${resOf(nb.biggest)} ${codecName(nb.biggest.vc)}`, sc(nb.biggest)) : ""}
        ${nb.oldest ? nbCard("calendar", "ye", "Oldest release", fmtDate(parseDay(nb.oldest.date)), nb.oldest.title, sc(nb.oldest)) : ""}
        ${nb.newest ? nbCard("spark", "gr", "Newest addition", ago(nb.newest.created), nb.newest.title, sc(nb.newest)) : ""}
        ${nb.cast ? nbCard("users", "ma", "Biggest cast", plural(nb.cast.perf.length, "performer"), nb.cast.title, sc(nb.cast)) : ""}
        ${nb.played ? nbCard("play", "cy", "Most played", plural(nb.played.plays, "play"), nb.played.title, sc(nb.played)) : ""}
        ${nb.tagged ? nbCard("tag", "gr", "Most tagged", plural(nb.tagged.tags.length, "tag"), nb.tagged.title, sc(nb.tagged)) : ""}
        ${nb.performer ? nbCard("user", "ma", "Most scenes", plural(nb.performer.n, "scene"), nb.performer.p.name, `/performers/${nb.performer.p.id}`) : ""}
        ${nb.studio ? nbCard("studio", "or", "Busiest studio", plural(nb.studio.n, "scene"), nb.studio.name, `/studios/${nb.studio.id}`) : ""}
      </div>
      ${card({ title: l.year === null ? (l.timeline === "added" ? "Added to Stash, by year" : "Released, by year") : `${l.year}, by month`, icon: "calendar", c: "or",
        right: `${chipFor("lib", "timeline", "released", "Released", "or")}${chipFor("lib", "timeline", "added", "Added to Stash", "or")}${l.year !== null ? ` <button class="ins-chip" data-set="lib.year=null">← all years</button>` : ""}`,
        sub: `${l.year === null ? "Click a year to see its months." : "Click a month to list those scenes."}${undatedN ? ` ${plural(undatedN, "scene")} without a release date are not shown.` : ""}` },
        bars.length ? barChart(bars, { c: l.timeline === "added" ? "cy" : "or" }) : `<div class="ins-empty">No dates yet.</div>`)}
      <div class="ins-grid">
        ${card({ title: "Lengths", icon: "clock", c: "pu", sub: `Median ${fmtDur(percentile(m.scenes.map((s) => s.dur).filter(Boolean).sort((a, b) => a - b), 0.5))} · click to list` },
          rows(lens.map((x) => ({ ...x, text: `${fmtN(x.value)} <small>${pct(share(x.value))}</small>`, color: "var(--pu)" })), { max: lenMax, lw: "minmax(110px,130px)", vw: "96px" }))}
        ${card({ title: "State", icon: "check", c: "gr", sub: "Share of scenes · click to list" }, rows(stateRows, { max: L.scenes, lw: "minmax(110px,130px)", vw: "110px" }))}
      </div>
      <div class="ins-grid">
        ${card({ title: "Ratings", icon: "star", c: "ye", sub: "Scenes per rating, and O's per scene at each" }, rows(rbands, { lw: "minmax(80px,100px)", vw: "140px" }))}
        ${card({ title: "Cast size", icon: "users", c: "ma", sub: "Performers per scene" }, rows(castRows.map((r) => ({ ...r, text: `${fmtN(r.value)} <small>${pct(share(r.value))}</small>` })), { lw: "minmax(90px,110px)", vw: "96px" }))}
      </div>`;
  }

  // ── Files and quality ─────────────────────────────────────────────────────

  const VC_MATCH = { "H.264": "h264", HEVC: "hevc", AV1: "av1", VP9: "vp9", VP8: "vp8", "MPEG-4": "mpeg4", WMV: "wmv", "VC-1": "vc1", "MPEG-2": "mpeg2", "MPEG-1": "mpeg1" };
  const RES_LINK = { "8K": ["EQUALS", "8k"], "5K+": ["GREATER_THAN", "4k"], "4K": ["EQUALS", "4k"], "1440p": ["EQUALS", "1440p"], "1080p": ["EQUALS", "1080p"],
                     "720p": ["EQUALS", "720p"], "480p": ["EQUALS", "480p"], "below 480p": ["LESS_THAN", "480p"] };
  const FPS_LINK = { "24/25": [0, 26], "30": [27, 39], "50": [40, 54], "60": [55, 64], "over 60": [65, null] };

  // One distribution as console rows: count, share, and a link where Stash
  // has a filter for it.
  function dist(map, order, o = {}) {
    let list = [...map.values()];
    if (order) list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)); else list.sort((a, b) => b.n - a.n);
    const tot = list.reduce((a, r) => a + r.n, 0);
    const max = Math.max(1, ...list.map((r) => r.n));
    return `<div class="hd"><span>${o.head}</span><span>${fmtN(tot)} FILES</span></div>` + rows(list.slice(0, o.limit || 9).map((r, i) => ({
      label: r.key, value: r.n, text: `${fmtN(r.n)} <small>${pct(r.n / Math.max(1, tot))}</small>`,
      color: o.color ? o.color(r, i) : CYCLE[i % CYCLE.length], go: o.link ? o.link(r) : null,
      tip: `${r.key}: ${plural(r.n, "file")}, ${fmtBytes(r.size)}, ${fmtDur(r.secs)}${r.secs ? `\n${fmtBytes((r.size / r.secs) * 3600)} per hour` : ""}${o.tipMore ? o.tipMore(r) : ""}` })),
      { max, lw: "minmax(64px,92px)", vw: "88px" });
  }

  function renderFiles(el) {
    const m = app.model;
    const fs = m.get("files", () => fileStats(m.scenes));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const first = [...fs.vcodec.values()].reduce((a, r) => a + r.size, 0);
    const avgBr = fs.brN ? fs.brSum / fs.brN : 0;
    const con = (html) => `<div class="ins-well ins-con">${html}</div>`;

    const brRows = RES_ORDER.filter((r) => fs.bitrate[r]).map((r) => {
      const b = fs.bitrate[r];
      return `<tr><td style="color:${RES_COLOR[r]}">${esc(r)}</td><td>${fmtN(b.n)}</td><td>${fmtMbps(b.p10)}</td><td style="color:var(--hi)">${fmtMbps(b.p50)}</td><td>${fmtMbps(b.p90)}</td><td style="color:var(--ye)">${b.n >= 10 ? fmtMbps(b.p50 * 2.5) : "–"}</td></tr>`;
    }).join("");
    const costRows = [...fs.vcodec.values()].filter((r) => r.secs > 0).sort((a, b) => b.size - a.size).map((r, i) => {
      const avgShort = r.n ? r.short / r.n : 0;
      return `<tr class="click" data-go="${esc(S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize"))}">
        <td style="color:${LEGACY.has(r.key) ? "var(--re)" : CYCLE[i % CYCLE.length]}">${esc(r.key)}</td><td>${fmtN(r.n)}</td>
        <td style="color:var(--hi)">${fmtBytes((r.size / r.secs) * 3600)}</td><td>${avgShort ? `${Math.round(avgShort)}p` : "–"}</td><td>${pct(r.size / Math.max(1, first))}</td></tr>`;
    }).join("");

    el.innerHTML = `
      <div class="ins-card ins-well ins-con ins-strip" style="--c:var(--cy)">
        <div><span>FILES</span><b>${fmtN(fs.files)}</b></div><div><span>SIZE</span><b>${fmtBytes(fs.size)}</b></div>
        <div><span>RUNTIME</span><b>${fmtDur(fs.secs)}</b></div><div><span>AVG BITRATE</span><b>${fmtMbps(avgBr)} Mbps</b></div>
        <div><span>PER HOUR</span><b>${fs.secs ? fmtBytes((first / fs.secs) * 3600) : "–"}</b></div>
        <div class="click" data-go="${esc(S([{ type: "file_count", modifier: "GREATER_THAN", value: { value: 1 } }]))}" style="cursor:pointer" data-tip="Scenes with more than one file: open them"><span>MULTI-FILE</span><b>${fmtN(fs.multi)}</b></div>
        ${fs.noFile ? `<div class="warn" data-go="${esc(S([{ type: "file_count", modifier: "EQUALS", value: { value: 0 } }]))}" style="cursor:pointer" data-tip="Scenes whose file is gone: open them"><span>NO FILE</span><b>${fmtN(fs.noFile)}</b></div>` : ""}
        ${fs.noPhash ? `<div class="warn" data-tab="actions" style="cursor:pointer" data-tip="Files without a phash cannot be matched as duplicates. Generate them on the Actions tab."><span>NO PHASH</span><b>${fmtN(fs.noPhash)}</b></div>` : ""}
      </div>
      <div class="ins-grid3">
        ${card({ title: "Video codec", icon: "film", c: "cy" }, con(dist(fs.vcodec, null, { head: "CODEC", color: (r, i) => (LEGACY.has(r.key) ? "#D14D41" : CYCLE[i % CYCLE.length]),
          link: (r) => S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize") })))}
        ${card({ title: "Audio codec", icon: "audio", c: "cy" }, con(dist(fs.acodec, null, { head: "CODEC", color: (r, i) => (r.key === "none" ? "#D14D41" : CYCLE[i % CYCLE.length]),
          link: (r) => (r.raw ? S([{ type: "audio_codec", modifier: "EQUALS", value: r.raw }]) : null) })))}
        ${card({ title: "Container", icon: "box", c: "cy" }, con(dist(fs.container, null, { head: "FORMAT" })))}
        ${card({ title: "Resolution", icon: "expand", c: "cy" }, con(dist(fs.res, RES_ORDER, { head: "RESOLUTION", color: (r) => RES_COLOR[r.key],
          link: (r) => S([{ type: "resolution", modifier: RES_LINK[r.key][0], value: RES_LINK[r.key][1] }], "filesize"),
          tipMore: () => "\nOpens Stash's resolution filter; its steps differ a little" })))}
        ${card({ title: "Frame rate", icon: "frame", c: "cy" }, con(dist(fs.fps, FPS_ORDER, { head: "FPS",
          link: (r) => { const x = FPS_LINK[r.key]; return x ? S([x[1] === null ? { type: "framerate", modifier: "GREATER_THAN", value: { value: x[0] - 1 } } : { type: "framerate", modifier: "BETWEEN", value: { value: x[0], value2: x[1] } }]) : null; } })))}
        ${card({ title: "Shape", icon: "frame", c: "cy" }, con(dist(fs.shape, ["landscape", "portrait", "square", "VR"], { head: "SHAPE",
          tipMore: (r) => (r.key === "VR" ? "\nTold by shape: 2:1 at 4K wide or more, or 1:1 at 2.8K or more" : "") })))}
      </div>
      <div class="ins-grid">
        ${card({ title: "Bitrate by resolution", icon: "gauge", c: "cy", sub: "Mbps. Half the files sit between low and high; over 2.5× the median counts as a space hog." },
          con(`<table><tr><th>RES</th><th>FILES</th><th>LOW 10%</th><th>MEDIAN</th><th>HIGH 10%</th><th>HOG ABOVE</th></tr>${brRows}</table>`))}
        ${card({ title: "Cost per hour", icon: "disk", c: "cy", sub: "Storage an hour of video takes, by codec. Click a codec to list its files, largest first." },
          con(`<table><tr><th>CODEC</th><th>FILES</th><th>PER HOUR</th><th>AVG RES</th><th>OF SPACE</th></tr>${costRows}</table>`))}
      </div>
      ${spaceCard(m, fs, net)}
      <div class="ins-note" style="text-align:center">Duplicates, files to re-encode or upgrade, and space hogs are on the ${go("#", "Actions")} tab.</div>`;
    const lnk = el.querySelector('.ins-note .ins-go[data-go="#"]');
    if (lnk) { lnk.removeAttribute("data-go"); lnk.dataset.tab = "actions"; }
  }



  // ── What works for you (2.2) ──────────────────────────────────────────────
  // A sidebar of dimensions, and for the chosen one a row per value: rank,
  // name, a bar centred on 1x (right and green: more than its share, left
  // and coral: less), the two shares, the lift. Strongest first, except
  // dimensions with a natural order (height, age, length...), which keep it;
  // either way the three strongest are highlighted.

  function worksCard(m, y) {
    const pulls = strongestPulls();
    const dim = ALL_DIMS.find((d) => d.id === y.dim) || ALL_DIMS[0];
    const ordinal = isOrdinal(dim.id);
    // "auto" is the dimension's natural reading: in order where it has one,
    // strongest first where it does not
    const sort = y.sort === "size" ? "size" : ordinal && y.sort !== "pull" ? "order" : "pull";
    const R = rankTraits(traits(dim.id), dim.id, y.wmetric, { small: y.small, sort: sort === "order" ? undefined : sort });
    const color = y.wmetric === "watch" ? "cy" : "ma";
    const side = (title, list) => `<div class="h">${title}</div>` + list.map((d) =>
      `<button class="ins-side-b${y.dim === d.id ? " on" : ""}" data-set="you.dim=${d.id}">${esc(d.label)}</button>`).join("");
    const what = y.wmetric === "watch" ? "watching" : "O's";
    const rowsHtml = R.rows.slice(0, 60).map((r) => {
      const x = liftPos(r.mLift), w = Math.abs(x) * 50, tone = liftTone(r.mLift), link = traitLink(dim.id, r.value);
      return `<div class="ins-lr${r.top ? " top" : ""}${link ? " click" : ""}" ${link ? `data-go="${esc(link)}"` : ""}
        data-tip="${esc(`${traitLabel(dim.id, r.value)}\n${fmtN(r.scenes)} scenes · ${pct(r.libShare)} of the library\n${os(r.o)} · ${pct(r.oShare)} of yours\nplayed ${r.plays}× · watched ${fmtDur(r.watch)} (${pct(r.watchShare)})\nrank ${r.rank} by strength`)}">
        <span class="rk">${r.rank}</span>
        <span class="l">${traitIcon(dim.id, r.value)}<span>${esc(traitLabel(dim.id, r.value))}</span></span>
        <div class="ins-div"><i style="left:${x >= 0 ? 50 : 50 - w}%;width:${Math.max(0.8, w).toFixed(1)}%;background:var(--${tone === "up" ? "gr" : tone === "down" ? "re" : "tx3"})"></i></div>
        <span class="nums">${pct(r.mShare)} of ${what} · ${pct(r.libShare)} of scenes</span>
        <span class="ins-lift ${tone}">${r.mLift.toFixed(1)}×</span></div>`;
    }).join("");
    return card({ title: "What works for you", icon: "spark", c: "gr", id: "ins-works",
      right: `${chipFor("you", "wmetric", "o", "O's", "gr")}${chipFor("you", "wmetric", "watch", "Watched", "gr")} &nbsp;
        ${ordinal ? `${chipFor("you", "sort", "auto", "In order", "gr")}${chipFor("you", "sort", "pull", "Strongest", "gr")}` : chipFor("you", "sort", "auto", "Strongest", "gr")}${chipFor("you", "sort", "size", "Biggest", "gr")}`,
      sub: `How each group does for you against its share of the library. Right of the line gets you there more often. The three strongest are highlighted.` },
      `${pulls.length ? `<div class="ins-pulls">${pulls.map(({ d, r }) => `<div class="ins-well ins-pull" data-set="you.dim=${d.id}"
        data-tip="${esc(`${r.scenes} scenes (${pct(r.libShare)} of the library)\n${os(r.o)} (${pct(r.oShare)} of yours)`)}">
        <div class="k">${esc(d.label)}</div><div class="n">${traitIcon(d.id, r.value)}<span>${esc(traitLabel(d.id, r.value))}</span></div><span class="ins-lift up">${r.lift.toFixed(1)}×</span>
        <div class="d">${pct(r.oShare)} of O's from ${pct(r.libShare)} of scenes</div></div>`).join("")}</div>` : ""}
      <div class="ins-ww">
        <nav class="ins-side">${side("PERFORMER", PERFORMER_TRAITS)}${side("SCENE", SCENE_TRAITS)}</nav>
        <div class="ins-wbody">
          <div class="ins-lr ins-axis"><span></span><span class="l">${esc(dim.label)}${sort === "order" ? " · in order" : sort === "size" ? " · biggest first" : " · strongest first"}</span>
            <div class="ax"><span>¼×</span><span>1×</span><span>4×</span></div><span class="nums">your ${what} · library</span><span>lift</span></div>
          <div class="ins-well" style="--c:var(--${color})">${rowsHtml || `<div class="ins-empty">Nothing to compare yet for ${esc(dim.label.toLowerCase())}${R.hidden ? "; the groups are all small" : ""}.</div>`}</div>
          <div class="ins-note">${R.hidden ? `${plural(R.hidden, "small group")} hidden (under ${fmtN(R.minScenes)} scenes, or too little played to say). <button class="ins-chip" data-set="you.small=${y.small ? "false" : "true"}">${y.small ? "hide" : "show"} them</button>` : ""}</div>
        </div>
      </div>`);
  }

  // ── Where the space goes (2.2): a ranked list, by studio, network, codec
  // or resolution ─────────────────────────────────────────────────────────

  function spaceCard(m, fs, net) {
    const f = app.files, mode = f.space;
    let list;
    if (mode === "codec") list = [...fs.vcodec.values()].map((r) => ({ name: r.key, size: r.size, n: r.n, color: LEGACY.has(r.key) ? "var(--re)" : isEfficient(r.raw) ? "var(--gr)" : "var(--cy)",
                                go: S([{ type: "video_codec", modifier: "INCLUDES", value: VC_MATCH[r.key] || r.raw }], "filesize") }));
    else if (mode === "resolution") list = [...fs.res.values()].map((r) => ({ name: r.key, size: r.size, n: r.n, color: RES_COLOR[r.key],
                                go: S([{ type: "resolution", modifier: RES_LINK[r.key][0], value: RES_LINK[r.key][1] }], "filesize") }));
    else if (mode === "network") list = net.networks.map((x) => ({ name: `${x.name}`, sub: `${plural(x.sites, "site")}`, size: x.size, n: x.scenes, go: `/studios/${x.id}` }))
      .concat(net.independent.list.map((x) => ({ name: x.name, size: x.size, n: x.scenes, go: `/studios/${x.id}` })));
    else list = net.studios.map((x) => ({ name: x.name, size: x.size, n: x.scenes, go: S([{ type: "studios", modifier: "INCLUDES", value: items(x.id, x.name) }], "filesize") }));
    const noStudio = mode === "studio" || mode === "network" ? m.scenes.filter((s) => !s.studio) : [];
    if (noStudio.length) list.push({ name: "no studio", size: noStudio.reduce((a, s) => a + (s.size || 0), 0), n: noStudio.length, color: "var(--tx3)",
                                     go: S([{ type: "studios", modifier: "IS_NULL", value: { items: [], excluded: [], depth: 0 } }], "filesize") });
    list.sort((a, b) => b.size - a.size);
    const total = Math.max(1, list.reduce((a, x) => a + x.size, 0));
    const shown = list.slice(0, f.spaceAll ? 40 : 15), rest = list.slice(shown.length);
    const max = Math.max(1, ...shown.map((x) => x.size));
    const rowsHtml = shown.map((x) => `<div class="ins-sr${x.go ? " click" : ""}" ${x.go ? `data-go="${esc(x.go)}"` : ""}
      data-tip="${esc(`${x.name}${x.sub ? ` (${x.sub})` : ""}\n${fmtBytes(x.size)} · ${pct(x.size / total)}\n${plural(x.n, "scene")} · ${fmtBytes(x.size / Math.max(1, x.n))} each on average`)}">
      <span class="l">${esc(x.name)}${x.sub ? ` <small>${esc(x.sub)}</small>` : ""}</span>
      <div class="ins-trk"><i style="width:${Math.max(0.8, (x.size / max) * 100).toFixed(1)}%;${x.color ? `background:${x.color}` : ""}"></i></div>
      <span class="v">${fmtBytes(x.size)}</span><span class="p">${pct(x.size / total)}</span><span class="n">${plural(x.n, "scene")}</span></div>`).join("");
    const restSize = rest.reduce((a, x) => a + x.size, 0);
    return card({ title: "Where the space goes", icon: "disk", c: "cy",
      right: ["studio", "network", "codec", "resolution"].map((k) => chipFor("files", "space", k, k[0].toUpperCase() + k.slice(1), "cy")).join(""),
      sub: `${fmtBytes(total)} in all, largest first. Click one to list its scenes by file size.` },
      `<div class="ins-well" style="--c:var(--cy)">${rowsHtml}</div>` +
      (rest.length ? `<div class="ins-note">+ ${fmtN(rest.length)} more · ${fmtBytes(restSize)} (${pct(restSize / total)}) ${f.spaceAll || list.length <= 15 ? "" : `<button class="ins-chip" data-set="files.spaceAll=true">show 25 more</button>`}</div>`
        : f.spaceAll && list.length > 15 ? `<div class="ins-note"><button class="ins-chip" data-set="files.spaceAll=false">show fewer</button></div>` : ""));
  }

  // ── Probably wrong (shared by Actions and the Health hero) ───────────────

  function problemChecks(m) {
    const fs = m.get("files", () => fileStats(m.scenes));
    const conflicts = m.get("conflicts", () => dateConflicts(m.scenes, m.perfById));
    const twins = m.get("twins", () => sameNames(m.performers));
    const future = m.get("future", () => futureDates(m.scenes, m.now));
    const c = m.counts, today = dayKey(m.now);
    const checks = [
      { n: fs.noFile, icon: "alert", c: "re", title: "Scenes with no file", sub: "The file was moved or deleted outside Stash; a scan or clean sorts it out",
        go: S([{ type: "file_count", modifier: "EQUALS", value: { value: 0 } }]) },
      { n: new Set(conflicts.map((x) => x.s.id)).size, icon: "alert", c: "re", title: "Scenes dated before a performer turned 18", sub: "Nearly always a wrong birthdate or a wrong scene date (a re-release, a typo)",
        more: conflicts.length, pills: conflicts.slice(0, 10).map((x) => ({ label: `${x.s.title} · ${x.p.name}, ${x.age}`, go: `/scenes/${x.s.id}` })) },
      { n: twins.length, icon: "users", c: "re", title: "Performers with the same name", sub: "Probably one person added twice; Stash can merge them",
        pills: twins.slice(0, 12).map((g) => ({ label: `${g[0].name} ×${g.length}`, go: `/performers?q=${encodeURIComponent(g[0].name)}` })) },
      { n: future.length, icon: "calendar", c: "ye", title: "Release date in the future", sub: "Pre-release dates are fine; typos are not",
        go: S([{ type: "date", modifier: "GREATER_THAN", value: { value: today } }], "date", "asc") },
      { n: c["t.once"], icon: "tag", c: "or", title: "Tags used on one scene", sub: "Often a typo or a near-twin of another tag",
        go: listUrl("/tags", [{ type: "scene_count", modifier: "EQUALS", value: { value: 1 } }], "name", "asc") },
      { n: c["p.noscenes"], icon: "user", c: "tx2", title: "Performers with no scenes", sub: "Fine if you keep them on purpose",
        go: P([{ type: "scene_count", modifier: "EQUALS", value: { value: 0 } }], "name") },
      { n: c["st.noscenes"], icon: "studio", c: "tx2", title: "Studios with no scenes", sub: "Often a parent network, which is fine",
        go: listUrl("/studios", [{ type: "scene_count", modifier: "EQUALS", value: { value: 0 } }], "name", "asc") },
    ].filter((x) => x.n !== null && x.n !== undefined);
    const open = checks.filter((x) => x.n > 0);
    return { open, clear: checks.filter((x) => !x.n), serious: open.filter((x) => x.c === "re" || x.c === "ye").reduce((a, x) => a + x.n, 0) };
  }
  const checkRow = (x) => `<div class="ins-chk${x.go ? " click" : ""}" ${x.go ? `data-go="${esc(x.go)}"` : ""}>
    <span class="ins-sq" style="--c:var(--${x.c})">${ic(x.icon)}</span>
    <div><div class="n">${esc(x.title)}</div><div class="sub">${esc(x.sub)}</div></div>
    <div class="v">${fmtN(x.n)}${x.go ? `<span class="ins-go">${ic("arrow")}</span>` : ""}</div>
    ${x.pills && x.pills.length ? `<div class="more">${x.pills.map((p) => `<span class="ins-pill" data-go="${esc(p.go)}">${esc(p.label)}</span>`).join("")}${(x.more ?? x.n) > x.pills.length ? `<span class="ins-pill" style="cursor:default">+${fmtN((x.more ?? x.n) - x.pills.length)} more</span>` : ""}</div>` : ""}
  </div>`;

  // ── Actions (2.2) ─────────────────────────────────────────────────────────
  // Everything that asks for something to be done, in one place. Writes only
  // ever happen on a button press; the destructive one asks twice.

  function dupState() {
    const a = app.acts;
    if (!a.dups) return null;
    const plans = a.dups.map((g) => dupChoose(g, a.mode, { sharp: a.sharp }));
    let files = 0, bytes = 0, ready = 0, review = 0;
    for (const p of plans) {
      let any = false;
      for (const it of p.items) {
        const on = a.ticks.has(it.s.id) ? a.ticks.get(it.s.id) : it.remove;
        it.on = on;
        if (on) { files += 1; bytes += it.s.fsize || 0; any = true; }
      }
      if (p.review) review += 1; else if (any) ready += 1;
    }
    plans.sort((x, y) => (x.review ? 1 : 0) - (y.review ? 1 : 0) || y.items.reduce((n, i) => n + (i.on ? i.s.fsize : 0), 0) - x.items.reduce((n, i) => n + (i.on ? i.s.fsize : 0), 0));
    return { plans, files, bytes, ready, review };
  }

  function renderActions(el) {
    const m = app.model, a = app.acts;
    const fs = m.get("files", () => fileStats(m.scenes));
    const up = m.get("upgrades", () => upgrades(m.scenes));
    const hog = m.get("hogs", () => spaceHogs(m.scenes, fs));
    const ne = m.get("noteff", () => notEfficient(m.scenes, fs));
    const H = m.get("health", () => healthModel(m));
    const P2 = problemChecks(m);
    const D = dupState();
    const noPhashIds = m.scenes.filter((s) => s.phash === false).map((s) => s.id);
    const con = (html) => `<div class="ins-well ins-con">${html}</div>`;
    const sceneLine = (s, right, color, extra) => `<div class="ins-li click" data-go="/scenes/${esc(s.id)}">${thumb(s)}
      <div style="min-width:0"><div class="n">${esc(s.title)}</div><div class="sub">${esc(resOf(s))} · ${esc(codecName(s.vc))} · ${fmtBytes(s.fsize)}${extra || ""}</div></div>
      <div class="v" style="color:${color}">${right}</div></div>`;
    const tileA = (icon, c, label, value, sub, target) => `<div class="ins-card ins-tile click" style="--c:var(--${c})" data-jump="${target}">
      <div class="l">${ic(icon)}${esc(label)}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;

    // the duplicate cleaner
    let dupBody;
    if (a.state === "scanning") dupBody = `<div class="ins-progress" style="padding:24px 0">Asking Stash for exact matches…<div class="bar"><i></i></div></div>`;
    else if (a.state === "error" && !a.dups) dupBody = `<div class="ins-error">Stash could not run the match: ${esc(a.err)}</div>`;
    else if (!a.dups) dupBody = `<div style="text-align:center;padding:16px 0 8px"><div style="color:var(--tx2);margin-bottom:12px">Finds exact copies with Stash's phash match, then picks the copy to keep in each group.</div>
      <button class="ins-btn big" data-act="dups">${ic("search")} Find duplicates</button>
      ${fs.noPhash ? `<div class="ins-note">${plural(fs.noPhash, "file")} have no phash yet and cannot be matched; generate them below first.</div>` : ""}</div>`;
    else {
      const run = a.run;
      // only a cleanup in progress locks the controls; a finished one does not
      const busy = !!(run && !run.finished);
      const seg = (k, l) => `<button class="${a.mode === k ? "on" : ""}" data-set="acts.mode=${k}" ${busy ? "disabled" : ""}>${l}</button>`;
      const tog = (k, l) => `<button class="ins-tog${a[k] ? " on" : ""}" data-set="acts.${k}=${a[k] ? "false" : "true"}" ${busy ? "disabled" : ""}><i></i>${l}</button>`;
      const item = (it, keep) => `<div class="ins-cp">${keep ? "<span></span>" : `<button class="ins-bx${it.on ? " on" : ""}" data-act="dtick" data-id="${esc(it.s.id)}" ${busy ? "disabled" : ""} aria-label="Remove this copy"></button>`}
        ${thumb(it.s)}<span class="t"><span class="ins-k ${keep ? "keep" : it.on ? "del" : "look"}">${keep ? "KEEP" : it.on ? "REMOVE" : "LOOK"}</span>
        <span class="ins-go" data-go="/scenes/${esc(it.s.id)}" style="color:var(--tx)">${esc(it.s.title)}</span>
        <span class="m"> · ${esc(codecName(it.s.vc))} ${esc(resOf(it.s))} · ${fmtBytes(it.s.fsize)}${it.s.o ? ` · ${os(it.s.o)}` : ""}${!keep && it.why ? ` · ${esc(it.why)}` : ""}${!keep && it.on && a.merge && (it.s.o || it.s.plays) ? " · history moves over" : ""}</span></span>
        <span class="v">${keep ? `scene ${esc(it.s.id)}` : it.on ? `<b style="color:var(--down)">${fmtBytes(it.s.fsize)}</b>` : "kept"}</span></div>`;
      const shown = D.plans.slice(0, a.showAll ? 400 : 25);
      dupBody = `<div class="ins-opts"><span>Keep</span><span class="ins-seg">${seg("hevc", "HEVC or AV1")}${seg("best", "Best quality")}${seg("smallest", "Smallest")}</span>
          ${tog("merge", "Move O's, plays, tags and performers to the kept scene first")}
          ${a.mode === "hevc" ? tog("sharp", "Only if the HEVC/AV1 copy is at least as sharp") : ""}</div>
        <div class="ins-con ins-sum"><span><em>GROUPS</em><b>${fmtN(D.plans.length)}</b></span><span><em>READY</em><b style="color:var(--up)">${fmtN(D.ready)}</b></span>
          <span><em>TO REMOVE</em><b style="color:var(--down)">${plural(D.files, "file")} · ${fmtBytes(D.bytes)}</b></span><span><em>NEEDS A LOOK</em><b style="color:var(--ye)">${fmtN(D.review)}</b></span>
          <span style="margin-left:auto"><button class="ins-chip" data-act="dups" ${busy ? "disabled" : ""}>scan again</button></span></div>
        ${D.plans.length ? `<div class="ins-well ins-dups">${shown.map((p) => `<div class="ins-dg${p.review ? " review" : ""}">${p.review ? `<div class="why">${ic("alert")} ${esc(p.reason)}</div>` : ""}
          ${item({ s: p.keep }, true)}${p.items.map((it) => item(it, false)).join("")}</div>`).join("")}</div>
          ${D.plans.length > shown.length ? `<div class="ins-note"><button class="ins-chip" data-set="acts.showAll=true">show all ${fmtN(D.plans.length)} groups</button></div>` : ""}`
          : `<div class="ins-empty">${ic("check")} No exact duplicates among files that have a phash.</div>`}
        ${run ? `<div class="ins-run"><div class="bar"><i style="width:${(run.done / Math.max(1, run.total) * 100).toFixed(1)}%"></i></div>
            <span>${run.finished ? `Done: ${plural(run.ok, "group")} cleaned, ${plural(run.files, "file")} removed, ${fmtBytes(run.bytes)} freed${run.errors.length ? `, ${plural(run.errors.length, "group")} skipped` : ""}.` : `Group ${run.done + 1} of ${run.total}…`}</span></div>
            ${run.errors.length ? `<div class="ins-note" style="color:var(--down)">${run.errors.slice(0, 6).map((e) => esc(e)).join("<br>")}</div>` : ""}` : ""}
        ${a.msg ? `<div class="ins-note" style="color:var(--up)">${esc(a.msg)}</div>` : ""}
        <div class="ins-btns">
          <button class="ins-btn" data-act="dtag" ${!D.files || busy ? "disabled" : ""}>${ic("tag")} Tag ${plural(D.files, "copy", "copies")} for delete</button>
          <button class="ins-btn danger${a.armed ? " armed" : ""}" data-act="dremove" ${!D.files || busy ? "disabled" : ""}>${ic("alert")}
            ${a.armed ? `Really remove ${plural(D.files, "file")} (${fmtBytes(D.bytes)}) from disk? Click again` : `Remove ${plural(D.files, "file")} · ${fmtBytes(D.bytes)}…`}</button></div>
        <div class="ins-note" style="text-align:right">Tagging is safe and uses QuickTools' delete tag. Removing deletes the copies' files from disk${a.merge ? "; their O's, plays, markers, tags and performers move to the kept scene first" : ""}. Nothing happens to a group that changed since the scan.</div>`;
    }

    const wins = H.wins.slice(0, 3);
    el.innerHTML = `
      <div class="ins-tiles">
        ${tileA("copy", "bl", "Duplicates", a.dups ? plural(a.dups.length, "group") : "scan", a.dups && D ? `${fmtBytes(D.bytes)} to free` : "exact phash matches", "ins-a-dups")}
        ${tileA("disk", "cy", "Not HEVC or AV1", fmtN(ne.n), `~${fmtBytes(ne.gain)} to gain`, "ins-a-hevc")}
        ${tileA("up", "re", "Worth upgrading", fmtN(up.n), "below 720p or legacy", "ins-a-up")}
        ${tileA("pulse", "ye", "Metadata", esc(H.grade), wins.length ? `${plural(wins.length, "quick win")}` : "nothing quick", "ins-a-fix")}
        ${tileA("alert", "or", "Probably wrong", fmtN(P2.serious), `${plural(P2.open.length, "kind")} of problem`, "ins-a-fix")}
        ${tileA("search", "pu", "No phash", fmtN(fs.noPhash), "cannot be matched yet", "ins-a-fix")}
      </div>
      ${card({ title: "Duplicate cleaner", icon: "copy", c: "bl", id: "ins-a-dups", right: a.scanned ? `scanned ${ago(a.scanned)}` : "",
        sub: "Keeps one copy per group and removes the rest. Nothing is changed until you press a button at the bottom." }, dupBody)}
      <div class="ins-grid">
        ${card({ title: "Not HEVC or AV1 yet", icon: "disk", c: "cy", id: "ins-a-hevc", right: `<b style="color:var(--hi)">${fmtN(ne.n)}</b>`,
          sub: `${fmtBytes(ne.size)} of files; at this library's usual HEVC/AV1 rates they would take about ${fmtBytes(ne.size - ne.gain)}. Biggest gain first. Tag them so a re-encoder (Tdarr, Unmanic) can pick them up.` },
          con(ne.list.length ? ne.list.slice(0, 8).map((x) => sceneLine(x.s, `−${fmtBytes(x.gain)}`, "var(--cy)", ` · ${fmtMbps(bitrateOf(x.s))} Mbps`)).join("") : `<div class="ins-empty">${ic("check")} Every file is HEVC or AV1.</div>`) +
          (ne.n ? `<div class="ins-btns"><button class="ins-btn" data-act="reencode" data-n="100">${ic("tag")} Tag the top ${fmtN(Math.min(100, ne.n))} "Re-encode"</button>
            ${ne.n > 100 ? `<button class="ins-btn" data-act="reencode" data-n="all">Tag all ${fmtN(ne.n)}</button>` : ""}
            <span class="ins-go" data-go="${esc(S([{ type: "video_codec", modifier: "NOT_MATCHES_REGEX", value: "hevc|av1" }], "filesize"))}">Open all in Stash${ic("arrow")}</span></div>` : "") +
          (a.tagMsg ? `<div class="ins-note" style="color:var(--up)">${esc(a.tagMsg)}</div>` : ""))}
        ${card({ title: "Worth upgrading", icon: "up", c: "re", id: "ins-a-up", right: `<b style="color:var(--hi)">${fmtN(up.n)}</b>`,
          sub: `Below 720p or a legacy codec (${fmtBytes(up.size)}). The ones you watch most come first: a better copy of those is worth the most.` },
          con(up.list.length ? up.list.slice(0, 8).map((s) => sceneLine(s, s.o ? `${s.o}${ic("drop")}` : "", "var(--ma)", s.o || s.plays ? ` · played ${s.plays}×` : "")).join("") : `<div class="ins-empty">${ic("check")} Nothing below 720p or in a legacy codec.</div>`) +
          (up.n ? `<div class="ins-btns"><span class="ins-go" data-go="${esc(S([{ type: "resolution", modifier: "LESS_THAN", value: "720p" }], "o_counter"))}">All below 720p${ic("arrow")}</span></div>` : ""))}
      </div>
      <div class="ins-grid">
        ${card({ title: "Space hogs", icon: "box", c: "ye", right: `<b style="color:var(--hi)">${fmtN(hog.n)}</b>`,
          sub: `Over 2.5× the usual bitrate for their resolution, any codec. Re-encoded they would free about ${fmtBytes(hog.saving)}.` },
          con(hog.list.length ? hog.list.slice(0, 8).map((x) => sceneLine(x.s, `−${fmtBytes(x.saving)}`, "var(--ye)", ` · ${fmtMbps(bitrateOf(x.s))} Mbps, ${x.ratio.toFixed(1)}× usual`)).join("") : `<div class="ins-empty">${ic("check")} No file stands out for its size.</div>`))}
        ${card({ title: "Fix next", icon: "pulse", c: "ye", id: "ins-a-fix", sub: "The metadata gaps that would lift your grade most, and things that look wrong." },
          (wins.length ? wins.map((w) => `<div class="ins-chk click" data-go="${esc(missingLink(w.p.g, w.p.key))}"><span class="ins-sq" style="--c:var(--ye)">${ic("pulse")}</span>
            <div><div class="n">${esc(winText(w.p).replace(/^./, (c) => c.toUpperCase()))}</div><div class="sub">${w.grade !== H.grade ? `to ${esc(w.grade)}` : `+${(w.gain * 100).toFixed(1)} points`}</div></div>
            <div class="v"><span class="ins-go">${ic("arrow")}</span></div></div>`).join("") : "") +
          (fs.noPhash ? `<div class="ins-chk"><span class="ins-sq" style="--c:var(--pu)">${ic("search")}</span>
            <div><div class="n">${plural(fs.noPhash, "file")} without a phash</div><div class="sub">They cannot be matched as duplicates. Generating runs a Stash task for just these scenes.</div></div>
            <div class="v">${a.phashMsg ? `<span style="color:var(--up);font-weight:400;font-size:12px">${esc(a.phashMsg)}</span>` : `<button class="ins-btn" data-act="phash">Generate</button>`}</div></div>` : "") +
          P2.open.map(checkRow).join("") +
          (!wins.length && !P2.open.length && !fs.noPhash ? `<div class="ins-empty">${ic("check")} Nothing to fix.</div>` : "") +
          (P2.clear.length ? `<div class="ins-note" style="color:var(--gr)">${ic("check")} All clear: ${P2.clear.map((x) => esc(x.title.toLowerCase())).join(", ")}.</div>` : ""))}
      </div>`;
    a._noPhashIds = noPhashIds;
    a._noteff = ne;
  }

  async function scanDuplicates() {
    const a = app.acts;
    a.state = "scanning"; a.err = ""; a.msg = ""; a.run = null; a.armed = false;
    render();
    try { a.dups = await loadDuplicates(); a.ticks = new Map(); a.state = "done"; a.scanned = Date.now(); }
    catch (e) { a.err = e.message; a.state = "error"; }
    if (app.tab === "actions") render();
  }

  // Group by group, one at a time, so a failure stops at that group and the
  // rest still get done; each re-reads its scenes before touching them.
  async function removeTicked() {
    const a = app.acts, D = dupState();
    const work = D.plans.map((p) => ({ keep: p.keep, drops: p.items.filter((i) => i.on).map((i) => i.s) })).filter((w) => w.drops.length);
    a.armed = false;
    a.run = { total: work.length, done: 0, ok: 0, files: 0, bytes: 0, errors: [], finished: false };
    render();
    const doneIds = new Set();
    for (const w of work) {
      try {
        a.run.files += await removeCopies(w.keep, w.drops, a.merge);
        a.run.bytes += w.drops.reduce((n, s) => n + (s.fsize || 0), 0);
        a.run.ok += 1;
        w.drops.forEach((s) => doneIds.add(s.id));
      } catch (e) {
        a.run.errors.push(`${w.keep.title}: ${e.message}`);
      }
      a.run.done += 1;
      if (app.tab === "actions") render();
    }
    a.run.finished = true;
    // the cleaned groups leave the list; the library cache is stale now
    a.dups = a.dups.map((g) => g.filter((s) => !doneIds.has(s.id))).filter((g) => g.length > 1);
    cachePut({ at: 0 });
    a.msg = "Refresh (top right) to read the library again with these changes.";
    render();
  }

  async function tagTicked(btn) {
    const a = app.acts, D = dupState();
    const ids = D.plans.flatMap((p) => p.items.filter((i) => i.on).map((i) => i.s.id));
    btn.disabled = true;
    try {
      const name = await deleteTagName();
      await tagScenes(ids, name);
      a.msg = `Tagged ${plural(ids.length, "copy", "copies")} "${name}". Filter the scene list by that tag to review and delete them.`;
    } catch (e) { a.msg = ""; a.err = e.message; a.msg = `Tagging failed: ${e.message}`; }
    render();
  }

  async function tagReencode(btn) {
    const a = app.acts, ne = a._noteff;
    const list = btn.dataset.n === "all" ? ne.list : ne.list.slice(0, 100);
    btn.disabled = true;
    try { await tagScenes(list.map((x) => x.s.id), "Re-encode"); a.tagMsg = `Tagged ${plural(list.length, "scene")} "Re-encode".`; }
    catch (e) { a.tagMsg = `Tagging failed: ${e.message}`; }
    render();
  }

  async function runPhash(btn) {
    const a = app.acts;
    btn.disabled = true;
    try { await generatePhashes(a._noPhashIds || []); a.phashMsg = "Started in Stash's task queue. Refresh when it is done."; }
    catch (e) { a.phashMsg = `Could not start: ${e.message}`; }
    render();
  }

  // ── Metadata health ───────────────────────────────────────────────────────

  // [is_missing value, label, count key, weight]. Weights are how much a
  // gap hurts finding and filtering things: a scene without a studio or
  // performers is lost to most filters, one without details is not.
  const HEALTH = {
    scenes: [["title", "Title", "s.title", 1], ["date", "Date", "s.date", 1], ["studio", "Studio", "s.studio", 2],
             ["performers", "Performers", "s.performers", 2], ["tags", "Tags", "s.tags", 2], ["cover", "Cover", "s.cover", 0.5],
             ["details", "Details", "s.details", 0.5], ["url", "URL", "s.url", 0.5], ["stash_id", "StashDB link", "s.stash_id", 1.5],
             ["organized", "Organized", "s.organized", 1]],
    performers: [["image", "Image", "p.image", 1], ["gender", "Gender", "p.gender", 0.5], ["birthdate", "Birthdate", "p.birthdate", 0.75],
                 ["country", "Country", "p.country", 0.5], ["height", "Height", "p.height", 0.25], ["measurements", "Measurements", "p.measurements", 0.25],
                 ["stash_id", "StashDB link", "p.stash_id", 1], ["url", "URL", "p.url", 0.25]],
    studios: [["image", "Image", "st.image", 1], ["stash_id", "StashDB link", "st.stash_id", 1], ["url", "URL", "st.url", 0.5]],
  };
  const GROUP_WEIGHT = { scenes: 0.7, performers: 0.22, studios: 0.08 };
  const NOUN = { scenes: ["scene", "scenes"], performers: ["performer", "performers"], studios: ["studio", "studios"] };

  function healthModel(m) {
    const totals = { scenes: m.scenes.length, performers: m.performers.length, studios: m.studios.length };
    const parts = {};
    for (const g of Object.keys(HEALTH)) {
      parts[g] = HEALTH[g].map(([key, label, ck, weight]) => {
        const missing = m.counts[ck];
        return { g, key, label, weight, missing: missing ?? null, total: totals[g] };
      }).filter((p) => p.missing !== null && p.total);
    }
    const scoreOf = (pp) => {
      let w = 0, have = 0;
      for (const g of Object.keys(pp)) { const s = healthScore(pp[g]); if (s !== null) { w += GROUP_WEIGHT[g]; have += GROUP_WEIGHT[g] * s; } }
      return w ? have / w : null;
    };
    const score = scoreOf(parts);
    // the gaps that would lift the score most if filled
    const wins = [];
    for (const g of Object.keys(parts)) for (const p of parts[g]) {
      if (!p.missing) continue;
      const fixed = { ...parts, [g]: parts[g].map((x) => (x === p ? { ...x, missing: 0 } : x)) };
      wins.push({ p, gain: scoreOf(fixed) - score, grade: gradeOf(Math.floor(scoreOf(fixed) * 100) / 100) });
    }
    wins.sort((a, b) => b.gain - a.gain);
    return { parts, score, grade: gradeOf(score === null ? null : Math.floor(score * 100) / 100), wins: wins.slice(0, 3) };
  }

  function missingLink(g, key) {
    if (g === "scenes") return key === "organized" ? S([{ type: "organized", value: "false" }]) : S([{ type: "is_missing", modifier: "EQUALS", value: key }]);
    return listUrl(`/${g}`, [{ type: "is_missing", modifier: "EQUALS", value: key }], g === "performers" ? "scenes_count" : "scenes_count");
  }
  // Rounded down, so 99.8% filled never reads as complete and the shown
  // percentage agrees with the grade.
  const pctDown = (f) => `${Math.floor((f || 0) * 100)}%`;
  const toneOf = (f) => (f >= 0.85 ? "var(--gr)" : f >= 0.65 ? "var(--ye)" : f >= 0.45 ? "var(--or)" : "var(--re)");
  const winText = (p) => (p.key === "organized" ? `mark ${fmtN(p.missing)} scenes organized`
    : `add ${p.label === "StashDB link" ? "StashDB links" : p.label.toLowerCase()} to ${plural(p.missing, NOUN[p.g][0], NOUN[p.g][1])}`);

  function renderHealth(el) {
    const m = app.model;
    const H = m.get("health", () => healthModel(m));
    const block = (g) => {
      const list = H.parts[g];
      if (!list.length) return `<div class="ins-empty">Stash did not report these counts.</div>`;
      return list.map((p) => {
        const f = 1 - p.missing / p.total;
        return `<div class="ins-row${p.missing ? " click" : ""}" style="--lw:minmax(100px,120px);--vw:150px;--c:${toneOf(f)}" ${p.missing ? `data-go="${esc(missingLink(g, p.key))}"` : ""}
          data-tip="${esc(`${p.label}: ${fmtN(p.total - p.missing)} of ${fmtN(p.total)} ${NOUN[g][1]} have it${p.missing ? `\nclick to list the ${fmtN(p.missing)} without` : ""}`)}">
          <span class="l"><span>${esc(p.label)}</span></span><div class="ins-trk"><i style="width:${(f * 100).toFixed(1)}%"></i></div>
          <span class="v">${pctDown(f)} ${p.missing ? `<small style="color:var(--bl)">${fmtN(p.missing)} missing</small>` : `<small style="color:var(--gr)">complete</small>`}</span></div>`;
      }).join("");
    };

    const P2 = problemChecks(m);
    const ringColor = H.score === null ? "#575653" : H.score >= 0.8 ? "#879A39" : H.score >= 0.66 ? "#D0A215" : H.score >= 0.5 ? "#DA702C" : "#D14D41";

    el.innerHTML = `
      <section class="ins-card ins-hero" style="--c:var(--ye)">
        <div><div class="k">${ic("pulse")}METADATA HEALTH</div><div class="big">${esc(H.grade)}</div>
          <div class="s">${H.score === null ? "Stash did not report what is filled in." : `<b>${pctDown(H.score)}</b> of what Stash can know is filled in, weighted by how much each gap gets in the way of finding things.`}
            ${H.wins.length ? `<br>Quickest wins: ${H.wins.map((w, i) => `<span class="ins-go" data-go="${esc(missingLink(w.p.g, w.p.key))}">${esc(winText(w.p))}</span>${i === 0 && w.grade !== H.grade ? ` (to ${esc(w.grade)})` : ""}`).join(", ")}.` : ""}</div></div>
        ${ring([{ f: H.score || 0, color: ringColor }], pctDown(H.score), "filled in", 150)}
      </section>
      <div class="ins-grid">
        ${card({ title: "Scenes", icon: "film", c: "or", right: fmtN(m.scenes.length), sub: "Click a row to list the scenes missing it" }, block("scenes"))}
        <div>
          ${card({ title: "Performers", icon: "users", c: "ma", right: fmtN(m.performers.length) }, block("performers"))}
          ${card({ title: "Studios", icon: "studio", c: "cy", right: fmtN(m.studios.length) }, block("studios"))}
        </div>
      </div>
      <div class="ins-note" style="text-align:center">${P2.serious ? `${plural(P2.serious, "thing")} look wrong rather than missing; ` : ""}fixes and checks are on the
        <span class="ins-go" data-tab="actions">Actions${ic("arrow")}</span> tab.</div>`;
  }

  // ── Collection ────────────────────────────────────────────────────────────

  const GENDERS = [["FEMALE", "Women", "ma"], ["MALE", "Men", "bl"], ["TRANSGENDER_FEMALE", "Trans women", "pu"], ["TRANSGENDER_MALE", "Trans men", "cy"],
                   ["NON_BINARY", "Non-binary", "ye"], ["INTERSEX", "Intersex", "gr"], ["", "Not set", "tx3"]];

  function growthChart(g) {
    const W = 1000, H = 170, padL = 46, padB = 22, padT = 10;
    const max = Math.max(1, ...g.map((x) => x.total));
    const step = (W - padL) / Math.max(1, g.length - 1);
    const X = (i) => padL + i * step, Y = (v) => padT + (H - padT - padB) * (1 - v / max);
    const line = g.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x.total).toFixed(1)}`).join(" ");
    const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))); return Math.ceil(v / p) * p; };
    const top = nice(max);
    const ticks = [0, top / 2, top].filter((v) => v <= max * 1.001 || v === 0);
    const years = g.map((x, i) => ({ i, d: new Date(x.from) })).filter((x) => x.d.getMonth() === 0 || x.i === 0);
    const hit = g.map((x, i) => `<rect x="${(X(i) - step / 2).toFixed(1)}" y="0" width="${Math.max(2, step).toFixed(1)}" height="${H - padB}" fill="transparent"
      data-tip="${esc(`${fmtDate(x.from, { month: "long", year: "numeric" })}\n+${fmtN(x.added)} added · ${fmtN(x.total)} in all\n${fmtBytes(x.size)} on disk then`)}"/>`).join("");
    return `<div class="ins-well" style="padding:8px 10px 4px"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
      <defs><linearGradient id="ins-gg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#879A39" stop-opacity=".45"/><stop offset="1" stop-color="#879A39" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map((v) => `<line x1="${padL}" x2="${W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#282726" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <text x="${padL - 6}" y="${(Y(v) + 4).toFixed(1)}" fill="#878580" font-size="11" text-anchor="end">${fmtN(v)}</text>`).join("")}
      ${years.map((x) => `<text x="${X(x.i).toFixed(1)}" y="${H - 5}" fill="#878580" font-size="11" text-anchor="${x.i === 0 ? "start" : "middle"}">${x.d.getFullYear()}</text>
        <line x1="${X(x.i).toFixed(1)}" x2="${X(x.i).toFixed(1)}" y1="${H - padB}" y2="${H - padB + 4}" stroke="#575653" vector-effect="non-scaling-stroke"/>`).join("")}
      <path d="${line} L${X(g.length - 1).toFixed(1)} ${H - padB} L${padL} ${H - padB} Z" fill="url(#ins-gg)"/>
      <path d="${line}" fill="none" stroke="#A9BA5A" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${hit}</svg></div>`;
  }

  function renderCollection(el) {
    const m = app.model, cs = app.col;
    const g = m.get("growth", () => growth(m.scenes, m.now));
    const tags = m.get("tags", () => tagCounts(m.scenes));
    const net = m.get("networks", () => networks(m.studios, m.scenes));
    const pr = m.get("pairs", () => pairs(m.scenes).slice(0, 12));
    const faces = m.get("faces", () => newFaces(m.scenes));
    const ages = m.get("ages", () => ageCounts(m.scenes, m.perfById));
    const N = m.scenes.length;

    const last12 = g.slice(-12), avg12 = last12.length ? last12.reduce((a, x) => a + x.added, 0) / last12.length : 0;
    const busiest = g.reduce((b, x) => (!b || x.added > b.added ? x : b), null);
    let doubled = null;
    if (g.length) { const now = g[g.length - 1].total; for (let i = g.length - 1; i >= 0; i--) if (g[i].total <= now / 2) { doubled = g.length - 1 - i; break; } }
    const recent = g.slice(-24).map((x) => ({ value: x.added, label: new Date(x.from).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      tip: `${fmtDate(x.from, { month: "long", year: "numeric" })}: +${fmtN(x.added)}`, hi: busiest && x.key === busiest.key,
      click: x.added ? () => { const d = new Date(x.from), to = dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime());
        navigate(S([{ type: "created_at", modifier: "BETWEEN", value: { value: `${dayKey(x.from)} 00:00`, value2: `${to} 23:59` } }], "created_at")); } : null }));

    const tagSel = tags.find((t) => t.id === cs.tag) || tags[0];
    const co = tagSel ? m.get(`co:${tagSel.id}`, () => coTags(m.scenes, tagSel.id)) : { n: 0, rows: [] };

    // who is in it: performers with a scene here
    const inLib = new Set(m.scenes.flatMap((s) => s.perf));
    const genderN = new Map();
    for (const id of inLib) { const p = m.perfById.get(id); const k = p && p.gender ? p.gender : ""; genderN.set(k, (genderN.get(k) || 0) + 1); }
    const gTotal = Math.max(1, inLib.size);
    const allow = cs.gender === "ALL" ? null : cs.gender;
    const countries = new Map();
    let noCountry = 0;
    for (const id of inLib) {
      const p = m.perfById.get(id);
      if (!p || (allow && (p.gender || "") !== allow)) continue;
      const code = countryCode(p.country);
      if (!code) { noCountry += 1; continue; }
      countries.set(code, (countries.get(code) || 0) + 1);
    }
    const cRows = [...countries.entries()].sort((a, b) => b[1] - a[1]);
    const ageBars = [];
    for (let a = 18; a <= 50; a++) {
      const r = ages.get(a) || { n: 0, o: 0 };
      ageBars.push({ value: r.n, label: String(a), tip: `Age ${a}: ${plural(r.n, "appearance")}, ${os(r.o)}${r.n ? ` (${(r.o / r.n).toFixed(2)} per scene)` : ""}`,
                     click: r.n ? () => navigate(S([{ type: "performer_age", modifier: "EQUALS", value: { value: a } }], "date")) : null });
    }
    const faceBars = faces.slice(-30).map((x) => ({ value: x.n, label: String(x.year), tip: `${x.year}: ${plural(x.n, "performer")} in their first scene here` }));
    const sMode = cs.studios;

    el.innerHTML = `
      ${card({ title: "Growth", icon: "trend", c: "gr",
        sub: g.length ? `${fmtN(N)} scenes added since ${fmtDate(g[0].from, { month: "long", year: "numeric" })} · <b style="color:var(--hi)">${Math.round(avg12)}</b> a month over the last year${busiest ? ` · busiest month ${fmtDate(busiest.from, { month: "short", year: "numeric" })} (+${fmtN(busiest.added)})` : ""}${doubled !== null && doubled > 0 ? ` · doubled in the last ${plural(doubled, "month")}` : ""}` : "" },
        g.length ? growthChart(g) + `<div style="margin-top:12px">${barChart(recent, { c: "gr", height: 90 })}</div><div class="ins-note">Added per month, last 24. Click a month to list what came in.</div>` : `<div class="ins-empty">No added dates.</div>`)}
      <div class="ins-grid">
        ${card({ title: "Top tags", icon: "tag", c: "gr", sub: "Scenes with each tag. Click one to see what goes with it." },
          `<div class="ins-scroll" style="max-height:470px">${rows(tags.slice(0, 40).map((t) => ({ labelHtml: `<span style="${tagSel && t.id === tagSel.id ? "color:var(--hi);font-weight:600" : ""}">${esc(t.name)}</span>`,
            value: t.n, text: `${fmtN(t.n)} <small>${pct(t.n / Math.max(1, N))}</small>`, color: tagSel && t.id === tagSel.id ? "#A9BA5A" : "var(--gr)",
            set: `col.tag=${t.id}`, tip: `${t.name}: ${plural(t.n, "scene")}` })), { lw: "minmax(110px,170px)", vw: "100px" })}</div>`)}
        ${card({ title: tagSel ? `Goes with ${esc(tagSel.name)}` : "Goes with", icon: "link", c: "gr",
          right: tagSel ? go(S([{ type: "tags", modifier: "INCLUDES", value: items(tagSel.id, tagSel.name) }]), `${fmtN(tagSel.n)} scenes`) : "",
          sub: "Share of its scenes that also have each tag; the lift is how much more often than across the library." },
          co.rows.length ? rows(co.rows.slice(0, 14).map((r) => ({ label: r.name, value: r.share, text: `${pct(r.share)} <span class="ins-lift ${liftTone(r.lift)}">${r.lift.toFixed(1)}×</span>`,
            color: r.lift >= 1.25 ? "var(--gr)" : r.lift <= 0.8 ? "var(--re)" : "var(--tx2)",
            tip: `${r.name}: on ${fmtN(r.together)} of ${fmtN(co.n)} ${tagSel.name} scenes`,
            go: S([{ type: "tags", modifier: "INCLUDES_ALL", value: { items: [{ id: tagSel.id, label: tagSel.name }, { id: r.id, label: r.name }], excluded: [], depth: 0 } }]) })),
            { max: 1, lw: "minmax(110px,170px)", vw: "120px" }) : `<div class="ins-empty">Not enough scenes share a tag with it yet.</div>`)}
      </div>
      <div class="ins-grid">
        ${card({ title: "Studios", icon: "studio", c: "or", right: `${chipFor("col", "studios", "networks", "Networks", "or")}${chipFor("col", "studios", "studios", "Studios", "or")}`,
          sub: sMode === "networks" ? `A parent studio and its sites together. ${plural(net.independent.studios, "independent studio")} hold ${plural(net.independent.scenes, "scene")}.` : "Scenes per studio" },
          sMode === "networks"
            ? (net.networks.length ? rows(net.networks.slice(0, 14).map((x, i) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${plural(x.sites, "site")}</small>`,
                color: CYCLE[i % CYCLE.length], go: `/studios/${x.id}`, tip: `${x.name}\n${plural(x.sites, "site")} with scenes here\n${plural(x.scenes, "scene")} · ${fmtBytes(x.size)}` })), { lw: "minmax(110px,170px)", vw: "120px" })
              : `<div class="ins-empty">No studio here has a parent set.</div>`) +
              (net.independent.list.length ? `<div class="ins-sub" style="margin:14px 0 6px">Largest independents</div>` +
                rows(net.independent.list.slice(0, 8).map((x) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${pct(x.scenes / Math.max(1, N))}</small>`,
                  color: "var(--tx2)", go: `/studios/${x.id}`, tip: `${x.name}: ${plural(x.scenes, "scene")}, ${fmtBytes(x.size)}` })),
                  { lw: "minmax(110px,170px)", vw: "120px", max: Math.max(1, ...net.networks.map((x) => x.scenes), net.independent.list[0].scenes) }) : "")
            : rows(net.studios.slice(0, 15).map((x, i) => ({ label: x.name, value: x.scenes, text: `${fmtN(x.scenes)} <small>${pct(x.scenes / Math.max(1, N))}</small>`,
                color: CYCLE[i % CYCLE.length], go: `/studios/${x.id}`, tip: `${x.name}: ${plural(x.scenes, "scene")}, ${fmtBytes(x.size)}` })), { lw: "minmax(110px,170px)", vw: "100px" }))}
        ${card({ title: "Who is in it", icon: "globe", c: "ma", sub: `${plural(inLib.size, "performer")} with a scene here` },
          `<div class="ins-split">${GENDERS.filter(([k]) => genderN.get(k)).map(([k, label, c]) => `<i style="flex:${genderN.get(k)};background:var(--${c})" data-tip="${esc(label)}: ${fmtN(genderN.get(k))} (${pct(genderN.get(k) / gTotal)})"></i>`).join("")}</div>
          <div class="ins-legend2" style="margin:0 0 12px">${GENDERS.filter(([k]) => genderN.get(k)).map(([k, label, c]) => `<span><i style="background:var(--${c})"></i>${esc(label)} <b style="color:var(--hi);font-weight:600">${fmtN(genderN.get(k))}</b> ${pct(genderN.get(k) / gTotal)}</span>`).join("")}</div>
          <div class="ins-dims">${[["FEMALE", "Women"], ["MALE", "Men"], ["ALL", "Everyone"]].map(([k, l]) => chipFor("col", "gender", k, l, "ma")).join("")}</div>
          <div class="ins-scroll" style="max-height:330px">${cRows.length ? rows(cRows.map(([code, n]) => ({ labelHtml: `${flag(code)}<span>${esc(regionName(code))}</span>`, value: n,
            text: `${fmtN(n)}`, color: "var(--ma)", go: P([{ type: "country", modifier: "EQUALS", value: code }]) })), { lw: "minmax(130px,200px)", vw: "60px" }) : `<div class="ins-empty">No countries set.</div>`}</div>
          <div class="ins-note">${plural(cRows.length, "country", "countries")} · ${plural(noCountry, "performer")} without one</div>`)}
      </div>
      <div class="ins-grid">
        ${card({ title: "Pairs", icon: "link", c: "ma", sub: "Performers who share the most scenes. Click to list them." },
          pr.length ? pr.map((x) => { const a = m.perfById.get(x.a) || { id: x.a, name: `Performer ${x.a}` }, b = m.perfById.get(x.b) || { id: x.b, name: `Performer ${x.b}` };
            return `<div class="ins-li click" style="grid-template-columns:54px minmax(0,1fr) auto" data-go="${esc(S([{ type: "performers", modifier: "INCLUDES_ALL", value: { items: [{ id: a.id, label: a.name }, { id: b.id, label: b.name }], excluded: [], depth: 0 } }]))}">
              <span style="display:flex">${avatar(a, "sm")}<span style="margin-left:-6px">${avatar(b, "sm")}</span></span>
              <div class="n">${esc(a.name)} <span style="color:var(--tx2)">and</span> ${esc(b.name)}</div><div class="v" style="color:var(--hi);font-weight:700">${plural(x.n, "scene")}</div></div>`; }).join("")
            : `<div class="ins-empty">No two performers share a scene yet.</div>`)}
        ${card({ title: "Ages and new faces", icon: "user", c: "pu", sub: "Age of each performer on the scene's date. Click an age to list those scenes." },
          barChart(ageBars, { c: "pu", height: 90 }) +
          `<div class="ins-sub" style="margin:14px 0 8px">The year each performer's first scene here came out</div>` +
          (faceBars.length ? barChart(faceBars, { c: "ma", height: 70 }) : `<div class="ins-empty">No release dates.</div>`))}
      </div>`;
  }

  // ── Controls (one delegated click handler on the root) ────────────────────

  function onClick(ev) {
    const t = ev.target.closest && ev.target.closest("[data-tab],[data-set],[data-nav],[data-daynav],[data-day],[data-bar],[data-go],[data-act],[data-jump]");
    if (!t || !app.root.contains(t)) return;
    if (t.dataset.tab) { app.tab = t.dataset.tab; setPref("tab", app.tab); render(); app.root.scrollIntoView({ block: "start" }); return; }
    if (t.dataset.jump) { document.getElementById(t.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.dataset.set) {
      const i = t.dataset.set.indexOf("=");
      const path = t.dataset.set.slice(0, i), raw = t.dataset.set.slice(i + 1);
      const [grp, key] = path.split(".");
      const val = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
      app[grp][key] = val;
      if (grp === "you" && key === "kind") app.you.offset = 0;
      if (grp === "you" && key === "dim") { setPref("dim", val); app.you.sort = "auto"; }
      // a different rule makes a different selection: hand ticks start over
      if (grp === "acts" && (key === "mode" || key === "sharp")) { app.acts.ticks = new Map(); app.acts.armed = false; }
      if (grp === "col" && key === "gender") setPref("gender", val);
      if (grp === "lib" && key === "timeline") app.lib.year = null;
      render();
      if (grp === "you" && key === "dim") document.getElementById("ins-works")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (t.dataset.nav) { app.you.offset = Math.min(0, app.you.offset + Number(t.dataset.nav)); render(); return; }
    if (t.dataset.daynav) {
      const d = parseDay(app.you.day || dayKey(Date.now()));
      const next = addDays(d, Number(t.dataset.daynav));
      if (next <= dayStart(Date.now())) app.you.day = dayKey(next);
      render(); document.getElementById("ins-otd")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (t.dataset.day) {
      app.tab = "you"; app.you.day = t.dataset.day; render();
      document.getElementById("ins-otd")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (t.dataset.bar) { const f = CLICKS[+t.dataset.bar]; if (f) f(); return; }
    if (t.dataset.go) { navigate(t.dataset.go); return; }
    if (t.dataset.act === "refresh") { if (!app.acts.run || app.acts.run.finished) { app.acts = freshActs(); load(true); } return; }
    if (t.dataset.act === "import") { importOStats(t); return; }
    if (t.dataset.act === "dups") { scanDuplicates(); return; }
    if (t.dataset.act === "dtick") {
      const a = app.acts, id = t.dataset.id;
      const it = dupState().plans.flatMap((p) => p.items).find((i) => i.s.id === id);
      if (it) a.ticks.set(id, !it.on);
      a.armed = false; render(); return;
    }
    if (t.dataset.act === "dtag") { tagTicked(t); return; }
    if (t.dataset.act === "dremove") {
      const a = app.acts;
      if (!a.armed) {
        a.armed = true; render();
        clearTimeout(a.armTimer);
        a.armTimer = setTimeout(() => { if (a.armed) { a.armed = false; if (app.tab === "actions") render(); } }, 6000);
        return;
      }
      removeTicked(); return;
    }
    if (t.dataset.act === "reencode") { tagReencode(t); return; }
    if (t.dataset.act === "phash") { runPhash(t); return; }
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
  // Stash draws its numbers as three ".stats" rows; Insights goes after the
  // last one (after the first put it between them). Insights covers every
  // one of those numbers, so by user request Stash's rows are hidden unless
  // the "Show Stash's own numbers" setting is on. Hidden with one stylesheet
  // that exists only while on /stats, never by removing React's elements,
  // and hidden from the start so they do not flash before the setting is
  // read (Stats Enhancer hid a tile by position and resized the rest).

  const onStats = () => /^\/stats\/?$/.test(location.pathname);
  let showNative = false;
  function syncNative() {
    const want = onStats() && !showNative;
    const el = document.getElementById("insights-hide-native");
    if (want && !el) {
      const s = document.createElement("style");
      s.id = "insights-hide-native";
      s.textContent = ".stats { display: none !important; }";
      document.head.appendChild(s);
    } else if (!want && el) el.remove();
  }
  readConfig().then((c) => { showNative = c.showStashNumbers === true || c.showStashNumbers === "true"; syncNative(); });
  function mount() {
    syncNative();
    if (!onStats()) return;
    if (app.root && app.root.isConnected) return;
    const rows = document.querySelectorAll(".stats");
    const native = rows[rows.length - 1];
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
    if (onStats()) mount(); else syncNative();
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
