/**
 * Todo - Stash UI plugin
 *
 * A small task list behind a button in the top bar. Tasks can be linked to the
 * page they were written on (a scene, performer, studio, tag, gallery or
 * group), so "fix the tags on this one" leads back to it.
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
  const PREF_KEY  = "todoPrefs";        // UI only: link checkbox, done section open
  const POLL_MS   = 30000;              // pick up changes made on another device

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
      case "edit": {
        const i = at(op.id);
        if (i >= 0) list[i] = { ...list[i], text: op.text };
        return list;
      }
      case "delete": {                    // by id list, so "clear done" never
        const ids = new Set(op.ids);      // takes a task ticked elsewhere meanwhile
        return list.filter((t) => !(t && ids.has(t.id)));
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

  // Open first in list order, then done, most recently finished first.
  function sortForView(all) {
    const items = all.filter(isTask);
    const open = items.filter((t) => !t.done);
    const done = items.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    return { open, done };
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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

  // A readable name for the page a task is linked to.
  async function entityLabel(ent) {
    const q = {
      scene:     [`query ($id: ID!) { findScene(id: $id) { title files { basename } } }`, (d) => d?.findScene && (d.findScene.title || d.findScene.files?.[0]?.basename)],
      performer: [`query ($id: ID!) { findPerformer(id: $id) { name } }`, (d) => d?.findPerformer?.name],
      studio:    [`query ($id: ID!) { findStudio(id: $id) { name } }`, (d) => d?.findStudio?.name],
      tag:       [`query ($id: ID!) { findTag(id: $id) { name } }`, (d) => d?.findTag?.name],
      gallery:   [`query ($id: ID!) { findGallery(id: $id) { title } }`, (d) => d?.findGallery?.title],
      group:     [`query ($id: ID!) { findGroup(id: $id) { name } }`, (d) => d?.findGroup?.name],
    }[ent.kind];
    const fallback = `${ent.kind[0].toUpperCase()}${ent.kind.slice(1)} ${ent.id}`;
    if (!q) return fallback;
    try { return (await q[1](await gql(q[0], { id: ent.id }))) || fallback; }
    catch (_) { return fallback; }
  }

  // ═══ UI prefs (browser only, nothing that matters if lost) ═════════════════

  function prefs() {
    try { return { link: true, showDone: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; }
    catch (_) { return { link: true, showDone: false }; }
  }
  function setPref(k, v) {
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...prefs(), [k]: v })); } catch (_) {}
  }

  // ═══ Styles ════════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById("todo-styles")) return;
    const s = document.createElement("style");
    s.id = "todo-styles";
    s.textContent = `
.todo-nav .todo-count { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 5px;
  border-radius: 9px; background: #f5a623; color: #1b2229; font-size: 11px; font-weight: 700;
  line-height: 18px; text-align: center; vertical-align: middle; }
.todo-nav .todo-count:empty { display: none; }
.todo-nav .todo-here { box-shadow: 0 0 0 2px #f5a623 inset; border-radius: 4px; }
#todo-panel { position: fixed; top: 56px; right: 16px; z-index: 1060; width: 380px;
  max-width: calc(100vw - 32px); max-height: calc(100vh - 80px); display: none; flex-direction: column;
  background: #232b33; border: 1px solid #3c4a57; border-radius: 8px; color: #e6e9ec;
  box-shadow: 0 12px 36px rgba(0,0,0,.6); font-size: 14px; }
#todo-panel.todo-open { display: flex; }
#todo-panel .todo-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
#todo-panel .todo-title { font-weight: 700; font-size: 15px; }
#todo-panel .todo-sub { color: #8b97a3; font-size: 12px; }
#todo-panel .todo-x { margin-left: auto; background: none; border: 0; color: #8b97a3; font-size: 20px;
  line-height: 1; cursor: pointer; padding: 0 2px; }
#todo-panel .todo-x:hover { color: #fff; }
#todo-panel .todo-add { padding: 0 14px 10px; }
#todo-panel .todo-add input[type=text] { width: 100%; box-sizing: border-box; background: #1b2229;
  color: #e6e9ec; border: 1px solid #44525f; border-radius: 5px; padding: 8px 10px; font: inherit; outline: none; }
#todo-panel .todo-add input[type=text]:focus { border-color: #f5a623; }
#todo-panel .todo-linkopt { display: flex; align-items: center; gap: 6px; margin-top: 6px;
  font-size: 12px; color: #a9b4bf; cursor: pointer; user-select: none; }
#todo-panel .todo-linkopt b { color: #e6e9ec; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 250px; }
#todo-panel .todo-err { margin: 0 14px 8px; padding: 6px 8px; border-radius: 4px; font-size: 12px;
  background: rgba(226,87,76,.15); border: 1px solid #a3403a; color: #f0d3d0; }
#todo-panel .todo-err:empty { display: none; }
#todo-panel .todo-body { overflow-y: auto; padding: 0 6px 10px; }
#todo-panel .todo-sec { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: #6e7b88;
  padding: 8px 8px 4px; display: flex; align-items: center; gap: 8px; }
#todo-panel .todo-sec button { background: none; border: 0; color: #8b97a3; font: inherit; cursor: pointer;
  text-transform: none; letter-spacing: 0; font-size: 11px; padding: 0; }
#todo-panel .todo-sec button:hover { color: #fff; }
#todo-panel .todo-sec .todo-right { margin-left: auto; }
#todo-panel .todo-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 5px; }
#todo-panel .todo-row:hover { background: #2b353f; }
#todo-panel .todo-row input[type=checkbox] { margin-top: 3px; accent-color: #f5a623; cursor: pointer; flex: none; }
#todo-panel .todo-main { flex: 1; min-width: 0; }
#todo-panel .todo-text { word-wrap: break-word; cursor: text; }
#todo-panel .todo-row.todo-done .todo-text { color: #7f8b97; text-decoration: line-through; }
#todo-panel .todo-link { display: inline-block; margin-top: 2px; font-size: 11px; color: #7fb2e5;
  cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#todo-panel .todo-link:hover { text-decoration: underline; }
#todo-panel .todo-del { visibility: hidden; background: none; border: 0; color: #8b97a3; cursor: pointer;
  font-size: 16px; line-height: 1; padding: 0 2px; flex: none; }
#todo-panel .todo-row:hover .todo-del { visibility: visible; }
#todo-panel .todo-del:hover { color: #e2574c; }
#todo-panel .todo-edit { width: 100%; box-sizing: border-box; background: #1b2229; color: #e6e9ec;
  border: 1px solid #f5a623; border-radius: 4px; padding: 3px 6px; font: inherit; outline: none; }
#todo-panel .todo-empty { padding: 14px 8px; color: #7f8b97; font-size: 13px; text-align: center; }
#todo-panel .todo-row[draggable=true] { cursor: grab; }
#todo-panel .todo-row.todo-drop { box-shadow: 0 -2px 0 #f5a623; }
`;
    document.head.appendChild(s);
  }

  // ═══ Panel ═════════════════════════════════════════════════════════════════

  const ICON = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    style="vertical-align:-3px;margin-right:4px"><path d="M2 4l1.5 1.5L6 3"/><path d="M8.5 4.5H14"/>
    <path d="M2 10l1.5 1.5L6 9"/><path d="M8.5 10.5H14"/></svg>`;

  let panel = null;
  let open = false;
  let errorText = "";
  let here = null;            // {kind, id, label} for the current page
  let hereSeq = 0;
  let editing = null;         // id of the task being edited
  let dragId = null;

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

  function build() {
    injectStyles();
    panel = document.createElement("div");
    panel.id = "todo-panel";
    panel.innerHTML = `
      <div class="todo-head"><span class="todo-title">Todo</span><span class="todo-sub"></span>
        <button class="todo-x" title="Close (Esc)">&times;</button></div>
      <div class="todo-add">
        <input type="text" placeholder="Add a task, Enter to save" maxlength="500">
        <label class="todo-linkopt"><input type="checkbox"><span></span></label>
      </div>
      <div class="todo-err"></div>
      <div class="todo-body"></div>`;
    document.body.appendChild(panel);

    $(".todo-x").addEventListener("click", () => toggle(false));
    const input = $(".todo-add input[type=text]");
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();              // keep Stash and QuickTools hotkeys out of the box
      if (ev.key === "Enter" && input.value.trim()) { addTask(input.value.trim()); input.value = ""; }
      if (ev.key === "Escape") toggle(false);
    });
    const cb = $(".todo-linkopt input");
    cb.addEventListener("change", () => setPref("link", cb.checked));
    panel.addEventListener("keydown", (ev) => { if (ev.key === "Escape") toggle(false); });
    setError(errorText);
  }

  function addTask(text) {
    const link = here && prefs().link ? { kind: here.kind, id: here.id, label: here.label } : null;
    commit({ type: "add", item: { id: newId(), text, done: false, created: Date.now(), ...(link ? { link } : {}) } });
  }

  function navigate(url) {
    // React Router listens for popstate; a full reload would lose the SPA
    history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  function row(t) {
    const r = document.createElement("div");
    r.className = "todo-row" + (t.done ? " todo-done" : "");
    r.dataset.id = t.id;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.title = t.done ? "Mark as not done" : "Mark as done";
    cb.addEventListener("change", () => commit({ type: "done", id: t.id, done: cb.checked, when: Date.now() }));
    r.appendChild(cb);

    const main = document.createElement("div");
    main.className = "todo-main";
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
      main.appendChild(inp);
      setTimeout(() => { inp.focus(); inp.select(); }, 0);
    } else {
      const tx = document.createElement("div");
      tx.className = "todo-text";
      tx.textContent = t.text;
      tx.title = "Click to edit";
      tx.addEventListener("click", () => { editing = t.id; render(); });
      main.appendChild(tx);
    }
    if (t.link && entityUrl(t.link)) {
      const a = document.createElement("span");
      a.className = "todo-link";
      a.textContent = `${t.link.kind}: ${t.link.label || t.link.id}`;
      a.title = "Open";
      a.addEventListener("click", () => navigate(entityUrl(t.link)));
      main.appendChild(a);
    }
    r.appendChild(main);

    const del = document.createElement("button");
    del.className = "todo-del";
    del.innerHTML = "&times;";
    del.title = "Delete";
    del.addEventListener("click", () => commit({ type: "delete", ids: [t.id] }));
    r.appendChild(del);

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

  function section(label, extra) {
    const s = document.createElement("div");
    s.className = "todo-sec";
    s.innerHTML = `<span>${escapeHtml(label)}</span>`;
    if (extra) s.appendChild(extra);
    return s;
  }

  function render() {
    renderNav();
    if (!panel || !open) return;
    const { open: todo, done } = sortForView(items);
    $(".todo-sub").textContent = loaded ? `${todo.length} open` : "loading...";

    const lbl = $(".todo-linkopt");
    lbl.style.display = here ? "" : "none";
    if (here) {
      $(".todo-linkopt input").checked = prefs().link;
      $(".todo-linkopt span").innerHTML = `Link to this ${here.kind}: <b>${escapeHtml(here.label || here.id)}</b>`;
    }

    const body = $(".todo-body");
    body.innerHTML = "";
    if (!loaded) return;

    const mine = here ? todo.filter((t) => sameEntity(t.link, here)) : [];
    if (mine.length) {
      body.appendChild(section(`This ${here.kind}`));
      mine.forEach((t) => body.appendChild(row(t)));
    }
    const rest = todo.filter((t) => !mine.includes(t));
    if (mine.length && rest.length) body.appendChild(section("Everything else"));
    rest.forEach((t) => body.appendChild(row(t)));
    if (!todo.length) {
      const e = document.createElement("div");
      e.className = "todo-empty";
      e.textContent = done.length ? "All done." : "Nothing to do yet. Type above and press Enter.";
      body.appendChild(e);
    }

    if (done.length) {
      const showDone = prefs().showDone;
      const wrap = document.createElement("span");
      wrap.className = "todo-right";
      const tog = document.createElement("button");
      tog.textContent = showDone ? "hide" : "show";
      tog.addEventListener("click", () => { setPref("showDone", !showDone); render(); });
      const clr = document.createElement("button");
      clr.textContent = "clear";
      clr.title = "Delete all done tasks";
      clr.style.marginLeft = "10px";
      clr.addEventListener("click", () => {
        if (confirm(`Delete ${done.length} done task${done.length === 1 ? "" : "s"}?`)) {
          commit({ type: "delete", ids: done.map((t) => t.id) });
        }
      });
      wrap.append(tog, clr);
      body.appendChild(section(`Done (${done.length})`, wrap));
      if (showDone) done.forEach((t) => body.appendChild(row(t)));
    }
  }

  function toggle(want) {
    open = want === undefined ? !open : want;
    if (open && !panel) build();
    if (panel) panel.classList.toggle("todo-open", open);
    if (open) {
      render();
      load();                            // fresh from Stash every time it opens
      setTimeout(() => $(".todo-add input[type=text]")?.focus(), 0);
    } else {
      editing = null;
    }
  }

  // ── Nav button ─────────────────────────────────────────────────────────────

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
    item.querySelector(".todo-count").textContent = loaded && n ? String(n) : "";
    const forHere = here && items.some((t) => isTask(t) && !t.done && sameEntity(t.link, here));
    item.querySelector("a").classList.toggle("todo-here", !!forHere);
    item.querySelector("a").title = forHere ? "Todo: there are tasks for this page" : "Todo";
  }

  // ── Page tracking ──────────────────────────────────────────────────────────

  let lastPath = null;
  function onPath() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const ent = entityFromPath(location.pathname);
    const seq = ++hereSeq;
    here = ent ? { ...ent, label: null } : null;
    render();
    if (ent) {
      entityLabel(ent).then((label) => {
        if (seq !== hereSeq) return;
        here = { ...ent, label };
        render();
      });
    }
  }

  // Close on a click outside, and on Esc anywhere. Clicks on the nav button
  // are its own toggle.
  document.addEventListener("pointerdown", (ev) => {
    if (!open || !panel) return;
    if (panel.contains(ev.target) || ev.target.closest?.(".todo-nav")) return;
    toggle(false);
  }, true);

  // ═══ Start ═════════════════════════════════════════════════════════════════

  if (window.__TODO_TEST__) {
    window.__TodoTest = { entityFromPath, entityUrl, sameEntity, applyOp, parseItems, sortForView };
    return;
  }

  // Batched with a timer: rAF never fires in a hidden tab (see Collections).
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; renderNav(); onPath(); }, 80);
  }).observe(document.body, { childList: true, subtree: true });

  setInterval(onPath, 1000);
  setInterval(() => { if (document.visibilityState === "visible" && !editing) load(); }, POLL_MS);
  window.addEventListener("focus", () => { if (!editing) load(); });

  onPath();
  load();
})();
