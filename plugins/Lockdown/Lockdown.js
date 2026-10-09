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

  // The one line of history: done, given up, fastest, current streak of
  // completions. Entries this version does not understand are ignored here
  // and kept in storage.
  function historySummary(list) {
    const ok = (e) => e && (e.result === "done" || e.result === "gaveup") && typeof e.ms === "number";
    const all = (list || []).filter(ok);
    const done = all.filter((e) => e.result === "done");
    let streak = 0;
    for (let i = all.length - 1; i >= 0 && all[i].result === "done"; i--) streak++;
    return {
      done: done.length,
      gaveUp: all.length - done.length,
      fastest: done.length ? Math.min(...done.map((e) => e.ms)) : null,
      streak,
    };
  }

  // The stored history, or null when it cannot be trusted (never overwrite
  // a list that failed to parse).
  function parseHistory(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (_) { return null; }
  }

  if (window.__LOCKDOWN_TEST__) {
    window.__LockdownTest = { routeCheck, enumOf, toGraphQLFilter, spinSchedule, fmtDuration,
                              historySummary, parseHistory };
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

  // History: read-merge-write of this plugin's config map; every other key
  // rides through, and a history that does not parse is left alone.
  let writeChain = Promise.resolve();
  function recordHistory(entry) {
    const run = writeChain.then(async () => {
      const d = await gql(`query { configuration { plugins } }`);
      const plugins = d?.configuration?.plugins;
      if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
      const mine = plugins[PLUGIN_ID] || {};
      const list = parseHistory(mine.history);
      if (list === null) throw new Error("saved history could not be read; left as it was");
      list.push(entry);
      await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                { id: PLUGIN_ID, input: { ...mine, history: JSON.stringify(list.slice(-HISTORY_MAX)) } });
    });
    writeChain = run.catch((e) => log(`History not saved: ${e.message}`, "error"));
    return run;
  }

  async function readHistory() {
    try {
      const d = await gql(`query { configuration { plugins } }`);
      return parseHistory(d?.configuration?.plugins?.[PLUGIN_ID]?.history) || [];
    } catch (_) { return []; }
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
.ld-nav .ld-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #e2574c;
  margin-left: 5px; vertical-align: middle; box-shadow: 0 0 6px #e2574c; }
body.ld-on .top-nav { visibility: hidden !important; }
#ld-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 1065; display: flex; align-items: center; gap: 12px;
  padding: 0 14px; background: linear-gradient(90deg, #2a1416, #1c2126 60%); border-bottom: 2px solid #e2574c;
  color: #e6e9ec; font-size: 14px; box-shadow: 0 4px 18px rgba(0,0,0,.5); }
#ld-bar img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 2px solid #e2574c; }
#ld-bar .ld-who b { font-size: 15px; }
#ld-bar .ld-time { font-variant-numeric: tabular-nums; color: #f5a623; font-weight: 600; min-width: 64px; }
#ld-bar a, #ld-bar button { background: none; border: 1px solid #44525f; color: #e6e9ec; border-radius: 4px;
  padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; text-decoration: none; }
#ld-bar a:hover, #ld-bar button:hover { border-color: #8b97a3; }
#ld-bar .ld-links { display: flex; gap: 6px; }
#ld-bar .ld-giveup { margin-left: auto; position: relative; overflow: hidden; border-color: #a3403a; color: #f0d3d0;
  user-select: none; touch-action: none; }
#ld-bar .ld-giveup .ld-fill { position: absolute; inset: 0; width: 0; background: rgba(226,87,76,.55); }
#ld-bar .ld-giveup span { position: relative; }
#ld-veil { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1064; background: #12161a; display: none; }
body.ld-checking #ld-veil { display: block; }
.ld-modal-back { position: fixed; inset: 0; z-index: 1070; background: rgba(0,0,0,.65); display: flex;
  align-items: center; justify-content: center; }
.ld-modal { width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 40px); overflow-y: auto;
  background: #232b33; border: 1px solid #3c4a57; border-radius: 10px; color: #e6e9ec; padding: 18px 20px;
  box-shadow: 0 16px 50px rgba(0,0,0,.7); }
.ld-modal h3 { margin: 0 0 4px; font-size: 19px; }
.ld-modal .ld-sub { color: #8b97a3; font-size: 13px; margin-bottom: 14px; }
.ld-modal .ld-opt { display: flex; gap: 8px; margin-bottom: 8px; }
.ld-modal button, .ld-modal select { font: inherit; font-size: 14px; border-radius: 6px; }
.ld-modal .ld-go { flex: 1; text-align: left; padding: 10px 12px; background: #2e3944; color: #e6e9ec;
  border: 1px solid #44525f; cursor: pointer; }
.ld-modal .ld-go:hover:not(:disabled) { border-color: #e2574c; background: #35303a; }
.ld-modal .ld-go:disabled { opacity: .45; cursor: default; }
.ld-modal .ld-go small { display: block; color: #8b97a3; font-size: 12px; }
.ld-modal select { flex: 1; min-width: 0; background: #1b2229; color: #e6e9ec; border: 1px solid #44525f; padding: 8px; }
.ld-modal label { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #c6ced6; margin: 12px 0 4px;
  cursor: pointer; }
.ld-modal .ld-err { color: #f5a623; font-size: 12px; min-height: 1.2em; margin-top: 6px; }
.ld-modal .ld-hist { border-top: 1px solid #3c4a57; margin-top: 14px; padding-top: 10px; font-size: 12px; color: #a9b4bf; }
.ld-modal .ld-hist b { color: #e6e9ec; }
.ld-modal .ld-hist div { margin-top: 3px; }
.ld-modal .ld-close { margin-top: 12px; width: 100%; padding: 7px; background: none; color: #8b97a3;
  border: 1px solid #3c4a57; cursor: pointer; }
.ld-spin { text-align: center; padding: 10px 0 4px; }
.ld-spin img { width: 150px; height: 150px; border-radius: 50%; object-fit: cover; border: 3px solid #44525f;
  background: #1b2229; }
.ld-spin .ld-name { font-size: 22px; font-weight: 700; margin-top: 12px; min-height: 1.3em; }
.ld-spin.ld-landed img { border-color: #e2574c; box-shadow: 0 0 24px rgba(226,87,76,.6); }
.ld-spin .ld-msg { color: #8b97a3; font-size: 13px; margin-top: 6px; min-height: 1.2em; }
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

  function modal(html) {
    closeModal();
    injectStyles();
    const back = document.createElement("div");
    back.className = "ld-modal-back";
    back.innerHTML = `<div class="ld-modal">${html}</div>`;
    document.body.appendChild(back);
    return back.querySelector(".ld-modal");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function openStart() {
    const here = performerOnPage();
    const box = modal(`
      <h3>Lockdown</h3>
      <div class="ld-sub">One performer, nothing else, until an O on one of their scenes.</div>
      <div class="ld-opt"><button class="ld-go" data-a="fav">Spin your favourites<small>loading...</small></button></div>
      <div class="ld-opt"><select data-a="filter"><option value="">Saved performer filter...</option></select>
        <button class="ld-go" data-a="spinfilter" style="flex:0 0 auto">Spin</button></div>
      <div class="ld-opt" data-a="hererow" style="display:none"><button class="ld-go" data-a="here">Lock this performer<small></small></button></div>
      <label><input type="checkbox" data-a="roulette"> Scene roulette: random scenes only, no picking</label>
      <div class="ld-err" data-a="err"></div>
      <div class="ld-hist" data-a="hist">History loading...</div>
      <button class="ld-close" data-a="close">Not now</button>`);
    const $ = (a) => box.querySelector(`[data-a="${a}"]`);
    const err = (t) => { $("err").textContent = t || ""; };
    $("close").addEventListener("click", closeModal);
    box.parentElement.addEventListener("pointerdown", (ev) => { if (ev.target === box.parentElement) closeModal(); });
    $("roulette").checked = prefs().roulette;
    $("roulette").addEventListener("change", () => setPref("roulette", $("roulette").checked));
    const how = () => ({ roulette: $("roulette").checked });

    let favs = null;
    favourites().then((list) => {
      favs = list;
      $("fav").querySelector("small").textContent = list.length
        ? `${list.length} favourite performer${list.length === 1 ? "" : "s"} with scenes`
        : "No favourite performers with scenes yet";
      $("fav").disabled = !list.length;
    }).catch((e) => { $("fav").querySelector("small").textContent = `Could not load: ${e.message}`; });
    $("fav").addEventListener("click", () => { if (favs && favs.length) spin(favs, "favourites", how().roulette); });

    let saved = [];
    savedPerformerFilters().then((list) => {
      saved = list;
      for (const f of list) {
        const o = document.createElement("option");
        o.value = f.id; o.textContent = f.name;
        $("filter").appendChild(o);
      }
      if (!list.length) $("filter").firstChild.textContent = "No saved performer filters";
    }).catch(() => {});
    $("spinfilter").addEventListener("click", async () => {
      const f = saved.find((x) => x.id === $("filter").value);
      if (!f) { err("Pick a saved filter first."); return; }
      err("");
      try {
        const list = await performersFor(f);
        if (!list.length) { err(`"${f.name}" has no performers with scenes.`); return; }
        spin(list, `filter: ${f.name}`, how().roulette);
      } catch (e) {
        err(`Can't use "${f.name}" for a spin: ${e.message}.`);
      }
    });

    if (here) {
      performer(here).then((p) => {
        if (!p) return;
        $("hererow").style.display = "";
        $("here").querySelector("small").textContent = p.scene_count
          ? `${p.name}, ${p.scene_count} scene${p.scene_count === 1 ? "" : "s"}` : `${p.name} has no scenes`;
        $("here").disabled = !p.scene_count;
        $("here").addEventListener("click", () => begin(p, "chosen", how().roulette));
      }).catch(() => {});
    }

    readHistory().then((list) => {
      const s = historySummary(list);
      const recent = list.filter((e) => e && e.name).slice(-5).reverse();
      $("hist").innerHTML = (s.done || s.gaveUp)
        ? `<b>${s.done}</b> done &middot; <b>${s.gaveUp}</b> given up` +
          (s.fastest !== null ? ` &middot; fastest <b>${fmtDuration(s.fastest)}</b>` : "") +
          (s.streak > 1 ? ` &middot; streak <b>${s.streak}</b>` : "") +
          recent.map((e) => `<div>${escapeHtml(e.name)} &middot; ${e.result === "done" ? "done in" : "gave up after"} ${fmtDuration(e.ms)}</div>`).join("")
        : "No lockdowns yet.";
    });
  }

  // ═══ Spin ══════════════════════════════════════════════════════════════════

  function spin(list, how, roulette) {
    const pick = list[Math.floor(Math.random() * list.length)];   // decided now, shown last
    const box = modal(`<div class="ld-spin"><img alt=""><div class="ld-name"></div><div class="ld-msg">Spinning...</div></div>`);
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
    const ms = Date.now() - done.startedAt;
    recordHistory({ pid: done.pid, name: done.name, how: done.how, result, ms, at: done.startedAt });
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

  function tick() {
    if (!lock || !bar) return;
    const t = bar.querySelector(".ld-time");
    if (t) t.textContent = fmtDuration(Date.now() - lock.startedAt);
  }

  function clearBar() {
    document.body.classList.remove("ld-on", "ld-checking");
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
    if (!force && path === lastPath) return;
    lastPath = path;
    const r = routeCheck(path, lock.pid, lock.roulette);
    if (r.ok) { document.body.classList.remove("ld-checking"); return; }
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
    if (seq !== checkSeq || !lock || location.pathname !== path) return;
    allowedCache.set(key, ok);
    if (ok) document.body.classList.remove("ld-checking"); else bounce();
  }

  function bounce() {
    document.body.classList.remove("ld-checking");
    if (lock.roulette) { goRandom(); return; }
    navigate(`/performers/${lock.pid}/scenes`, true);
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
    setTimeout(() => { queued = false; ensureNav(); if (lock) renderBar(); }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(() => {
    ensureNav();
    if (!lock) return;
    enforce(false);
    tick();
    checkO();
  }, 250);

  ensureNav();
  if (lock) enforce(true);
})();
