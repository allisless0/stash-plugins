/**
 * QuickNav - Stash UI plugin
 * Double-click the right half of the video for the next scene in the queue,
 * the left half for the previous one. Suppresses double-click-to-fullscreen.
 */
(function () {
  "use strict";
  if (window.__QuickNavLoaded) return;
  window.__QuickNavLoaded = true;

  // Fraction of the video width, centred, where a double-click is left alone
  // and still toggles fullscreen. 0 disables the exemption entirely.
  const DEAD_ZONE   = 0;
  // Hold this while double-clicking to get the normal fullscreen toggle back.
  const ESCAPE_KEY  = "shiftKey";
  const DEBUG       = localStorage.getItem("quickNavDebug") === "1";

  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl]("[QuickNav]", m); };

  function onScenePage() {
    return /\/scenes\/\d+/.test(window.location.pathname);
  }

  // ── Firing Stash's own queue navigation ────────────────────────────────────
  // Stash binds "p n" and "p p" through Mousetrap. Triggering those keeps the
  // queue, continue-play behaviour and history handling identical to clicking
  // the queue buttons by hand.
  function viaMousetrap(seq) {
    try {
      const lib  = window.PluginApi?.libraries?.Mousetrap;
      const inst = lib?.default ?? lib;
      if (inst && typeof inst.trigger === "function") {
        // trigger() on an unbound sequence is a silent no-op, so only trust it
        // when the binding actually exists. Otherwise fall through.
        const bound = isBound(inst, seq);
        if (bound === false) { log(`Mousetrap has no '${seq}' binding, falling back`); return false; }
        inst.trigger(seq);
        log(`Mousetrap.trigger('${seq}')`);
        return true;
      }
    } catch (e) {
      log(`Mousetrap failed: ${e.message}`, "error");
    }
    return false;
  }

  // Best-effort check for an existing binding. Mousetrap keeps its map in a
  // private closure on most builds; return null when it cannot be inspected.
  function isBound(inst, seq) {
    try {
      const map = inst._callbacks || inst._directMap;
      if (!map) return null;
      const keys = Object.keys(map);
      const last = seq.split(" ").pop();
      return keys.some((k) => k === seq || k.startsWith(seq) || k.startsWith(last + ":"));
    } catch (_) { return null; }
  }

  // Mousetrap listens on document for keypress, so synthesise the character
  // codes it actually reads rather than relying on the KeyboardEvent init dict.
  function viaSyntheticKeys(chars) {
    chars.forEach((ch, i) => {
      setTimeout(() => {
        const code = ch.charCodeAt(0);
        for (const type of ["keydown", "keypress", "keyup"]) {
          const ev = new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true });
          Object.defineProperty(ev, "which",   { get: () => code });
          Object.defineProperty(ev, "keyCode", { get: () => code });
          Object.defineProperty(ev, "charCode",{ get: () => (type === "keypress" ? code : 0) });
          document.dispatchEvent(ev);
        }
      }, i * 50);
    });
    log(`Synthesised keys: ${chars.join(" ")}`);
    return true;
  }

  // Last resort: click whatever queue control Stash rendered.
  function viaQueueButton(direction) {
    const wanted = direction === "next" ? /next/i : /prev/i;
    const candidates = document.querySelectorAll(
      "button, a[role='button'], .vjs-control"
    );
    for (const el of candidates) {
      const label = `${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""} ${el.className || ""}`;
      if (wanted.test(label) && /scene|queue|vjs/i.test(label)) {
        el.click();
        log(`Clicked queue control: ${label.trim()}`);
        return true;
      }
    }
    return false;
  }

  function go(direction) {
    const seq   = direction === "next" ? "p n" : "p p";
    const chars = direction === "next" ? ["p", "n"] : ["p", "p"];
    if (viaMousetrap(seq)) return;
    if (viaQueueButton(direction)) return;
    viaSyntheticKeys(chars);
  }

  // ── Feedback ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("quicknav-styles")) return;
    const s = document.createElement("style");
    s.id = "quicknav-styles";
    s.textContent = `
#quicknav-flash {
  position: fixed; z-index: 10001; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  width: 84px; height: 84px; margin: -42px 0 0 -42px;
  border-radius: 50%; background: rgba(0,0,0,.55);
  color: #fff; font-size: 34px; line-height: 1;
  opacity: 0; transform: scale(.7);
  transition: opacity .18s ease, transform .18s ease;
}
#quicknav-flash.qn-on { opacity: 1; transform: scale(1); }
@media (prefers-reduced-motion: reduce) { #quicknav-flash { transition: none; } }
`;
    document.head.appendChild(s);
  }

  let flashEl = null;
  let flashTimer = null;

  function flash(direction, x, y) {
    injectStyles();
    if (!flashEl) {
      flashEl = document.createElement("div");
      flashEl.id = "quicknav-flash";
      document.body.appendChild(flashEl);
    }
    flashEl.textContent = direction === "next" ? "\u23ED" : "\u23EE";
    flashEl.style.left = x + "px";
    flashEl.style.top  = y + "px";
    flashEl.classList.add("qn-on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove("qn-on"), 320);
  }

  // ── Double-click handling ──────────────────────────────────────────────────
  function videoFor(target) {
    // The dblclick may land on the video, the tech wrapper or an overlay,
    // so walk up to the player container and take its video element.
    const player = target.closest?.(".video-js, .vjs-tech, video, #VideoJsPlayer");
    if (!player) return null;
    if (player.tagName === "VIDEO") return player;
    return player.querySelector("video") || player;
  }

  document.addEventListener("dblclick", (ev) => {
    if (!onScenePage()) return;
    if (ev[ESCAPE_KEY]) return;                                  // let fullscreen through
    if (ev.target.closest?.(".vjs-control-bar, .vjs-menu")) return;  // never steal control clicks

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
  }, true);

  log("QuickNav ready. Double-click the left or right half of the video.");
})();
