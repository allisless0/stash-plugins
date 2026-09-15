/**
 * QuickCriteria - Stash UI plugin
 *
 * Keyboard and mouse companion for the Advanced Rating plugin. Press R on a
 * performer page to score every criterion, then commit in one write.
 *
 * Criteria come from the tag tree, so upstream renames are picked up for free.
 * Grouping and ordering come from Advanced Rating's config when it can be read,
 * and degrade to a flat list when it cannot. Scenes are never touched.
 */
(function () {
  "use strict";
  if (window.__QuickCriteriaLoaded) return;
  window.__QuickCriteriaLoaded = true;

  const GQL_URL        = "/graphql";
  const PLUGIN_ID      = "QuickCriteria";
  const ADV_ID         = "advancedRating";
  const DEFAULT_PARENT = "Advanced Performer Rating";
  const CRIT_RE        = /^(.+?)\s*★$/;           // "Face ★"
  const LEVEL_RE       = /^(.+?)\s*★:\s*([0-5])$/; // "Face ★: 4"
  const DIVERGE_LIMIT  = 1.5;                      // /10 points before we flag it
  const DEBUG          = localStorage.getItem("quickCriteriaDebug") === "1";

  let parentTagName = DEFAULT_PARENT;
  let hiddenNames   = [];     // lowercased criterion names to omit
  let panel         = null;
  let open          = false;
  let performerId   = null;
  let performerName = "";
  let rows          = [];   // flat render model: {kind:"group"|"crit", ...}
  let criteria      = [];   // {name, levels, saved, value, group, order}
  let otherTagIds   = [];
  let cursor        = 0;    // index into criteria
  let evidence      = null;
  let busy          = false;
  let loadSeq       = 0;

  const log = (m, lvl = "log") => { if (DEBUG || lvl === "error") console[lvl]("[QuickCriteria]", m); };

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

  async function loadAllPluginConfig() {
    try {
      const d = await gql(`query { configuration { plugins } }`);
      return d?.configuration?.plugins ?? {};
    } catch (e) {
      log(`Config read failed: ${e.message}`);
      return {};
    }
  }

  /**
   * Find Advanced Rating's performer criteria inside Stash's plugin config.
   *
   * Key names there are not a stable contract and guessing them proved
   * unreliable, so this walks the whole config tree collecting every list that
   * looks like named records, then picks the one whose names overlap best with
   * the criteria we already found in the tag tree. That identifies the right
   * list without knowing what it is called, and naturally rejects the scene
   * criteria because their names will not match.
   */
  function parseAdvancedConfig(all, discoveredNames) {
    const wanted = new Set(discoveredNames.map((n) => n.toLowerCase()));
    if (!wanted.size) return null;

    const lists = [];
    const seen  = new Set();

    const coerce = (v) => {
      if (typeof v === "string" && /^[[{]/.test(v.trim())) {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v;
    };

    const asRecords = (v) => {
      if (Array.isArray(v)) {
        const rec = v.filter((x) => x && typeof x === "object");
        return rec.length === v.length && rec.length ? rec : null;
      }
      if (v && typeof v === "object") {
        const ent = Object.entries(v).filter(([, x]) => x && typeof x === "object");
        if (!ent.length || ent.length !== Object.keys(v).length) return null;
        return ent.map(([k, x]) => ({ id: k, ...x }));
      }
      return null;
    };

    const nameOf = (r) => r.name ?? r.label ?? r.title ?? null;

    (function walk(node, depth) {
      if (depth > 6 || node === null || node === undefined) return;
      const v = coerce(node);
      if (!v || typeof v !== "object") return;
      if (seen.has(v)) return;
      seen.add(v);

      const recs = asRecords(v);
      if (recs && recs.some((r) => nameOf(r))) lists.push(recs);

      const kids = Array.isArray(v) ? v : Object.values(v);
      for (const k of kids) walk(k, depth + 1);
    })(all, 0);

    // Best overlap with the tag-derived criterion names wins.
    let best = null, bestHits = 0;
    for (const l of lists) {
      let hits = 0;
      for (const r of l) {
        const n = nameOf(r);
        if (n && wanted.has(String(n).trim().toLowerCase())) hits++;
      }
      if (hits > bestHits) { bestHits = hits; best = l; }
    }
    if (!best || bestHits < Math.min(2, wanted.size)) {
      log(`No criteria list matched. Config keys: ` +
          `${Object.keys(all?.[ADV_ID] || {}).join(", ") || "(advancedRating absent)"}`, "error");
      return null;
    }

    // Group references may be ids or names. Resolve ids against any other list
    // whose entries carry matching identifiers.
    const refs = new Set();
    for (const r of best) {
      const g = r.group ?? r.groupId ?? r.group_id ?? r.bucket;
      if (g !== undefined && g !== null) refs.add(String(g));
    }

    const groupName = {};
    for (const l of lists) {
      if (l === best) continue;
      let matched = 0;
      for (const r of l) {
        const id = String(r.id ?? r.key ?? r.slug ?? "");
        if (id && refs.has(id)) matched++;
      }
      if (matched) {
        for (const r of l) {
          const id = String(r.id ?? r.key ?? r.slug ?? "");
          const n  = nameOf(r);
          if (id && n) groupName[id] = String(n);
        }
      }
    }

    const out = [];
    best.forEach((c, i) => {
      const n = nameOf(c);
      if (!n) return;
      if (c.enabled === false || c.disabled === true) return;
      const g = c.group ?? c.groupId ?? c.group_id ?? c.bucket;
      const gk = g === undefined || g === null ? null : String(g);
      const desc = c.description ?? c.desc ?? c.tooltip ?? c.help ?? null;
      out.push({
        name:  String(n).trim(),
        group: gk === null ? null : (groupName[gk] ?? gk),
        order: typeof c.order === "number" ? c.order : i,
        desc:  desc ? String(desc) : null,
      });
    });
    log(`Matched criteria list: ${bestHits}/${wanted.size} names, ` +
        `${Object.keys(groupName).length} group labels resolved`);
    return out.length ? out : null;
  }

  async function discoverCriteria() {
    const d = await gql(
      `query ($f: FindFilterType) {
         findTags(filter: $f) {
           tags { id name children { id name children { id name } } }
         }
       }`,
      { f: { q: parentTagName, per_page: 25 } }
    );
    const tags = d?.findTags?.tags ?? [];
    let parent = tags.find((t) => t.name === parentTagName) ||
                 tags.find((t) => t.name.toLowerCase() === parentTagName.toLowerCase()) ||
                 tags.find((t) => (t.children || []).some((c) => CRIT_RE.test(c.name)));
    if (!parent) return [];

    const out = [];
    for (const child of parent.children || []) {
      const m = CRIT_RE.exec(child.name);
      if (!m) continue;
      const levels = {};
      for (const lv of child.children || []) {
        const lm = LEVEL_RE.exec(lv.name);
        if (lm) levels[parseInt(lm[2], 10)] = lv.id;
      }
      if (Object.keys(levels).length) out.push({ name: m[1].trim(), levels });
    }
    return out;
  }

  async function loadPerformer(id) {
    const d = await gql(
      `query ($id: ID!) { findPerformer(id: $id) { id name rating100 tags { id name } } }`,
      { id }
    );
    return d?.findPerformer ?? null;
  }

  async function loadEvidence(id) {
    const d = await gql(
      `query ($pf: SceneFilterType, $f: FindFilterType) {
         findScenes(scene_filter: $pf, filter: $f) { count scenes { id rating100 } }
       }`,
      { pf: { performers: { value: [id], modifier: "INCLUDES" } }, f: { per_page: -1 } }
    );
    const scenes = d?.findScenes?.scenes ?? [];
    const rated  = scenes.filter((s) => typeof s.rating100 === "number" && s.rating100 > 0);
    return {
      total: d?.findScenes?.count ?? scenes.length,
      rated: rated.length,
      mean:  rated.length ? rated.reduce((a, s) => a + s.rating100, 0) / rated.length / 10 : null,
    };
  }

  async function savePerformer() {
    const tagIds = otherTagIds.slice();
    for (const c of criteria) {
      if (c.value !== null && c.levels[c.value]) tagIds.push(c.levels[c.value]);
    }
    await gql(
      `mutation ($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`,
      { input: { id: performerId, tag_ids: Array.from(new Set(tagIds)) } }
    );
  }

  // ── Context ────────────────────────────────────────────────────────────────
  function currentPerformerId() {
    const m = window.location.pathname.match(/\/performers\/(\d+)/);
    return m ? m[1] : null;
  }

  function typingInAField(el) {
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
           el.tagName === "SELECT" || el.isContentEditable;
  }

  function previewScore() {
    const vals = criteria.filter((c) => c.value !== null).map((c) => c.value);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length * 2;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("quickcriteria-styles")) return;
    const s = document.createElement("style");
    s.id = "quickcriteria-styles";
    s.textContent = `
#qc-backdrop {
  position: fixed; inset: 0; z-index: 9998; background: rgba(0,0,0,.45);
  opacity: 0; pointer-events: none; transition: opacity .12s ease;
}
#qc-backdrop.qc-open { opacity: 1; pointer-events: auto; }

#quickcriteria {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%) scale(.97);
  z-index: 9999; width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px); overflow-y: auto;
  background: #3b4149; border: 1px solid #4d545d; border-radius: 8px;
  box-shadow: 0 20px 60px rgba(0,0,0,.65);
  color: #f0f2f4; font-family: inherit;
  opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease;
}
#quickcriteria.qc-open { opacity: 1; transform: translate(-50%,-50%) scale(1); pointer-events: auto; }

#quickcriteria .qc-top { display: flex; align-items: flex-start; justify-content: space-between;
  padding: 20px 22px 14px; border-bottom: 1px solid #4d545d; gap: 16px; }
#quickcriteria .qc-title { font-size: 22px; font-weight: 700; line-height: 1.2; }
#quickcriteria .qc-sub { font-size: 13px; color: #a8b1ba; margin-top: 4px; }
#quickcriteria .qc-x { background: none; border: none; color: #c6ced6; font-size: 24px;
  line-height: 1; cursor: pointer; padding: 0 2px; }
#quickcriteria .qc-x:hover { color: #fff; }

#quickcriteria .qc-body { padding: 6px 22px 4px; }
#quickcriteria .qc-group { font-size: 13px; font-weight: 700; letter-spacing: .05em;
  text-transform: uppercase; color: #f5d33a; padding: 18px 0 6px;
  border-bottom: 1px solid #575e67; margin-bottom: 4px; }

#quickcriteria .qc-row { display: flex; align-items: center; gap: 14px;
  padding: 9px 8px; margin: 0 -8px; border-radius: 5px; }
#quickcriteria .qc-row.qc-hi { background: #474e57; }
#quickcriteria .qc-label { flex: 1; font-size: 16px; line-height: 1.3; }
#quickcriteria .qc-dirty { color: #f5d33a; margin-left: 6px; font-size: 13px; }
#quickcriteria .qc-pill { display: inline-block; margin-left: 8px; padding: 1px 7px;
  border-radius: 9px; background: #6b6231; color: #f5d33a;
  font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
  vertical-align: middle; }
#quickcriteria .qc-sub .qc-pill { margin-left: 6px; }
#quickcriteria .qc-info { margin-left: 7px; color: #8d97a2; font-size: 14px; cursor: help; }
#quickcriteria .qc-info:hover { color: #d6dce2; }

#quickcriteria .qc-stars { display: flex; gap: 5px; }
#quickcriteria .qc-star { font-size: 24px; line-height: 1; cursor: pointer;
  color: #5d656f; user-select: none; transition: color .06s ease, transform .06s ease; }
#quickcriteria .qc-star.qc-on { color: #f5d33a; }
#quickcriteria .qc-star:hover { transform: scale(1.14); }

#quickcriteria .qc-clear { background: none; border: none; cursor: pointer;
  color: #6f7883; font-size: 17px; line-height: 1; padding: 0 2px; min-width: 18px; }
#quickcriteria .qc-clear:hover { color: #e4606d; }
#quickcriteria .qc-clear.qc-hidden { visibility: hidden; }

#quickcriteria .qc-foot { padding: 14px 22px 8px; border-top: 1px solid #4d545d;
  margin-top: 14px; font-size: 13px; color: #a8b1ba; line-height: 1.75; }
#quickcriteria .qc-warn { color: #f5d33a; }
#quickcriteria .qc-actions { display: flex; align-items: center; gap: 10px;
  padding: 10px 22px 18px; }
#quickcriteria .qc-btn { font-size: 14px; padding: 8px 18px; border-radius: 5px;
  border: 1px solid #5d656f; background: #4a515a; color: #f0f2f4; cursor: pointer; }
#quickcriteria .qc-btn:hover { background: #555d67; }
#quickcriteria .qc-btn.qc-primary { background: #2f7d4f; border-color: #2f7d4f; font-weight: 600; }
#quickcriteria .qc-btn.qc-primary:hover { background: #389560; }
#quickcriteria .qc-btn:disabled { opacity: .5; cursor: default; }
#quickcriteria .qc-status { margin-left: auto; font-size: 13px; color: #f5d33a; }
#quickcriteria .qc-keys { padding: 0 22px 16px; font-size: 12px; color: #838d97; }
#quickcriteria kbd { background: #4a515a; border: 1px solid #5d656f; border-bottom-width: 2px;
  border-radius: 3px; padding: 1px 5px; font-size: 11px; font-family: inherit; color: #d6dce2; }
#quickcriteria .qc-empty { padding: 24px 8px; font-size: 14px; color: #a8b1ba; line-height: 1.6; }
@media (prefers-reduced-motion: reduce) {
  #quickcriteria, #qc-backdrop, #quickcriteria .qc-star { transition: none; }
}
`;
    document.head.appendChild(s);
  }

  // ── Build ──────────────────────────────────────────────────────────────────
  let backdrop = null;

  function buildPanel() {
    injectStyles();

    backdrop = document.createElement("div");
    backdrop.id = "qc-backdrop";
    backdrop.addEventListener("pointerdown", () => closePanel());
    document.body.appendChild(backdrop);

    const el = document.createElement("div");
    el.id = "quickcriteria";
    el.innerHTML = `
      <div class="qc-top">
        <div>
          <div class="qc-title">Performer Ratings</div>
          <div class="qc-sub" data-qc="sub">Loading…</div>
        </div>
        <button class="qc-x" data-qc="close" title="Close without saving">&times;</button>
      </div>
      <div class="qc-body" data-qc="body"></div>
      <div class="qc-foot" data-qc="foot"></div>
      <div class="qc-actions">
        <button class="qc-btn qc-primary" data-qc="save">Save</button>
        <button class="qc-btn" data-qc="cancel">Cancel</button>
        <span class="qc-status" data-qc="status"></span>
      </div>
      <div class="qc-keys">
        <kbd>0</kbd>–<kbd>5</kbd> score and advance &middot;
        <kbd>↑</kbd><kbd>↓</kbd> move &middot;
        <kbd>Backspace</kbd> unrate &middot;
        <kbd>Enter</kbd> save &middot;
        <kbd>Esc</kbd> cancel
      </div>`;
    document.body.appendChild(el);

    el.querySelector('[data-qc="close"]').addEventListener("click", () => closePanel());
    el.querySelector('[data-qc="cancel"]').addEventListener("click", () => closePanel());
    el.querySelector('[data-qc="save"]').addEventListener("click", () => commit());
    return el;
  }

  function q(n) { return panel.querySelector(`[data-qc="${n}"]`); }
  function status(t) { if (panel) q("status").textContent = t; }

  // ── Render ─────────────────────────────────────────────────────────────────
  function buildRowModel() {
    rows = [];
    let lastGroup = null;
    criteria.forEach((c, i) => {
      if (c.group && c.group !== lastGroup) {
        rows.push({ kind: "group", name: c.group });
        lastGroup = c.group;
      }
      rows.push({ kind: "crit", index: i });
    });
  }

  function renderBody() {
    const body = q("body");
    body.innerHTML = "";

    if (!criteria.length) {
      body.innerHTML = `<div class="qc-empty">
        No rating criteria found under <b>${escapeHtml(parentTagName)}</b>.<br>
        Open Settings → Plugins → Advanced Rating and click <b>Save</b> in the
        Performers section to create the tags.</div>`;
      return;
    }

    for (const r of rows) {
      if (r.kind === "group") {
        const g = document.createElement("div");
        g.className = "qc-group";
        g.textContent = r.name;
        body.appendChild(g);
        continue;
      }

      const i = r.index;
      const c = criteria[i];
      const row = document.createElement("div");
      row.className = "qc-row" + (i === cursor ? " qc-hi" : "");

      const label = document.createElement("div");
      label.className = "qc-label";
      label.innerHTML = escapeHtml(c.name) +
        (c.value === null ? `<span class="qc-pill">unrated</span>` : "") +
        (c.desc ? `<span class="qc-info" title="${escapeHtml(c.desc)}">&#9432;</span>` : "") +
        (c.value !== c.saved ? `<span class="qc-dirty" title="Unsaved">●</span>` : "");
      row.appendChild(label);

      const stars = document.createElement("div");
      stars.className = "qc-stars";
      for (let s = 1; s <= 5; s++) {
        const star = document.createElement("span");
        star.className = "qc-star" + (c.value !== null && s <= c.value ? " qc-on" : "");
        star.textContent = "★";
        star.title = `${c.name}: ${s}`;
        // Hover previews the score without committing it.
        star.addEventListener("mouseenter", () => paintStars(stars, s));
        star.addEventListener("mouseleave", () => paintStars(stars, c.value));
        star.addEventListener("click", (ev) => {
          ev.stopPropagation();
          cursor = i;
          c.value = (c.value === s) ? null : s;   // clicking the current score unrates
          render();
        });
        stars.appendChild(star);
      }
      row.appendChild(stars);

      const clear = document.createElement("button");
      clear.className = "qc-clear" + (c.value === null ? " qc-hidden" : "");
      clear.innerHTML = "&times;";
      clear.title = "Unrate";
      clear.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cursor = i; c.value = null; render();
      });
      row.appendChild(clear);

      row.addEventListener("click", () => { cursor = i; render(); });
      body.appendChild(row);
    }
  }

  function paintStars(container, upto) {
    const kids = container.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("qc-on", upto !== null && i < upto);
    }
  }

  function renderHeader() {
    const rated   = criteria.filter((c) => c.value !== null).length;
    const missing = criteria.length - rated;
    const base    = `${criteria.length} criteria · ${rated} rated`;
    q("sub").innerHTML =
      (performerName ? escapeHtml(performerName) + " · " : "") + base +
      (missing > 0 ? ` <span class="qc-pill">${missing} unrated</span>` : "");
  }

  function renderFoot() {
    const foot = q("foot");
    const pv = previewScore();
    const lines = [];

    lines.push(pv === null
      ? "Nothing rated yet."
      : `Unweighted mean <b>${pv.toFixed(1)}/10</b>. Advanced Rating applies your weights on save.`);

    if (!evidence) {
      lines.push("Checking scene ratings…");
    } else if (!evidence.total) {
      lines.push("No scenes linked to this performer.");
    } else if (!evidence.rated) {
      lines.push(`Scenes: ${evidence.total}, <span class="qc-warn">none rated</span>. ` +
                 `This score rests on memory alone.`);
    } else {
      const pct = Math.round(evidence.rated / evidence.total * 100);
      let l = `Scenes: ${evidence.rated}/${evidence.total} rated (${pct}%) · average <b>${evidence.mean.toFixed(1)}/10</b>`;
      if (evidence.rated < 3) l += ` <span class="qc-warn">— thin evidence</span>`;
      lines.push(l);
      if (pv !== null && Math.abs(pv - evidence.mean) >= DIVERGE_LIMIT) {
        const dir = pv > evidence.mean ? "higher" : "lower";
        lines.push(`<span class="qc-warn">You rate them ${Math.abs(pv - evidence.mean).toFixed(1)} points ${dir} than their scenes score.</span>`);
      }
    }
    foot.innerHTML = lines.join("<br>");
  }

  function render() { buildRowModel(); renderBody(); renderHeader(); renderFoot(); }

  // ── Open / close ───────────────────────────────────────────────────────────
  async function openPanel() {
    const id = currentPerformerId();
    if (!id) return;
    const seq = ++loadSeq;

    performerId   = id;
    performerName = "";
    criteria = []; rows = []; otherTagIds = []; evidence = null; cursor = 0;

    if (!panel) panel = buildPanel();
    q("sub").textContent = "Loading…";
    status("");
    render();
    panel.classList.add("qc-open");
    backdrop.classList.add("qc-open");
    open = true;

    try {
      // Config first: discoverCriteria() searches by parentTagName, so a
      // custom name must be known before the search runs, not after.
      const allCfg = await loadAllPluginConfig();
      if (seq !== loadSeq || !open) return;
      const own = allCfg?.[PLUGIN_ID];
      if (own?.parentTagName) parentTagName = String(own.parentTagName).trim() || DEFAULT_PARENT;
      hiddenNames = String(own?.hiddenCriteria || "")
        .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

      const [discovered, perf] = await Promise.all([discoverCriteria(), loadPerformer(id)]);
      if (seq !== loadSeq || !open) return;

      performerName = perf?.name || "";

      const current  = {};
      const levelTag = {};   // criterion name -> tag id currently on the performer
      for (const t of perf?.tags || []) {
        const lm = LEVEL_RE.exec(t.name);
        if (lm) { current[lm[1].trim()] = parseInt(lm[2], 10); levelTag[lm[1].trim()] = t.id; }
        else otherTagIds.push(t.id);
      }

      // Grouping and order are a presentation nicety. If the config cannot be
      // read the list still works, just flat and in tag order.
      const meta = parseAdvancedConfig(allCfg, discovered.map((c) => c.name));
      const byName = {};
      (meta || []).forEach((m) => { byName[m.name.toLowerCase()] = m; });

      criteria = discovered
        // Disabled criteria keep their tags on disk, so tag discovery alone
        // still finds them. Drop them when the config tells us which are live,
        // and fall back to the manual hidden list when it does not.
        .filter((c) => {
          const key = c.name.toLowerCase();
          if (hiddenNames.includes(key)) return false;
          if (meta && !byName[key]) return false;
          return true;
        })
        .map((c) => {
          const m = byName[c.name.toLowerCase()];
          const v = current[c.name] !== undefined ? current[c.name] : null;
          return { ...c, saved: v, value: v, group: m?.group ?? null,
                   order: m?.order ?? 9999, desc: m?.desc ?? null };
        });
      if (meta) criteria.sort((a, b) => a.order - b.order);

      // Level tags for criteria we are NOT showing (hidden, disabled upstream,
      // or renamed) must ride through the save untouched. Without this a save
      // silently stripped them. Rule 5 in MAINTENANCE.md.
      const active = new Set(criteria.map((c) => c.name));
      for (const [name, tagId] of Object.entries(levelTag)) {
        if (!active.has(name)) otherTagIds.push(tagId);
      }
      log(meta
        ? `Grouping from config, ${criteria.length} of ${discovered.length} criteria active`
        : `Flat list, config unreadable, ${hiddenNames.length} hidden manually`);

      render();
    } catch (e) {
      log(e.message, "error");
      status("Load failed");
    }

    try {
      const ev = await loadEvidence(id);
      if (seq !== loadSeq || !open) return;
      evidence = ev;
      renderFoot();
    } catch (e) {
      log(`Evidence load failed: ${e.message}`, "error");
      evidence = { total: 0, rated: 0, mean: null };
      renderFoot();
    }
  }

  function closePanel() {
    if (!open) return;
    open = false;
    loadSeq++;
    if (panel)    panel.classList.remove("qc-open");
    if (backdrop) backdrop.classList.remove("qc-open");
  }

  async function commit() {
    if (busy) return;                       // second Enter during a save: ignore
    if (!criteria.length) { closePanel(); return; }
    if (!criteria.some((c) => c.value !== c.saved)) { closePanel(); return; }

    busy = true;
    q("save").disabled = true;
    status("Saving…");
    try {
      await savePerformer();
      criteria.forEach((c) => { c.saved = c.value; });
      syncStashCache();
      status("Saved");
      render();
      setTimeout(closePanel, 450);
    } catch (e) {
      log(e.message, "error");
      status("Save failed");
    } finally {
      busy = false;
      if (panel) q("save").disabled = false;
    }
  }

  function syncStashCache() {
    try {
      const svc    = window.PluginApi?.utils?.StashService;
      const client = typeof svc?.getClient === "function" ? svc.getClient() : null;
      if (!client) return;
      const cacheId = client.cache.identify({ __typename: "Performer", id: String(performerId) });
      if (cacheId) client.cache.evict({ id: cacheId });
      client.cache.gc();
      client.refetchQueries({ include: ["FindPerformer", "FindPerformers"] });
    } catch (e) {
      log(`Cache sync failed: ${e.message}`);
    }
  }

  // ── Keys ───────────────────────────────────────────────────────────────────
  function onKeyDown(ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (typingInAField(document.activeElement)) return;

    if (!open) {
      if ((ev.key === "r" || ev.key === "R") && currentPerformerId()) {
        ev.preventDefault(); ev.stopPropagation();
        openPanel();
      }
      return;
    }

    const k = ev.key;
    const stop = () => { ev.preventDefault(); ev.stopPropagation(); };

    if (k === "Escape")                          { stop(); closePanel(); return; }
    if (k === "Enter" || k === "r" || k === "R") { stop(); commit();     return; }
    if (!criteria.length) return;

    if (k === "ArrowDown") { stop(); cursor = Math.min(criteria.length - 1, cursor + 1); render(); return; }
    if (k === "ArrowUp")   { stop(); cursor = Math.max(0, cursor - 1); render(); return; }

    if (k === "Backspace" || k === "Delete") {
      stop(); criteria[cursor].value = null; render(); return;
    }

    if (/^[0-5]$/.test(k)) {
      stop();
      criteria[cursor].value = parseInt(k, 10);
      if (cursor < criteria.length - 1) cursor++;
      render();
      return;
    }
  }

  document.addEventListener("keydown", onKeyDown, true);

  setInterval(() => {
    if (open && currentPerformerId() !== performerId) closePanel();
  }, 400);

  log("QuickCriteria ready. Press R on a performer page.");
})();
