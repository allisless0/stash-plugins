/**
 * QuickRate - Stash UI plugin
 * Rate the current scene on a 0.0-10.0 scale from the player. Hotkey: R
 */
(function () {
  "use strict";
  if (window.__QuickRateLoaded) return;
  window.__QuickRateLoaded = true;

  const GQL_URL    = "/graphql";
  const STEP_FINE  = 0.1;
  const STEP_BIG   = 0.5;
  const SAVE_DELAY = 650;    // ms of quiet before an edit is written
  const BAR_HEIGHT = 80;     // px of player chrome to stay clear of
  const DEBUG      = localStorage.getItem("quickRateDebug") === "1";

  let ratingField = null;    // "rating100" | "rating", resolved once
  let panel       = null;
  let open        = false;
  let value       = 0;       // 0.0 - 10.0
  let saved       = null;    // last value known to be in the database
  let original    = null;    // value in the database when the panel opened, for Esc
  let touched     = false;   // a commit ran since open; fetch result must not clobber it
  let buffer      = "";      // digits typed since opening
  let saveTimer   = null;
  let sceneId     = null;
  let mouseX      = null;
  let mouseY      = null;

  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl]("[QuickRate]", m); };

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

  // Stash 0.24+ stores ratings as rating100 (0-100). Older builds use rating (1-5).
  async function resolveRatingField() {
    if (ratingField) return ratingField;
    try {
      const d = await gql(`query { __type(name: "SceneUpdateInput") { inputFields { name } } }`);
      const names = (d?.__type?.inputFields ?? []).map((f) => f.name);
      ratingField = names.includes("rating100") ? "rating100" : "rating";
    } catch (e) {
      log(`Schema probe failed, assuming rating100: ${e.message}`, "error");
      ratingField = "rating100";
    }
    log(`Rating field: ${ratingField}`);
    return ratingField;
  }

  function toStored(v) {
    if (v === null) return null;
    if (ratingField === "rating100") return Math.round(v * 10);
    return Math.max(1, Math.min(5, Math.round(v / 2)));   // legacy 1-5 stars
  }

  function fromStored(raw) {
    if (raw === null || raw === undefined) return null;
    return ratingField === "rating100" ? raw / 10 : raw * 2;
  }

  async function fetchRating(id) {
    await resolveRatingField();
    const d = await gql(`query ($id: ID!) { findScene(id: $id) { id ${ratingField} } }`, { id });
    return fromStored(d?.findScene?.[ratingField]);
  }

  async function writeRating(id, v) {
    await resolveRatingField();
    const input = { id };
    input[ratingField] = toStored(v);
    await gql(`mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`, { input });
    syncStashCache(id, toStored(v));
  }

  // ── Live UI refresh ────────────────────────────────────────────────────────
  // Stash's scene page renders from an Apollo normalised cache. A plain fetch
  // writes the database but leaves that cache stale, so the star widget keeps
  // showing the old value until a reload. Poke the cache instead.
  function getApolloClient() {
    try {
      const api = window.PluginApi;
      const svc = api?.utils?.StashService;
      if (typeof svc?.getClient === "function")   return svc.getClient();
      if (typeof api?.utils?.getClient === "function") return api.utils.getClient();
      if (svc?.client) return svc.client;
    } catch (e) {
      log(`Apollo lookup failed: ${e.message}`);
    }
    return null;
  }

  function syncStashCache(id, storedValue) {
    const client = getApolloClient();
    if (!client) { log("No Apollo client exposed, UI will update on reload"); return; }

    try {
      const cacheId = client.cache.identify({ __typename: "Scene", id: String(id) });
      if (cacheId) {
        client.cache.modify({
          id: cacheId,
          fields: { [ratingField]: () => storedValue },
        });
        log(`Cache updated for ${cacheId}`);
      }
    } catch (e) {
      log(`cache.modify failed: ${e.message}`, "error");
    }

    // Lists and counts elsewhere on the page still hold the old value.
    try {
      client.refetchQueries({ include: ["FindScene", "FindScenes"] });
    } catch (e) {
      log(`refetchQueries failed: ${e.message}`);
    }
  }

  // ── Scene context ──────────────────────────────────────────────────────────
  function currentSceneId() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  function typingInAField(el) {
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
           el.tagName === "SELECT" || el.isContentEditable;
  }

  // ── Saving ─────────────────────────────────────────────────────────────────
  function sameRating(a, b) {
    if (a === null || b === null) return a === b;
    return Math.abs(a - b) < 0.001;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    status("");
    saveTimer = setTimeout(() => commit(value), SAVE_DELAY);
  }

  // Write any pending edit immediately. Called before the panel goes away.
  function flushSave() {
    clearTimeout(saveTimer);
    if (!open) return;
    if (saved !== null && Math.abs(saved - value) < 0.001) return;
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
    if (panel) render();
    try {
      await writeRating(id, v);
      log(`Scene ${id} rated ${v === null ? "(cleared)" : v.toFixed(1)}`);
    } catch (e) {
      saved = prev;
      log(e.message, "error");
      status("Save failed");
      if (panel) render();
    }
  }

  // ── Panel ──────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("quickrate-styles")) return;
    const css = `
#quickrate {
  position: fixed; left: 0; top: 0; z-index: 10000; width: 300px;
  background: #232b33; border: 1px solid #3c4a57; border-radius: 6px;
  box-shadow: 0 10px 34px rgba(0,0,0,.6);
  padding: 12px 14px 10px; color: #e6e9ec; font-family: inherit;
  opacity: 0; pointer-events: none; transform: scale(.97); transform-origin: top left;
  transition: opacity .1s ease, transform .1s ease;
}
#quickrate.qr-open { opacity: 1; transform: scale(1); pointer-events: auto; }
#quickrate .qr-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
#quickrate .qr-value { font-size: 34px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums; }
#quickrate .qr-value .qr-max { font-size: 14px; font-weight: 400; color: #8b97a3; margin-left: 3px; }
#quickrate .qr-prev { font-size: 12px; color: #8b97a3; }
#quickrate .qr-status { font-size: 12px; color: #f5a623; min-height: 1.3em; }
#quickrate .qr-track { position: relative; height: 22px; cursor: pointer; }
#quickrate .qr-bar { position: absolute; top: 9px; left: 0; right: 0; height: 4px; background: #38434e; border-radius: 2px; }
#quickrate .qr-fill { position: absolute; top: 9px; left: 0; height: 4px; background: #f5a623; border-radius: 2px; }
#quickrate .qr-knob { position: absolute; top: 3px; width: 15px; height: 15px; margin-left: -7.5px;
  background: #f5a623; border-radius: 50%; box-shadow: 0 1px 4px rgba(0,0,0,.5); }
#quickrate .qr-ticks { display: flex; justify-content: space-between; font-size: 10px;
  color: #6e7b88; font-variant-numeric: tabular-nums; }
#quickrate .qr-hint { margin-top: 8px; font-size: 11px; color: #7f8b97; line-height: 1.5; }
#quickrate kbd { background: #2e3944; border: 1px solid #44525f; border-bottom-width: 2px;
  border-radius: 3px; padding: 0 4px; font-size: 10px; font-family: inherit; color: #c6ced6; }
@media (prefers-reduced-motion: reduce) { #quickrate { transition: none; } }
`;
    const s = document.createElement("style");
    s.id = "quickrate-styles";
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildPanel() {
    injectStyles();
    const el = document.createElement("div");
    el.id = "quickrate";
    el.innerHTML = `
      <div class="qr-head">
        <div class="qr-value"><span data-qr="num">0.0</span><span class="qr-max">/ 10</span></div>
        <div style="text-align:right">
          <div class="qr-prev" data-qr="prev"></div>
          <div class="qr-status" data-qr="status"></div>
        </div>
      </div>
      <div class="qr-track" data-qr="track">
        <div class="qr-bar"></div>
        <div class="qr-fill" data-qr="fill"></div>
        <div class="qr-knob" data-qr="knob"></div>
      </div>
      <div class="qr-ticks">
        <span>0</span><span>2</span><span>4</span><span>6</span><span>8</span><span>10</span>
      </div>
      <div class="qr-hint">
        Type a number or drag. Saves on its own.
        <kbd>&larr;</kbd><kbd>&rarr;</kbd> 0.1 &middot;
        <kbd>&uarr;</kbd><kbd>&darr;</kbd> 0.5 &middot;
        <kbd>X</kbd> clear &middot; <kbd>Esc</kbd> undo
      </div>`;
    document.body.appendChild(el);

    const track = el.querySelector('[data-qr="track"]');
    const setFromEvent = (ev) => {
      const r = track.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      buffer = "";
      setValue(Math.round(pct * 100) / 10);
    };
    track.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      track.setPointerCapture(ev.pointerId);
      setFromEvent(ev);
      const move = (e) => setFromEvent(e);
      const up = () => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
    });

    return el;
  }

  function q(name) { return panel.querySelector(`[data-qr="${name}"]`); }

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

  function status(text) { if (panel) q("status").textContent = text; }

  // ── Placement ──────────────────────────────────────────────────────────────
  // Anchor to the cursor, stay inside the viewport, and keep off the player's
  // control bar so next, prev and seek stay clickable.
  function positionPanel() {
    const pad = 12;
    const r   = panel.getBoundingClientRect();
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;

    const ax = mouseX === null ? vw / 2 : mouseX;
    const ay = mouseY === null ? vh / 2 : mouseY;

    let x = ax + 16;
    let y = ay + 16;

    if (x + r.width  + pad > vw) x = ax - r.width - 16;
    if (y + r.height + pad > vh) y = ay - r.height - 16;
    x = Math.max(pad, Math.min(x, vw - r.width  - pad));
    y = Math.max(pad, Math.min(y, vh - r.height - pad));

    const video = document.querySelector("video");
    if (video) {
      const vr = video.getBoundingClientRect();
      if (vr.width > 0 && vr.height > 0) {
        const barTop = vr.bottom - BAR_HEIGHT;
        const overlapsBar = y + r.height > barTop && y < vr.bottom + 8 &&
                            x + r.width > vr.left && x < vr.right;
        if (overlapsBar) {
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
  async function openPanel() {
    const id = currentSceneId();
    if (!id) return;
    sceneId = id;

    if (!panel) panel = buildPanel();
    buffer   = "";
    saved    = null;
    original = null;
    touched  = false;
    value    = 0;
    render();
    status("Loading...");
    positionPanel();
    panel.classList.add("qr-open");
    open = true;

    try {
      const current = await fetchRating(id);
      if (!open || sceneId !== id) return;
      original = current;
      // If the user already typed and auto-save fired, the database now holds
      // their value, not `current`. Do not roll `saved` back to stale data.
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

  // save=true writes any pending edit. save=false discards the pending edit AND
  // restores whatever was in the database when the panel opened, so Esc is a
  // real undo even after the 650ms auto-save already wrote something.
  function closePanel(save = true) {
    if (!open) return;
    if (save) {
      flushSave();
    } else {
      clearTimeout(saveTimer);
      if (touched && !sameRating(saved, original)) {
        saved = null;               // bypass commit's no-change shortcut
        commit(original);
      }
    }
    open   = false;
    buffer = "";
    if (panel) panel.classList.remove("qr-open");
  }

  function clearRating() {
    clearTimeout(saveTimer);
    commit(null);
    value = 0;
    render();
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  document.addEventListener("mousemove", (ev) => { mouseX = ev.clientX; mouseY = ev.clientY; }, true);

  function onKeyDown(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typingInAField(document.activeElement)) return;

    if (!open) {
      if (ev.key === "r" || ev.key === "R") {
        if (!currentSceneId()) return;
        ev.preventDefault();
        ev.stopPropagation();
        openPanel();
      }
      return;
    }

    // Panel is open: swallow the keys we handle so Stash's own hotkeys stay quiet.
    const k = ev.key;
    const stop = () => { ev.preventDefault(); ev.stopPropagation(); };

    if (k === "Escape")                           { stop(); closePanel(false); return; }
    if (k === "r" || k === "R" || k === "Enter")  { stop(); closePanel(true);  return; }
    if (k === "x" || k === "X" || k === "Delete") { stop(); clearRating();     return; }

    if (k === "ArrowRight") { stop(); buffer = ""; setValue(value + STEP_FINE); return; }
    if (k === "ArrowLeft")  { stop(); buffer = ""; setValue(value - STEP_FINE); return; }
    if (k === "ArrowUp")    { stop(); buffer = ""; setValue(value + STEP_BIG);  return; }
    if (k === "ArrowDown")  { stop(); buffer = ""; setValue(value - STEP_BIG);  return; }

    if (k === "Backspace") {
      stop();
      buffer = buffer.slice(0, -1);
      setValue(buffer === "" ? 0 : parseFloat(buffer) || 0);
      return;
    }

    if (/^[0-9]$/.test(k) || k === "." || k === ",") {
      stop();
      const ch = k === "," ? "." : k;
      if (ch === "." && buffer.includes(".")) return;
      if (buffer === "0" && ch !== ".") { buffer = "0." + ch; setValue(parseFloat(buffer)); return; }
      const next = buffer + ch;
      const n = parseFloat(next);
      if (!isNaN(n) && n > 10) buffer = buffer + "." + ch;   // "8" then "5" means 8.5
      else                     buffer = next;
      setValue(parseFloat(buffer) || 0);
      return;
    }
  }
  document.addEventListener("keydown", onKeyDown, true);

  // Clicking anywhere outside commits and dismisses, so hitting next or play
  // in the player bar saves the rating on the way through.
  //
  // A click on the video surface itself is different: the user wants the
  // panel gone, not the video paused. Swallow that one click completely
  // (pointerdown through click) so video.js never sees it. Control-bar
  // clicks still go through, so next/prev/play keep working.
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
    closePanel(true);
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

  // Resuming playback dismisses too.
  document.addEventListener("play", (ev) => {
    if (open && ev.target instanceof HTMLMediaElement) closePanel(true);
  }, true);

  // Navigating to another scene commits against the scene being left.
  setInterval(() => {
    if (open && currentSceneId() !== sceneId) closePanel(true);
  }, 300);

  window.addEventListener("pagehide", () => closePanel(true));
  window.addEventListener("resize", () => { if (open) positionPanel(); });

  log("QuickRate ready. Press R on a scene page.");
})();
