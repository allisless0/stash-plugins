/**
 * QuickMark - Stash UI plugin
 * Add a scene marker at the current playback position. Hotkey: M
 */
(function () {
  "use strict";
  if (window.__QuickMarkLoaded) return;
  window.__QuickMarkLoaded = true;

  const GQL_URL      = "/graphql";
  const RECENT_KEY   = "quickMarkRecentTags";
  const RECENT_MAX   = 9;          // quick-pick slots, one per number key
  const SEARCH_LIMIT = 8;
  const DEBUG        = localStorage.getItem("quickMarkDebug") === "1";

  let panel        = null;
  let open         = false;
  let sceneId      = null;
  let markSeconds  = 0;            // frozen at the moment M was pressed
  let results      = [];           // [{id, name, isNew}]
  let highlight    = 0;
  let searchSeq    = 0;
  let mouseX       = null;
  let mouseY       = null;
  let supportsEnd  = null;         // end_seconds exists on this Stash build
  let busy         = false;

  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl]("[QuickMark]", m); };

  // ── GraphQL ────────────────────────────────────────────────────────────────
  async function gql(query, variables) {
    const res = await fetch(GQL_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    return json.data ?? null;
  }

  async function probeSchema() {
    if (supportsEnd !== null) return;
    try {
      const d = await gql(`query { __type(name: "SceneMarkerCreateInput") { inputFields { name } } }`);
      const names = (d?.__type?.inputFields ?? []).map((f) => f.name);
      supportsEnd = names.includes("end_seconds");
    } catch {
      supportsEnd = false;
    }
    log(`end_seconds supported: ${supportsEnd}`);
  }

  async function searchTags(q) {
    const d = await gql(
      `query ($f: FindFilterType) { findTags(filter: $f) { tags { id name } } }`,
      { f: { q, per_page: SEARCH_LIMIT, sort: "name", direction: "ASC" } }
    );
    return d?.findTags?.tags ?? [];
  }

  async function createTag(name) {
    const d = await gql(
      `mutation ($input: TagCreateInput!) { tagCreate(input: $input) { id name } }`,
      { input: { name } }
    );
    return d?.tagCreate ?? null;
  }

  async function createMarker(tagId, title, seconds) {
    const input = {
      scene_id:       sceneId,
      primary_tag_id: tagId,
      seconds:        Math.max(0, Math.round(seconds * 1000) / 1000),
      title:          title || "",
    };
    const d = await gql(
      `mutation ($input: SceneMarkerCreateInput!) {
         sceneMarkerCreate(input: $input) { id seconds primary_tag { id name } }
       }`,
      { input }
    );
    return d?.sceneMarkerCreate ?? null;
  }

  // ── Recent tags ────────────────────────────────────────────────────────────
  function loadRecent() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }

  function noteRecent(tag) {
    const list = loadRecent().filter((t) => t.id !== tag.id);
    list.unshift({ id: tag.id, name: tag.name });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
    catch (e) { log(`Could not save recents: ${e.message}`); }
  }

  // ── Scene context ──────────────────────────────────────────────────────────
  function currentSceneId() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function videoEl() {
    const vids = Array.from(document.querySelectorAll("video"));
    return vids.find((v) => v.duration > 0) || vids[0] || null;
  }

  function fmt(sec) {
    // Round to tenths first. Rounding after the split lets 59.95 render as 0:60.0.
    const s = Math.round(Math.max(0, sec) * 10) / 10;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s - h * 3600 - m * 60;
    const rr = (r < 10 ? "0" : "") + r.toFixed(1);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rr}` : `${m}:${rr}`;
  }

  function typingInAField(el) {
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
           el.tagName === "SELECT" || el.isContentEditable;
  }

  // ── Panel ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("quickmark-styles")) return;
    const s = document.createElement("style");
    s.id = "quickmark-styles";
    s.textContent = `
#quickmark {
  position: fixed; left: 0; top: 0; z-index: 10000; width: 340px;
  background: #232b33; border: 1px solid #3c4a57; border-radius: 6px;
  box-shadow: 0 10px 34px rgba(0,0,0,.6);
  padding: 12px 14px 10px; color: #e6e9ec; font-family: inherit;
  opacity: 0; pointer-events: none; transform: scale(.97); transform-origin: top left;
  transition: opacity .1s ease, transform .1s ease;
}
#quickmark.qm-open { opacity: 1; transform: scale(1); pointer-events: auto; }
#quickmark .qm-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
#quickmark .qm-time { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
#quickmark .qm-status { font-size: 12px; color: #f5a623; min-height: 1.3em; text-align: right; }
#quickmark input {
  width: 100%; box-sizing: border-box; background: #1b2229; color: #e6e9ec;
  border: 1px solid #44525f; border-radius: 4px; padding: 6px 8px;
  font-size: 13px; font-family: inherit; outline: none;
}
#quickmark input:focus { border-color: #f5a623; }
#quickmark .qm-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  color: #6e7b88; margin: 8px 0 3px; }
#quickmark .qm-list { margin-top: 6px; max-height: 208px; overflow-y: auto; }
#quickmark .qm-row { display: flex; align-items: center; gap: 8px; padding: 5px 7px;
  border-radius: 4px; cursor: pointer; font-size: 13px; }
#quickmark .qm-row.qm-hi { background: #33404d; }
#quickmark .qm-row .qm-key { font-size: 10px; color: #8b97a3; min-width: 14px;
  text-align: center; border: 1px solid #44525f; border-radius: 3px; padding: 0 3px; }
#quickmark .qm-row .qm-new { font-size: 10px; color: #f5a623; margin-left: auto; }
#quickmark .qm-empty { padding: 10px 7px; font-size: 12px; color: #7f8b97; }
#quickmark .qm-hint { margin-top: 8px; font-size: 11px; color: #7f8b97; line-height: 1.5; }
#quickmark kbd { background: #2e3944; border: 1px solid #44525f; border-bottom-width: 2px;
  border-radius: 3px; padding: 0 4px; font-size: 10px; font-family: inherit; color: #c6ced6; }
@media (prefers-reduced-motion: reduce) { #quickmark { transition: none; } }
`;
    document.head.appendChild(s);
  }

  function buildPanel() {
    injectStyles();
    const el = document.createElement("div");
    el.id = "quickmark";
    el.innerHTML = `
      <div class="qm-head">
        <div class="qm-time" data-qm="time">0:00.0</div>
        <div class="qm-status" data-qm="status"></div>
      </div>
      <input data-qm="search" placeholder="Tag" autocomplete="off" spellcheck="false">
      <div class="qm-label">Title (optional)</div>
      <input data-qm="title" placeholder="Defaults to the tag name" autocomplete="off">
      <div class="qm-list" data-qm="list"></div>
      <div class="qm-hint">
        <kbd>1</kbd>-<kbd>9</kbd> recent &middot;
        <kbd>&uarr;</kbd><kbd>&darr;</kbd> pick &middot;
        <kbd>Enter</kbd> add &middot;
        <kbd>,</kbd><kbd>.</kbd> nudge 1s &middot;
        <kbd>Esc</kbd> cancel
      </div>`;
    document.body.appendChild(el);

    el.querySelector('[data-qm="search"]').addEventListener("input", onSearchInput);
    el.querySelector('[data-qm="search"]').addEventListener("keydown", onPanelKey);
    el.querySelector('[data-qm="title"]').addEventListener("keydown", onPanelKey);
    return el;
  }

  function q(name) { return panel.querySelector(`[data-qm="${name}"]`); }
  function status(t) { if (panel) q("status").textContent = t; }

  function renderTime() { q("time").textContent = fmt(markSeconds); }

  function renderList() {
    const list = q("list");
    list.innerHTML = "";
    if (!results.length) {
      const d = document.createElement("div");
      d.className = "qm-empty";
      d.textContent = q("search").value.trim()
        ? "No tags match. Keep typing to create one."
        : "No recent tags yet. Type to search.";
      list.appendChild(d);
      return;
    }
    results.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "qm-row" + (i === highlight ? " qm-hi" : "");
      const showKey = !q("search").value.trim() && i < 9;
      row.innerHTML =
        (showKey ? `<span class="qm-key">${i + 1}</span>` : `<span class="qm-key"></span>`) +
        `<span>${escapeHtml(t.name)}</span>` +
        (t.isNew ? `<span class="qm-new">create</span>` : "");
      row.addEventListener("mouseenter", () => {
        highlight = i;
        // toggle classes in place; rebuilding under a moving cursor flickers
        list.querySelectorAll(".qm-row").forEach((r, j) => r.classList.toggle("qm-hi", j === i));
      });
      row.addEventListener("click", () => commit(i));
      list.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  let searchTimer = null;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const term = q("search").value.trim();
    if (!term) {
      results   = loadRecent();
      highlight = 0;
      renderList();
      return;
    }
    searchTimer = setTimeout(() => runSearch(term), 160);
  }

  async function runSearch(term) {
    const seq = ++searchSeq;
    try {
      const tags = await searchTags(term);
      if (seq !== searchSeq || !open) return;
      results = tags.map((t) => ({ id: t.id, name: t.name }));
      // Offer creation only when nothing matches exactly.
      if (!tags.some((t) => t.name.toLowerCase() === term.toLowerCase())) {
        results.push({ id: null, name: term, isNew: true });
      }
      highlight = 0;
      renderList();
    } catch (e) {
      log(e.message, "error");
      status("Tag search failed");
    }
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  async function commit(index) {
    if (busy) return;
    const pick = results[index];
    if (!pick) { status("Pick a tag first"); return; }

    busy = true;
    status(pick.isNew ? "Creating tag..." : "Adding marker...");
    try {
      let tag = pick;
      if (pick.isNew) {
        tag = await createTag(pick.name);
        if (!tag) throw new Error("tagCreate returned nothing");
        status("Adding marker...");
      }
      const title  = q("title").value.trim();
      const marker = await createMarker(tag.id, title, markSeconds);
      if (!marker) throw new Error("sceneMarkerCreate returned nothing");

      noteRecent(tag);
      syncStashCache();
      status(`Added at ${fmt(markSeconds)}`);
      log(`Marker ${marker.id} at ${markSeconds}s tag=${tag.name}`);
      setTimeout(closePanel, 550);
    } catch (e) {
      log(e.message, "error");
      status(`Failed: ${String(e.message).slice(0, 70)}`);
      // A recent tag that was renamed or deleted since it was noted fails here
      // forever. Drop it so the slot stops being a trap.
      if (!pick.isNew && pick.id && /tag|not found|no rows|constraint/i.test(e.message)) {
        const list = loadRecent().filter((t) => t.id !== pick.id);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (_) {}
        if (!q("search").value.trim()) { results = list; highlight = 0; renderList(); }
      }
    } finally {
      busy = false;
    }
  }

  // Stash renders the marker list from its Apollo cache, so nudge it rather
  // than making the user reload to see the marker appear.
  function syncStashCache() {
    try {
      const svc    = window.PluginApi?.utils?.StashService;
      const client = typeof svc?.getClient === "function" ? svc.getClient() : null;
      if (!client) { log("No Apollo client, marker list updates on reload"); return; }
      client.refetchQueries({ include: ["FindSceneMarkers", "SceneMarkerTags", "FindScene"] });
    } catch (e) {
      log(`refetch failed: ${e.message}`);
    }
  }

  // ── Placement ──────────────────────────────────────────────────────────────
  function positionPanel() {
    const pad = 12;
    const r   = panel.getBoundingClientRect();
    const vw  = window.innerWidth, vh = window.innerHeight;
    const ax  = mouseX === null ? vw / 2 : mouseX;
    const ay  = mouseY === null ? vh / 2 : mouseY;

    let x = ax + 16, y = ay + 16;
    if (x + r.width  + pad > vw) x = ax - r.width - 16;
    if (y + r.height + pad > vh) y = ay - r.height - 16;
    x = Math.max(pad, Math.min(x, vw - r.width  - pad));
    y = Math.max(pad, Math.min(y, vh - r.height - pad));

    const v = videoEl();
    if (v) {
      const vr = v.getBoundingClientRect();
      if (vr.width > 0 && vr.height > 0) {
        const barTop = vr.bottom - 80;
        const hits = y + r.height > barTop && y < vr.bottom + 8 &&
                     x + r.width > vr.left && x < vr.right;
        if (hits) {
          const above = barTop - r.height - 10;
          if (above >= pad) y = above;
          else if (vr.bottom + 10 + r.height + pad <= vh) y = vr.bottom + 10;
        }
      }
    }
    panel.style.left = Math.round(x) + "px";
    panel.style.top  = Math.round(y) + "px";
  }

  // ── Open / close ───────────────────────────────────────────────────────────
  function openPanel() {
    const id = currentSceneId();
    if (!id) return;
    const v = videoEl();
    if (!v) { log("No video element on the page"); return; }

    sceneId     = id;
    markSeconds = v.currentTime || 0;   // frozen now, fumbling will not move it
    probeSchema();

    if (!panel) panel = buildPanel();
    q("search").value = "";
    q("title").value  = "";
    status("");
    results   = loadRecent();
    highlight = 0;
    renderTime();
    renderList();
    positionPanel();
    panel.classList.add("qm-open");
    open = true;
    q("search").focus();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    clearTimeout(searchTimer);
    if (panel) panel.classList.remove("qm-open");
    const v = videoEl();
    if (v) v.focus?.();
  }

  // ── Keys ───────────────────────────────────────────────────────────────────
  document.addEventListener("mousemove", (ev) => { mouseX = ev.clientX; mouseY = ev.clientY; }, true);

  function onPanelKey(ev) {
    const k = ev.key;
    const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
    const inTitle = ev.target === q("title");

    if (k === "Escape") { stop(); closePanel(); return; }

    if (k === "Enter") {
      stop();
      commit(highlight);
      return;
    }

    if (k === "ArrowDown") { stop(); highlight = Math.min(results.length - 1, highlight + 1); renderList(); return; }
    if (k === "ArrowUp")   { stop(); highlight = Math.max(0, highlight - 1); renderList(); return; }

    if (k === "Tab" && !inTitle) { stop(); q("title").focus(); return; }
    if (k === "Tab" && inTitle)  { stop(); q("search").focus(); return; }

    // Nudge the timestamp. Only when the search box is empty, so these stay
    // typeable inside a tag name.
    if ((k === "," || k === ".") && !inTitle && !q("search").value) {
      stop();
      markSeconds = Math.max(0, markSeconds + (k === "." ? 1 : -1));
      renderTime();
      return;
    }

    // Number keys pick a recent tag outright, but only with an empty search box.
    if (/^[1-9]$/.test(k) && !inTitle && !q("search").value) {
      const i = parseInt(k, 10) - 1;
      if (i < results.length) { stop(); commit(i); }
      return;
    }
  }

  document.addEventListener("keydown", (ev) => {
    if (open) {
      // Focus can leave the inputs (click on the panel body). Escape must
      // still close, and Stash's own hotkeys must not fire underneath.
      if (typingInAField(document.activeElement) && panel?.contains(document.activeElement)) return;
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closePanel(); return; }
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
        ev.preventDefault(); ev.stopPropagation();     // keep Stash hotkeys quiet
        const inp = q("search");
        inp.focus();
        inp.value += ev.key;                            // do not lose the keystroke
        onSearchInput();
      }
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typingInAField(document.activeElement)) return;
    if (ev.key !== "m" && ev.key !== "M") return;
    if (!currentSceneId()) return;
    ev.preventDefault();
    ev.stopPropagation();
    openPanel();
  }, true);

  // Clicking away cancels. Creating a marker is deliberate, so nothing is
  // committed implicitly the way QuickRate commits a rating.
  //
  // A click on the video surface closes the panel and nothing else: swallow
  // the whole click so video.js does not toggle pause. Control-bar clicks are
  // left alone.
  let swallowUntil = 0;
  function isVideoSurface(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest(".vjs-control-bar, .vjs-menu, .vjs-modal-dialog, button, a")) return false;
    return !!el.closest("video, .vjs-tech, .video-js, .VideoPlayer");
  }
  document.addEventListener("pointerdown", (ev) => {
    if (!open) return;
    if (panel && panel.contains(ev.target)) return;
    const onVideo = isVideoSurface(ev.target);
    closePanel();
    if (onVideo) {
      swallowUntil = performance.now() + 600;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    }
  }, true);
  for (const type of ["mousedown", "mouseup", "pointerup", "click", "dblclick", "touchstart", "touchend"]) {
    document.addEventListener(type, (ev) => {
      if (performance.now() >= swallowUntil) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
    }, true);
  }

  setInterval(() => {
    if (open && currentSceneId() !== sceneId) closePanel();
  }, 400);

  window.addEventListener("resize", () => { if (open) positionPanel(); });

  log("QuickMark ready. Press M on a scene page.");
})();
