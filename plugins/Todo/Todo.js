/**
 * Todo - Stash UI plugin
 *
 * A small task list behind a button in the top bar. Tasks can be linked to the
 * page they were written on (a scene, performer, studio, tag, gallery or
 * group), so "fix the tags on this one" leads back to it. On a page with
 * tasks, a chip by the title says so; a scene's page also shows the tasks of
 * the performers in it.
 *
 * Stored in this plugin's Stash config, not the browser, so the list is the
 * same on every device and survives clearing site data.
 */
(function () {
  "use strict";
  if (window.__TodoLoaded) return;
  window.__TodoLoaded = true;

  const PLUGIN_ID = "Todo";
  const DEBUG     = (() => { try { return localStorage.getItem("todoDebug") === "1"; } catch (_) { return false; } })();
  const PREF_KEY  = "todoPrefs";        // UI only: link chip on or off
  const POLL_MS   = 30000;              // pick up changes made on another device
  const UNDO_MS   = 6000;
  const SEARCH_FROM = 10;               // the search box appears past this many open tasks

  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // ═══ Pure helpers (tested) ═════════════════════════════════════════════════

  // Which Stash object a path is the page of, or null.
  const KINDS = { scenes: "scene", performers: "performer", studios: "studio",
                  tags: "tag", galleries: "gallery", groups: "group", movies: "group" };
  function entityFromPath(pathname) {
    const m = /^\/(scenes|performers|studios|tags|galleries|groups|movies)\/(\d+)(?:\/|$)/.exec(pathname || "");
    return m ? { kind: KINDS[m[1]], id: m[2] } : null;
  }

  function entityUrl(link) {
    const base = { scene: "scenes", performer: "performers", studio: "studios",
                   tag: "tags", gallery: "galleries", group: "groups" }[link.kind];
    return base ? `/${base}/${link.id}` : null;
  }

  function sameEntity(a, b) {
    return !!a && !!b && a.kind === b.kind && String(a.id) === String(b.id);
  }

  const linkKey = (l) => (l ? `${l.kind}:${l.id}` : "");

  // Changes are sent as operations and replayed on the list as it is in Stash
  // at write time, not as a whole list from this tab. Two devices editing at
  // once then both land, instead of the later write erasing the earlier one.
  function applyOp(items, op) {
    const list = items.slice();
    const at = (id) => list.findIndex((t) => t && t.id === id);
    switch (op.type) {
      case "add":
        if (at(op.item.id) < 0) list.unshift(op.item);
        return list;
      case "done": {                      // explicit state, not a flip: safe to replay
        const i = at(op.id);
        if (i >= 0) list[i] = { ...list[i], done: !!op.done, doneAt: op.done ? op.when : null };
        return list;
      }
      case "pin": {                       // explicit state too
        const i = at(op.id);
        if (i >= 0) list[i] = { ...list[i], pinned: !!op.pinned };
        return list;
      }
      case "edit": {
        const i = at(op.id);
        if (i >= 0) list[i] = { ...list[i], text: op.text };
        return list;
      }
      case "delete": {                    // by id list, so "clear done" never
        const ids = new Set(op.ids);      // takes a task ticked elsewhere meanwhile
        return list.filter((t) => !(t && ids.has(t.id)));
      }
      case "restore": {                   // undo of a delete: back where it was
        const entries = (op.entries || []).slice().sort((a, b) => a.index - b.index);
        for (const { item, index } of entries) {
          if (item && at(item.id) < 0) list.splice(Math.max(0, Math.min(list.length, index)), 0, item);
        }
        return list;
      }
      case "move": {
        const i = at(op.id);
        if (i < 0) return list;
        const [t] = list.splice(i, 1);
        list.splice(Math.max(0, Math.min(list.length, op.to)), 0, t);
        return list;
      }
      default:
        return list;
    }
  }

  // The stored list, or null when it cannot be trusted. Null stops a write: a
  // list that failed to parse must never be overwritten with this tab's copy.
  // Entries this version does not understand are kept as they are and only
  // hidden (isTask), so a save never drops them (rule 5).
  function parseItems(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : null;
    } catch (_) { return null; }
  }

  function isTask(t) {
    return !!t && typeof t.id === "string" && typeof t.text === "string";
  }

  // Pinned first, otherwise the stored order (newest on top, or as dragged).
  function orderTasks(list) {
    return list.filter((t) => t.pinned).concat(list.filter((t) => !t.pinned));
  }

  // Open first in list order, then done, most recently finished first.
  function sortForView(all) {
    const items = all.filter(isTask);
    const open = orderTasks(items.filter((t) => !t.done));
    const done = items.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    return { open, done };
  }

  // "All", grouped by what each task is about: [{ key, link, items }].
  // Groups holding a pin come first, then the one with the newest task;
  // unlinked tasks ("General") always last.
  function groupTasks(open) {
    const groups = new Map();
    for (const t of open) {
      const k = linkKey(t.link) || "general";
      if (!groups.has(k)) groups.set(k, { key: k, link: t.link || null, items: [] });
      groups.get(k).items.push(t);
    }
    const score = (g) => [g.items.some((t) => t.pinned) ? 1 : 0, Math.max(...g.items.map((t) => t.created || 0))];
    const linked = [...groups.values()].filter((g) => g.key !== "general").sort((a, b) => {
      const sa = score(a), sb = score(b);
      return sb[0] - sa[0] || sb[1] - sa[1];
    });
    for (const g of linked) g.items = orderTasks(g.items);
    const general = groups.get("general");
    if (general) general.items = orderTasks(general.items);
    return general ? linked.concat(general) : linked;
  }

  // What belongs to this page: its own tasks, and on a scene page the tasks
  // of the performers in it, by performer.
  function tasksForPage(open, here, scenePerformerIds) {
    const own = open.filter((t) => sameEntity(t.link, here));
    const byPerformer = [];
    if (here && here.kind === "scene") {
      for (const pid of scenePerformerIds || []) {
        const list = open.filter((t) => sameEntity(t.link, { kind: "performer", id: pid }));
        if (list.length) byPerformer.push({ pid: String(pid), items: orderTasks(list) });
      }
    }
    return { own: orderTasks(own), byPerformer, count: own.length + byPerformer.reduce((n, g) => n + g.items.length, 0) };
  }

  function matches(t, q) {
    const term = String(q || "").trim().toLowerCase();
    if (!term) return true;
    return String(t.text).toLowerCase().includes(term) ||
           String((t.link && t.link.label) || "").toLowerCase().includes(term);
  }

  function fmtAgo(at, now) {
    if (!at) return "";
    const day = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(now) - day(at)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  if (window.__TODO_TEST__) {
    window.__TodoTest = { entityFromPath, entityUrl, sameEntity, applyOp, parseItems, sortForView,
                          orderTasks, groupTasks, tasksForPage, matches, fmtAgo };
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

  async function readConfig() {
    const d = await gql(`query { configuration { plugins } }`);
    const plugins = d?.configuration?.plugins;
    if (!plugins || typeof plugins !== "object") throw new Error("could not read the plugin config");
    return plugins[PLUGIN_ID] || {};
  }

  let items = [];
  let loaded = false;
  let writeChain = Promise.resolve();

  async function load() {
    try {
      const mine = await readConfig();
      const parsed = parseItems(mine.items);
      if (parsed === null) {
        log("The stored list does not parse; showing nothing and writing nothing", "error");
        setError("The saved list could not be read. Nothing will be changed until it is fixed.");
        return;
      }
      items = parsed;
      loaded = true;
      setError("");
      render();
      fetchMeta(items.filter(isTask).map((t) => t.link).filter(Boolean));
    } catch (e) {
      log(`Load failed: ${e.message}`, "error");
      setError(`Could not load: ${e.message}`);
    }
  }

  // configurePlugin replaces this plugin's whole map, so read, apply, write
  // back with every other key intact (rule 5). Writes run one at a time.
  function commit(op) {
    if (!loaded) { setError("Not loaded yet: the change was not saved."); return Promise.resolve(); }
    items = applyOp(items, op);          // show it now
    render();
    const run = writeChain.then(async () => {
      const mine = await readConfig();
      const stored = parseItems(mine.items);
      if (stored === null) throw new Error("the saved list could not be read, so it was left alone");
      const next = applyOp(stored, op);
      await gql(`mutation ($id: ID!, $input: Map!) { configurePlugin(plugin_id: $id, input: $input) }`,
                { id: PLUGIN_ID, input: { ...mine, items: JSON.stringify(next) } });
      items = next;                      // includes whatever another device added
      setError("");
      render();
    });
    writeChain = run.catch((e) => {
      log(`Save failed: ${e.message}`, "error");
      setError(`Not saved: ${e.message}`);
      load();                            // show what is really stored
    });
    return run;
  }

  // ── What a link looks like: name, picture, and a scene's performers ───────
  // Read from Stash in one aliased request per batch and kept for the page's
  // life. Tasks store the label they were written with, so a failed lookup
  // still shows something.

  const meta = new Map();              // "scene:12" -> { label, image, performers? }
  const metaWanted = new Set();

  const META_Q = {
    scene:     (id) => `findScene(id: "${id}") { title files { basename } paths { screenshot } performers { id name image_path } }`,
    performer: (id) => `findPerformer(id: "${id}") { name image_path }`,
    studio:    (id) => `findStudio(id: "${id}") { name image_path }`,
    tag:       (id) => `findTag(id: "${id}") { name image_path }`,
    gallery:   (id) => `findGallery(id: "${id}") { title }`,
    group:     (id) => `findGroup(id: "${id}") { name front_image_path }`,
  };

  function readMeta(kind, d) {
    if (!d) return null;
    switch (kind) {
      case "scene":     return { label: d.title || d.files?.[0]?.basename || null, image: d.paths?.screenshot || null,
                                 performers: (d.performers || []).map((p) => ({ id: String(p.id), name: p.name, image: p.image_path || null })) };
      case "performer":
      case "studio":
      case "tag":       return { label: d.name, image: d.image_path || null };
      case "gallery":   return { label: d.title || null, image: null };
      case "group":     return { label: d.name, image: d.front_image_path || null };
      default:          return null;
    }
  }

  async function fetchMeta(links) {
    const todo = [];
    for (const l of links) {
      const k = linkKey(l);
      if (!k || meta.has(k) || metaWanted.has(k) || !META_Q[l.kind] || !/^\d+$/.test(String(l.id))) continue;
      metaWanted.add(k);
      todo.push(l);
    }
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      try {
        const d = await gql(`query { ${batch.map((l, j) => `a${j}: ${META_Q[l.kind](l.id)}`).join(" ")} }`);
        batch.forEach((l, j) => meta.set(linkKey(l), readMeta(l.kind, d?.[`a${j}`]) || { label: null, image: null }));
      } catch (e) {
        log(`Link details failed: ${e.message}`);
        batch.forEach((l) => meta.set(linkKey(l), { label: null, image: null }));
      }
    }
    if (todo.length) render();
  }

  const labelOf = (l) => (meta.get(linkKey(l))?.label) || l.label || `${l.kind} ${l.id}`;
  const imageOf = (l) => (meta.get(linkKey(l))?.image) || l.image || null;

  // ═══ UI prefs (browser only, nothing that matters if lost) ═════════════════

  function prefs() {
    try { return { link: true, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; }
    catch (_) { return { link: true }; }
  }
  function setPref(k, v) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {}
  }

  // ═══ Styles ════════════════════════════════════════════════════════════════
  // Every row is the same grid: a 40 px picture column (photo, thumbnail,
  // icon, or the checkbox), the text, then actions. Text therefore starts at
  // one left edge everywhere, whatever the picture is.

  function injectStyles() {
    if (document.getElementById("todo-styles")) return;
    const s = document.createElement("style");
    s.id = "todo-styles";
    s.textContent = `
/* Flexoki dark (shared with Insights). Green is Todo's accent, yellow marks
   pins, red deletes, cyan scenes, magenta performers. Only colours, borders
   and shadows are theme here; the grid and paddings are the signed-off 1.1.0
   layout, and edges added for depth are box-shadows so no box grows. */
.todo-nav .todo-count { display: inline-block; min-width: 18px; padding: 0 6px; margin-left: 5px;
  border-radius: 9px; background: #879A39; background: linear-gradient(180deg, #879A39, #66800B); color: #100F0F; font-size: 11px; font-weight: 700;
  line-height: 18px; text-align: center; vertical-align: middle;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.5); }
.todo-nav .todo-count:empty { display: none; }
.todo-nav .todo-here { box-shadow: 0 0 0 2px #879A39 inset; border-radius: 4px; }
/* sits in Stash's own header: the chip recipe, not a Flexoki slab */
.todo-chip { display: inline-flex; align-items: center; gap: 5px; margin-left: 10px; padding: 2px 10px 2px 8px;
  border-radius: 999px; background: #343331; background: color-mix(in srgb, #879A39 22%, #343331);
  border: 1px solid color-mix(in srgb, #879A39 50%, transparent); color: #E6E4D9;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.4);
  font-size: 12px; font-weight: 600; cursor: pointer; vertical-align: middle; white-space: nowrap; line-height: 18px; }
.todo-chip:hover { background: color-mix(in srgb, #879A39 34%, #343331); border-color: color-mix(in srgb, #879A39 70%, transparent); color: #E6E4D9; }
.todo-chip svg { width: 13px; height: 13px; color: #A9BA5A; }
#todo-panel { position: fixed; top: 56px; right: 16px; z-index: 1060; width: 400px;
  max-width: calc(100vw - 32px); max-height: calc(100vh - 80px); display: none; flex-direction: column;
  background: #282726; background: linear-gradient(180deg, #2D2C2A 0, #282726 64px);
  border: 1px solid #0d0c0c; border-top-color: #48463F; border-radius: 12px; color: #CECDC3;
  box-shadow: 0 1px 0 rgba(0,0,0,.7), 0 20px 50px -12px rgba(0,0,0,.75); font-size: 14px; }
#todo-panel.todo-open { display: flex; }
#todo-panel button { font: inherit; }
#todo-panel .todo-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 10px; }
#todo-panel .todo-title { font-weight: 700; font-size: 16px; color: #E6E4D9; }
#todo-panel .todo-sub { color: #878580; font-size: 12px; }
#todo-panel .todo-x { margin-left: auto; background: none; border: 0; color: #878580; font-size: 22px;
  line-height: 1; cursor: pointer; padding: 0 2px; }
#todo-panel .todo-x:hover { color: #E6E4D9; }
#todo-panel .todo-add { padding: 0 16px 6px; }
#todo-panel input.todo-input { width: 100%; box-sizing: border-box; background: #1C1B1A; color: #CECDC3;
  border: 1px solid #000; border-bottom-color: #343331; border-radius: 8px; padding: 9px 11px; font: inherit; outline: none;
  box-shadow: inset 0 2px 5px rgba(0,0,0,.5); }
#todo-panel input.todo-input::placeholder { color: #6F6E69; }
#todo-panel input.todo-input:focus { border-color: color-mix(in srgb, #879A39 70%, transparent);
  box-shadow: inset 0 2px 5px rgba(0,0,0,.5), 0 0 0 2px color-mix(in srgb, #879A39 22%, transparent); }
#todo-panel .todo-linkline { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 12px; color: #878580; }
/* a link is a link whatever it points at, so the add-box chip stays blue */
#todo-panel .todo-lchip { display: inline-flex; align-items: center; gap: 6px; max-width: 290px; padding: 2px 6px 2px 3px;
  border-radius: 999px; background: #343331; background: color-mix(in srgb, #4385BE 22%, #343331);
  border: 1px solid color-mix(in srgb, #4385BE 50%, transparent); color: #E6E4D9;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.08); }
#todo-panel .todo-lchip .todo-lname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#todo-panel .todo-lchip button { background: none; border: 0; color: #6FA3D6; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
#todo-panel .todo-lchip button:hover { color: #E6E4D9; }
#todo-panel .todo-lchip.todo-off { background: none; border-style: dashed; border-color: #575653; box-shadow: none; color: #878580; cursor: pointer; padding: 2px 9px; }
#todo-panel .todo-lchip.todo-off:hover { color: #E6E4D9; border-color: #6F6E69; }
#todo-panel .todo-tabs { display: flex; align-items: center; gap: 6px; padding: 6px 16px 8px; flex-wrap: wrap; }
#todo-panel .todo-tab { background: #1C1B1A; border: 1px solid #000; border-bottom-color: #343331; color: #B7B5AC; border-radius: 999px;
  padding: 3px 11px; font-size: 12px; cursor: pointer; }
#todo-panel .todo-tab:hover { color: #E6E4D9; }
#todo-panel .todo-tab b { font-weight: 600; margin-left: 3px; color: #878580; }
#todo-panel .todo-tab.todo-on { background: #343331; background: color-mix(in srgb, #879A39 22%, #343331);
  border-color: color-mix(in srgb, #879A39 50%, transparent); box-shadow: inset 0 1px 0 rgba(255,255,255,.08); color: #E6E4D9; }
#todo-panel .todo-tab.todo-on b { color: #A9BA5A; }
#todo-panel .todo-tabs .todo-search { flex: 1 1 110px; margin-left: auto; padding: 4px 9px; font-size: 12px; }
#todo-panel .todo-err { margin: 0 16px 8px; padding: 6px 8px; border-radius: 6px; font-size: 12px;
  background: #1C1B1A; background: color-mix(in srgb, #D14D41 16%, #1C1B1A); border: 1px solid color-mix(in srgb, #D14D41 55%, transparent); color: #E8705F; }
#todo-panel .todo-err:empty { display: none; }
#todo-panel .todo-body { overflow-y: auto; padding: 0 0 10px; scrollbar-color: #403E3C transparent; }
#todo-panel .todo-r { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; column-gap: 12px; align-items: center;
  min-height: 36px; padding: 0 16px; box-sizing: border-box; }
#todo-panel .todo-r.todo-task:hover { background: rgba(255,255,255,.04); }
#todo-panel .todo-m { display: flex; align-items: center; justify-content: center; }
#todo-panel .todo-m input { width: 16px; height: 16px; margin: 0; accent-color: #879A39; cursor: pointer; }
#todo-panel .todo-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.35; cursor: text; }
#todo-panel .todo-r.todo-isdone .todo-t { color: #6F6E69; text-decoration: line-through; text-decoration-color: #575653; }
#todo-panel .todo-acts { display: flex; align-items: center; gap: 6px; }
#todo-panel .todo-act { background: none; border: 0; color: #878580; cursor: pointer; padding: 2px; line-height: 0; visibility: hidden; }
#todo-panel .todo-r:hover .todo-act { visibility: visible; }
#todo-panel .todo-act.todo-pinned { visibility: visible; color: #D0A215; }
#todo-panel .todo-act:hover { color: #E6E4D9; }
#todo-panel .todo-act.todo-del:hover { color: #E8705F; }
#todo-panel .todo-act svg { width: 15px; height: 15px; }
#todo-panel .todo-when { font-size: 11px; color: #6F6E69; }
#todo-panel .todo-edit { width: 100%; box-sizing: border-box; background: #1C1B1A; color: #E6E4D9;
  border: 1px solid #879A39; border-radius: 4px; padding: 3px 6px; font: inherit; outline: none;
  box-shadow: inset 0 2px 4px rgba(0,0,0,.5); }
/* engraved divider: a dark line with a faint lit edge under it */
#todo-panel .todo-g { margin-top: 8px; padding-top: 8px; border-top: 1px solid #1C1B1A; box-shadow: inset 0 1px 0 rgba(255,255,255,.03); }
#todo-panel .todo-g:first-child { margin-top: 0; padding-top: 2px; border-top: 0; box-shadow: none; }
#todo-panel .todo-gh { cursor: pointer; }
#todo-panel .todo-gh:hover .todo-gname { text-decoration: underline; }
#todo-panel .todo-gname { font-weight: 600; color: #E6E4D9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* the header carries no kind class; its picture says what it links to */
#todo-panel .todo-gh:hover:has(.todo-th) .todo-gname { color: #3AA99F; }
#todo-panel .todo-gh:hover:has(.todo-av) .todo-gname { color: #CE5D97; }
#todo-panel .todo-gsub { font-size: 12px; color: #878580; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#todo-panel .todo-arrow { color: #878580; }
/* inset 6 px with 10 px padding: its picture column lands on the rows' 16 px edge.
   Raised on the panel; its edge is a shadow ring, as a real border would shift that column 1 px */
#todo-panel .todo-card { min-height: 56px; background: #343331; background: linear-gradient(180deg, #403E3C 0, #343331 28px);
  margin: 0 6px 8px; padding: 0 10px; border-radius: 10px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px #0d0c0c, 0 8px 18px -10px rgba(0,0,0,.7);
  grid-template-columns: 40px minmax(0, 1fr) auto; }
#todo-panel .todo-card .todo-gname { font-size: 15px; }
#todo-panel .todo-av { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: flex; align-items: center;
  justify-content: center; background: #403E3C; background: color-mix(in srgb, #CE5D97 20%, #282726); color: #CE5D97;
  font-size: 12px; font-weight: 700; overflow: hidden;
  box-shadow: 0 0 0 1.5px color-mix(in srgb, #CE5D97 55%, transparent), 0 1px 3px rgba(0,0,0,.5); }
#todo-panel .todo-av.todo-big { width: 40px; height: 40px; font-size: 14px; }
#todo-panel .todo-th { width: 40px; height: 24px; border-radius: 4px; object-fit: cover; background: #403E3C;
  background: color-mix(in srgb, #3AA99F 18%, #282726); display: flex;
  align-items: center; justify-content: center; color: #3AA99F; overflow: hidden;
  box-shadow: 0 0 0 1px color-mix(in srgb, #3AA99F 45%, transparent), 0 1px 3px rgba(0,0,0,.5); }
#todo-panel .todo-ic { width: 32px; height: 32px; border-radius: 6px; background: #343331; display: flex; align-items: center;
  justify-content: center; color: #878580; overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 0 0 1px #0d0c0c, 0 1px 3px rgba(0,0,0,.5); }
#todo-panel img.todo-ic { object-fit: cover; }
#todo-panel .todo-ic svg, #todo-panel .todo-th svg { width: 15px; height: 15px; }
#todo-panel .todo-mini { width: 18px; height: 18px; border-radius: 50%; object-fit: cover; background: #403E3C; color: #E6E4D9; display: inline-flex;
  align-items: center; justify-content: center; font-size: 9px; font-weight: 700; flex: none; overflow: hidden;
  box-shadow: 0 1px 2px rgba(0,0,0,.5); }
#todo-panel .todo-mini.todo-sq { border-radius: 3px; width: 28px; background: color-mix(in srgb, #3AA99F 25%, #282726); }
#todo-panel .todo-empty { padding: 14px 16px; color: #878580; font-size: 13px; line-height: 1.55; }
#todo-panel .todo-empty b { color: #E6E4D9; }
#todo-panel .todo-clear { margin: 2px 16px 8px; display: flex; justify-content: flex-end; }
#todo-panel .todo-linkbtn { background: none; border: 0; color: #E8705F; cursor: pointer; font-size: 12px; padding: 0; }
#todo-panel .todo-linkbtn:hover { color: #D14D41; }
#todo-panel .todo-linkbtn.todo-armed { color: #100F0F; background: #D14D41; background: linear-gradient(180deg, #D14D41, #AF3029);
  border-radius: 4px; padding: 2px 8px; box-shadow: inset 0 1px 0 rgba(255,255,255,.2), 0 1px 2px rgba(0,0,0,.5); }
#todo-panel .todo-r[draggable=true] { cursor: grab; }
#todo-panel .todo-r.todo-drop { box-shadow: inset 0 2px 0 #879A39; }
#todo-panel .todo-undo[hidden] { display: none; }
#todo-panel .todo-undo { display: flex; align-items: center; gap: 10px; margin: 0 12px 12px; padding: 8px 12px;
  border-radius: 8px; background: #1C1B1A; border: 1px solid #403E3C; color: #E6E4D9; font-size: 13px;
  box-shadow: 0 10px 28px rgba(0,0,0,.6); }
#todo-panel .todo-undo span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#todo-panel .todo-undo button { background: none; border: 0; color: #A9BA5A; font-weight: 700; cursor: pointer; padding: 0; }
#todo-panel .todo-undo button:hover { color: #E6E4D9; }
`;
    document.head.appendChild(s);
  }

  // ═══ Panel ═════════════════════════════════════════════════════════════════

  const ICON = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    style="vertical-align:-3px;margin-right:4px"><path d="M2 4l1.5 1.5L6 3"/><path d="M8.5 4.5H14"/>
    <path d="M2 10l1.5 1.5L6 9"/><path d="M8.5 10.5H14"/></svg>`;
  const SVG = {
    pin: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M6 2h4l-.6 4 2.6 2.5H4L6.6 6z"/><path d="M8 8.5V14" stroke-linecap="round"/></svg>`,
    trash: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>`,
    list: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4l1.5 1.5L6 3"/><path d="M8.5 4.5H14"/><path d="M2 10l1.5 1.5L6 9"/><path d="M8.5 10.5H14"/></svg>`,
    play: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5v7l5.5-3.5z" fill="currentColor"/></svg>`,
    tag: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/></svg>`,
    building: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 14V3h7v11M10 7h3v7M5.5 5.5h2M5.5 8.5h2M5.5 11.5h2"/></svg>`,
    image: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5"/></svg>`,
    film: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 3v10M11 3v10"/></svg>`,
  };
  const KIND_ICON = { studio: SVG.building, tag: SVG.tag, gallery: SVG.image, group: SVG.film };
  const KIND_NAME = { scene: "scene", performer: "performer", studio: "studio", tag: "tag", gallery: "gallery", group: "group" };

  let panel = null;
  let open = false;
  let errorText = "";
  let here = null;            // {kind, id, label} for the current page
  let hereSeq = 0;
  let editing = null;         // id of the task being edited
  let dragId = null;
  let tab = "all";            // "here" | "all" | "done"
  let query = "";
  let linkOn = true;          // the add box links to this page
  let undo = null;            // { text, entries, timer }
  let clearArmed = false;

  const $ = (sel) => panel && panel.querySelector(sel);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function setError(t) {
    errorText = t || "";
    const e = $(".todo-err");
    if (e) e.textContent = errorText;
  }

  function navigate(url) {
    // React Router listens for popstate; a full reload would lose the SPA
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("") || "?";

  // The picture for a link, sized for the 40 px column (or `big` for the
  // page card): performer = circle, scene = 16:9 thumbnail, the rest = a
  // rounded square with their image or an icon.
  function mediaHtml(link, big) {
    if (!link) return `<span class="todo-ic">${SVG.list}</span>`;
    const img = imageOf(link);
    if (link.kind === "performer") {
      return img ? `<img class="todo-av${big ? " todo-big" : ""}" src="${escapeHtml(img)}" alt="">`
                 : `<span class="todo-av${big ? " todo-big" : ""}">${escapeHtml(initials(labelOf(link)))}</span>`;
    }
    if (link.kind === "scene") {
      return img ? `<img class="todo-th" src="${escapeHtml(img)}" alt="">` : `<span class="todo-th">${SVG.play}</span>`;
    }
    return img ? `<img class="todo-ic" src="${escapeHtml(img)}" alt="">` : `<span class="todo-ic">${KIND_ICON[link.kind] || SVG.list}</span>`;
  }

  function miniHtml(link) {
    const img = imageOf(link);
    const sq = link.kind === "scene" ? " todo-sq" : "";
    return img ? `<img class="todo-mini${sq}" src="${escapeHtml(img)}" alt="">`
               : `<span class="todo-mini${sq}">${link.kind === "performer" ? escapeHtml(initials(labelOf(link))) : ""}</span>`;
  }

  function scenePerformerLine(link) {
    const ps = meta.get(linkKey(link))?.performers || [];
    return ps.length ? ps.map((p) => p.name).join(", ") : "";
  }

  function build() {
    injectStyles();
    panel = document.createElement("div");
    panel.id = "todo-panel";
    panel.innerHTML = `
      <div class="todo-head"><span class="todo-title">Todo</span><span class="todo-sub"></span>
        <button class="todo-x" title="Close (Esc)" aria-label="Close">&times;</button></div>
      <div class="todo-add">
        <input class="todo-input" type="text" placeholder="Add a task, Enter to save" maxlength="500" aria-label="New task">
        <div class="todo-linkline"></div>
      </div>
      <div class="todo-tabs"></div>
      <div class="todo-err"></div>
      <div class="todo-body"></div>
      <div class="todo-undo" hidden><span></span><button>Undo</button></div>`;
    document.body.appendChild(panel);

    $(".todo-x").addEventListener("click", () => toggle(false));
    const input = $(".todo-add input");
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();              // keep Stash and QuickTools hotkeys out of the box
      if (ev.key === "Enter" && input.value.trim()) { addTask(input.value.trim()); input.value = ""; }
      if (ev.key === "Escape") toggle(false);
    });
    $(".todo-undo button").addEventListener("click", () => {
      if (!undo) return;
      commit({ type: "restore", entries: undo.entries });
      hideUndo();
    });
    panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") toggle(false); });
    setError(errorText);
  }

  function addTask(text) {
    const link = here && linkOn ? { kind: here.kind, id: here.id, label: labelOf(here), image: imageOf(here) || undefined } : null;
    commit({ type: "add", item: { id: newId(), text, done: false, created: Date.now(), ...(link ? { link } : {}) } });
    if (link && tab === "done") tab = here ? "here" : "all";
  }

  function showUndo(text, entries) {
    if (undo) clearTimeout(undo.timer);
    undo = { text, entries, timer: setTimeout(hideUndo, UNDO_MS) };
    const bar = $(".todo-undo");
    bar.querySelector("span").textContent = text;
    bar.hidden = false;
  }
  function hideUndo() {
    if (undo) clearTimeout(undo.timer);
    undo = null;
    const bar = $(".todo-undo");
    if (bar) bar.hidden = true;
  }

  function deleteTasks(list, label) {
    const entries = list.map((t) => ({ item: t, index: items.findIndex((x) => x && x.id === t.id) }));
    commit({ type: "delete", ids: list.map((t) => t.id) });
    showUndo(label, entries);
  }

  // ── Rows ───────────────────────────────────────────────────────────────────

  function taskRow(t, opts = {}) {
    const r = document.createElement("div");
    r.className = "todo-r todo-task" + (t.done ? " todo-isdone" : "");
    r.dataset.id = t.id;
    const m = document.createElement("div");
    m.className = "todo-m";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.title = t.done ? "Mark as not done" : "Mark as done";
    cb.addEventListener("change", () => commit({ type: "done", id: t.id, done: cb.checked, when: Date.now() }));
    m.appendChild(cb);
    r.appendChild(m);

    if (editing === t.id) {
      const inp = document.createElement("input");
      inp.className = "todo-edit";
      inp.value = t.text;
      const finish = (save) => {
        if (editing !== t.id) return;
        editing = null;
        const v = inp.value.trim();
        if (save && v && v !== t.text) commit({ type: "edit", id: t.id, text: v });
        else render();
      };
      inp.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
      });
      inp.addEventListener("blur", () => finish(true));
      r.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      const tx = document.createElement("div");
      tx.className = "todo-t";
      tx.textContent = t.text;
      tx.title = t.text + (t.done ? "" : "\n\nClick to edit");
      if (!t.done) tx.addEventListener("click", () => { editing = t.id; render(); });
      r.appendChild(tx);
    }

    const acts = document.createElement("div");
    acts.className = "todo-acts";
    if (opts.when) {
      const w = document.createElement("span");
      w.className = "todo-when";
      w.textContent = fmtAgo(t.doneAt, Date.now());
      acts.appendChild(w);
    }
    if (!t.done) {
      const pin = document.createElement("button");
      pin.className = "todo-act" + (t.pinned ? " todo-pinned" : "");
      pin.title = t.pinned ? "Unpin" : "Pin to the top";
      pin.innerHTML = SVG.pin;
      pin.addEventListener("click", () => commit({ type: "pin", id: t.id, pinned: !t.pinned }));
      acts.appendChild(pin);
    }
    const del = document.createElement("button");
    del.className = "todo-act todo-del";
    del.title = "Delete";
    del.innerHTML = SVG.trash;
    del.addEventListener("click", () => deleteTasks([t], `Deleted “${t.text}”`));
    acts.appendChild(del);
    r.appendChild(acts);

    // Drag to reorder open tasks; the order is the stored order.
    if (!t.done && editing !== t.id) {
      r.draggable = true;
      r.addEventListener("dragstart", (ev) => { dragId = t.id; ev.dataTransfer.effectAllowed = "move"; });
      r.addEventListener("dragover", (ev) => { if (dragId && dragId !== t.id) { ev.preventDefault(); r.classList.add("todo-drop"); } });
      r.addEventListener("dragleave", () => r.classList.remove("todo-drop"));
      r.addEventListener("drop", (ev) => {
        ev.preventDefault();
        r.classList.remove("todo-drop");
        if (!dragId || dragId === t.id) return;
        const from = items.findIndex((x) => x && x.id === dragId);
        let to = items.findIndex((x) => x && x.id === t.id);
        if (from < to) to -= 1;          // removing the dragged one shifts the target up
        commit({ type: "move", id: dragId, to });
        dragId = null;
      });
      r.addEventListener("dragend", () => { dragId = null; });
    }
    return r;
  }

  // A group's header row: picture, name, what it is and how many, and a way
  // to its page.
  function groupHead(link, count, card) {
    const r = document.createElement("div");
    r.className = "todo-r todo-gh" + (card ? " todo-card" : "");
    if (!link) {
      r.innerHTML = `<div class="todo-m">${mediaHtml(null)}</div><div><div class="todo-gname">General</div>` +
        `<div class="todo-gsub">not linked · ${count}</div></div><span></span>`;
      r.classList.remove("todo-gh");
      return r;
    }
    let sub = card ? count : `${KIND_NAME[link.kind]} · ${count}`;
    if (link.kind === "scene") {
      const who = scenePerformerLine(link);
      if (who) sub += ` · ${who}`;
    }
    r.innerHTML = `<div class="todo-m">${mediaHtml(link, card)}</div>` +
      `<div><div class="todo-gname">${escapeHtml(labelOf(link))}</div><div class="todo-gsub">${escapeHtml(sub)}</div></div>` +
      (card ? `<span></span>` : `<span class="todo-arrow">→</span>`);
    if (!card && entityUrl(link)) {
      r.title = `Open ${labelOf(link)}`;
      r.addEventListener("click", () => navigate(entityUrl(link)));
    }
    return r;
  }

  function group(head, rows) {
    const g = document.createElement("div");
    g.className = "todo-g";
    g.appendChild(head);
    rows.forEach((x) => g.appendChild(x));
    return g;
  }

  function empty(html) {
    const e = document.createElement("div");
    e.className = "todo-empty";
    e.innerHTML = html;
    return e;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function scenePerformerIds() {
    if (!here || here.kind !== "scene") return [];
    return (meta.get(linkKey(here))?.performers || []).map((p) => p.id);
  }

  function hereInfo() {
    const { open: todo } = sortForView(items);
    return here ? tasksForPage(todo, here, scenePerformerIds()) : { own: [], byPerformer: [], count: 0 };
  }

  function render() {
    renderNav();
    renderChip();
    if (!panel || !open) return;
    const { open: todo, done } = sortForView(items);
    const hi = hereInfo();
    if (tab === "here" && !here) tab = "all";
    $(".todo-sub").textContent = loaded ? `${todo.length} open` : "loading…";

    // the link chip under the add box
    const line = $(".todo-linkline");
    if (!here) line.innerHTML = "";
    else if (linkOn) {
      line.innerHTML = `<span>Links to</span><span class="todo-lchip">${miniHtml(here)}` +
        `<span class="todo-lname">${escapeHtml(KIND_NAME[here.kind])} · ${escapeHtml(labelOf(here))}</span>` +
        `<button title="Don't link this task" aria-label="Don't link">&times;</button></span>`;
      line.querySelector("button").addEventListener("click", () => { linkOn = false; setPref("link", false); render(); });
    } else {
      line.innerHTML = `<span class="todo-lchip todo-off">+ link to this ${escapeHtml(KIND_NAME[here.kind])}</span>`;
      line.querySelector(".todo-lchip").addEventListener("click", () => { linkOn = true; setPref("link", true); render(); });
    }

    // tabs, and the search once the list is long
    const tabs = $(".todo-tabs");
    const showSearch = todo.length > SEARCH_FROM || (tab === "done" && done.length > SEARCH_FROM) || !!query;
    tabs.innerHTML =
      (here ? `<button class="todo-tab${tab === "here" ? " todo-on" : ""}" data-t="here">This ${escapeHtml(KIND_NAME[here.kind])}<b>${hi.count}</b></button>` : "") +
      `<button class="todo-tab${tab === "all" ? " todo-on" : ""}" data-t="all">All<b>${todo.length}</b></button>` +
      `<button class="todo-tab${tab === "done" ? " todo-on" : ""}" data-t="done">Done<b>${done.length}</b></button>` +
      (showSearch ? `<input class="todo-input todo-search" placeholder="Search" aria-label="Search tasks">` : "");
    tabs.querySelectorAll(".todo-tab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.t; render(); }));
    const search = tabs.querySelector(".todo-search");
    if (search) {
      search.value = query;
      search.addEventListener("input", () => { query = search.value; renderBody(); });
      search.addEventListener("keydown", (ev) => ev.stopPropagation());
    }
    renderBody();
  }

  function renderBody() {
    const body = $(".todo-body");
    body.innerHTML = "";
    if (!loaded) return;
    const { open: todoAll, done: doneAll } = sortForView(items);
    const todo = todoAll.filter((t) => matches(t, query));
    const done = doneAll.filter((t) => matches(t, query));

    if (!todoAll.length && !doneAll.length) {
      body.appendChild(empty(`<b>Nothing to do yet.</b><br>Write tasks about your library: a scene to re-cut, a performer
        to fix, tags to add. On a scene or performer page a task links to it, so you can find your way back, and the
        page shows a chip with its tasks.`));
      return;
    }

    if (tab === "here" && here) {
      const hi = tasksForPage(todo, here, scenePerformerIds());
      const doneHere = doneAll.filter((t) => sameEntity(t.link, here)).length;
      body.appendChild(groupHead(here, `${hi.own.length} open · ${doneHere} done`, true));
      if (hi.own.length) hi.own.forEach((t) => body.appendChild(taskRow(t)));
      else if (!hi.byPerformer.length) body.appendChild(empty(`No tasks for this ${KIND_NAME[here.kind]} yet. Type one above.`));
      for (const g of hi.byPerformer) {
        const link = { kind: "performer", id: g.pid, label: (meta.get(linkKey(here))?.performers || []).find((p) => p.id === g.pid)?.name };
        body.appendChild(group(groupHead(link, g.items.length), g.items.map((t) => taskRow(t))));
      }
      return;
    }

    if (tab === "done") {
      if (!done.length) { body.appendChild(empty(query ? "Nothing matches." : "Nothing done yet. Tick a task when it's finished.")); return; }
      const bar = document.createElement("div");
      bar.className = "todo-clear";
      const btn = document.createElement("button");
      btn.className = "todo-linkbtn" + (clearArmed ? " todo-armed" : "");
      btn.textContent = clearArmed ? `Clear all ${doneAll.length}? Click again` : "Clear done";
      btn.addEventListener("click", () => {
        if (!clearArmed) {
          clearArmed = true;
          renderBody();
          setTimeout(() => { if (clearArmed) { clearArmed = false; if (open) renderBody(); } }, 4000);
          return;
        }
        clearArmed = false;
        deleteTasks(doneAll, `Cleared ${doneAll.length} done task${doneAll.length === 1 ? "" : "s"}`);
      });
      bar.appendChild(btn);
      body.appendChild(bar);
      done.forEach((t) => body.appendChild(taskRow(t, { when: true })));
      return;
    }

    if (!todo.length) { body.appendChild(empty(query ? "Nothing matches." : "All done. Add another above.")); return; }
    for (const g of groupTasks(todo)) {
      body.appendChild(group(groupHead(g.link, g.items.length), g.items.map((t) => taskRow(t))));
    }
  }

  function toggle(want) {
    open = want === undefined ? !open : want;
    if (open && !panel) build();
    if (panel) panel.classList.toggle("todo-open", open);
    if (open) {
      linkOn = prefs().link;
      query = "";
      clearArmed = false;
      tab = here && hereInfo().count ? "here" : "all";
      render();
      load();                            // fresh from Stash every time it opens
      setTimeout(() => $(".todo-add input")?.focus(), 0);
    } else {
      editing = null;
      hideUndo();
    }
  }

  // ── Nav button and the page chip ───────────────────────────────────────────

  function renderNav() {
    const nav = document.querySelector(".top-nav .navbar-collapse .navbar-nav");
    if (!nav) return;
    let item = nav.querySelector(".todo-nav");
    if (!item) {
      injectStyles();
      item = document.createElement("div");
      item.className = "nav-link todo-nav col-4 col-sm-3 col-md-2 col-lg-auto";
      const a = document.createElement("a");
      a.href = "#";
      a.className = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column " +
                    "justify-content-between align-items-center btn btn-primary";
      a.innerHTML = ICON + `<span>Todo</span><span class="todo-count"></span>`;
      a.addEventListener("click", (ev) => { ev.preventDefault(); a.blur(); toggle(); });
      item.appendChild(a);
      nav.appendChild(item);
    }
    const n = items.filter((t) => isTask(t) && !t.done).length;
    const h = loaded ? hereInfo().count : 0;
    // Only touch the DOM on a change: every write is a mutation, and the
    // observer that calls this would otherwise call it again forever.
    const count = item.querySelector(".todo-count");
    const text = !loaded ? "" : h ? `${h} here` : n ? String(n) : "";
    if (count.textContent !== text) count.textContent = text;
    const a = item.querySelector("a");
    if (a.classList.contains("todo-here") !== h > 0) a.classList.toggle("todo-here", h > 0);
    const title = h ? `Todo: ${h} for this page` : "Todo";
    if (a.title !== title) a.title = title;
  }

  // "2 todos" by the page title, when this page (or, on a scene, one of its
  // performers) has open tasks. Opens the panel on this page's tab.
  function renderChip() {
    const h = loaded && here ? hereInfo().count : 0;
    let chip = document.querySelector(".todo-chip");
    const spot = here && (document.querySelector(".scene-subheader") ||
                          document.querySelector(".detail-header .name-icons") ||
                          document.querySelector(".detail-header h2"));
    if (!h || !spot) { chip?.remove(); return; }
    if (!chip) {
      injectStyles();
      chip = document.createElement("span");
      chip.className = "todo-chip";
      chip.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); toggle(true); tab = "here"; render(); });
    }
    if (chip.parentElement !== spot) spot.appendChild(chip);
    const text = `${ICON.replace('width="18" height="18"', 'width="13" height="13"').replace(/style="[^"]*"/, "")}${h} todo${h === 1 ? "" : "s"}`;
    if (chip.dataset.n !== String(h)) { chip.innerHTML = text; chip.dataset.n = String(h); }
    chip.title = "Open this page's tasks";
  }

  // ── Page tracking ──────────────────────────────────────────────────────────

  let lastPath = null;
  function onPath() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const ent = entityFromPath(location.pathname);
    const seq = ++hereSeq;
    here = ent ? { ...ent, label: null } : null;
    if (open && tab === "here" && !here) tab = "all";
    render();
    if (ent) {
      fetchMeta([ent]).then(() => {
        if (seq !== hereSeq) return;
        const m = meta.get(linkKey(ent));
        here = { ...ent, label: m?.label || null };
        // a scene's performers' details, for its page tab
        if (ent.kind === "scene") fetchMeta((m?.performers || []).map((p) => ({ kind: "performer", id: p.id })));
        render();
      });
    }
  }

  // Close on a click outside. Clicks on the nav button and the page chip are
  // their own toggles.
  document.addEventListener("pointerdown", (ev) => {
    if (!open || !panel) return;
    if (panel.contains(ev.target) || ev.target.closest?.(".todo-nav, .todo-chip")) return;
    toggle(false);
  }, true);

  // ═══ Start ═════════════════════════════════════════════════════════════════

  // Batched with a timer: rAF never fires in a hidden tab (see Collections).
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; renderNav(); renderChip(); onPath(); }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(onPath, 1000);
  setInterval(() => { if (document.visibilityState === "visible" && !editing) load(); }, POLL_MS);
  window.addEventListener("focus", () => { if (!editing) load(); });

  onPath();
  load();
})();
