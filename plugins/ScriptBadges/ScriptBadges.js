/**
 * ScriptBadges - Stash UI plugin
 *
 * Marks every scene card with whether the scene has a funscript, so it is
 * easy to see what in a library still needs one. Uses Stash's own
 * `interactive` flag: the same thing the Scenes "Interactive" filter and
 * Stash's Handy support go by.
 */
(function () {
  "use strict";
  if (window.__ScriptBadgesLoaded) return;
  window.__ScriptBadgesLoaded = true;

  const PLUGIN_ID = "ScriptBadges";
  const CACHE_MS  = 60000;
  const DEBUG = (() => { try { return localStorage.getItem("scriptBadgesDebug") === "1"; } catch { return false; } })();
  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl](`[${PLUGIN_ID}]`, m); };

  // ── Pure helpers (tested by scripts/test_scriptbadges.js) ──────────────────

  function sceneIdFromHref(href) {
    return String(href || "").match(/\/scenes\/(\d+)/)?.[1] ?? null;
  }

  // What a card shows. null means no badge.
  function badgeFor(info, onlyMissing) {
    if (!info) return null;
    if (info.interactive) {
      if (onlyMissing) return null;
      return {
        cls: "has",
        text: info.speed ? `Script · ${info.speed}` : "Script",
        title: info.speed
          ? `Has a funscript. Average speed ${info.speed} (Stash's measure of how busy it is).`
          : "Has a funscript.",
      };
    }
    return {
      cls: "none",
      text: "No script",
      title: "Stash found no funscript for this scene. It looks for a .funscript with exactly " +
             "the video's file name, next to the video, when it scans: after adding one, rescan " +
             "that folder (Settings › Tasks › Scan).",
    };
  }

  // ── Stash ──────────────────────────────────────────────────────────────────

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    let json;
    try { json = await res.json(); } catch { throw new Error(`Stash returned ${res.status}`); }
    if (json?.errors?.length) throw new Error(json.errors[0].message);
    return json?.data ?? null;
  }

  let onlyMissing = false;
  const cache = new Map();          // scene id -> {interactive, speed, ts}
  let timer = null;
  let queued = false;

  async function loadSettings() {
    try {
      const d = await gql(`query { configuration { plugins } }`);
      onlyMissing = d?.configuration?.plugins?.[PLUGIN_ID]?.onlyMissing === true;
    } catch (e) { log(`Settings read failed: ${e.message}`); }
  }

  function injectStyles() {
    if (document.getElementById("scriptbadges-styles")) return;
    const st = document.createElement("style");
    st.id = "scriptbadges-styles";
    st.textContent = `
.sb-badge {
  position: absolute; left: 0.6rem; bottom: 0.9rem; z-index: 2; pointer-events: auto;
  padding: 1px 7px; border-radius: 4px; font-size: 11px; font-weight: 600;
  line-height: 1.5; white-space: nowrap; cursor: default;
}
.sb-badge.has  { color: #d9f7e4; background: rgba(20,110,60,.85); }
.sb-badge.none { color: #ffe2c2; background: rgba(0,0,0,.72); border: 1px solid rgba(240,150,60,.8); }
/* the badge carries the speed now; Stash's bare number would sit under it */
.scene-card.sb-done .scene-interactive-speed-overlay { display: none; }
`;
    document.head.appendChild(st);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    // A timer, not requestAnimationFrame: rAF does not run in hidden tabs.
    clearTimeout(timer);
    timer = setTimeout(() => { queued = false; render(); }, 200);
  }

  async function render() {
    const cards = [...document.querySelectorAll(".scene-card")];
    if (!cards.length) return;
    const need = new Set();
    const ids = new Map();
    for (const card of cards) {
      const link = card.querySelector("a.scene-card-link") || card.querySelector('a[href*="/scenes/"]');
      const id = sceneIdFromHref(link?.getAttribute("href"));
      if (!id) continue;
      ids.set(card, id);
      const c = cache.get(id);
      if (!c || Date.now() - c.ts > CACHE_MS) need.add(id);
    }
    if (need.size) {
      try {
        const d = await gql(`query ($ids: [ID!]) { findScenes(ids: $ids, filter: { per_page: -1 }) {
                               scenes { id interactive interactive_speed } } }`, { ids: [...need] });
        for (const s of d?.findScenes?.scenes ?? []) {
          cache.set(String(s.id), { interactive: !!s.interactive, speed: s.interactive_speed || 0, ts: Date.now() });
        }
      } catch (e) { log(`Lookup failed: ${e.message}`, "error"); return; }
    }
    injectStyles();
    for (const [card, id] of ids) {
      const b = badgeFor(cache.get(id), onlyMissing);
      const host = card.querySelector(".scene-card-preview") || card;
      let el = host.querySelector(":scope > .sb-badge");
      if (!b) { el?.remove(); card.classList.remove("sb-done"); continue; }
      if (!el) { el = document.createElement("div"); host.appendChild(el); }
      el.className = `sb-badge ${b.cls}`;
      if (el.textContent !== b.text) el.textContent = b.text;
      el.title = b.title;
      card.classList.add("sb-done");
    }
  }

  if (window.__SB_TEST__) {
    window.__ScriptBadgesTest = { sceneIdFromHref, badgeFor };
    return;
  }

  loadSettings().then(() => {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  });
})();
