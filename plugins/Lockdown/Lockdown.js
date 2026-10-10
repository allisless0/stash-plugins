/**
 * Lockdown - Stash UI plugin
 *
 * Locks this browser's Stash to one performer until an O on one of their
 * scenes. The performer comes from a spin of your favourites, a spin of a
 * saved performer filter, or the performer page you are on. Only that
 * performer's page, scenes, images and galleries open; anything else bounces
 * back. Holding "Give up" for five seconds ends it early, as a forfeit.
 *
 * The lock is per browser on purpose (localStorage). A plugin cannot truly
 * lock anything; this is a commitment game, and giving up is meant to be
 * possible but visible. History lives in Stash's plugin config.
 */
(function () {
  "use strict";
  if (window.__LockdownLoaded) return;
  window.__LockdownLoaded = true;

  const PLUGIN_ID = "Lockdown";
  const STATE_KEY = "lockdownState";   // the active lock, this browser only
  const PREF_KEY  = "lockdownPrefs";   // { roulette }
  const HOLD_MS   = 5000;              // how long Give up must be held
  const HISTORY_MAX = 200;
  const DEBUG = (() => { try { return localStorage.getItem("lockdownDebug") === "1"; } catch (_) { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════

  const PERF_TABS = ["", "scenes", "galleries", "images"];

  // What the lock says about a path:
  //   { ok: true }                      allowed as it is
  //   { check: "scene"|"image"|"gallery", id }   allowed if it features them
  //   { bounce: true }                  not allowed, send them back
  // With roulette on, the performer's scene list is off limits: scenes come
  // at random, so the Scenes tab bounces too.
  function routeCheck(pathname, pid, roulette) {
    const p = (pathname || "").replace(/\/+$/, "");
    let m = /^\/performers\/(\d+)(?:\/([a-z]+))?$/.exec(p);
    if (m) {
      if (m[1] !== String(pid)) return { bounce: true };
      const tab = m[2] || "";
      if (!PERF_TABS.includes(tab)) return { bounce: true };
      if (roulette && (tab === "" || tab === "scenes")) return { bounce: true };
      return { ok: true };
    }
    if ((m = /^\/scenes\/(\d+)$/.exec(p)))            return { check: "scene", id: m[1] };
    if ((m = /^\/images\/(\d+)$/.exec(p)))            return { check: "image", id: m[1] };
    if ((m = /^\/galleries\/(\d+)(?:\/.*)?$/.exec(p))) return { check: "gallery", id: m[1] };
    return { bounce: true };
  }

  // A card or list row on any page, as the item it shows: {kind, id} or
  // null. Scene, image and gallery cards are told apart by class, because a
  // scene card also links its galleries; a wall item or a queue row takes the
  // first item link it has.
  function cardItem(className, hrefs) {
    const cls = " " + (className || "") + " ";
    const order = cls.includes(" scene-card ") ? ["scenes"]
      : cls.includes(" image-card ") ? ["images"]
      : cls.includes(" gallery-card ") ? ["galleries"]
      : ["scenes", "images", "galleries"];
    const kinds = { scenes: "scene", images: "image", galleries: "gallery" };
    for (const want of order) {
      const re = new RegExp(`^(?:https?://[^/]+)?/${want}/(\\d+)(?:[/?#]|$)`);
      for (const h of hrefs || []) {
        const m = re.exec(h || "");
        if (m) return { kind: kinds[want], id: m[1] };
      }
    }
    return null;
  }

  // On the locked performer's own tabs, Stash merges any "performers" rule in
  // the URL with the performer the page is about; an "any of" rule then lists
  // other performers' scenes too. Those rules come out of the URL. Returns
  // the cleaned query string, or null when there was nothing to remove.
  function stripPerformerRules(search) {
    let params;
    try { params = new URLSearchParams(search || ""); } catch { return null; }
    const cs = params.getAll("c");
    const keep = cs.filter((raw) => {
      let inString = false, escaped = false, json = "";
      for (const ch of raw) {
        if (escaped) { escaped = false; json += ch; continue; }
        if (ch === "\\" && inString) { escaped = true; json += ch; continue; }
        if (ch === '"') inString = !inString;
        json += (!inString && ch === "(") ? "{" : (!inString && ch === ")") ? "}" : ch;
      }
      try { return JSON.parse(json).type !== "performers"; } catch { return true; }
    });
    if (keep.length === cs.length) return null;
    // Rebuild by hand from the raw parts: URLSearchParams would re-encode the
    // criteria differently from how Stash writes them.
    const parts = (search || "").replace(/^\?/, "").split("&").filter((part) => {
      if (!part.startsWith("c=")) return true;
      let raw;
      try { raw = decodeURIComponent(part.slice(2).replace(/\+/g, " ")); } catch { return true; }
      return keep.includes(raw);
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  // Gender and circumcision are saved as display labels ("Transgender
  // Female", "Uncut"); GraphQL wants the enum. Stash maps label to enum and
  // falls back to a case-insensitive match; the enums are the labels in upper
  // snake case, so that is the rule.
  function enumOf(label) {
    return String(label || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  }

  const ids = (list) => (list || []).map((x) => (x && typeof x === "object" ? String(x.id) : String(x)));

  // A saved performer filter's object_filter, as the GraphQL PerformerFilterType
  // input, the way Stash's criteria do it (toCriterionInput). `fieldTypes`
  // maps each filter field to its input type name, read from the schema, so
  // the shape follows the Stash version rather than a list in this file.
  // Throws on a field it cannot translate: a spin that silently dropped part
  // of a filter would pick from the wrong people.
  function toGraphQLFilter(objectFilter, fieldTypes) {
    const out = {};
    for (const [field, saved] of Object.entries(objectFilter || {})) {
      const type = fieldTypes[field];
      if (!type) throw new Error(`unknown filter field "${field}"`);
      const s = saved && typeof saved === "object" ? saved : { value: saved };
      const mod = s.modifier;
      const v = s.value;
      const num = (x) => (x && typeof x === "object" ? x : { value: x, value2: s.value2 });
      switch (type) {
        case "IntCriterionInput":
        case "FloatCriterionInput": {
          const n = num(v);
          out[field] = { modifier: mod, value: n.value ?? 0, value2: n.value2 };
          break;
        }
        case "DateCriterionInput":
        case "TimestampCriterionInput": {
          const n = num(v);
          out[field] = { modifier: mod, value: n.value ?? "", value2: n.value2 };
          break;
        }
        case "StringCriterionInput":
          out[field] = { modifier: mod, value: v ?? "" };
          break;
        case "MultiCriterionInput":
        case "HierarchicalMultiCriterionInput": {
          const items = Array.isArray(v) ? v : (v && v.items) || [];
          const o = { modifier: mod, value: ids(items), excludes: ids(v && v.excluded) };
          if (type === "HierarchicalMultiCriterionInput") o.depth = mod === "EQUALS" ? 0 : ((v && v.depth) || 0);
          out[field] = o;
          break;
        }
        case "GenderCriterionInput":
          out[field] = { modifier: mod, value_list: (Array.isArray(v) ? v : v ? [v] : []).map(enumOf) };
          break;
        case "CircumcisionCriterionInput":
          out[field] = { modifier: mod, value: (Array.isArray(v) ? v : v ? [v] : []).map(enumOf) };
          break;
        case "StashIDCriterionInput":
          out[field] = { modifier: mod, endpoint: v && v.endpoint, stash_id: v && (v.stashID ?? v.stash_id) };
          break;
        case "Boolean":
          out[field] = v === true || v === "true";
          break;
        case "String":
          out[field] = v ?? "";
          break;
        case "CustomFieldCriterionInput":     // saved as the list itself
          out[field] = Array.isArray(saved) ? saved : v;
          break;
        default:
          throw new Error(`filter field "${field}" (${type}) is not supported`);
      }
    }
    return out;
  }

  // Delays for a spin of `steps` names: fast, then slowing into the pick.
  function spinSchedule(steps) {
    const out = [];
    for (let i = 0; i < steps; i++) {
      const t = i / Math.max(1, steps - 1);
      out.push(Math.round(55 + 420 * t * t * t));
    }
    return out;
  }

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(r).padStart(2, "0")}s`;
    return `${r}s`;
  }

  // Lifetime totals, kept apart from the history list and updated with each
  // lockdown. The list is capped (HISTORY_MAX) to keep the config small;
  // totals counted from it would quietly shrink once it filled (1.0 did
  // that). `perf` counts lockdowns per performer for "most locked"; it grows
  // with the number of different performers, not of lockdowns. Keys this
  // version does not know (1.2's fastestMs, later ones) ride through.
  const EMPTY_STATS = { v: 2, done: 0, gaveUp: 0, totalMs: 0, streak: 0, bestStreak: 0, perf: {} };

  const isEntry = (e) => !!e && (e.result === "done" || e.result === "gaveup") && typeof e.ms === "number";
  const perfKey = (e) => (e.pid ? String(e.pid) : `name:${e.name || "?"}`);

  // Which entry a row is: its id from 1.3 on, a fingerprint before that.
  function entryKey(e) {
    return e && e.id ? String(e.id) : `${e && e.pid}|${e && e.at}|${e && e.ms}|${e && e.result}`;
  }

  function addToStats(stats, e) {
    const st = { ...EMPTY_STATS, ...(stats || {}) };
    st.perf = { ...(st.perf || {}) };
    if (!isEntry(e)) return st;
    st.totalMs += e.ms;
    if (e.result === "done") {
      st.done += 1;
      st.streak += 1;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
    } else {
      st.gaveUp += 1;
      st.streak = 0;
    }
    const k = perfKey(e);
    st.perf[k] = { name: e.name || (st.perf[k] && st.perf[k].name) || "?", n: ((st.perf[k] && st.perf[k].n) || 0) + 1 };
    return st;
  }

  // For a history from before totals (or per-performer counts) were kept:
  // count what the list has.
  function statsFromHistory(list) {
    return (list || []).reduce(addToStats, { ...EMPTY_STATS, perf: {} });
  }

  function perfFromList(list) {
    return statsFromHistory(list).perf;
  }

  // Current and best run of completions, from a list in time order.
  function streaksOf(list) {
    let run = 0, best = 0;
    for (const e of list || []) {
      if (!isEntry(e)) continue;
      if (e.result === "done") { run += 1; best = Math.max(best, run); } else run = 0;
    }
    return { streak: run, best };
  }

  // Totals after removing one entry. `rest` is the list without it. When the
  // list still holds every lockdown counted, streaks are recounted exactly;
  // past the 200-entry cap the oldest are gone, so the best streak can only
  // be kept or raised, never recounted (documented limit).
  function removeFromStats(stats, e, rest) {
    const st = { ...EMPTY_STATS, ...(stats || {}) };
    st.perf = { ...(st.perf || {}) };
    if (!isEntry(e)) return st;
    const complete = st.done + st.gaveUp === (rest || []).filter(isEntry).length + 1;
    st.totalMs = Math.max(0, st.totalMs - e.ms);
    if (e.result === "done") st.done = Math.max(0, st.done - 1);
    else st.gaveUp = Math.max(0, st.gaveUp - 1);
    const k = perfKey(e);
    if (st.perf[k]) {
      const n = (st.perf[k].n || 0) - 1;
      if (n > 0) st.perf[k] = { ...st.perf[k], n }; else delete st.perf[k];
    }
    const s = streaksOf(rest);
    st.streak = s.streak;
    st.bestStreak = complete ? s.best : Math.max(s.best, st.bestStreak);
    return st;
  }

  // The performer locked most often, or null. Ties go to the name first in
  // the alphabet so the tile does not flicker between equals.
  function mostLocked(stats) {
    let best = null;
    for (const v of Object.values((stats && stats.perf) || {})) {
      if (!v || !v.n) continue;
      if (!best || v.n > best.n || (v.n === best.n && String(v.name) < String(best.name))) best = v;
    }
    return best;
  }

  // Newest first, by calendar month: [{ key, label, done, gaveUp, items }].
  function groupByMonth(entries) {
    const groups = [];
    const byKey = new Map();
    const sorted = (entries || []).filter(isEntry).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    for (const e of sorted) {
      const d = new Date(typeof e.at === "number" ? e.at : 0);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }), done: 0, gaveUp: 0, items: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      g.items.push(e);
      if (e.result === "done") g.done += 1; else g.gaveUp += 1;
    }
    return groups;
  }

  // The full view's filters: result ("all" | "done" | "gaveup") and a name.
  function filterEntries(entries, result, q) {
    const term = String(q || "").trim().toLowerCase();
    return (entries || []).filter((e) => isEntry(e) &&
      (result === "all" || !result || e.result === result) &&
      (!term || String(e.name || "").toLowerCase().includes(term)));
  }

  // undefined: none stored yet (build from history); null: stored but
  // unreadable (leave alone); otherwise the totals.
  function parseStats(raw) {
    if (raw === undefined || raw === null || raw === "") return undefined;
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }

  // "today", "yesterday", "3d ago", else a short date.
  function fmtWhen(at, now) {
    const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(now) - day(at)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // The stored history, or null when it cannot be trusted (never overwrite
  // a list that failed to parse).
  function parseHistory(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (_) { return null; }
  }

  if (window.__LOCKDOWN_TEST__) {
    window.__LockdownTest = { routeCheck, enumOf, toGraphQLFilter, spinSchedule, fmtDuration,
                              addToStats, statsFromHistory, parseStats, fmtWhen, entryKey,
                              removeFromStats, mostLocked, groupByMonth, filterEntries, streaksOf,
                              parseHistory, cardItem, stripPerformerRules };
    return;
  }

  // ═══ Stash ═════════════════════════════════════════════════════════════════

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let json;
    try { json = await res.json(); }
    catch { throw new Error(`Stash returned ${res.status}${res.status === 401 ? ": logged out?" : ""}`); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }

  const PERF_FIELDS = "id name image_path scene_count";

  async function favourites() {
    const d = await gql(`query { findPerformers(performer_filter: { filter_favorites: true },
                           filter: { per_page: -1 }) { performers { ${PERF_FIELDS} } } }`);
    return (d?.findPerformers?.performers ?? []).filter((p) => p.scene_count > 0);
  }

  async function savedPerformerFilters() {
    const d = await gql(`query { findSavedFilters(mode: PERFORMERS) { id name find_filter { q } object_filter } }`);
    return d?.findSavedFilters ?? [];
  }

  // Each PerformerFilterType field's input type name, read once.
  let fieldTypes = null;
  async function performerFieldTypes() {
    if (fieldTypes) return fieldTypes;
    const d = await gql(`query { __type(name: "PerformerFilterType") {
                           inputFields { name type { kind name ofType { kind name ofType { name } } } } } }`);
    const out = {};
    for (const f of d?.__type?.inputFields ?? []) {
      let t = f.type;
      while (t && !t.name && t.ofType) t = t.ofType;
      out[f.name] = t?.name;
    }
    fieldTypes = out;
    return out;
  }

  async function performersFor(saved) {
    const filter = toGraphQLFilter(saved.object_filter, await performerFieldTypes());
    const q = saved.find_filter?.q || undefined;
    const d = await gql(`query ($pf: PerformerFilterType, $f: FindFilterType) {
                           findPerformers(performer_filter: $pf, filter: $f) { performers { ${PERF_FIELDS} } } }`,
                        { pf: filter, f: { per_page: -1, q } });
    return (d?.findPerformers?.performers ?? []).filter((p) => p.scene_count > 0);
  }

  // Search box: performers with at least one scene, by name.
  async function searchPerformers(term) {
    const d = await gql(`query ($f: FindFilterType, $pf: PerformerFilterType) {
                           findPerformers(filter: $f, performer_filter: $pf) { performers { ${PERF_FIELDS} } } }`,
                        { f: { q: term, per_page: 8, sort: "name", direction: "ASC" },
                          pf: { scene_count: { modifier: "GREATER_THAN", value: 0 } } });
    return d?.findPerformers?.performers ?? [];
  }

  // How many performers with scenes a saved filter matches, for its menu
  // item. Throws like performersFor when the filter cannot be translated.
  async function countFor(saved) {
    const filter = toGraphQLFilter(saved.object_filter, await performerFieldTypes());
    if (!filter.scene_count) filter.scene_count = { modifier: "GREATER_THAN", value: 0 };
    const d = await gql(`query ($pf: PerformerFilterType, $f: FindFilterType) {
                           findPerformers(performer_filter: $pf, filter: $f) { count } }`,
                        { pf: filter, f: { per_page: 1, q: saved.find_filter?.q || undefined } });
    return d?.findPerformers?.count ?? 0;
  }

  async function performer(id) {
    const d = await gql(`query ($id: ID!) { findPerformer(id: $id) { ${PERF_FIELDS} } }`, { id });
    return d?.findPerformer ?? null;
  }

  // Sum of O counts over every scene they are in. An O anywhere on those
  // scenes, from any page or device, raises it.
  async function sceneOSum(pid) {
    const d = await gql(`query ($pf: SceneFilterType) { findScenes(scene_filter: $pf, filter: { per_page: -1 }) {
                           scenes { o_counter } } }`,
                        { pf: { performers: { value: [String(pid)], modifier: "INCLUDES" } } });
    return (d?.findScenes?.scenes ?? []).reduce((a, s) => a + (s.o_counter || 0), 0);
  }

  async function randomScene(pid, notId) {
    const seed = Math.floor(Math.random() * 1e8);
    const d = await gql(`query ($pf: SceneFilterType, $f: FindFilterType) { findScenes(scene_filter: $pf, filter: $f) {
                           scenes { id } } }`,
                        { pf: { performers: { value: [String(pid)], modifier: "INCLUDES" } },
                          f: { per_page: 2, sort: `random_${seed}` } });
    const list = d?.findScenes?.scenes ?? [];
    const pick = list.find((s) => String(s.id) !== String(notId)) || list[0];
    return pick ? String(pick.id) : null;
  }

  async function features(kind, id, pid) {
    const q = {
      scene:   `query ($id: ID!) { r: findScene(id: $id) { performers { id } } }`,
      image:   `query ($id: ID!) { r: findImage(id: $id) { performers { id } } }`,
      gallery: `query ($id: ID!) { r: findGallery(id: $id) { performers { id } } }`,
    }[kind];
    const d = await gql(q, { id });
    return (d?.r?.performers ?? []).some((p) => String(p.id) === String(pid));
  }

  // Which of these items feature the performer, in one request: aliases of
  // findScene / findImage / findGallery, which exist under the same names
  // across Stash versions (the by-id arguments of the list queries do not).
  async function featuresMany(items, pid) {
    const field = { scene: "findScene", image: "findImage", gallery: "findGallery" };
    const parts = items.filter((it) => /^\d+$/.test(it.id) && field[it.kind])
      .map((it, i) => `a${i}: ${field[it.kind]}(id: "${it.id}") { performers { id } }`);
    if (!parts.length) return [];
    const d = await gql(`query { ${parts.join(" ")} }`);
    return items.map((_, i) => (d?.[`a${i}`]?.performers ?? []).some((p) => String(p.id) === String(pid)));
  }

  // History: read-merge-write of this plugin's config map; every other key
  // rides through, and a history or totals that do not parse are left alone.
  // `fn(list, stats)` returns the new { list, stats }. Writes run one at a
  // time.
  let writeChain = Promise.resolve();
  function updateHistory(fn) {
    const run = writeChain.then(async () => {
      const d = await gql(`query { configuration { plugins } }`);
      const plugins = d?.configuration?.plugins;
      if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
      const mine = plugins[PLUGIN_ID] || {};
      const list = parseHistory(mine.history);
      if (list === null) throw new Error("saved history could not be read; left as it was");
      let stats = parseStats(mine.stats);
      if (stats === null) throw new Error("saved totals could not be read; left as they were");
      if (stats === undefined) stats = statsFromHistory(list);      // first time: from the list
      if (!stats.perf) stats = { ...stats, perf: perfFromList(list) }; // from 1.2: counts start here
      const next = fn(list, stats);
      await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                { id: PLUGIN_ID, input: { ...mine, history: JSON.stringify(next.list.slice(-HISTORY_MAX)),
                                          stats: JSON.stringify(next.stats) } });
      return { list: next.list.slice(-HISTORY_MAX), stats: next.stats };
    });
    writeChain = run.catch((e) => log(`History not saved: ${e.message}`, "error"));
    return run;
  }

  function recordHistory(entry) {
    return updateHistory((list, stats) => ({ list: list.concat(entry), stats: addToStats(stats, entry) }));
  }

  function removeEntry(key) {
    return updateHistory((list, stats) => {
      const i = list.findIndex((e) => isEntry(e) && entryKey(e) === key);
      if (i < 0) return { list, stats };
      const rest = list.slice(0, i).concat(list.slice(i + 1));
      return { list: rest, stats: removeFromStats(stats, list[i], rest) };
    });
  }

  // A fresh start: the list and the totals. Other keys are kept.
  function clearHistory() {
    return updateHistory(() => ({ list: [], stats: { ...EMPTY_STATS, perf: {} } }));
  }

  async function readHistory() {
    try {
      const d = await gql(`query { configuration { plugins } }`);
      const mine = d?.configuration?.plugins?.[PLUGIN_ID] || {};
      const list = parseHistory(mine.history) || [];
      let stats = parseStats(mine.stats) || statsFromHistory(list);
      if (!stats.perf) stats = { ...stats, perf: perfFromList(list) };
      return { list, stats };
    } catch (_) { return { list: [], stats: { ...EMPTY_STATS, perf: {} } }; }
  }

  // ═══ State ═════════════════════════════════════════════════════════════════

  function readState() {
    try { const s = JSON.parse(localStorage.getItem(STATE_KEY) || "null"); return s && s.pid ? s : null; }
    catch (_) { return null; }
  }
  function writeState(s) {
    try { if (s) localStorage.setItem(STATE_KEY, JSON.stringify(s)); else localStorage.removeItem(STATE_KEY); }
    catch (e) { log(`Could not store the lock: ${e.message}`, "error"); }
  }
  function prefs() {
    try { return { roulette: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; }
    catch (_) { return { roulette: false }; }
  }
  function setPref(k, v) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {}
  }

  let lock = readState();

  // ═══ Styles ════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("lockdown-styles")) return;
    const s = document.createElement("style");
    s.id = "lockdown-styles";
    s.textContent = `
/* Flexoki dark (as Insights). Red #D14D41 is the lock, magenta #CE5D97 an O,
   coral #E8705F a give-up. Only colours and shadows live here besides the
   enforcement rules, which must not change. */
.ld-nav .ld-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #D14D41;
  margin-left: 5px; vertical-align: middle; box-shadow: 0 0 6px #D14D41; }
/* The nav button stays Stash's own; only the lock picks up the accent. */
.ld-nav a svg { color: #D14D41; }
body.ld-on .top-nav { visibility: hidden !important; }
#ld-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 1065; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; background: #282726; background: linear-gradient(90deg, color-mix(in srgb, #D14D41 20%, #1C1B1A), #282726 60%);
  border-bottom: 2px solid #D14D41;
  color: #CECDC3; font-size: 14px; box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 12px 24px -10px rgba(0,0,0,.65); }
#ld-bar img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 2px solid #D14D41; }
#ld-bar .ld-who b { font-size: 15px; color: #E6E4D9; }
#ld-bar .ld-time { font-variant-numeric: tabular-nums; color: #D0A215; font-weight: 600; min-width: 64px; }
#ld-bar a, #ld-bar button { background: linear-gradient(180deg, #343331, #282726); border: 1px solid #0b0a0a;
  border-top-color: #403E3C; color: #CECDC3; border-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.5);
  padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
#ld-bar a:hover, #ld-bar button:hover { color: #E6E4D9; border-top-color: #575653; }
#ld-bar .ld-links { display: flex; gap: 6px; }
#ld-bar .ld-giveup { margin-left: auto; position: relative; overflow: hidden; border-color: #AF3029; color: #E8705F;
  user-select: none; touch-action: none; }
#ld-bar .ld-giveup:hover { border-color: #D14D41; color: #E6E4D9; }
#ld-bar .ld-giveup .ld-fill { position: absolute; inset: 0; width: 0; background: rgba(209,77,65,.55); }
#ld-bar .ld-giveup span { position: relative; }
#ld-veil { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1064; background: #100F0F; display: none; }
/* Every card stays invisible until it is known to feature the performer, so
   a list that somehow widens never shows anyone else. */
body.ld-on .scene-card:not(.ld-ok), body.ld-on .image-card:not(.ld-ok),
body.ld-on .gallery-card:not(.ld-ok), body.ld-on .wall-item:not(.ld-ok),
body.ld-on li:has(> .queue-scene-details):not(.ld-ok),
body.ld-on li:has(.queue-scene-details):not(.ld-ok) { visibility: hidden !important; }
body.ld-on .ld-no { display: none !important; }
body.ld-checking #ld-veil { display: block; }
.ld-modal-back { position: fixed; inset: 0; z-index: 1070; background: rgba(0,0,0,.65); display: flex;
  align-items: center; justify-content: center; }
.ld-modal { width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 40px); overflow-y: auto;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-radius: 12px; color: #CECDC3; padding: 18px 20px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); scrollbar-color: #403E3C transparent; }
.ld-modal h3 { margin: 0 0 4px; font-size: 19px; color: #E6E4D9; }
.ld-modal .ld-sub { color: #878580; font-size: 13px; margin-bottom: 14px; }
.ld-modal .ld-opt { display: flex; gap: 8px; margin-bottom: 8px; }
.ld-modal button, .ld-modal select { font: inherit; font-size: 14px; border-radius: 6px; }
.ld-modal .ld-go { flex: 1; text-align: left; padding: 10px 12px; background: linear-gradient(180deg, #343331, #282726);
  color: #CECDC3; border: 1px solid #0b0a0a; border-top-color: #403E3C; box-shadow: 0 1px 2px rgba(0,0,0,.5); cursor: pointer; }
.ld-modal .ld-go:hover:not(:disabled) { color: #E6E4D9; border-color: color-mix(in srgb, #D14D41 55%, #0b0a0a);
  border-top-color: #D14D41; background: #343331; background: linear-gradient(180deg, color-mix(in srgb, #D14D41 16%, #343331), #282726); }
.ld-modal .ld-go:disabled { opacity: .45; cursor: default; }
.ld-modal .ld-go small { display: block; color: #878580; font-size: 12px; }
.ld-modal select { flex: 1; min-width: 0; background: #1C1B1A; color: #CECDC3; border: 1px solid #000;
  border-bottom-color: #343331; box-shadow: inset 0 2px 5px rgba(0,0,0,.5); padding: 8px; }
.ld-modal label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #B7B5AC; margin: 12px 0 4px;
  cursor: pointer; }
.ld-modal .ld-err { color: #D0A215; font-size: 12px; min-height: 1.2em; margin-top: 6px; }
.ld-modal .ld-hist { border-top: 1px solid #403E3C; margin-top: 14px; padding-top: 12px; font-size: 12px; color: #B7B5AC; }
.ld-modal .ld-empty { color: #878580; text-align: center; padding: 6px 0; }
.ld-ico { width: 16px; height: 16px; flex: none; vertical-align: middle; }
.ld-drop path { fill: #CE5D97; }
.ld-drop .ld-shine { fill: none; stroke: rgba(255,255,255,.75); stroke-width: 1.1; stroke-linecap: round; }
.ld-x path { fill: none; stroke: #E8705F; stroke-width: 2.4; stroke-linecap: round; }
.ld-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.ld-tile { background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; border-radius: 8px; padding: 8px 6px 7px;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.5);
  text-align: center; display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
.ld-tile .ld-ico { width: 18px; height: 18px; margin-bottom: 1px; }
.ld-tile b { font-size: 17px; color: #E6E4D9; font-variant-numeric: tabular-nums; line-height: 1.15; }
.ld-tile span { font-size: 10.5px; color: #878580; line-height: 1.25; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 100%; }
.ld-strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 10px 0 2px; }
.ld-strip .ld-ico { width: 14px; height: 14px; }
.ld-total { font-size: 11px; color: #878580; margin: 6px 0 4px; }
.ld-rows { display: flex; flex-direction: column; gap: 2px; }
.ld-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; }
.ld-row:hover { background: #343331; }
.ld-row.gaveup .ld-rname { color: #B7B5AC; }
.ld-av img, .ld-av i { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; display: block; }
.ld-av i { background: #403E3C; color: #B7B5AC; font-style: normal; font-size: 11px; font-weight: 700;
  text-align: center; line-height: 24px; }
.ld-rname { flex: 1; min-width: 0; color: #CECDC3; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-rtime { font-variant-numeric: tabular-nums; color: #B7B5AC; }
.ld-row.gaveup .ld-rtime { color: #E8705F; }
.ld-rwhen { color: #878580; min-width: 62px; text-align: right; }
.ld-more { margin-top: 6px; width: 100%; padding: 5px; background: none; border: 1px dashed #403E3C;
  border-radius: 6px; color: #878580; font: inherit; font-size: 12px; cursor: pointer; }
.ld-more:hover { color: #E6E4D9; border-color: #575653; }
.ld-modal .ld-close { margin-top: 12px; width: 100%; padding: 7px; background: linear-gradient(180deg, #343331, #282726);
  color: #878580; border: 1px solid #0b0a0a; border-top-color: #403E3C; box-shadow: 0 1px 2px rgba(0,0,0,.5); cursor: pointer; }
.ld-modal .ld-close:hover { color: #E6E4D9; border-top-color: #575653; }
.ld-spin { text-align: center; padding: 10px 0 4px; }
.ld-spin img { width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 3px solid #403E3C;
  background: #1C1B1A; box-shadow: 0 12px 24px -10px rgba(0,0,0,.65); }
.ld-spin .ld-name { font-size: 22px; font-weight: 700; margin-top: 12px; min-height: 1.3em; color: #E6E4D9; }
.ld-spin.ld-landed img { border-color: #D14D41; box-shadow: 0 0 24px rgba(209,77,65,.6); }
.ld-spin .ld-msg { color: #878580; font-size: 13px; margin-top: 6px; min-height: 1.2em; }

.ld-modal.ld-tall { max-height: calc(100vh - 40px); }
.ld-modal .ld-head { display: flex; align-items: center; gap: 8px; }
.ld-modal .ld-head h3 { display: flex; align-items: center; gap: 7px; }
.ld-lock { width: 19px; height: 19px; }
.ld-lock rect { fill: #D14D41; }
.ld-lock path { stroke: #D14D41; stroke-width: 1.6; }
.ld-modal .ld-link { background: none; border: 0; padding: 0; color: #4385BE; font: inherit; font-size: 13px;
  cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.ld-modal .ld-head .ld-link { margin-left: auto; }
.ld-modal .ld-link:hover { text-decoration: underline; color: #6FA3D6; }
.ld-modal .ld-danger { color: #E8705F; }
.ld-modal .ld-danger.ld-armed { color: #100F0F; background: #D14D41; border-radius: 4px; padding: 2px 8px; text-decoration: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2); }
.ld-guide { background: #282726; background: color-mix(in srgb, #4385BE 10%, #1C1B1A);
  border: 1px solid color-mix(in srgb, #4385BE 35%, transparent); border-radius: 8px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
  padding: 10px 12px; margin-bottom: 14px; font-size: 13px; color: #CECDC3; }
.ld-guide ol { margin: 6px 0 4px; padding-left: 20px; line-height: 1.6; }
.ld-guide .ld-link { display: block; margin-left: auto; }
.ld-modal .ld-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #878580; margin-bottom: 6px; }
.ld-search { position: relative; }
.ld-search .ld-ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #878580; }
.ld-search input { width: 100%; box-sizing: border-box; background: #1C1B1A; color: #CECDC3; border: 1px solid #000;
  border-bottom-color: #343331; box-shadow: inset 0 2px 5px rgba(0,0,0,.5);
  border-radius: 6px; padding: 9px 10px 9px 32px; font: inherit; font-size: 14px; outline: none; }
.ld-search input::placeholder { color: #6F6E69; }
.ld-search input:focus { border-color: #D14D41; }
.ld-search.ld-small { flex: 0 1 150px; margin-left: auto; }
.ld-search.ld-small input { padding: 5px 8px 5px 28px; font-size: 12px; }
.ld-results { margin-top: 4px; }
.ld-res { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 14px; }
.ld-res.ld-hi { background: #343331; background: color-mix(in srgb, #D14D41 14%, #343331); color: #E6E4D9;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
.ld-res .ld-rmeta { color: #878580; font-size: 12px; }
.ld-res .ld-arrow { color: #878580; visibility: hidden; }
.ld-res.ld-hi .ld-arrow { visibility: visible; }
.ld-hint { color: #878580; font-size: 12px; padding: 6px 2px; }
.ld-or { display: flex; align-items: center; gap: 10px; margin: 16px 0 8px; color: #878580; font-size: 12px; }
.ld-or::before, .ld-or::after { content: ""; flex: 1; height: 1px; background: #403E3C; }
.ld-spins { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.ld-spins .ld-go { width: 100%; }
.ld-menuwrap { position: relative; }
.ld-menu { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 2; background: #282726;
  background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-radius: 6px; padding: 4px; max-height: 240px; overflow-y: auto;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); scrollbar-color: #403E3C transparent; }
.ld-mi { display: flex; align-items: center; gap: 8px; width: 100%; background: none; border: 0; color: #CECDC3;
  font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 4px; cursor: pointer; text-align: left; }
.ld-mi:hover { background: #343331; color: #E6E4D9; }
.ld-mi span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-mi small { color: #878580; font-size: 11px; }
.ld-mi.ld-cant { opacity: .55; }
.ld-modal .ld-roul { align-items: flex-start; margin-top: 14px; }
.ld-modal .ld-roul input { margin-top: 3px; accent-color: #D14D41; }
.ld-modal .ld-roul small { display: block; color: #878580; font-size: 12px; }
.ld-hhead { display: flex; align-items: center; margin-bottom: 8px; }
.ld-hhead b { font-size: 14px; color: #E6E4D9; }
.ld-hhead .ld-link { margin-left: auto; }
.ld-crown path { fill: #D0A215; }
.ld-flame path { fill: #DA702C; }
.ld-tile.ld-tname b { font-size: 13px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-del { background: none; border: 0; color: #878580; cursor: pointer; padding: 0 2px; font: inherit; font-size: 12px;
  visibility: hidden; min-width: 18px; }
.ld-row:hover .ld-del, .ld-row.ld-confirm .ld-del { visibility: visible; }
.ld-del:hover { color: #E8705F; }
.ld-row.ld-confirm { background: rgba(209,77,65,.18); }
.ld-row.ld-confirm .ld-del { color: #E8705F; font-weight: 600; }
.ld-all { margin-top: 8px; }
.ld-filters { display: flex; align-items: center; gap: 6px; margin: 10px 0 6px; flex-wrap: wrap; }
.ld-chip { display: inline-flex; align-items: center; gap: 4px; background: #1C1B1A; border: 1px solid #000;
  border-bottom-color: #343331; color: #B7B5AC;
  border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.ld-chip:hover { color: #E6E4D9; }
.ld-chip .ld-ico { width: 12px; height: 12px; }
.ld-chip.ld-on { background: #343331; background: color-mix(in srgb, #D14D41 22%, #343331);
  border-color: color-mix(in srgb, #D14D41 50%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); color: #E6E4D9; }
.ld-month { display: flex; align-items: center; font-size: 11px; color: #878580; padding: 12px 6px 4px;
  border-bottom: 1px solid #403E3C; margin-bottom: 2px; }
.ld-month .ld-mcount { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
.ld-month .ld-ico { width: 11px; height: 11px; }
.ld-foot { font-size: 11px; color: #6F6E69; text-align: center; margin-top: 10px; }
.ld-back { background: none; border: 0; color: #B7B5AC; font: inherit; font-size: 18px; cursor: pointer; padding: 0 4px 0 0; }
.ld-back:hover { color: #E6E4D9; }
#ld-tip { position: fixed; left: 50%; transform: translateX(-50%); z-index: 1066; max-width: min(560px, calc(100vw - 32px));
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px); border: 1px solid #D14D41;
  border-radius: 8px; padding: 9px 12px; color: #CECDC3; font-size: 13px;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); }
#ld-tip button { margin-left: 8px; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border: 1px solid #0b0a0a; color: #100F0F; border-radius: 4px; padding: 3px 10px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.5);
  font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
#ld-toast { position: fixed; left: 50%; transform: translateX(-50%); z-index: 1067; background: rgba(28,27,26,.96);
  border: 1px solid #AF3029; color: #E8705F; border-radius: 6px; padding: 7px 14px; font-size: 13px;
  box-shadow: 0 10px 28px rgba(0,0,0,.6);
  opacity: 0; pointer-events: none; transition: opacity .2s; }
#ld-toast.ld-show { opacity: 1; }
`;
    document.head.appendChild(s);
  }

  // ═══ Navigation ════════════════════════════════════════════════════════════

  function navigate(url, replace) {
    // React Router listens for popstate; a full reload would lose the SPA.
    (replace ? history.replaceState : history.pushState).call(history, {}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  // ═══ Start dialog ══════════════════════════════════════════════════════════

  function performerOnPage() {
    const m = /^\/performers\/(\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function closeModal() {
    document.querySelector(".ld-modal-back")?.remove();
  }

  // sticky: no closing by clicking outside (the spin must play out).
  function modal(html, sticky) {
    closeModal();
    injectStyles();
    const back = document.createElement("div");
    back.className = "ld-modal-back";
    back.innerHTML = `<div class="ld-modal">${html}</div>`;
    if (!sticky) back.addEventListener("pointerdown", (ev) => { if (ev.target === back) closeModal(); });
    document.body.appendChild(back);
    return back.querySelector(".ld-modal");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── Shared pieces ─────────────────────────────────────────────────────────

  // A drop for a lockdown that ended in an O, an X for one given up.
  const DROP = `<svg class="ld-ico ld-drop" viewBox="0 0 16 16" aria-label="done"><path d="M8 1.2C8 1.2 3.2 6.6 3.2 10.1a4.8 4.8 0 0 0 9.6 0C12.8 6.6 8 1.2 8 1.2z"/><path class="ld-shine" d="M5.9 10.4a2.2 2.2 0 0 0 1.6 2.1" fill="none"/></svg>`;
  const CROSS = `<svg class="ld-ico ld-x" viewBox="0 0 16 16" aria-label="given up"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>`;
  const CROWN = `<svg class="ld-ico ld-crown" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5l3 3L8 4l2.5 4.5 3-3-1.3 7H3.8z"/></svg>`;
  const FLAME = `<svg class="ld-ico ld-flame" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.5 2.5 3.8 4 3.8 7.6A3.8 3.8 0 0 1 4.2 9.1c0-1.8 1-2.8 1.8-3.6.1 1.3.7 2.1 1.4 2.4C7.2 5.6 7.6 3.5 8 1.5z"/></svg>`;
  const TRASH = `<svg class="ld-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SEARCH = `<svg class="ld-ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const LOCK_SVG = `<svg class="ld-ico ld-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none"/></svg>`;
  const icon = (e) => (e.result === "done" ? DROP : CROSS);

  function avatarHtml(name, image) {
    return image ? `<img src="${escapeHtml(image)}" alt="">`
                 : `<i>${escapeHtml(String(name || "?").trim().charAt(0).toUpperCase())}</i>`;
  }

  function tilesHtml(st) {
    const top = mostLocked(st);
    const tile = (ico, big, label, cls = "") => `<div class="ld-tile ${cls}">${ico}<b>${big}</b><span>${label}</span></div>`;
    return `<div class="ld-tiles">` +
      tile(DROP, st.done, "done") +
      tile(CROSS, st.gaveUp, "given up") +
      tile(CROWN, top ? escapeHtml(top.name) : "–", top ? `most locked · ${top.n}×` : "most locked", "ld-tname") +
      tile(FLAME, st.bestStreak, `best streak${st.streak ? ` · now ${st.streak}` : ""}`) +
      `</div>`;
  }

  function rowHtml(e, now) {
    return `<div class="ld-row ${e.result}" data-key="${escapeHtml(entryKey(e))}">${icon(e)}` +
      `<span class="ld-av">${avatarHtml(e.name, e.image)}</span>` +
      `<span class="ld-rname">${escapeHtml(e.name || "?")}</span>` +
      `<span class="ld-rtime">${e.result === "done" ? "" : "gave up "}${escapeHtml(fmtDuration(e.ms))}</span>` +
      `<span class="ld-rwhen">${escapeHtml(typeof e.at === "number" ? fmtWhen(e.at, now) : "")}</span>` +
      `<button class="ld-del" title="Remove from history" aria-label="Remove">${TRASH}</button></div>`;
  }

  // Remove one entry: the first click asks, a second within 4 s removes.
  // No dialogs. `after(data)` re-renders with what Stash now holds.
  function wireRowDeletes(box, after) {
    box.addEventListener("click", async (ev) => {
      const btn = ev.target.closest && ev.target.closest(".ld-del");
      if (!btn) return;
      const row = btn.closest(".ld-row");
      if (!row.classList.contains("ld-confirm")) {
        box.querySelectorAll(".ld-row.ld-confirm").forEach((r) => r.classList.remove("ld-confirm"));
        row.classList.add("ld-confirm");
        btn.innerHTML = "Remove?";
        setTimeout(() => { if (row.isConnected && row.classList.contains("ld-confirm")) {
          row.classList.remove("ld-confirm"); btn.innerHTML = TRASH; } }, 4000);
        return;
      }
      btn.innerHTML = "…";
      try { after(await removeEntry(row.dataset.key)); }
      catch (e) { btn.innerHTML = "Failed"; log(`Remove failed: ${e.message}`, "error"); }
    });
  }

  // Clear everything: the first click names the count, a second clears.
  function wireClear(btn, count, after) {
    let armed = false, t = null;
    btn.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        btn.textContent = `Clear all ${typeof count === "function" ? count() : count}? Click again`;
        btn.classList.add("ld-armed");
        t = setTimeout(() => { armed = false; btn.innerHTML = `${TRASH} Clear history`; btn.classList.remove("ld-armed"); }, 4000);
        return;
      }
      clearTimeout(t);
      btn.textContent = "Clearing…";
      try { after(await clearHistory()); }
      catch (e) { btn.textContent = "Failed"; log(`Clear failed: ${e.message}`, "error"); }
    });
  }

  // ── Start dialog ──────────────────────────────────────────────────────────

  const GUIDE = `<div class="ld-guide" data-a="guide">
      <b>First time? Here's the deal</b>
      <ol><li>Pick a performer, or let a spin choose</li>
        <li>Stash only shows them: their scenes, images and galleries</li>
        <li>An O on any of their scenes ends it</li>
        <li>Stuck? Hold <i>Give up</i> for 5 seconds. It counts as an X</li></ol>
      <button class="ld-link" data-a="gotit">Got it</button></div>`;

  async function openStart() {
    const here = performerOnPage();
    const box = modal(`
      <div class="ld-head"><h3>${LOCK_SVG} Lockdown</h3>
        <button class="ld-link" data-a="help">How it works</button></div>
      <div class="ld-sub">One performer, nothing else, until an O on one of their scenes.</div>
      <div data-a="guidebox">${prefs().guideSeen ? "" : GUIDE}</div>
      <div class="ld-label">Pick a performer</div>
      <div class="ld-search">${SEARCH}<input data-a="q" placeholder="Search performers" autocomplete="off" spellcheck="false"></div>
      <div class="ld-results" data-a="results"></div>
      <div class="ld-or"><span>or let a spin decide</span></div>
      <div class="ld-spins">
        <button class="ld-go" data-a="fav">Favourites<small>…</small></button>
        <div class="ld-menuwrap"><button class="ld-go" data-a="filters">Saved filter ▾<small>…</small></button>
          <div class="ld-menu" data-a="menu" hidden></div></div>
      </div>
      <label class="ld-roul"><input type="checkbox" data-a="roulette">
        <span>Scene roulette<small>You can't choose scenes. Each one is random, and so is the next.</small></span></label>
      <div class="ld-err" data-a="err"></div>
      <div class="ld-hist" data-a="hist"><div class="ld-empty">Loading history…</div></div>
      <button class="ld-close" data-a="close">Not now</button>`);
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);
    const err = (t) => { $("err").textContent = t || ""; };
    $("close").addEventListener("click", closeModal);
    $("roulette").checked = !!prefs().roulette;
    $("roulette").addEventListener("change", () => setPref("roulette", $("roulette").checked));
    const roulette = () => $("roulette").checked;

    // the guide: shown until "Got it", back with "How it works"
    const wireGuide = () => $("gotit")?.addEventListener("click", () => { setPref("guideSeen", true); $("guidebox").innerHTML = ""; });
    wireGuide();
    $("help").addEventListener("click", () => {
      $("guidebox").innerHTML = $("guidebox").innerHTML ? "" : GUIDE;
      wireGuide();
    });

    // search first; on a performer page, that performer is offered first
    let results = [], hi = 0, seq = 0, timer = null, herePerf = null;
    const renderResults = () => {
      const typed = $("q").value.trim();
      const list = typed ? results : (herePerf ? [herePerf] : []);
      if (!list.length) {
        $("results").innerHTML = typed ? `<div class="ld-hint">No performer with scenes matches “${escapeHtml(typed)}”.</div>` : "";
        return;
      }
      hi = Math.min(hi, list.length - 1);
      $("results").innerHTML = list.map((p, i) =>
        `<div class="ld-res${i === hi ? " ld-hi" : ""}" data-i="${i}"><span class="ld-av">${avatarHtml(p.name, p.image_path)}</span>` +
        `<span class="ld-rname">${!typed ? "Lock " : ""}${escapeHtml(p.name)}</span>` +
        `<span class="ld-rmeta">${p.scene_count} scene${p.scene_count === 1 ? "" : "s"}</span><span class="ld-arrow">→</span></div>`).join("");
      $("results").querySelectorAll(".ld-res").forEach((el) => {
        el.addEventListener("click", () => begin(list[+el.dataset.i], "chosen", roulette()));
        el.addEventListener("mouseenter", () => { hi = +el.dataset.i;
          $("results").querySelectorAll(".ld-res").forEach((r, j) => r.classList.toggle("ld-hi", j === hi)); });
      });
    };
    $("q").addEventListener("input", () => {
      clearTimeout(timer);
      hi = 0;
      const term = $("q").value.trim();
      if (!term) { results = []; renderResults(); return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try { const r = await searchPerformers(term); if (mine === seq) { results = r; renderResults(); } }
        catch (e) { err(`Search failed: ${e.message}`); }
      }, 180);
    });
    $("q").addEventListener("keydown", (ev) => {
      ev.stopPropagation();                 // keep Stash and QuickTools keys out of the box
      const list = $("q").value.trim() ? results : (herePerf ? [herePerf] : []);
      if (ev.key === "ArrowDown") { ev.preventDefault(); hi = Math.min(list.length - 1, hi + 1); renderResults(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); hi = Math.max(0, hi - 1); renderResults(); }
      else if (ev.key === "Enter" && list[hi]) { ev.preventDefault(); begin(list[hi], "chosen", roulette()); }
      else if (ev.key === "Escape") closeModal();
    });
    if (here) {
      performer(here).then((p) => { if (p && p.scene_count) { herePerf = p; if (!$("q").value.trim()) renderResults(); } }).catch(() => {});
    }
    setTimeout(() => $("q").focus(), 0);

    // spins
    let favs = null;
    favourites().then((list) => {
      favs = list;
      $("fav").querySelector("small").textContent = list.length
        ? `${list.length} performer${list.length === 1 ? "" : "s"}` : "No favourites with scenes";
    }).catch(() => { $("fav").querySelector("small").textContent = "Could not load"; });
    $("fav").addEventListener("click", () => {
      if (favs && favs.length) spin(favs, "favourites", roulette());
      else err("Favourite some performers who have scenes first, or search above.");
    });

    let saved = [];
    savedPerformerFilters().then((list) => {
      saved = list;
      $("filters").querySelector("small").textContent = list.length
        ? `${list.length} saved filter${list.length === 1 ? "" : "s"}` : "No saved performer filters";
    }).catch(() => { $("filters").querySelector("small").textContent = "Could not load"; });
    $("filters").addEventListener("click", () => {
      const menu = $("menu");
      if (!menu.hidden) { menu.hidden = true; return; }
      if (!saved.length) { err("Save a filter on the Performers page first, then it shows up here."); return; }
      menu.innerHTML = saved.map((f, i) =>
        `<button class="ld-mi" data-i="${i}"><span>${escapeHtml(f.name)}</span><small data-c="${i}">…</small></button>`).join("");
      menu.hidden = false;
      saved.forEach((f, i) => {
        countFor(f).then((n) => {
          const el = menu.querySelector(`[data-c="${i}"]`);
          if (el) el.textContent = `${n} performer${n === 1 ? "" : "s"}`;
        }).catch((e) => {
          const el = menu.querySelector(`[data-c="${i}"]`);
          if (el) { el.textContent = "can't use"; el.title = e.message; el.closest(".ld-mi").classList.add("ld-cant"); }
        });
      });
      menu.querySelectorAll(".ld-mi").forEach((b) => b.addEventListener("click", async () => {
        const f = saved[+b.dataset.i];
        menu.hidden = true;
        err("");
        try {
          const list = await performersFor(f);
          if (!list.length) { err(`“${f.name}” matches no performers with scenes.`); return; }
          spin(list, `filter: ${f.name}`, roulette());
        } catch (e) {
          err(`Can't spin “${f.name}”: ${e.message}.`);
        }
      }));
    });

    const show = (data) => renderPreview($("hist"), data);
    readHistory().then(show);
  }

  // The dialog's history: tiles, the last 30 as a strip, the latest 5, and
  // the way into the full view.
  function renderPreview(box, data) {
    const { list, stats } = data;
    const entries = list.filter(isEntry);
    if (!stats.done && !stats.gaveUp) {
      box.innerHTML = `<div class="ld-empty">No lockdowns yet. Your drops and X's will show up here.</div>`;
      return;
    }
    const now = Date.now();
    box.innerHTML =
      `<div class="ld-hhead"><b>Your history</b><button class="ld-link ld-danger" data-a="clear">${TRASH} Clear history</button></div>` +
      tilesHtml(stats) +
      `<div class="ld-strip" title="Last ${Math.min(30, entries.length)}, oldest first">` +
        entries.slice(-30).map((e) => `<span title="${escapeHtml(e.name || "")} · ${escapeHtml(fmtDuration(e.ms))}">${icon(e)}</span>`).join("") +
      `</div>` +
      `<div class="ld-total">${escapeHtml(fmtDuration(stats.totalMs))} locked in total</div>` +
      `<div class="ld-rows">${entries.slice(-5).reverse().map((e) => rowHtml(e, now)).join("")}</div>` +
      `<button class="ld-link ld-all" data-a="all">See all history (${stats.done + stats.gaveUp}) →</button>`;
    const rerender = (d) => renderPreview(box, d);
    wireRowDeletes(box.querySelector(".ld-rows"), rerender);
    wireClear(box.querySelector('[data-a="clear"]'), stats.done + stats.gaveUp, rerender);
    box.querySelector('[data-a="all"]').addEventListener("click", () => openHistory(data));
  }

  // ── Full history ──────────────────────────────────────────────────────────

  const PAGE = 30;

  function openHistory(data) {
    let { list, stats } = data;
    let result = "all", q = "", shown = PAGE;
    const box = modal(`
      <div class="ld-head"><h3><button class="ld-back" data-a="back" aria-label="Back">←</button> Your history</h3>
        <button class="ld-link ld-danger" data-a="clear">${TRASH} Clear history</button></div>
      <div data-a="tiles"></div>
      <div class="ld-total" data-a="total"></div>
      <div class="ld-filters">
        <button class="ld-chip ld-on" data-r="all">All</button>
        <button class="ld-chip" data-r="done">${DROP} Done</button>
        <button class="ld-chip" data-r="gaveup">${CROSS} Given up</button>
        <div class="ld-search ld-small">${SEARCH}<input data-a="q" placeholder="Performer" autocomplete="off"></div>
      </div>
      <div data-a="list"></div>
      <div class="ld-foot">Your latest ${HISTORY_MAX} lockdowns are kept. Totals count all of them.</div>`);
    box.classList.add("ld-tall");
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);

    const render = () => {
      $("tiles").innerHTML = tilesHtml(stats);
      $("total").textContent = `${stats.done + stats.gaveUp} lockdowns · ${fmtDuration(stats.totalMs)} locked in total`;
      const matching = filterEntries(list, result, q);
      const groups = groupByMonth(matching);
      const now = Date.now();
      let left = shown, html = "";
      for (const g of groups) {
        if (left <= 0) break;
        html += `<div class="ld-month"><span>${escapeHtml(g.label)}</span>` +
          `<span class="ld-mcount">${g.done} ${DROP} ${g.gaveUp} ${CROSS}</span></div>`;
        const items = g.items.slice(0, left);
        html += items.map((e) => rowHtml(e, now)).join("");
        left -= items.length;
      }
      if (!matching.length) html = `<div class="ld-empty">${list.length ? "Nothing matches." : "No lockdowns yet."}</div>`;
      if (matching.length > shown) html += `<button class="ld-more" data-a="more">Show ${Math.min(PAGE, matching.length - shown)} more</button>`;
      $("list").innerHTML = html;
      $("more")?.addEventListener("click", () => { shown += PAGE; render(); });
    };
    const update = (d) => { list = d.list; stats = d.stats; render(); };

    $("back").addEventListener("click", () => openStart());
    box.querySelectorAll(".ld-chip").forEach((c) => c.addEventListener("click", () => {
      result = c.dataset.r; shown = PAGE;
      box.querySelectorAll(".ld-chip").forEach((x) => x.classList.toggle("ld-on", x === c));
      render();
    }));
    $("q").addEventListener("input", () => { q = $("q").value; shown = PAGE; render(); });
    $("q").addEventListener("keydown", (ev) => ev.stopPropagation());
    wireRowDeletes($("list"), update);
    wireClear($("clear"), () => stats.done + stats.gaveUp, update);
    render();
  }

  // ═══ Spin ══════════════════════════════════════════════════════════════════

  function spin(list, how, roulette) {
    const pick = list[Math.floor(Math.random() * list.length)];   // decided now, shown last
    const box = modal(`<div class="ld-spin"><img alt=""><div class="ld-name"></div><div class="ld-msg">Spinning...</div></div>`, true);
    const img = box.querySelector("img"), name = box.querySelector(".ld-name");
    const delays = spinSchedule(Math.min(26, Math.max(8, list.length * 3)));
    let i = 0;
    const show = (p) => { name.textContent = p.name; if (p.image_path) img.src = p.image_path; };
    const step = () => {
      if (i >= delays.length - 1) {
        show(pick);
        box.querySelector(".ld-spin").classList.add("ld-landed");
        box.querySelector(".ld-msg").textContent = "Locked in.";
        setTimeout(() => begin(pick, how, roulette), 1400);
        return;
      }
      show(list[Math.floor(Math.random() * list.length)]);
      setTimeout(step, delays[i++]);
    };
    step();
  }

  // ═══ Lock ══════════════════════════════════════════════════════════════════

  async function begin(p, how, roulette) {
    let baseO = 0;
    try { baseO = await sceneOSum(p.id); } catch (e) { log(`O baseline failed: ${e.message}`, "error"); }
    lock = { pid: String(p.id), name: p.name, image: p.image_path || "", startedAt: Date.now(),
             baseO, roulette: !!roulette, how };
    allowedCache.clear();
    itemCache.clear();
    writeState(lock);
    closeModal();
    enforce(true);
    if (roulette) await goRandom();
    else navigate(`/performers/${lock.pid}/scenes`);
  }

  async function end(result) {
    if (!lock) return;
    const done = lock;
    lock = null;
    writeState(null);
    clearBar();
    for (const el of document.querySelectorAll(".ld-ok, .ld-no")) el.classList.remove("ld-ok", "ld-no");
    const ms = Date.now() - done.startedAt;
    recordHistory({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                    pid: done.pid, name: done.name, image: done.image || "", how: done.how, result, ms,
                    at: done.startedAt });
    const box = modal(`<div class="ld-spin ${result === "done" ? "ld-landed" : ""}">
        ${done.image ? `<img src="${escapeHtml(done.image)}" alt="">` : ""}
        <div class="ld-name">${result === "done" ? "Lockdown complete" : "Lockdown given up"}</div>
        <div class="ld-msg">${escapeHtml(done.name)} &middot; ${fmtDuration(ms)}</div></div>
        <button class="ld-close">Close</button>`);
    box.querySelector(".ld-close").addEventListener("click", closeModal);
  }

  async function goRandom() {
    if (!lock) return;
    const cur = (/^\/scenes\/(\d+)/.exec(location.pathname) || [])[1];
    try {
      const id = await randomScene(lock.pid, cur);
      if (id) { navigate(`/scenes/${id}`); return; }
    } catch (e) { log(`Random scene failed: ${e.message}`, "error"); }
    navigate(`/performers/${lock.pid}/galleries`, true);
  }

  // ── The bar ────────────────────────────────────────────────────────────────

  let bar = null, veil = null, timerId = null;

  function navHeight() {
    const nav = document.querySelector(".top-nav");
    return (nav && nav.offsetHeight) || 50;
  }

  function renderBar() {
    if (!lock) return;
    injectStyles();
    document.body.classList.add("ld-on");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "ld-bar";
      veil = document.createElement("div");
      veil.id = "ld-veil";
      document.body.append(bar, veil);
    }
    if (!bar.isConnected) document.body.append(bar, veil);
    const h = navHeight();
    bar.style.height = h + "px";
    veil.style.top = h + "px";
    if (bar.dataset.pid === lock.pid && bar.dataset.roulette === String(lock.roulette)) return;
    bar.dataset.pid = lock.pid;
    bar.dataset.roulette = String(lock.roulette);
    const base = `/performers/${lock.pid}`;
    bar.innerHTML =
      (lock.image ? `<img src="${escapeHtml(lock.image)}" alt="">` : "") +
      `<span class="ld-who">Locked to <b>${escapeHtml(lock.name)}</b></span>` +
      `<span class="ld-time"></span>` +
      `<span class="ld-links">` +
        (lock.roulette ? `<button data-a="random">Random scene</button>`
                       : `<a href="${base}/scenes" data-a="link">Scenes</a>`) +
        `<a href="${base}/galleries" data-a="link">Galleries</a><a href="${base}/images" data-a="link">Images</a>` +
      `</span>` +
      `<button class="ld-giveup" title="Hold for 5 seconds to end the lockdown without an O">` +
        `<div class="ld-fill"></div><span>Give up (hold)</span></button>`;
    bar.querySelectorAll('[data-a="link"]').forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault(); navigate(a.getAttribute("href"));
    }));
    bar.querySelector('[data-a="random"]')?.addEventListener("click", goRandom);
    wireGiveUp(bar.querySelector(".ld-giveup"));
    tick();
    showTip();
  }

  function wireGiveUp(btn) {
    const fill = btn.querySelector(".ld-fill");
    // A timer rather than requestAnimationFrame, which stalls in a hidden tab.
    let started = 0, iv = null;
    const stop = () => {
      started = 0;
      clearInterval(iv);
      fill.style.transition = "width .2s"; fill.style.width = "0";
      btn.querySelector("span").textContent = "Give up (hold)";
    };
    const frame = () => {
      if (!started) return;
      const t = (Date.now() - started) / HOLD_MS;
      fill.style.width = Math.min(100, t * 100) + "%";
      btn.querySelector("span").textContent = t < 1 ? `Keep holding... ${Math.ceil((1 - t) * HOLD_MS / 1000)}` : "Given up";
      if (t >= 1) { started = 0; clearInterval(iv); end("gaveup"); }
    };
    btn.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      btn.setPointerCapture?.(ev.pointerId);
      started = Date.now();
      fill.style.transition = "none";
      clearInterval(iv);
      iv = setInterval(frame, 50);
    });
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) btn.addEventListener(t, () => { if (started) stop(); });
  }

  // One-time tip the first time the bar appears.
  function showTip() {
    if (prefs().barTipSeen || document.getElementById("ld-tip") || !lock) return;
    const tip = document.createElement("div");
    tip.id = "ld-tip";
    tip.style.top = navHeight() + 8 + "px";
    tip.innerHTML = `Only <b>${escapeHtml(lock.name)}</b> until an O. Use the links in this bar to move around; ` +
      `hold <b>Give up</b> for 5 seconds to quit. <button>Got it</button>`;
    tip.querySelector("button").addEventListener("click", () => { setPref("barTipSeen", true); tip.remove(); });
    document.body.appendChild(tip);
  }

  // Says why a page did not open, briefly, under the bar.
  let toastTimer = null;
  function ldToast(text) {
    let t = document.getElementById("ld-toast");
    if (!t) { t = document.createElement("div"); t.id = "ld-toast"; document.body.appendChild(t); }
    t.style.top = navHeight() + 10 + "px";
    t.textContent = text;
    t.classList.add("ld-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("ld-show"), 2600);
  }

  function tick() {
    if (!lock || !bar) return;
    const t = bar.querySelector(".ld-time");
    if (t) t.textContent = fmtDuration(Date.now() - lock.startedAt);
  }

  function clearBar() {
    document.body.classList.remove("ld-on", "ld-checking");
    document.getElementById("ld-tip")?.remove();
    document.getElementById("ld-toast")?.remove();
    bar?.remove(); veil?.remove();
    bar = null; veil = null;
  }

  // ── Enforcement ────────────────────────────────────────────────────────────

  const allowedCache = new Map();    // "scene:12" -> true/false, for this lock
  let checkSeq = 0;
  let lastPath = null;

  async function enforce(force) {
    if (!lock) return;
    renderBar();
    const path = location.pathname;
    // The query counts too: a filter added on their Scenes tab changes only
    // the query, and it is exactly what can widen the list.
    const here = path + location.search;
    if (!force && here === lastPath) return;
    lastPath = here;
    const r = routeCheck(path, lock.pid, lock.roulette);
    if (r.ok) {
      const clean = stripPerformerRules(location.search);
      if (clean !== null) {
        document.body.classList.add("ld-checking");
        ldToast("Other performers can't be added during a lockdown");
        later(() => { lastPath = null; navigate(path + clean, true); });
        return;
      }
      document.body.classList.remove("ld-checking");
      return;
    }
    if (r.bounce) { bounce(); return; }
    const key = `${lock.pid}:${r.check}:${r.id}`;
    if (allowedCache.has(key)) {
      if (allowedCache.get(key)) document.body.classList.remove("ld-checking"); else bounce();
      return;
    }
    // Hide the page until we know, so a forbidden scene is never seen.
    document.body.classList.add("ld-checking");
    const seq = ++checkSeq;
    let ok = false;
    try { ok = await features(r.check, r.id, lock.pid); }
    catch (e) { log(`Check failed (${e.message}), treating as not allowed`, "error"); }
    if (seq !== checkSeq || !lock || location.pathname + location.search !== here) return;
    allowedCache.set(key, ok);
    if (ok) document.body.classList.remove("ld-checking"); else bounce();
  }

  // The router records a navigation in two steps: the URL, then the state
  // it renders. Redirecting inside the first step (as 1.0.0 did, from the
  // pushState wrapper) was overwritten by the second, so the forbidden page
  // rendered under an allowed URL. The veil goes up at once and the redirect
  // waits for the router to finish.
  function later(fn) { setTimeout(fn, 0); }

  function bounce() {
    document.body.classList.add("ld-checking");
    const ownList = new RegExp(`^/performers/${lock.pid}(/scenes)?/?$`).test(location.pathname);
    ldToast(lock.roulette && ownList ? "Scene roulette: scenes come at random"
                                     : `Locked to ${lock.name}: that page isn't theirs`);
    later(() => {
      if (!lock) return;
      lastPath = null;                   // re-check wherever we land
      if (lock.roulette) { goRandom(); return; }
      navigate(`/performers/${lock.pid}/scenes`, true);
    });
  }

  // ── Cards ──────────────────────────────────────────────────────────────────
  // Checked on every page while locked: anything that does not feature the
  // performer is removed from view (ld-no), the rest shown (ld-ok).

  const CARD_SEL = ".scene-card, .image-card, .gallery-card, .wall-item, .queue-scene-details";
  const itemCache = new Map();       // "scene:12" -> true/false, for this lock
  let cardBusy = false;

  function cardOf(el) {
    return el.classList.contains("queue-scene-details") ? (el.closest("li") || el) : el;
  }

  async function scanCards() {
    if (!lock || cardBusy) return;
    const pending = [];
    for (const el of document.querySelectorAll(CARD_SEL)) {
      const card = cardOf(el);
      if (card.classList.contains("ld-ok") || card.classList.contains("ld-no")) continue;
      const hrefs = Array.from(card.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
      if (card.tagName === "A") hrefs.unshift(card.getAttribute("href"));
      const it = cardItem(el.className, hrefs);
      if (!it) { card.classList.add("ld-no"); continue; }
      const key = `${lock.pid}:${it.kind}:${it.id}`;
      if (itemCache.has(key)) { card.classList.add(itemCache.get(key) ? "ld-ok" : "ld-no"); continue; }
      pending.push({ card, it, key });
    }
    if (!pending.length) return;
    cardBusy = true;
    try {
      const unique = [...new Map(pending.map((p) => [p.key, p.it])).entries()].slice(0, 120);
      const res = await featuresMany(unique.map(([, it]) => it), lock.pid);
      unique.forEach(([key], i) => itemCache.set(key, !!res[i]));
    } catch (e) {
      log(`Card check failed: ${e.message}`, "error");     // they stay hidden
    } finally {
      cardBusy = false;
    }
    for (const p of pending) {
      if (itemCache.has(p.key)) p.card.classList.add(itemCache.get(p.key) ? "ld-ok" : "ld-no");
    }
  }

  // ── O detection ────────────────────────────────────────────────────────────
  // The sum of O counts over their scenes, polled: faster on a scene page,
  // where the O button is. An O pressed anywhere counts. If the sum falls (an
  // O taken back), the baseline follows it down.

  let oBusy = false, lastOCheck = 0;
  async function checkO() {
    if (!lock || oBusy || document.visibilityState !== "visible") return;
    const onScene = /^\/scenes\/\d+/.test(location.pathname);
    if (Date.now() - lastOCheck < (onScene ? 2500 : 10000)) return;
    oBusy = true;
    lastOCheck = Date.now();
    try {
      const sum = await sceneOSum(lock.pid);
      if (!lock) return;
      if (sum > lock.baseO) { end("done"); return; }
      if (sum < lock.baseO) { lock.baseO = sum; writeState(lock); }
    } catch (e) { log(`O check failed: ${e.message}`); }
    finally { oBusy = false; }
  }

  // Roulette: when a scene ends, the next one is random too.
  document.addEventListener("ended", (ev) => {
    if (lock && lock.roulette && ev.target instanceof HTMLMediaElement && /^\/scenes\/\d+/.test(location.pathname)) {
      goRandom();
    }
  }, true);

  // ── Nav button ─────────────────────────────────────────────────────────────

  const ICON = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;margin-right:4px">
    <rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>`;

  function ensureNav() {
    const nav = document.querySelector(".top-nav .navbar-collapse .navbar-nav");
    if (!nav || nav.querySelector(".ld-nav")) return;
    injectStyles();
    const item = document.createElement("div");
    item.className = "nav-link ld-nav col-4 col-sm-3 col-md-2 col-lg-auto";
    const a = document.createElement("a");
    a.href = "#";
    a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column " +
                  "justify-content-between align-items-center btn btn-primary";
    a.innerHTML = ICON + "<span>Lockdown</span>";
    a.title = "Lock Stash to one performer until an O";
    a.addEventListener("click", (ev) => { ev.preventDefault(); a.blur(); if (!lock) openStart(); });
    item.appendChild(a);
    nav.appendChild(item);
  }

  // ═══ Start ═════════════════════════════════════════════════════════════════

  // Another tab of this browser started or ended a lock.
  window.addEventListener("storage", (ev) => {
    if (ev.key !== STATE_KEY) return;
    lock = readState();
    allowedCache.clear();
    if (lock) enforce(true); else clearBar();
  });

  // Check a route the moment the app changes it, before it renders, rather
  // than up to 250 ms later: a forbidden page should never flash up.
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn].bind(history);
    history[fn] = (...a) => { const r = orig(...a); if (lock) enforce(false); return r; };
  }
  window.addEventListener("popstate", () => { if (lock) enforce(false); });

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // A timer, not requestAnimationFrame: rAF never fires in a hidden tab.
    setTimeout(() => { queued = false; ensureNav(); if (lock) { renderBar(); scanCards(); } }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    ensureNav();
    if (!lock) return;
    enforce(false);
    tick();
    checkO();
    scanCards();
  }, 250);

  ensureNav();
  if (lock) enforce(true);
})();
