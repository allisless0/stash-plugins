/**
 * QuickTools - Stash UI plugin
 *
 * Four shortcuts for the scene player, sharing one core:
 *   R            rate the scene, 0.0 - 10.0
 *   M            add a marker at the current position
 *   D            toggle the "Marked for Delete" tag
 *   double-click jump through the scene queue (off by default)
 *
 * Merged from the separate QuickRate, QuickMark and QuickNav plugins. The
 * merge was not cosmetic: the two panels previously shipped their own copies
 * of the video-click suppression, and keeping two capture-phase handlers in
 * agreement by hand was a standing bug risk. There is now exactly one.
 */
(function () {
  "use strict";
  if (window.__QuickToolsLoaded) return;
  window.__QuickToolsLoaded = true;

  const PLUGIN_ID = "QuickTools";
  const GQL_URL   = "/graphql";
  const DEBUG     = localStorage.getItem("quickToolsDebug") === "1";
  const BAR_H     = 80;      // px of player chrome a panel must stay clear of

  const log = (m, lvl = "log") => {
    if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m);
  };

  // ═══ Shared core ═══════════════════════════════════════════════════════════

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

  function currentSceneId() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function onScenePage() {
    return /\/scenes\/\d+/.test(window.location.pathname);
  }

  function videoEl() {
    const vids = Array.from(document.querySelectorAll("video"));
    return vids.find((v) => v.duration > 0) || vids[0] || null;
  }

  function typingInAField(el) {
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
           el.tagName === "SELECT" || el.isContentEditable;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function fmtTime(sec) {
    // Round to tenths first. Rounding after the split lets 59.95 render 0:60.0.
    const s = Math.round(Math.max(0, sec) * 10) / 10;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s - h * 3600 - m * 60;
    const rr = (r < 10 ? "0" : "") + r.toFixed(1);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rr}` : `${m}:${rr}`;
  }

  // ── Apollo cache ───────────────────────────────────────────────────────────
  // Stash renders from a normalised Apollo cache. A plain fetch writes the
  // database but leaves that cache stale, so the page keeps showing the old
  // value until a reload. Poke the cache instead.
  function apolloClient() {
    try {
      const api = window.PluginApi;
      const svc = api?.utils?.StashService;
      if (typeof svc?.getClient === "function")       return svc.getClient();
      if (typeof api?.utils?.getClient === "function") return api.utils.getClient();
      if (svc?.client) return svc.client;
    } catch (e) {
      log(`Apollo lookup failed: ${e.message}`);
    }
    return null;
  }

  function refetch(queries) {
    const client = apolloClient();
    if (!client) { log("No Apollo client exposed, UI updates on reload"); return null; }
    try { client.refetchQueries({ include: queries }); }
    catch (e) { log(`refetchQueries failed: ${e.message}`); }
    return client;
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  // Defaults are the shipped behaviour: rating and markers on, nav off. Nav is
  // opt-in because it replaces double-click-to-fullscreen, which people have
  // muscle memory for.
  const settings = {
    disableRating:  false,
    disableMarkers: false,
    enableNav:      false,
    disableDelete:  false,
    deleteTagName:  "",     // blank means DEFAULT_DELETE_TAG
  };

  async function loadSettings() {
    try {
      const d   = await gql(`query { configuration { plugins } }`);
      const own = d?.configuration?.plugins?.[PLUGIN_ID] ?? {};
      for (const key of Object.keys(settings)) {
        const want = typeof settings[key];
        const got  = own[key];
        if (typeof got !== want) continue;
        if (want === "string") { if (got.trim()) settings[key] = got.trim(); }
        else settings[key] = got;
      }
      log(`Settings: ${JSON.stringify(settings)}`);
    } catch (e) {
      log(`Settings read failed, using defaults: ${e.message}`);
    }
  }

  // ── Cursor tracking and panel placement ────────────────────────────────────
  let mouseX = null;
  let mouseY = null;
  document.addEventListener("mousemove", (ev) => {
    mouseX = ev.clientX; mouseY = ev.clientY;
  }, true);

  // Anchor to the cursor, stay inside the viewport, and keep off the player's
  // control bar so next, prev and seek stay clickable.
  function positionPanel(el) {
    const pad = 12;
    const r   = el.getBoundingClientRect();
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const ax  = mouseX === null ? vw / 2 : mouseX;
    const ay  = mouseY === null ? vh / 2 : mouseY;

    let x = ax + 16;
    let y = ay + 16;
    if (x + r.width  + pad > vw) x = ax - r.width  - 16;
    if (y + r.height + pad > vh) y = ay - r.height - 16;
    x = Math.max(pad, Math.min(x, vw - r.width  - pad));
    y = Math.max(pad, Math.min(y, vh - r.height - pad));

    const v = videoEl();
    if (v) {
      const vr = v.getBoundingClientRect();
      if (vr.width > 0 && vr.height > 0) {
        const barTop = vr.bottom - BAR_H;
        const hits = y + r.height > barTop && y < vr.bottom + 8 &&
                     x + r.width > vr.left && x < vr.right;
        if (hits) {
          const above = barTop - r.height - 10;
          if (above >= pad) y = above;
          else if (vr.bottom + 10 + r.height + pad <= vh) y = vr.bottom + 10;
        }
      }
    }
    el.style.left = Math.round(x) + "px";
    el.style.top  = Math.round(y) + "px";
  }

  // ── Shared styles ──────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("quicktools-styles")) return;
    const s = document.createElement("style");
    s.id = "quicktools-styles";
    s.textContent = `
.qt-panel {
  position: fixed; left: 0; top: 0; z-index: 10000;
  background: #232b33; border: 1px solid #3c4a57; border-radius: 6px;
  box-shadow: 0 10px 34px rgba(0,0,0,.6);
  padding: 12px 14px 10px; color: #e6e9ec; font-family: inherit;
  opacity: 0; pointer-events: none; transform: scale(.97); transform-origin: top left;
  transition: opacity .1s ease, transform .1s ease;
}
.qt-panel.qt-open { opacity: 1; transform: scale(1); pointer-events: auto; }
.qt-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
.qt-status { font-size: 12px; color: #f5a623; min-height: 1.3em; text-align: right; }
.qt-hint { margin-top: 8px; font-size: 11px; color: #7f8b97; line-height: 1.5; }
.qt-panel kbd { background: #2e3944; border: 1px solid #44525f; border-bottom-width: 2px;
  border-radius: 3px; padding: 0 4px; font-size: 10px; font-family: inherit; color: #c6ced6; }

/* rating */
#qt-rate { width: 300px; }
#qt-rate .qt-value { font-size: 34px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; }
#qt-rate .qt-max { font-size: 14px; font-weight: 400; color: #8b97a3; margin-left: 3px; }
#qt-rate .qt-prev { font-size: 12px; color: #8b97a3; }
#qt-rate .qt-track { position: relative; height: 22px; cursor: pointer; }
#qt-rate .qt-bar  { position: absolute; top: 9px; left: 0; right: 0; height: 4px; background: #38434e; border-radius: 2px; }
#qt-rate .qt-fill { position: absolute; top: 9px; left: 0; height: 4px; background: #f5a623; border-radius: 2px; }
#qt-rate .qt-knob { position: absolute; top: 3px; width: 15px; height: 15px; margin-left: -7.5px;
  background: #f5a623; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
#qt-rate .qt-ticks { display: flex; justify-content: space-between; font-size: 10px;
  color: #6e7b88; font-variant-numeric: tabular-nums; }

/* marker */
#qt-mark { width: 340px; }
#qt-mark .qt-time { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
#qt-mark input {
  width: 100%; box-sizing: border-box; background: #1b2229; color: #e6e9ec;
  border: 1px solid #44525f; border-radius: 4px; padding: 6px 8px;
  font-size: 13px; font-family: inherit; outline: none;
}
#qt-mark input:focus { border-color: #f5a623; }
#qt-mark .qt-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  color: #6e7b88; margin: 8px 0 3px; }
#qt-mark .qt-list { margin-top: 6px; max-height: 208px; overflow-y: auto; }
#qt-mark .qt-row { display: flex; align-items: center; gap: 8px; padding: 5px 7px;
  border-radius: 4px; cursor: pointer; font-size: 13px; }
#qt-mark .qt-row.qt-hi { background: #33404d; }
#qt-mark .qt-row .qt-key { font-size: 10px; color: #8b97a3; min-width: 14px;
  text-align: center; border: 1px solid #44525f; border-radius: 3px; padding: 0 3px; }
#qt-mark .qt-row .qt-new { font-size: 10px; color: #f5a623; margin-left: auto; }
#qt-mark .qt-empty { padding: 10px 7px; font-size: 12px; color: #7f8b97; }

/* nav flash */
#qt-flash {
  position: fixed; z-index: 10001; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  width: 84px; height: 84px; margin: -42px 0 0 -42px;
  border-radius: 50%; background: rgba(0,0,0,.55);
  color: #fff; font-size: 34px; line-height: 1;
  opacity: 0; transform: scale(.7);
  transition: opacity .18s ease, transform .18s ease;
}
#qt-flash.qt-on { opacity: 1; transform: scale(1); }

/* marked for delete: a tint over the picture, stopping short of the control bar */
#qt-del-overlay {
  position: fixed; z-index: 10002; pointer-events: none;
  background: rgba(226,87,76,.13);
  box-shadow: inset 0 0 0 2px rgba(226,87,76,.55);
  opacity: 0; transition: opacity .16s ease;
}
#qt-del-overlay.qt-on { opacity: 1; }
#qt-del-overlay .qt-del-label {
  position: absolute; top: 10px; right: 10px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 3px;
  padding: 6px 10px; border-radius: 5px;
  background: rgba(26,15,15,.82); border: 1px solid #a3403a;
  box-shadow: 0 4px 16px rgba(0,0,0,.5);
}
#qt-del-overlay .qt-del-head { display: flex; align-items: center; gap: 7px; }
#qt-del-overlay .qt-del-name {
  color: #f0d3d0; font-size: 12px; font-weight: 600;
  letter-spacing: .03em; white-space: nowrap;
}
#qt-del-overlay .qt-del-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #e2574c; box-shadow: 0 0 6px #e2574c;
}
.qt-del-tip { font-size: 10px; color: #c39a96; white-space: nowrap; }
.qt-del-tip kbd {
  background: #2e3944; border: 1px solid #5a4444; border-radius: 3px;
  padding: 0 3px; font-size: 9px; font-family: inherit; color: #e8cbc8;
}

/* marked for delete: the brief confirmation over the player */
#qt-del-toast {
  position: fixed; z-index: 10003; pointer-events: none;
  padding: 10px 18px; border-radius: 6px; white-space: nowrap;
  background: rgba(0,0,0,.74); border: 1px solid #a3403a;
  color: #fff; font-size: 15px; font-weight: 600;
  box-shadow: 0 6px 22px rgba(0,0,0,.55);
  opacity: 0; transform: translate(-50%,-50%) scale(.92);
  transition: opacity .16s ease, transform .16s ease;
}
#qt-del-toast.qt-on  { opacity: 1; transform: translate(-50%,-50%) scale(1); }
#qt-del-toast.qt-off { border-color: #4a5560; }
#qt-del-toast.qt-err { border-color: #f5a623; color: #f5d8a0; font-size: 13px; }
#qt-del-toast .qt-del-tip { display: block; margin-top: 4px; font-weight: 400; }

@media (prefers-reduced-motion: reduce) {
  .qt-panel, #qt-flash, #qt-del-overlay, #qt-del-toast { transition: none; }
}
`;
    document.head.appendChild(s);
  }

  // ── Panel registry ─────────────────────────────────────────────────────────
  // Exactly one panel may be open. Before the merge each plugin tracked its own
  // `open` flag and neither knew about the other, so R while the marker panel
  // was up produced two overlapping panels both claiming the keyboard.
  let active = null;   // { id, close(commit) }

  function setActive(entry) {
    if (active && active !== entry) active.close(true);
    active = entry;
  }

  function clearActive(entry) {
    if (active === entry) active = null;
  }

  // ── Video-click suppression (one handler for every panel) ──────────────────
  // Clicking outside dismisses the open panel. A click on the video surface is
  // special: the user wants the panel gone, not the video paused, so the whole
  // click is swallowed from pointerdown through click. Control-bar clicks are
  // never swallowed, so play, next and seek keep working and the rating panel
  // still commits on the way through.
  let swallowUntil = 0;

  function isVideoSurface(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest(".vjs-control-bar, .vjs-menu, .vjs-modal-dialog, button, a")) return false;
    return !!el.closest("video, .vjs-tech, .video-js, .VideoPlayer");
  }

  document.addEventListener("pointerdown", (ev) => {
    if (!active) return;
    if (active.el && active.el.contains(ev.target)) return;
    const onVideo = isVideoSurface(ev.target);
    active.close(true);
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

  // Leaving the scene commits against the scene being left, not the new one.
  setInterval(() => {
    if (active && active.sceneId && currentSceneId() !== active.sceneId) {
      active.close(true);
    }
  }, 300);

  window.addEventListener("resize", () => {
    if (active && active.el) positionPanel(active.el);
  });
  window.addEventListener("pagehide", () => { if (active) active.close(true); });

  // ═══ Rating (R) ════════════════════════════════════════════════════════════

  const Rate = (() => {
    const STEP_FINE  = 0.1;
    const STEP_BIG   = 0.5;
    const SAVE_DELAY = 650;    // ms of quiet before an edit is written

    let field     = null;      // "rating100" | "rating", resolved once
    let panel     = null;
    let open      = false;
    let value     = 0;         // 0.0 - 10.0
    let saved     = null;      // last value known to be in the database
    let original  = null;      // value in the database when the panel opened
    let touched   = false;     // a commit ran since open
    let buffer    = "";        // digits typed since opening
    let saveTimer = null;
    let sceneId   = null;

    const entry = {
      id: "rate",
      get el() { return panel; },
      get sceneId() { return sceneId; },
      close: (commitEdit) => closePanel(commitEdit),
    };

    // Stash 0.24+ stores ratings as rating100 (0-100). Older builds use
    // rating (1-5 stars).
    async function resolveField() {
      if (field) return field;
      try {
        const d = await gql(`query { __type(name: "SceneUpdateInput") { inputFields { name } } }`);
        const names = (d?.__type?.inputFields ?? []).map((f) => f.name);
        field = names.includes("rating100") ? "rating100" : "rating";
      } catch (e) {
        log(`Schema probe failed, assuming rating100: ${e.message}`, "error");
        field = "rating100";
      }
      log(`Rating field: ${field}`);
      return field;
    }

    const toStored = (v) => {
      if (v === null) return null;
      if (field === "rating100") return Math.round(v * 10);
      return Math.max(1, Math.min(5, Math.round(v / 2)));
    };

    const fromStored = (raw) => {
      if (raw === null || raw === undefined) return null;
      return field === "rating100" ? raw / 10 : raw * 2;
    };

    async function fetchRating(id) {
      await resolveField();
      const d = await gql(`query ($id: ID!) { findScene(id: $id) { id ${field} } }`, { id });
      return fromStored(d?.findScene?.[field]);
    }

    async function writeRating(id, v) {
      await resolveField();
      const input = { id };
      input[field] = toStored(v);
      await gql(`mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`, { input });
      syncCache(id, toStored(v));
    }

    function syncCache(id, storedValue) {
      const client = refetch(["FindScene", "FindScenes"]);
      if (!client) return;
      try {
        const cacheId = client.cache.identify({ __typename: "Scene", id: String(id) });
        if (cacheId) {
          client.cache.modify({ id: cacheId, fields: { [field]: () => storedValue } });
          log(`Cache updated for ${cacheId}`);
        }
      } catch (e) {
        log(`cache.modify failed: ${e.message}`, "error");
      }
    }

    const same = (a, b) => (a === null || b === null) ? a === b : Math.abs(a - b) < 0.001;

    function scheduleSave() {
      clearTimeout(saveTimer);
      status("");
      saveTimer = setTimeout(() => commit(value), SAVE_DELAY);
    }

    function flushSave() {
      clearTimeout(saveTimer);
      if (!open) return;
      if (same(saved, value)) return;
      commit(value);
    }

    async function commit(v) {
      clearTimeout(saveTimer);
      const id = sceneId;
      if (!id) return;
      touched = true;
      if (v !== null && saved !== null && Math.abs(saved - v) < 0.001) return;
      const prev = saved;
      saved = v;
      status(v === null ? "Cleared" : `Saved ${v.toFixed(1)}`);
      render();
      try {
        await writeRating(id, v);
        log(`Scene ${id} rated ${v === null ? "(cleared)" : v.toFixed(1)}`);
      } catch (e) {
        saved = prev;
        log(e.message, "error");
        status("Save failed");
        render();
      }
    }

    function build() {
      injectStyles();
      const el = document.createElement("div");
      el.id = "qt-rate";
      el.className = "qt-panel";
      el.innerHTML = `
        <div class="qt-head">
          <div class="qt-value"><span data-qt="num">0.0</span><span class="qt-max">/ 10</span></div>
          <div style="text-align:right">
            <div class="qt-prev" data-qt="prev"></div>
            <div class="qt-status" data-qt="status"></div>
          </div>
        </div>
        <div class="qt-track" data-qt="track">
          <div class="qt-bar"></div>
          <div class="qt-fill" data-qt="fill"></div>
          <div class="qt-knob" data-qt="knob"></div>
        </div>
        <div class="qt-ticks">
          <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
        </div>
        <div class="qt-hint">
          Type a number or drag. Saves on its own.
          <kbd>&larr;</kbd><kbd>&rarr;</kbd> 0.1 &middot;
          <kbd>&uarr;</kbd><kbd>&darr;</kbd> 0.5 &middot;
          <kbd>X</kbd> clear &middot; <kbd>Esc</kbd> undo
        </div>`;
      document.body.appendChild(el);

      const track = el.querySelector('[data-qt="track"]');
      const fromEvent = (ev) => {
        const r = track.getBoundingClientRect();
        const pct = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
        buffer = "";
        setValue(Math.round(pct * 100) / 10);
      };
      track.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        track.setPointerCapture(ev.pointerId);
        fromEvent(ev);
        const move = (e) => fromEvent(e);
        const up = () => {
          track.removeEventListener("pointermove", move);
          track.removeEventListener("pointerup", up);
        };
        track.addEventListener("pointermove", move);
        track.addEventListener("pointerup", up);
      });
      return el;
    }

    const q = (n) => panel.querySelector(`[data-qt="${n}"]`);
    const status = (t) => { if (panel) q("status").textContent = t; };

    function setValue(v) {
      value = Math.min(10, Math.max(0, Math.round(v * 10) / 10));
      render();
      scheduleSave();
    }

    function render() {
      if (!panel) return;
      q("num").textContent = value.toFixed(1);
      const pct = value * 10;
      q("fill").style.width = pct + "%";
      q("knob").style.left  = pct + "%";
      q("prev").textContent = saved === null ? "Not rated" : `Saved: ${saved.toFixed(1)}`;
    }

    async function openPanel() {
      const id = currentSceneId();
      if (!id) return;
      setActive(entry);
      sceneId = id;

      if (!panel) panel = build();
      buffer = ""; saved = null; original = null; touched = false; value = 0;
      render();
      status("Loading...");
      positionPanel(panel);
      panel.classList.add("qt-open");
      open = true;

      try {
        const current = await fetchRating(id);
        if (!open || sceneId !== id) return;
        original = current;
        // If the user already typed and auto-save fired, the database now holds
        // their value. Do not roll `saved` back to what we just read.
        if (!touched) {
          saved = current;
          if (current !== null && buffer === "") value = current;
        }
        status("");
        render();
      } catch (e) {
        log(e.message, "error");
        status("Could not read rating");
      }
    }

    // commitEdit=true writes any pending edit. false discards it AND restores
    // whatever was in the database when the panel opened, so Esc is a real undo
    // even after the 650ms auto-save already wrote something.
    function closePanel(commitEdit = true) {
      if (!open) return;
      if (commitEdit) {
        flushSave();
      } else {
        clearTimeout(saveTimer);
        if (touched && !same(saved, original)) {
          saved = null;             // bypass commit's no-change shortcut
          commit(original);
        }
      }
      open = false;
      buffer = "";
      if (panel) panel.classList.remove("qt-open");
      clearActive(entry);
    }

    function clearRating() {
      clearTimeout(saveTimer);
      commit(null);
      value = 0;
      render();
    }

    function onKey(ev) {
      const k = ev.key;
      const stop = () => { ev.preventDefault(); ev.stopPropagation(); };

      if (k === "Escape")                          { stop(); closePanel(false); return true; }
      if (k === "r" || k === "R" || k === "Enter") { stop(); closePanel(true);  return true; }
      if (k === "x" || k === "X" || k === "Delete"){ stop(); clearRating();     return true; }

      if (k === "ArrowRight") { stop(); buffer = ""; setValue(value + STEP_FINE); return true; }
      if (k === "ArrowLeft")  { stop(); buffer = ""; setValue(value - STEP_FINE); return true; }
      if (k === "ArrowUp")    { stop(); buffer = ""; setValue(value + STEP_BIG);  return true; }
      if (k === "ArrowDown")  { stop(); buffer = ""; setValue(value - STEP_BIG);  return true; }

      if (k === "Backspace") {
        stop();
        buffer = buffer.slice(0, -1);
        setValue(buffer === "" ? 0 : parseFloat(buffer) || 0);
        return true;
      }

      if (/^[0-9]$/.test(k) || k === "." || k === ",") {
        stop();
        const ch = k === "," ? "." : k;
        if (ch === "." && buffer.includes(".")) return true;
        if (buffer === "0" && ch !== ".") { buffer = "0." + ch; setValue(parseFloat(buffer)); return true; }
        const next = buffer + ch;
        const n = parseFloat(next);
        // "8" then "5" means 8.5, not 85
        if (!isNaN(n) && n > 10) buffer = buffer + "." + ch;
        else                     buffer = next;
        setValue(parseFloat(buffer) || 0);
        return true;
      }
      return false;
    }

    return { openPanel, onKey, isOpen: () => open, closePanel };
  })();

  // ═══ Markers (M) ═══════════════════════════════════════════════════════════

  const Mark = (() => {
    const RECENT_KEY   = "quickMarkRecentTags";   // kept: migrates recents from QuickMark
    const RECENT_MAX   = 9;                       // one per number key
    const SEARCH_LIMIT = 8;

    let panel       = null;
    let open        = false;
    let sceneId     = null;
    let markSeconds = 0;       // frozen at the moment M was pressed
    let results     = [];      // [{id, name, isNew}]
    let highlight   = 0;
    let searchSeq   = 0;
    let searchTimer = null;
    let busy        = false;

    const entry = {
      id: "mark",
      get el() { return panel; },
      get sceneId() { return sceneId; },
      close: () => closePanel(),
    };

    async function searchTags(term) {
      const d = await gql(
        `query ($f: FindFilterType) { findTags(filter: $f) { tags { id name } } }`,
        { f: { q: term, per_page: SEARCH_LIMIT, sort: "name", direction: "ASC" } }
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
      const d = await gql(
        `mutation ($input: SceneMarkerCreateInput!) {
           sceneMarkerCreate(input: $input) { id seconds primary_tag { id name } }
         }`,
        {
          input: {
            scene_id:       sceneId,
            primary_tag_id: tagId,
            seconds:        Math.max(0, Math.round(seconds * 1000) / 1000),
            title:          title || "",
          },
        }
      );
      return d?.sceneMarkerCreate ?? null;
    }

    function loadRecent() {
      try {
        const raw = localStorage.getItem(RECENT_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
      } catch { return []; }
    }

    function saveRecent(list) {
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); }
      catch (e) { log(`Could not save recents: ${e.message}`); }
    }

    function noteRecent(tag) {
      const list = loadRecent().filter((t) => t.id !== tag.id);
      list.unshift({ id: tag.id, name: tag.name });
      saveRecent(list);
    }

    function build() {
      injectStyles();
      const el = document.createElement("div");
      el.id = "qt-mark";
      el.className = "qt-panel";
      el.innerHTML = `
        <div class="qt-head">
          <div class="qt-time" data-qt="time">0:00.0</div>
          <div class="qt-status" data-qt="status"></div>
        </div>
        <input data-qt="search" placeholder="Tag" autocomplete="off" spellcheck="false">
        <div class="qt-label">Title (optional)</div>
        <input data-qt="title" placeholder="Defaults to the tag name" autocomplete="off">
        <div class="qt-list" data-qt="list"></div>
        <div class="qt-hint">
          <kbd>1</kbd>-<kbd>9</kbd> recent &middot;
          <kbd>&uarr;</kbd><kbd>&darr;</kbd> pick &middot;
          <kbd>Enter</kbd> add &middot;
          <kbd>,</kbd><kbd>.</kbd> nudge 1s &middot;
          <kbd>Esc</kbd> cancel
        </div>`;
      document.body.appendChild(el);
      el.querySelector('[data-qt="search"]').addEventListener("input", onSearchInput);
      el.querySelector('[data-qt="search"]').addEventListener("keydown", onPanelKey);
      el.querySelector('[data-qt="title"]').addEventListener("keydown", onPanelKey);
      return el;
    }

    const q = (n) => panel.querySelector(`[data-qt="${n}"]`);
    const status = (t) => { if (panel) q("status").textContent = t; };
    const renderTime = () => { q("time").textContent = fmtTime(markSeconds); };

    function renderList() {
      const list = q("list");
      list.innerHTML = "";
      if (!results.length) {
        const d = document.createElement("div");
        d.className = "qt-empty";
        d.textContent = q("search").value.trim()
          ? "No tags match. Keep typing to create one."
          : "No recent tags yet. Type to search.";
        list.appendChild(d);
        return;
      }
      results.forEach((t, i) => {
        const row = document.createElement("div");
        row.className = "qt-row" + (i === highlight ? " qt-hi" : "");
        const showKey = !q("search").value.trim() && i < 9;
        row.innerHTML =
          (showKey ? `<span class="qt-key">${i + 1}</span>` : `<span class="qt-key"></span>`) +
          `<span>${escapeHtml(t.name)}</span>` +
          (t.isNew ? `<span class="qt-new">create</span>` : "");
        row.addEventListener("mouseenter", () => {
          highlight = i;
          // toggle in place; rebuilding under a moving cursor flickers
          list.querySelectorAll(".qt-row").forEach((r, j) => r.classList.toggle("qt-hi", j === i));
        });
        row.addEventListener("click", () => commit(i));
        list.appendChild(row);
      });
    }

    function onSearchInput() {
      clearTimeout(searchTimer);
      const term = q("search").value.trim();
      if (!term) {
        results = loadRecent();
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
        refetch(["FindSceneMarkers", "SceneMarkerTags", "FindScene"]);
        status(`Added at ${fmtTime(markSeconds)}`);
        log(`Marker ${marker.id} at ${markSeconds}s tag=${tag.name}`);
        setTimeout(closePanel, 550);
      } catch (e) {
        log(e.message, "error");
        status(`Failed: ${String(e.message).slice(0, 70)}`);
        // A recent tag renamed or deleted since it was noted fails here every
        // time. Drop it so the slot stops being a trap.
        if (!pick.isNew && pick.id && /tag|not found|no rows|constraint/i.test(e.message)) {
          const list = loadRecent().filter((t) => t.id !== pick.id);
          saveRecent(list);
          if (!q("search").value.trim()) { results = list; highlight = 0; renderList(); }
        }
      } finally {
        busy = false;
      }
    }

    function openPanel() {
      const id = currentSceneId();
      if (!id) return;
      const v = videoEl();
      if (!v) { log("No video element on the page"); return; }

      setActive(entry);
      sceneId     = id;
      markSeconds = v.currentTime || 0;   // frozen now, fumbling will not move it

      if (!panel) panel = build();
      q("search").value = "";
      q("title").value  = "";
      status("");
      results   = loadRecent();
      highlight = 0;
      renderTime();
      renderList();
      positionPanel(panel);
      panel.classList.add("qt-open");
      open = true;
      q("search").focus();
    }

    function closePanel() {
      if (!open) return;
      open = false;
      clearTimeout(searchTimer);
      if (panel) panel.classList.remove("qt-open");
      clearActive(entry);
      videoEl()?.focus?.();
    }

    function onPanelKey(ev) {
      const k = ev.key;
      const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
      const inTitle = ev.target === q("title");

      if (k === "Escape") { stop(); closePanel(); return; }
      if (k === "Enter")  { stop(); commit(highlight); return; }

      if (k === "ArrowDown") { stop(); highlight = Math.min(results.length - 1, highlight + 1); renderList(); return; }
      if (k === "ArrowUp")   { stop(); highlight = Math.max(0, highlight - 1); renderList(); return; }

      if (k === "Tab" && !inTitle) { stop(); q("title").focus();  return; }
      if (k === "Tab" && inTitle)  { stop(); q("search").focus(); return; }

      // Nudge the timestamp, but only with an empty search box so these stay
      // typeable inside a tag name.
      if ((k === "," || k === ".") && !inTitle && !q("search").value) {
        stop();
        markSeconds = Math.max(0, markSeconds + (k === "." ? 1 : -1));
        renderTime();
        return;
      }

      // Number keys pick a recent tag outright, same empty-box condition.
      if (/^[1-9]$/.test(k) && !inTitle && !q("search").value) {
        const i = parseInt(k, 10) - 1;
        if (i < results.length) { stop(); commit(i); }
        return;
      }
    }

    // Document-level fallback for when focus escapes the inputs, e.g. a click
    // on the panel body.
    function onKey(ev) {
      if (typingInAField(document.activeElement) && panel?.contains(document.activeElement)) {
        return true;    // the input's own handler deals with it
      }
      if (ev.key === "Escape") {
        ev.preventDefault(); ev.stopPropagation();
        closePanel();
        return true;
      }
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1) {
        ev.preventDefault(); ev.stopPropagation();   // keep Stash hotkeys quiet
        const inp = q("search");
        inp.focus();
        inp.value += ev.key;                          // do not lose the keystroke
        onSearchInput();
        return true;
      }
      return true;      // panel owns the keyboard while it is up
    }

    return { openPanel, onKey, isOpen: () => open, closePanel };
  })();

  // ═══ Queue navigation (double-click) ═══════════════════════════════════════

  const Nav = (() => {
    // Fraction of the video width, centred, where a double-click still toggles
    // fullscreen. 0 disables the exemption.
    const DEAD_ZONE  = 0;
    // Hold this while double-clicking to get the normal fullscreen toggle back.
    const ESCAPE_KEY = "shiftKey";

    let flashEl = null;
    let flashTimer = null;

    // Stash binds "p n" and "p p" through Mousetrap. Triggering those keeps the
    // queue, continue-play behaviour and history handling identical to clicking
    // the queue buttons by hand.
    function viaMousetrap(seq) {
      try {
        const lib  = window.PluginApi?.libraries?.Mousetrap;
        const inst = lib?.default ?? lib;
        if (inst && typeof inst.trigger === "function") {
          // trigger() on an unbound sequence is a silent no-op, so only trust
          // it when the binding actually exists. Otherwise fall through.
          if (isBound(inst, seq) === false) {
            log(`Mousetrap has no '${seq}' binding, falling back`);
            return false;
          }
          inst.trigger(seq);
          log(`Mousetrap.trigger('${seq}')`);
          return true;
        }
      } catch (e) {
        log(`Mousetrap failed: ${e.message}`, "error");
      }
      return false;
    }

    // Best-effort binding check. Mousetrap keeps its map in a private closure
    // on most builds, so return null when it cannot be inspected.
    function isBound(inst, seq) {
      try {
        const map = inst._callbacks || inst._directMap;
        if (!map) return null;
        const keys = Object.keys(map);
        const last = seq.split(" ").pop();
        return keys.some((k) => k === seq || k.startsWith(seq) || k.startsWith(last + ":"));
      } catch (_) { return null; }
    }

    // Last resort: click whatever queue control Stash rendered.
    function viaQueueButton(direction) {
      const wanted = direction === "next" ? /next/i : /prev/i;
      for (const el of document.querySelectorAll("button, a[role='button'], .vjs-control")) {
        const label = `${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`;
        if (wanted.test(label) && /scene|queue|vjs/i.test(label)) {
          el.click();
          log(`Clicked queue control: ${label.trim()}`);
          return true;
        }
      }
      return false;
    }

    // Mousetrap listens on document for keypress, so synthesise the character
    // codes it actually reads rather than relying on the init dict.
    function viaSyntheticKeys(chars) {
      chars.forEach((ch, i) => {
        setTimeout(() => {
          const code = ch.charCodeAt(0);
          for (const type of ["keydown", "keypress", "keyup"]) {
            const ev = new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true });
            Object.defineProperty(ev, "which",    { get: () => code });
            Object.defineProperty(ev, "keyCode",  { get: () => code });
            Object.defineProperty(ev, "charCode", { get: () => (type === "keypress" ? code : 0) });
            document.dispatchEvent(ev);
          }
        }, i * 50);
      });
      log(`Synthesised keys: ${chars.join(" ")}`);
    }

    function go(direction) {
      const seq   = direction === "next" ? "p n" : "p p";
      const chars = direction === "next" ? ["p", "n"] : ["p", "p"];
      if (viaMousetrap(seq)) return;
      if (viaQueueButton(direction)) return;
      viaSyntheticKeys(chars);
    }

    function flash(direction, x, y) {
      injectStyles();
      if (!flashEl) {
        flashEl = document.createElement("div");
        flashEl.id = "qt-flash";
        document.body.appendChild(flashEl);
      }
      flashEl.textContent = direction === "next" ? "\u23ED" : "\u23EE";
      flashEl.style.left = x + "px";
      flashEl.style.top  = y + "px";
      flashEl.classList.add("qt-on");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flashEl.classList.remove("qt-on"), 320);
    }

    function videoFor(target) {
      // The dblclick may land on the video, the tech wrapper or an overlay, so
      // walk up to the player container and take its video element.
      const player = target.closest?.(".video-js, .vjs-tech, video, #VideoJsPlayer");
      if (!player) return null;
      if (player.tagName === "VIDEO") return player;
      return player.querySelector("video") || player;
    }

    function onDblClick(ev) {
      if (!settings.enableNav) return;
      if (!onScenePage()) return;
      if (ev[ESCAPE_KEY]) return;                                     // let fullscreen through
      if (ev.target.closest?.(".vjs-control-bar, .vjs-menu")) return; // never steal control clicks
      if (active) return;      // a panel is up; its own dismiss handles this click

      const video = videoFor(ev.target);
      if (!video) return;

      const rect = video.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;

      const rel = (ev.clientX - rect.left) / rect.width;
      if (rel < 0 || rel > 1) return;
      if (DEAD_ZONE > 0 && Math.abs(rel - 0.5) < DEAD_ZONE / 2) return;

      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();

      const direction = rel >= 0.5 ? "next" : "previous";
      flash(direction, ev.clientX, ev.clientY);
      log(`Double-click at ${(rel * 100).toFixed(0)}% -> ${direction}`);
      go(direction);
    }

    return { onDblClick };
  })();

  // ═══ Marked for delete (D) ═════════════════════════════════════════════════
  // A plain tag, not a custom field or a sentinel rating, because the reaping
  // step already exists: filter the scene list by the tag, select all, delete.
  // This module only has to keep one tag_ids array honest.
  //
  // Deliberately not a panel. It never registers with the panel registry, so
  // it does not steal the keyboard and does not close on the next click.

  const Del = (() => {
    const DEFAULT_NAME = "Marked for Delete";
    const CACHE_KEY    = "quickToolsDeleteTag";   // { name, id }
    const TOAST_MS     = 1400;
    const POLL_MS      = 500;

    let tagId      = null;    // resolved lazily, never on page load
    let lookedUp   = false;   // a no-create lookup has run for the current name
    let sceneId    = null;
    let marked     = false;
    let busy       = false;
    let overlay    = null;
    let toast      = null;
    let toastTimer = null;
    let rafPending = false;

    const tagName = () => (settings.deleteTagName || DEFAULT_NAME);

    // ── Tag resolution ───────────────────────────────────────────────────────
    // The id is cached in localStorage against the name it was resolved for, so
    // renaming the tag in the plugin settings invalidates it for free.

    function readCached() {
      try {
        const o = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        return (o && o.name === tagName() && o.id) ? String(o.id) : null;
      } catch { return null; }
    }

    function writeCached(id) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ name: tagName(), id })); }
      catch (e) { log(`Could not cache the delete tag: ${e.message}`); }
    }

    function forgetCached() {
      try { localStorage.removeItem(CACHE_KEY); } catch {}
      tagId = null;
      lookedUp = false;
    }

    async function findTag() {
      const name = tagName();
      const d = await gql(
        `query ($f: FindFilterType) { findTags(filter: $f) { tags { id name } } }`,
        { f: { q: name, per_page: 25, sort: "name", direction: "ASC" } }
      );
      const hit = (d?.findTags?.tags ?? [])
        .find((t) => t.name.toLowerCase() === name.toLowerCase());
      return hit ? String(hit.id) : null;
    }

    // create=false is the page-load path: if the tag does not exist yet then no
    // scene can carry it, so there is nothing to check and nothing to create.
    async function ensureTag(create) {
      if (tagId) return tagId;

      const cached = readCached();
      if (cached) { tagId = cached; return tagId; }

      if (!lookedUp) {
        tagId = await findTag();
        lookedUp = true;
        if (tagId) { writeCached(tagId); return tagId; }
      }
      if (!create) return null;

      const d = await gql(
        `mutation ($input: TagCreateInput!) { tagCreate(input: $input) { id name } }`,
        { input: { name: tagName() } }
      );
      tagId = d?.tagCreate?.id ? String(d.tagCreate.id) : null;
      if (tagId) writeCached(tagId);
      return tagId;
    }

    // ── Scene state ──────────────────────────────────────────────────────────

    async function sceneTags(id) {
      const d = await gql(`query ($id: ID!) { findScene(id: $id) { id tags { id } } }`, { id });
      return (d?.findScene?.tags ?? []).map((t) => String(t.id));
    }

    // sceneUpdate replaces tag_ids rather than appending to it, so the whole
    // array has to be read back and rewritten. This is the one real trap here.
    async function applyToggle(sid, tid) {
      const tags = await sceneTags(sid);
      const has  = tags.includes(tid);
      const next = has ? tags.filter((t) => t !== tid) : tags.concat(tid);
      await gql(
        `mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
        { input: { id: sid, tag_ids: next } }
      );
      return !has;
    }

    async function toggle() {
      const id = currentSceneId();
      if (!id || busy) return;
      busy = true;
      try {
        let tid = await ensureTag(true);
        if (!tid) throw new Error("could not resolve the tag");

        let now;
        try {
          now = await applyToggle(id, tid);
        } catch (e) {
          // Most likely a cached id for a tag that has since been deleted in
          // Stash. Forget it, resolve again, and try exactly once more.
          log(`Toggle failed (${e.message}), re-resolving the tag`);
          forgetCached();
          tid = await ensureTag(true);
          if (!tid) throw e;
          now = await applyToggle(id, tid);
        }

        sceneId = id;
        marked  = now;
        renderOverlay();
        showToast(now ? "Marked for delete" : "Unmarked", now ? "" : "qt-off", now);
        refetch(["FindScene", "FindScenes"]);
      } catch (e) {
        log(`Delete mark failed: ${e.message}`, "error");
        showToast(`Could not tag: ${e.message}`, "qt-err");
      } finally {
        busy = false;
      }
    }

    async function refresh() {
      const id = currentSceneId();
      sceneId = id;
      marked  = false;
      renderOverlay();
      if (!id) return;

      const tid = await ensureTag(false);
      if (!tid) return;
      try {
        const tags = await sceneTags(id);
        if (currentSceneId() !== id) return;   // navigated away mid-flight
        marked = tags.includes(tid);
        renderOverlay();
      } catch (e) {
        log(`Delete tag check failed: ${e.message}`);
      }
    }

    // ── Overlay and toast ────────────────────────────────────────────────────
    // Both live in the body and are placed from the video's bounding rect, the
    // same trick positionPanel uses. Appending into the player's own DOM would
    // be tidier to write and would last until React's next render.
    //
    // Fullscreen is the exception: a fixed element in the body is not painted
    // over a fullscreen element, so the nodes move into it and back.

    function host() { return document.fullscreenElement || document.body; }

    function build() {
      injectStyles();
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "qt-del-overlay";
      }
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "qt-del-toast";
      }
      // Only rebuilt when the name actually changes. build() runs on every
      // reposition, and re-writing innerHTML each time would restart the fade
      // and churn the DOM at 2 Hz for nothing.
      if (overlay.dataset.qtName !== tagName()) {
        overlay.dataset.qtName = tagName();
        overlay.innerHTML =
          `<div class="qt-del-label">` +
            `<div class="qt-del-head">` +
              `<span class="qt-del-dot"></span>` +
              `<span class="qt-del-name">${escapeHtml(tagName())}</span>` +
            `</div>` +
            `<span class="qt-del-tip">Press <kbd>D</kbd> to unmark</span>` +
          `</div>`;
      }

      const h = host();
      if (overlay.parentNode !== h) h.appendChild(overlay);
      if (toast.parentNode !== h) h.appendChild(toast);
    }

    function playerRect() {
      const v = videoEl();
      if (!v) return null;
      const r = v.getBoundingClientRect();
      return (r.width > 40 && r.height > 40) ? r : null;
    }

    // The tint stops above the control bar so the timeline stays readable and
    // is not tinted along with the picture. video.js keeps the bar in layout
    // when it auto-hides, so the measured height is stable and the overlay does
    // not resize every time the controls fade. BAR_H is only the fallback for
    // a skin that does not use .vjs-control-bar.
    function controlBarH() {
      const v = videoEl();
      const root = v ? v.closest(".video-js, .VideoPlayer") : null;
      const bar = (root || document).querySelector(".vjs-control-bar");
      const h = bar ? bar.getBoundingClientRect().height : 0;
      return h > 0 ? h : BAR_H;
    }

    function renderOverlay() {
      if (!marked || !onScenePage()) {
        if (overlay) overlay.classList.remove("qt-on");
        return;
      }
      const r = playerRect();
      if (!r) { if (overlay) overlay.classList.remove("qt-on"); return; }

      build();
      const h = Math.max(0, r.height - controlBarH());
      if (h < 40) { overlay.classList.remove("qt-on"); return; }

      overlay.style.left   = Math.round(r.left) + "px";
      overlay.style.top    = Math.round(r.top) + "px";
      overlay.style.width  = Math.round(r.width) + "px";
      overlay.style.height = Math.round(h) + "px";
      overlay.classList.add("qt-on");
    }

    function showToast(text, cls, tip) {
      build();
      toast.innerHTML = escapeHtml(text) +
        (tip ? `<span class="qt-del-tip">Press <kbd>D</kbd> to unmark</span>` : "");
      toast.className = cls || "";

      const r = playerRect();
      toast.style.left = r ? Math.round(r.left + r.width / 2) + "px" : "50%";
      toast.style.top  = r ? Math.round(r.top + r.height / 2) + "px" : "50%";

      // Reflow so a repeat press restarts the transition instead of ignoring it.
      void toast.offsetWidth;
      toast.classList.add("qt-on");

      clearTimeout(toastTimer);
      toastTimer = setTimeout(
        () => toast.classList.remove("qt-on"),
        cls === "qt-err" ? 2600 : TOAST_MS
      );
    }

    function reposition() {
      if (!marked || rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; renderOverlay(); });
    }

    // ── Start ────────────────────────────────────────────────────────────────

    function start() {
      let lastScene = null;
      setInterval(() => {
        const id = currentSceneId();
        if (id !== lastScene) { lastScene = id; refresh(); return; }
        if (marked) renderOverlay();     // player resized, theatre mode toggled, etc
      }, POLL_MS);

      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
      document.addEventListener("fullscreenchange", () => {
        if (!marked) return;
        build();          // reparents into or out of the fullscreen element
        renderOverlay();
      });
    }

    return { start, toggle, isMarked: () => marked };
  })();

  // ═══ Keyboard router ═══════════════════════════════════════════════════════
  // One capture-phase listener. Previously each plugin installed its own and
  // both ran on every keystroke, which made behaviour depend on load order.
  //
  // On window, not document: window capture runs before any document listener,
  // so stopPropagation here actually keeps a handled key away from other
  // plugins. On document it only beat them if QuickTools happened to load
  // first, and typing 10 or 0.5 into the rating panel also hit IntifaceSync's
  // 0 (manual off).

  window.addEventListener("keydown", (ev) => {
    // An open panel owns the keyboard.
    if (Rate.isOpen()) {
      if (typingInAField(document.activeElement)) return;
      if (Rate.onKey(ev)) return;
      // D is the one key the rating panel lets through: R then D saves the
      // rating and marks the scene, which is the sequence people reach for.
      if (!settings.disableDelete && (ev.key === "d" || ev.key === "D")) {
        ev.preventDefault();
        ev.stopPropagation();
        Rate.closePanel(true);
        Del.toggle();
      }
      return;
    }
    if (Mark.isOpen()) {
      Mark.onKey(ev);
      return;
    }

    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typingInAField(document.activeElement)) return;
    if (!currentSceneId()) return;

    if (!settings.disableRating && (ev.key === "r" || ev.key === "R")) {
      ev.preventDefault();
      ev.stopPropagation();
      Rate.openPanel();
      return;
    }
    if (!settings.disableMarkers && (ev.key === "m" || ev.key === "M")) {
      ev.preventDefault();
      ev.stopPropagation();
      Mark.openPanel();
      return;
    }
    if (!settings.disableDelete && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault();
      ev.stopPropagation();
      Del.toggle();
      return;
    }
  }, true);

  document.addEventListener("dblclick", (ev) => Nav.onDblClick(ev), true);

  // Resuming playback dismisses the rating panel, committing on the way out.
  document.addEventListener("play", (ev) => {
    if (Rate.isOpen() && ev.target instanceof HTMLMediaElement) Rate.closePanel(true);
  }, true);

  // ═══ Start ═════════════════════════════════════════════════════════════════

  loadSettings().then(() => {
    const on = [];
    if (!settings.disableRating)  on.push("R rate");
    if (!settings.disableMarkers) on.push("M mark");
    if (!settings.disableDelete)  { on.push("D delete-tag"); Del.start(); }
    if (settings.enableNav)       on.push("double-click queue");
    log(`QuickTools ready. Active: ${on.join(", ") || "nothing (all features disabled)"}`);
  });
})();
