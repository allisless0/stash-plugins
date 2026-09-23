/**
 * Collections - Stash UI plugin
 *
 * A collection is a studio (and its sub-studios) that gets its own tab in the
 * top navigation bar, sorted by O count, and is kept out of the main Scenes
 * list. Optional round scoring for Cock Hero style videos: how far you got
 * before pressing O, kept as Hardcore and Easy records on the scene.
 *
 * Settings live in one plugin setting, parsed by parseCollections().
 */
(function () {
  "use strict";
  if (window.__CollectionsLoaded) return;
  window.__CollectionsLoaded = true;

  const PLUGIN_ID      = "Collections";
  const DEFAULT_CONFIG = "Cock Hero = Cock Hero, score, mode:beat";
  const DEBUG          = (() => { try { return localStorage.getItem("collectionsDebug") === "1"; } catch { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // Custom field names on the scene. Seconds for bests, counts for clears.
  const F_HC_BEST    = "round_best_hardcore";
  const F_EASY_BEST  = "round_best_easy";
  const F_HC_CLEARS  = "round_clears_hardcore";
  const F_EASY_CLEARS = "round_clears_easy";

  // Round rules (see roundTime()).
  const START_GRACE_S = 10;     // playing from before this counts as "from the start"
  const JUMP_S        = 1.5;    // tolerance before a position change counts as a seek
  const CLEAR_SLACK_S = 2;      // this close to the end counts as the end
  const ROUND_KEY     = "Collections.round.";   // + scene id, Easy progress across reloads
  const ROUND_TTL_MS  = 30 * 24 * 3600 * 1000;

  // ═══ Pure helpers (tested by scripts/test_collections.js) ══════════════════

  // "Tab = Studio, opt, opt; Tab2 = Studio2". Without "=", the tab is named
  // after the studio. Options: score, show, mode:<vibe mode>, sort:<field>.
  function parseCollections(text) {
    const src = String(text ?? "").trim() || DEFAULT_CONFIG;
    const out = [];
    for (const raw of src.split(";")) {
      const entry = raw.trim();
      if (!entry) continue;
      const [head, ...opts] = entry.split(",").map((x) => x.trim());
      const eq = head.indexOf("=");
      const name   = (eq >= 0 ? head.slice(0, eq) : head).trim();
      const studio = (eq >= 0 ? head.slice(eq + 1) : head).trim();
      if (!name || !studio) continue;
      const c = { name, studio, score: false, hide: true, mode: null, sort: "o_counter" };
      for (const o of opts) {
        const [k, v] = o.split(":").map((x) => x.trim());
        const key = (k || "").toLowerCase();
        if (key === "score") c.score = true;
        else if (key === "show") c.hide = false;
        else if (key === "mode" && v) c.mode = v.toLowerCase();
        else if (key === "sort" && v) c.sort = v;
      }
      out.push(c);
    }
    return out;
  }

  // Stash's list URLs carry each criterion as JSON with { } swapped for ( )
  // outside strings, then URL-encoded with ?#&;=+ escaped (ListFilterModel
  // .getEncodedParams in the Stash UI). Mirror that exactly or the page
  // ignores the criterion.
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

  function studioCriterion(modifier, items) {
    return { type: "studios", modifier, value: { items, excluded: [], depth: -1 } };
  }

  function tabUrl(studio, sort) {
    const dir = sort === "title" ? "asc" : "desc";
    const c = encodeCriterion(studioCriterion("INCLUDES", [{ id: studio.id, label: studio.name }]));
    return `/scenes?c=${c}&sortby=${encodeURIComponent(sort)}&sortdir=${dir}`;
  }

  // Is this list URL the collection's tab? Only a studios INCLUDES rule with
  // this id counts. Checking for the id anywhere lit the tab on the plain
  // Scenes page, because Stash writes the default filter (which EXCLUDES the
  // same studio) into that URL.
  function isTabUrl(search, id) {
    let params;
    try { params = new URLSearchParams(search).getAll("c"); } catch { return false; }
    for (const raw of params) {
      let inString = false, escaped = false, json = "";
      for (const ch of raw) {
        if (escaped) { escaped = false; json += ch; continue; }
        if (ch === "\\" && inString) { escaped = true; json += ch; continue; }
        if (ch === '"') inString = !inString;
        json += (!inString && ch === "(") ? "{" : (!inString && ch === ")") ? "}" : ch;
      }
      try {
        const c = JSON.parse(json);
        if (c.type === "studios" && (c.modifier === "INCLUDES" || c.modifier === "INCLUDES_ALL") &&
            (c.value?.items || []).some((it) => String(it.id) === String(id))) return true;
      } catch (_) {}
    }
    return false;
  }

  // Add "studio is not X" to the Scenes default filter for every wanted
  // studio, and take back exclusions this plugin added earlier that are no
  // longer wanted. Everything else in the filter rides through untouched
  // (rule 5), including exclusions the user made themselves.
  // Returns { filter, changed, conflict }.
  function mergeHide(defaultFilter, wanted, managedIds) {
    const f = JSON.parse(JSON.stringify(defaultFilter || {}));
    const wantedIds = new Set(wanted.map((w) => String(w.id)));
    const drop = new Set((managedIds || []).map(String).filter((id) => !wantedIds.has(id)));
    f.object_filter = f.object_filter || {};
    const crit = f.object_filter.studios;

    const apply = (list) => {
      const kept = (list || []).filter((it) => !drop.has(String(it.id)));
      for (const w of wanted) {
        if (!kept.some((it) => String(it.id) === String(w.id))) kept.push({ id: String(w.id), label: w.name });
      }
      return kept;
    };

    if (!crit) {
      if (!wanted.length) return { filter: defaultFilter || null, changed: false, conflict: false };
      f.object_filter.studios = { modifier: "EXCLUDES",
        value: { items: apply([]), excluded: [], depth: -1 } };
    } else if (crit.modifier === "EXCLUDES") {
      const items = apply(crit.value?.items);
      if (items.length) crit.value = { ...(crit.value || {}), items, depth: crit.value?.depth ?? -1 };
      else delete f.object_filter.studios;
    } else if (crit.modifier === "INCLUDES" || crit.modifier === "INCLUDES_ALL") {
      crit.value = { ...(crit.value || {}), excluded: apply(crit.value?.excluded) };
    } else {
      // IS_NULL / NOT_NULL / EQUALS on studio: the user's own rule, leave it
      return { filter: defaultFilter || null, changed: false, conflict: true };
    }
    if (!defaultFilter) {
      f.mode = "SCENES";
      f.find_filter = f.find_filter || {};
      f.ui_options = f.ui_options || {};
    }
    const changed = JSON.stringify(f) !== JSON.stringify(defaultFilter || {});
    return { filter: f, changed, conflict: false };
  }

  // ── Rounds ────────────────────────────────────────────────────────────────
  // A round starts Hardcore when playback starts near 0:00, and drops to Easy
  // (one way) on any seek, speed change or reload. The score in both modes is
  // how far the video has been played continuously from the start: pauses
  // cost nothing, and a skip ahead leaves a gap the score cannot cross until
  // it is played through.
  function roundNew(pos) {
    const fromStart = pos <= START_GRACE_S;
    return {
      mode: fromStart ? "hardcore" : "easy",
      reason: fromStart ? "" : `started at ${fmt(pos)}`,
      cov: fromStart ? [[0, pos]] : [],
      last: pos, lastWall: null, over: null,
    };
  }

  function demote(r, why) {
    if (r.mode === "hardcore") { r.mode = "easy"; r.reason = why; }
  }

  function addCov(cov, a, b) {
    if (b <= a) return;
    cov.push([a, b]);
    cov.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const iv of cov) {
      const top = merged[merged.length - 1];
      if (top && iv[0] <= top[1] + 0.5) top[1] = Math.max(top[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    cov.length = 0;
    cov.push(...merged);
  }

  // One timeupdate. `wall` is performance.now() in ms. Compared with wall
  // time so a buffering stall (position frozen, clock running) is not a seek,
  // but a jump further than playback could have gone, or any jump back, is.
  function roundTime(r, pos, playing, wall, rate = 1) {
    if (r.over) return;
    if (r.lastWall === null || !playing) {
      if (!playing && Math.abs(pos - r.last) > 0.5) {
        demote(r, pos > r.last ? `skipped ahead at ${fmt(r.last)}` : `went back at ${fmt(r.last)}`);
      }
      r.last = pos;
      r.lastWall = playing ? wall : null;
      return;
    }
    const d = pos - r.last;
    const expected = Math.max(0, (wall - r.lastWall) / 1000) * rate;
    if (d < -0.5) demote(r, `went back at ${fmt(r.last)}`);
    else if (d > expected + JUMP_S) demote(r, `skipped ahead at ${fmt(r.last)}`);
    else addCov(r.cov, r.last, pos);
    r.last = pos;
    r.lastWall = wall;
  }

  function roundScore(r) {
    const first = r.cov[0];
    if (!first || first[0] > 0.5) return 0;
    return first[1];
  }

  function roundCleared(r, duration) {
    return duration > 0 && roundScore(r) >= duration - CLEAR_SLACK_S;
  }

  // What to write after a round. Only changed keys; the caller sends them as
  // a partial custom-fields update so nothing else on the scene is touched.
  // A Hardcore result also passes Easy's rules, so it counts for both.
  function roundRecord(fields, mode, score, cleared, duration) {
    const num = (k) => { const v = parseFloat(fields?.[k]); return isFinite(v) ? v : 0; };
    const s = Math.round((cleared ? duration : score) * 10) / 10;
    const out = {};
    const prevHc = num(F_HC_BEST), prevEasy = num(F_EASY_BEST);
    if (mode === "hardcore") {
      if (s > prevHc) out[F_HC_BEST] = s;
      if (cleared) out[F_HC_CLEARS] = num(F_HC_CLEARS) + 1;
    }
    if (s > prevEasy) out[F_EASY_BEST] = s;
    if (cleared) out[F_EASY_CLEARS] = num(F_EASY_CLEARS) + 1;
    const newBest = mode === "hardcore" ? s > prevHc : s > prevEasy;
    return { out, newBest, score: s, prev: mode === "hardcore" ? prevHc : prevEasy };
  }

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? `${h}:` : "") + `${mm}:${String(r).padStart(2, "0")}`;
  }

  // ═══ Stash access ══════════════════════════════════════════════════════════

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

  function apolloClient() {
    try {
      const svc = window.PluginApi?.utils?.StashService;
      if (typeof svc?.getClient === "function") return svc.getClient();
    } catch (_) {}
    return null;
  }
  function refetch(queries) {
    const c = apolloClient();
    if (!c) return;
    try { c.refetchQueries({ include: queries }); } catch (e) { log(`refetch failed: ${e.message}`); }
  }

  // ═══ State ═════════════════════════════════════════════════════════════════

  let collections = [];          // parsed, each gets .id once its studio resolves
  let customFields = false;      // does this Stash have scene custom fields? (v0.31+)
  // Where records live. Scene custom fields arrived in Stash v0.31; before
  // that they are kept in this plugin's own config under `scores`,
  // {sceneId: {round_best_hardcore: ...}}, in the same shape.
  let configScores = null;       // cached `scores` map when custom fields are missing
  let ready = null;              // promise: settings read and studios resolved

  async function start() {
    let cfg = {};
    try {
      const d = await gql(`query { configuration { plugins } }`);
      cfg = d?.configuration?.plugins?.[PLUGIN_ID] ?? {};
    } catch (e) { log(`Settings read failed: ${e.message}`, "error"); }
    collections = parseCollections(cfg.collections);

    for (const c of collections) {
      try {
        const d = await gql(
          `query ($f: FindFilterType) { findStudios(filter: $f) { studios { id name aliases } } }`,
          { f: { q: c.studio, per_page: 40 } });
        const want = c.studio.toLowerCase();
        const hit = (d?.findStudios?.studios ?? []).find((s) =>
          s.name.toLowerCase() === want || (s.aliases || []).some((a) => a.toLowerCase() === want));
        if (hit) { c.id = String(hit.id); c.studioName = hit.name; }
        else log(`Studio "${c.studio}" not found; the "${c.name}" tab will say so`, "error");
      } catch (e) { log(`Studio lookup failed: ${e.message}`, "error"); }
    }

    try {
      const d = await gql(`query { __type(name: "SceneUpdateInput") { inputFields { name } } }`);
      customFields = (d?.__type?.inputFields ?? []).some((f) => f.name === "custom_fields");
    } catch (_) { customFields = false; }
    if (!customFields && collections.some((c) => c.score)) {
      log("No scene custom fields (Stash before v0.31): keeping scores in the plugin config");
    }

    await syncHidden(cfg);
    log(`Collections: ${collections.map((c) => `${c.name}${c.id ? "" : " (studio missing)"}`).join(", ")}`);
  }

  // ═══ Score storage ═════════════════════════════════════════════════════════

  async function readConfigScores(force) {
    if (configScores && !force) return configScores;
    try {
      const d = await gql(`query { configuration { plugins } }`);
      configScores = JSON.parse(d?.configuration?.plugins?.[PLUGIN_ID]?.scores || "{}") || {};
    } catch (e) { log(`Score read failed: ${e.message}`); configScores = configScores || {}; }
    return configScores;
  }

  async function recordsFor(ids) {
    const out = {};
    if (customFields) {
      const d = await gql(`query ($ids: [ID!]) { findScenes(ids: $ids, filter: { per_page: -1 }) {
                             scenes { id custom_fields files { duration } } } }`, { ids });
      for (const s of d?.findScenes?.scenes ?? []) {
        out[s.id] = { fields: s.custom_fields || {}, duration: s.files?.[0]?.duration || 0 };
      }
    } else {
      const all = await readConfigScores();
      const d = await gql(`query ($ids: [ID!]) { findScenes(ids: $ids, filter: { per_page: -1 }) {
                             scenes { id files { duration } } } }`, { ids });
      for (const s of d?.findScenes?.scenes ?? []) {
        out[s.id] = { fields: all[s.id] || {}, duration: s.files?.[0]?.duration || 0 };
      }
    }
    return out;
  }

  // Only the changed keys, for one scene. Custom fields: a partial update, so
  // other fields on the scene survive. Config: read-merge-write of the whole
  // plugin map, so the setting and other scenes' records survive (rule 5).
  let writeChain = Promise.resolve();
  function writeRecord(id, partial) {
    const run = writeChain.then(async () => {
      if (customFields) {
        await gql(`mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
                  { input: { id, custom_fields: { partial } } });
        return;
      }
      const d = await gql(`query { configuration { plugins } }`);
      const plugins = d?.configuration?.plugins;
      if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
      const mine = plugins[PLUGIN_ID] || {};
      let scores = {};
      try { scores = JSON.parse(mine.scores || "{}") || {}; } catch (_) {}
      scores[id] = { ...(scores[id] || {}), ...partial };
      await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                { id: PLUGIN_ID, input: { ...mine, scores: JSON.stringify(scores) } });
      configScores = scores;
    });
    writeChain = run.catch(() => {});
    return run;
  }

  // ═══ Keeping collections out of the main Scenes list ═══════════════════════
  // Done through Stash's own default filter for the Scenes page, because a
  // plugin cannot filter a list Stash renders. Any link with its own filter
  // (like the collection tab) is unaffected. The ids this plugin added are
  // remembered in its config, so turning "hide" off removes exactly those.

  async function syncHidden(cfg) {
    const wanted = collections.filter((c) => c.hide && c.id).map((c) => ({ id: c.id, name: c.studioName }));
    let managed = [];
    try { managed = JSON.parse(cfg.managedHidden || "[]"); } catch (_) {}
    if (!wanted.length && !managed.length) return;

    let ui;
    try { ui = (await gql(`query { configuration { ui } }`))?.configuration?.ui; }
    catch (e) { log(`UI config read failed, not touching the default filter: ${e.message}`, "error"); return; }
    if (!ui || typeof ui !== "object") return;

    const current = ui.defaultFilters?.scenes || null;
    const { filter, changed, conflict } = mergeHide(current, wanted, managed);
    if (conflict) log("The Scenes default filter already has its own studio rule; left it alone", "error");
    if (changed) {
      try {
        await gql(`mutation ($v: Any) { configureUISetting(key: "defaultFilters.scenes", value: $v) }`, { v: filter });
        refetch(["Configuration"]);
        log("Scenes default filter updated");
      } catch (e) { log(`Could not update the Scenes default filter: ${e.message}`, "error"); return; }
    }
    const nowManaged = conflict ? managed : wanted.map((w) => w.id);
    if (JSON.stringify(nowManaged) !== JSON.stringify(managed)) {
      // read-merge-write: configurePlugin replaces the whole map
      try {
        const d = await gql(`query { configuration { plugins } }`);
        const mine = d?.configuration?.plugins?.[PLUGIN_ID] ?? {};
        await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                  { id: PLUGIN_ID, input: { ...mine, managedHidden: JSON.stringify(nowManaged) } });
      } catch (e) { log(`Could not remember hidden studios: ${e.message}`); }
    }
  }

  // ═══ Styles ════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("collections-styles")) return;
    const st = document.createElement("style");
    st.id = "collections-styles";
    st.textContent = `
.coll-chip {
  position: absolute; top: 10px; left: 10px; z-index: 5;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 4px 10px; border-radius: 999px; cursor: pointer; user-select: none;
  font: 600 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff;
  background: rgba(0,0,0,.62); border: 1px solid rgba(255,255,255,.18);
  box-shadow: 0 2px 10px rgba(0,0,0,.4);
}
.coll-chip .coll-dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa3b0; }
.coll-chip.is-hc   { border-color: rgba(245,196,66,.7); }
.coll-chip.is-hc .coll-dot { background: #f5c442; box-shadow: 0 0 6px #f5c442; }
.coll-chip.is-easy { border-color: rgba(120,190,255,.6); }
.coll-chip.is-easy .coll-dot { background: #78beff; }
.coll-chip.is-over { border-color: rgba(235,110,90,.7); }
.coll-chip.is-over .coll-dot { background: #eb6e5a; }
.coll-chip .coll-sub { font-weight: 400; opacity: .75; }
.coll-best {
  position: absolute; top: -3px; bottom: -3px; width: 3px; margin-left: -1px;
  pointer-events: none; z-index: 3; border-radius: 1px;
}
.coll-best.hc   { background: #f5c442; box-shadow: 0 0 4px rgba(245,196,66,.8); }
.coll-best.easy { background: rgba(120,190,255,.6); }
/* top centre: top-left is Stash's rating ribbon and selection box, top-right
   the studio overlay, the bottom corners specs and ScriptBadges */
.coll-badge {
  position: absolute; top: 6px; left: 50%; transform: translateX(-50%);
  z-index: 2; pointer-events: none;
  padding: 2px 7px; border-radius: 5px; font-size: 11px; font-weight: 600;
  color: #fff; background: rgba(0,0,0,.72); border: 1px solid rgba(245,196,66,.6);
  white-space: nowrap;
}
.coll-badge .coll-easy { color: #9ecbff; font-weight: 500; }
.scene-card-preview { position: relative; }
.coll-nav svg { width: 1em; height: 1em; }
.coll-nav a.coll-missing { opacity: .5; }
/* a tab that is not the current page never keeps a pressed/focus look */
.coll-nav a.btn:not(.active):not(:hover) {
  background-color: transparent !important; border-color: transparent !important; box-shadow: none !important;
}
`;
    document.head.appendChild(st);
  }

  // ═══ Header tabs ═══════════════════════════════════════════════════════════
  // Built like Stash's own nav items so the theme styles them the same.

  const ICON = `<svg class="nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" viewBox="0 0 16 16"
    fill="currentColor" aria-hidden="true"><rect x="1" y="2" width="14" height="3" rx="1"/>
    <rect x="1" y="6.5" width="14" height="3" rx="1"/><rect x="1" y="11" width="14" height="3" rx="1"/></svg>`;

  function navigate(url) {
    // React Router listens for popstate; a full reload would lose the SPA.
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  function ensureTabs() {
    const nav = document.querySelector(".top-nav .navbar-collapse .navbar-nav");
    if (!nav || !collections.length) return;
    for (const [i, c] of collections.entries()) {
      let item = nav.querySelector(`.coll-nav[data-coll="${i}"]`);
      if (!item) {
        item = document.createElement("div");
        item.className = "nav-link coll-nav col-4 col-sm-3 col-md-2 col-lg-auto";
        item.dataset.coll = String(i);
        const a = document.createElement("a");
        a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column " +
                      "justify-content-between align-items-center btn btn-primary";
        a.innerHTML = ICON + `<span></span>`;
        a.querySelector("span").textContent = c.name;
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          a.blur();            // focus would keep the highlight after leaving
          if (c.id) navigate(tabUrl({ id: c.id, name: c.studioName }, c.sort));
          else alert(`Collections: no studio named "${c.studio}" was found in Stash.`);
        });
        item.appendChild(a);
        nav.appendChild(item);
      }
      const a = item.querySelector("a");
      if (c.id) a.href = tabUrl({ id: c.id, name: c.studioName }, c.sort);
      a.classList.toggle("coll-missing", !c.id);
      a.title = c.id ? `${c.studioName} scenes, by ${c.sort === "o_counter" ? "O count" : c.sort}`
                     : `No studio named "${c.studio}" in Stash`;
      const active = !!c.id && location.pathname === "/scenes" && isTabUrl(location.search, c.id);
      a.classList.toggle("active", active);
    }
  }

  // ═══ Scene cards: score badges ═════════════════════════════════════════════

  const cardCache = new Map();   // scene id -> {fields, duration, ts}
  let cardTimer = null;

  function scheduleBadges() {
    if (!collections.some((c) => c.score)) return;
    clearTimeout(cardTimer);
    cardTimer = setTimeout(renderBadges, 250);
  }

  async function renderBadges() {
    const cards = [...document.querySelectorAll(".scene-card")];
    const need = [];
    for (const card of cards) {
      const id = card.querySelector('a[href^="/scenes/"]')?.getAttribute("href")?.match(/\/scenes\/(\d+)/)?.[1];
      if (!id) continue;
      card.dataset.collId = id;
      const hit = cardCache.get(id);
      if (!hit || Date.now() - hit.ts > 60000) need.push(id);
    }
    if (need.length) {
      try {
        const recs = await recordsFor([...new Set(need)]);
        for (const [id, r] of Object.entries(recs)) cardCache.set(String(id), { ...r, ts: Date.now() });
      } catch (e) { log(`Badge lookup failed: ${e.message}`); return; }
    }
    for (const card of cards) {
      const info = cardCache.get(card.dataset.collId || "");
      const host = card.querySelector(".scene-card-preview") || card;
      let badge = host.querySelector(":scope > .coll-badge");
      const html = info ? badgeHtml(info) : "";
      if (!html) { badge?.remove(); continue; }
      if (!badge) { badge = document.createElement("div"); badge.className = "coll-badge"; host.appendChild(badge); }
      if (badge.innerHTML !== html) badge.innerHTML = html;
    }
  }

  function badgeHtml({ fields, duration }) {
    const n = (k) => { const v = parseFloat(fields?.[k]); return isFinite(v) ? v : 0; };
    const hc = n(F_HC_BEST), easy = n(F_EASY_BEST);
    const clears = n(F_HC_CLEARS) + 0, easyClears = n(F_EASY_CLEARS);
    if (!hc && !easy && !easyClears) return "";
    const pct = (s) => duration ? ` ${Math.round(s / duration * 100)}%` : "";
    const parts = [];
    if (clears) parts.push(`Cleared ×${clears}`);
    else if (hc) parts.push(`HC ${fmt(hc)}${pct(hc)}`);
    if (easy > hc || (!clears && easyClears)) {
      parts.push(`<span class="coll-easy">Easy ${easyClears && !clears ? `cleared ×${easyClears}` : fmt(easy)}</span>`);
    }
    return parts.join(" · ");
  }

  // ═══ Scene page: rounds ════════════════════════════════════════════════════

  const sceneInfo = new Map();   // scene id -> promise of {collection, fields, o, duration}
  let scene = null;              // {id, collection, fields, o, duration} for the open scene
  let round = null;
  let video = null;
  let chip = null;
  let restartArm = 0;
  let pendingO = null;           // {pos} from a click on the O button
  let lastSave = 0;

  function currentSceneId() {
    return location.pathname.match(/^\/scenes\/(\d+)/)?.[1] ?? null;
  }

  // fresh: re-read the O count and records. Membership can be cached; the
  // count cannot, or revisiting a scene would compare against a stale count
  // and record a loss that never happened.
  function loadScene(id, fresh) {
    if (fresh) sceneInfo.delete(id);
    if (!sceneInfo.has(id)) {
      sceneInfo.set(id, (async () => {
        await ready;
        const cf = customFields ? "custom_fields" : "";
        const stored = customFields ? null : (await readConfigScores(fresh))[id];
        const d = await gql(`query ($id: ID!) { findScene(id: $id) { id o_counter ${cf} files { duration }
          studio { id parent_studio { id parent_studio { id parent_studio { id } } } } } }`, { id });
        const s = d?.findScene;
        const chain = [];
        for (let st = s?.studio; st; st = st.parent_studio) chain.push(String(st.id));
        const collection = collections.find((c) => c.id && chain.includes(c.id)) || null;
        return { id, collection, fields: (customFields ? s?.custom_fields : stored) || {}, o: s?.o_counter || 0,
                 duration: s?.files?.[0]?.duration || 0 };
      })().catch((e) => { sceneInfo.delete(id); throw e; }));
    }
    return sceneInfo.get(id);
  }

  function saved(id) {
    try {
      const o = JSON.parse(localStorage.getItem(ROUND_KEY + id) || "null");
      return o && Date.now() - o.ts < ROUND_TTL_MS && Array.isArray(o.cov) ? o : null;
    } catch { return null; }
  }
  function save(force) {
    if (!round || round.over || !scene || !round.cov.length) return;
    if (!force && Date.now() - lastSave < 5000) return;
    lastSave = Date.now();
    try { localStorage.setItem(ROUND_KEY + scene.id, JSON.stringify({ cov: round.cov, ts: Date.now() })); } catch (_) {}
  }
  function forget(id) { try { localStorage.removeItem(ROUND_KEY + id); } catch (_) {} }

  function scoring() {
    return !!(scene && scene.collection && scene.collection.score);
  }

  function onVideoEvent(ev) {
    if (!scoring() || ev.target !== video) return;
    const pos = video.currentTime || 0;
    const playing = !video.paused && !video.ended;
    if (!round) {
      if (ev.type !== "play" && !playing) return;
      const s = saved(scene.id);
      if (s) { round = roundNew(pos); round.mode = "easy"; round.reason = "continued after a reload"; round.cov = s.cov; }
      else round = roundNew(pos);
    }
    if (ev.type === "ratechange" && video.playbackRate !== 1) demote(round, "playback speed changed");
    if (ev.type === "play" || ev.type === "pause") { round.last = pos; round.lastWall = null; }
    roundTime(round, pos, playing, performance.now(), video.playbackRate || 1);
    if (!round.over && roundCleared(round, scene.duration || video.duration)) finish("cleared");
    save(false);
    renderChip();
  }

  function attachVideo() {
    const v = document.querySelector(".video-js video") || document.querySelector("video");
    if (v === video) return;
    video = v;
    if (!v) return;
    for (const t of ["timeupdate", "play", "pause", "ratechange", "ended"]) v.addEventListener(t, onVideoEvent);
  }

  async function finish(kind, posHint) {
    if (!round || round.over) return;
    const dur = scene.duration || video?.duration || 0;
    const score = kind === "cleared" ? dur : roundScore(round);
    const rec = roundRecord(scene.fields, round.mode, score, kind === "cleared", dur);
    round.over = { kind, mode: round.mode, score: rec.score, newBest: rec.newBest, prev: rec.prev, at: posHint };
    forget(scene.id);
    renderChip();
    if (!Object.keys(rec.out).length) return;
    try {
      await writeRecord(scene.id, rec.out);
      Object.assign(scene.fields, rec.out);
      cardCache.delete(scene.id);
      renderLines();
      log(`Round ${kind} (${round.mode}) at ${fmt(rec.score)}: ${JSON.stringify(rec.out)}`);
    } catch (e) {
      log(`Could not save the score: ${e.message}`, "error");
      round.over.error = e.message;
      renderChip();
    }
  }

  // O pressed: confirm the count actually went up (the click may have missed,
  // or been the dropdown), then end the round at the score so far.
  async function checkO() {
    if (!scene) return;
    try {
      const d = await gql(`query ($id: ID!) { findScene(id: $id) { o_counter } }`, { id: scene.id });
      const o = d?.findScene?.o_counter ?? scene.o;
      if (o > scene.o && round && !round.over && scoring()) finish("lost", pendingO?.pos);
      scene.o = o;
    } catch (e) { log(`O check failed: ${e.message}`); }
    pendingO = null;
  }

  function restart() {
    if (!video || !scene) return;
    forget(scene.id);
    video.currentTime = 0;
    round = roundNew(0);
    const p = video.play?.();
    if (p && p.catch) p.catch(() => {});
    renderChip();
  }

  function renderChip() {
    const host = video?.closest(".video-js");
    if (!scoring() || !host) { chip?.remove(); return; }
    injectStyles();
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "coll-chip";
      for (const t of ["pointerdown", "mousedown", "dblclick"]) chip.addEventListener(t, (e) => e.stopPropagation());
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!round || round.over) { restart(); return; }
        if (Date.now() - restartArm < 3000) { restartArm = 0; restart(); return; }
        restartArm = Date.now();
        renderChip();
        setTimeout(renderChip, 3100);
      });
    }
    if (chip.parentNode !== host) host.appendChild(chip);

    const n = (k) => { const v = parseFloat(scene.fields?.[k]); return isFinite(v) ? v : 0; };
    const armed = Date.now() - restartArm < 3000;
    let cls = "coll-chip", text, sub = "", tip;
    if (!round) {
      text = "Round ready";
      sub = n(F_HC_BEST) ? `best ${fmt(n(F_HC_BEST))}` : "press play from the start";
      tip = "Play from the start for a Hardcore round. Pressing O ends the round and records how far you got.";
    } else if (round.over) {
      const o = round.over;
      cls += " is-over";
      const label = o.mode === "hardcore" ? "Hardcore" : "Easy";
      text = o.kind === "cleared" ? `Cleared! (${label})` : `Lost at ${fmt(o.score)} (${label})`;
      sub = o.error ? "not saved" : o.kind === "cleared" ? "click to go again"
          : o.newBest ? (o.prev ? `new best, was ${fmt(o.prev)}` : "first record") : `best ${fmt(o.prev)}`;
      tip = o.error ? `The score could not be saved: ${o.error}` : "Click to restart from 0:00.";
    } else {
      const hc = round.mode === "hardcore";
      cls += hc ? " is-hc" : " is-easy";
      text = `${hc ? "Hardcore" : "Easy"} · ${fmt(roundScore(round))}`;
      const best = n(hc ? F_HC_BEST : F_EASY_BEST);
      sub = armed ? "click again to restart" : best ? `best ${fmt(best)}` : "";
      tip = (hc ? "Hardcore: played from 0:00 with no seeking or speed change. Pausing is fine."
                : `Easy (${round.reason}). Pauses and seeks are forgiven; the score is how far you have played continuously from the start.`) +
            " Press O to end the round. Click to restart from 0:00.";
    }
    chip.className = cls;
    chip.title = tip;
    chip.innerHTML = `<span class="coll-dot"></span><span></span>${sub ? `<span class="coll-sub"></span>` : ""}`;
    chip.children[1].textContent = text;
    if (sub) chip.children[2].textContent = sub;
  }

  // Gold line: Hardcore best. Faint line: Easy best, when it is further.
  function renderLines() {
    const holder = video?.closest(".video-js")?.querySelector(".vjs-progress-holder");
    const dur = scene?.duration || video?.duration || 0;
    holder?.querySelectorAll(".coll-best").forEach((e) => e.remove());
    if (!holder || !scoring() || !dur) return;
    const n = (k) => { const v = parseFloat(scene.fields?.[k]); return isFinite(v) ? v : 0; };
    const put = (s, cls, title) => {
      if (!s) return;
      const el = document.createElement("div");
      el.className = `coll-best ${cls}`;
      el.style.left = `${Math.min(100, s / dur * 100)}%`;
      el.title = title;
      holder.appendChild(el);
    };
    put(n(F_HC_BEST), "hc", `Hardcore best ${fmt(n(F_HC_BEST))}`);
    if (n(F_EASY_BEST) > n(F_HC_BEST)) put(n(F_EASY_BEST), "easy", `Easy best ${fmt(n(F_EASY_BEST))}`);
  }

  async function onScene(id) {
    // leaving a scene with a live round: keep Easy progress for next time
    save(true);
    scene = null; round = null; pendingO = null; restartArm = 0;
    chip?.remove();
    if (!id) return;
    try {
      const info = await loadScene(id, true);
      if (currentSceneId() !== id) return;
      scene = { ...info, fields: { ...info.fields } };
      attachVideo();
      renderChip();
      renderLines();
    } catch (e) { log(`Scene lookup failed: ${e.message}`); }
  }

  // ═══ Wiring: one click listener, one observer, one timer ═══════════════════

  document.addEventListener("click", (ev) => {
    const group = ev.target.closest?.('[data-action="o-counter"]');
    if (!group || !scene) return;
    const btn = ev.target.closest("button");
    // the first button adds one; the dropdown toggle and its menu do not
    if (!btn || btn !== group.querySelector("button") || btn.classList.contains("dropdown-toggle")) return;
    pendingO = { pos: video?.currentTime ?? 0 };
    setTimeout(checkO, 900);
  }, true);

  let lastScene = undefined;
  let pollTick = 0;
  let lastHref = "";
  let rafQueued = false;
  // Batched with a timer, not requestAnimationFrame: rAF never fires in a
  // hidden tab, which left the flag stuck and the page without tabs or badges.
  new MutationObserver(() => {
    if (rafQueued) return;
    rafQueued = true;
    setTimeout(() => {
      rafQueued = false;
      ensureTabs();
      scheduleBadges();
      if (scene) {
        attachVideo();
        if (chip && !chip.isConnected) renderChip();
        const holder = video?.closest(".video-js")?.querySelector(".vjs-progress-holder");
        if (holder && !holder.querySelector(".coll-best")) renderLines();
      }
    }, 60);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; ensureTabs(); }
    const id = currentSceneId();
    if (id !== lastScene) { lastScene = id; onScene(id); }
    // O pressed some other way (hotkey, another tab): poll every 4 s while a
    // round runs
    if (round && !round.over && scene && !pendingO && document.visibilityState === "visible" &&
        ++pollTick % 4 === 0) checkO();
  }, 1000);

  window.addEventListener("pagehide", () => save(true));

  // ═══ For IntifaceSync: which vibe mode a scene's collection asks for ═══════
  window.__Collections = {
    async vibeModeFor(sceneId) {
      try {
        const info = await loadScene(String(sceneId));
        return info.collection?.mode || null;
      } catch { return null; }
    },
  };

  if (window.__COLL_TEST__) {
    window.__CollectionsTest = { parseCollections, encodeCriterion, tabUrl, isTabUrl, mergeHide,
      roundNew, roundTime, roundScore, roundCleared, roundRecord, fmt };
  }

  injectStyles();
  ready = start();
  ready.then(() => { ensureTabs(); scheduleBadges(); }).catch((e) => log(e.message, "error"));
})();
