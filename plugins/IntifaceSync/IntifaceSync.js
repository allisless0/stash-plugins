/**
 * IntifaceSync – Stash UI Plugin
 * Supports: Intiface Central + The Handy WiFi (HSSP)
 */

(function () {
  "use strict";
  if (window.__IntifaceSyncLoaded) return;
  window.__IntifaceSyncLoaded = true;

  const BACKEND_HOST    = window.location.hostname;
  const BACKEND_URL     = `ws://${BACKEND_HOST}:7880`;
  const PLUGIN_ID       = "IntifaceSync";
  const MIN_STROKE_GAP  = 5;
  const LS_KEY          = "IntifaceSync.settings";

  // ── State ──────────────────────────────────────────────────────────────────
  let ws                    = null;
  let wsReady               = false;
  let currentScenePath      = null;
  let funscripts            = [];
  let selectedFunscript     = null;
  let funscriptLoaded       = false;
  let pendingPlay           = null;
  let statusData            = { connected: false, playing: false, devices: [], mode: "intiface" };
  let offsetMs              = 0;
  let strokeMin             = 0;
  let strokeMax             = 100;
  let mode                  = "intiface";   // "intiface" | "handy_wifi"
  let handyKey              = "";
  let videoEl               = null;
  let toolbarInjected       = false;
  let reconnectTimer        = null;
  let reconnectDelay        = 3000;
  let intifaceReady         = false;
  let connectingToIntiface  = false;
  let pendingFindFunscripts = null;
  let statusPollInterval    = null;
  let backendEverConnected  = false;
  let backendStartInFlight  = false;
  let backendStartCooldown  = 0;
  let pendingIntifaceConnect = false;   // Connect was pressed before the backend was up
  let toolbarEl              = null;   // set early in buildToolbar, before mounting
  let autoStartCount         = 0;     // auto-start attempts this page session
  let backendStartGaveUp     = false; // stop nagging Stash once the cap is hit

  // The cooldown lives in localStorage so several open tabs share one budget
  // instead of each queueing its own Start Backend task.
  const START_LS_KEY   = "intifaceSyncLastBackendStart";
  const START_COOLDOWN = 60000;       // ms between task submissions, any tab
  const MAX_AUTO_STARTS = 3;          // then stop and tell the user

  function lastStartAt() {
    try { return parseInt(localStorage.getItem(START_LS_KEY) || "0", 10) || 0; }
    catch { return 0; }
  }
  function noteStartAt(t) {
    try { localStorage.setItem(START_LS_KEY, String(t)); } catch (_) {}
  }

  // ── Single-owner tab lock ──────────────────────────────────────────────────
  // The backend is one global player. Only ONE tab may talk to it, otherwise
  // tabs overwrite each other's script, and closing one tab stops the other.
  // Ownership lives in localStorage with a heartbeat; a BroadcastChannel gives
  // instant handoff when the owner closes so nobody waits for the TTL.
  const TAB_ID       = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const OWNER_KEY    = "IntifaceSync.owner";
  const OWNER_TTL    = 90000;   // long: background tabs get throttled to ~1 timer/min
  const OWNER_BEAT   = 1500;
  let   isOwner      = false;
  let   initDone     = false;
  let   ownerChannel = null;
  try { ownerChannel = new BroadcastChannel("IntifaceSync.owner"); } catch (_) {}

  function readOwner() {
    try { return JSON.parse(localStorage.getItem(OWNER_KEY) || "null"); } catch (_) { return null; }
  }
  function videoIsPlaying() {
    return !!(videoEl && !videoEl.paused && !videoEl.ended);
  }
  function writeOwner() {
    try {
      localStorage.setItem(OWNER_KEY, JSON.stringify({
        id: TAB_ID, ts: Date.now(), playing: videoIsPlaying(),
      }));
    } catch (_) {}
  }
  function releaseOwner() {
    const o = readOwner();
    if (o && o.id === TAB_ID) {
      try { localStorage.removeItem(OWNER_KEY); } catch (_) {}
    }
    if (isOwner && ownerChannel) {
      try { ownerChannel.postMessage({ type: "released", id: TAB_ID }); } catch (_) {}
    }
    isOwner = false;
  }
  function claimOwner(force = false) {
    const o   = readOwner();
    const now = Date.now();
    const free = !o || o.id === TAB_ID || (now - o.ts) > OWNER_TTL;
    if (free || force) {
      writeOwner();
      if (force && ownerChannel) {
        try { ownerChannel.postMessage({ type: "takeover", id: TAB_ID }); } catch (_) {}
      }
      return true;
    }
    return false;
  }
  function refreshOwnership() {
    if (!initDone) return;
    const was = isOwner;
    isOwner = claimOwner();
    if (was && !isOwner) {
      log("Lost tab ownership to another tab", "warn");
      if (ws) { try { ws.close(); } catch (_) {} }
      ws = null; wsReady = false; intifaceReady = false;
      clearTimeout(reconnectTimer);
      updateToolbarStatus();
    } else if (!was && isOwner) {
      log("This tab now owns the device");
      becomeOwner();
    }
  }

  // Fresh ownership means the backend still holds the OTHER tab's script and
  // play state. Re-ask for this scene's funscript and resume if we are playing.
  function becomeOwner() {
    intifaceReady   = false;
    funscriptLoaded = false;
    if (currentScenePath) pendingFindFunscripts = { videoPath: currentScenePath };
    if (videoIsPlaying())  pendingPlay = { time: videoEl.currentTime * 1000, rate: videoEl.playbackRate };
    writeOwner();
    connectBackend();
  }

  // Ownership follows the tab the user is actually using. A spectator takes
  // over when it becomes visible or is interacted with, unless the current
  // owner is mid-playback; pressing play here always wins because that is the
  // most recent thing the user did.
  function tryTakeover(reason) {
    if (isOwner || !initDone) return;
    const o = readOwner();
    const ownerAlive = o && o.id !== TAB_ID && (Date.now() - o.ts) <= OWNER_TTL;
    if (ownerAlive && o.playing && reason !== "play") return;
    log(`Taking over the device (${reason})`, "debug");
    claimOwner(true);
    refreshOwnership();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryTakeover("visible");
  });
  window.addEventListener("focus", () => tryTakeover("focus"));
  if (ownerChannel) {
    ownerChannel.addEventListener("message", (ev) => {
      const m = ev.data || {};
      if (m.id === TAB_ID) return;
      if (m.type === "released") {
        // previous owner left: try to take over right away
        setTimeout(refreshOwnership, 50);
      } else if (m.type === "takeover") {
        // another tab took the device with the button, back off immediately
        if (isOwner) refreshOwnership();
      }
    });
  }
  setInterval(refreshOwnership, OWNER_BEAT);
  window.addEventListener("pagehide", () => {
    if (previewOn) { previewOn = false; previewSamples = []; }
    releaseOwner();
  });

  function byId(id) {
    return document.getElementById(id) ||
           (toolbarEl ? toolbarEl.querySelector(`#${CSS.escape(id)}`) : null);
  }
  let eventInfoTimer = null;
  let eventInfoActive = false;
  let invert                = false;     // kept for Handy script reload only
  let outputOn              = true;      // global kill switch, hotkey E
  let manualOn              = false;
  let manualLevel           = 100;       // percent, master intensity for everything
  let manualShape           = "constant";
  let manualPeriod          = 4.0;       // seconds per cycle for shaped modes
  let manualOnMs            = 400;       // burst length for Pulse / Tease
  let manualDepth           = 15;        // % floor for Wave / Ramp
  let manualBuild           = 0;         // Tease: cycles spent escalating, 0 = off
  let manualCeiling         = 100;       // % of motor output the slider maxes at
  let manualMicroMs         = 120;       // micro on-pulse length
  let scalarStep            = 0.05;      // device floor, refreshed from status
  let handyEnabled          = false;     // Handy UI hidden unless enabled in settings
  let advancedOpen          = false;
  let hotkeysOn             = true;    // toolbar toggle, per-browser
  let hotkeysAllowed        = true;    // plugin setting; false disables them outright
  let vibeMode              = "speed";   // "speed" | "position" | "beat" | "auto" | "off"
  let beatMs                = 120;       // beat mode burst length
  let beatEdge              = "all";     // "all" | "low" | "high"
  let beatProminence        = 20;        // peak picking swing threshold for dense scripts
  let previewOn             = false;     // debug scope, never persisted
  const PREVIEW_WINDOW_MS   = 8000;      // seconds of history shown
  let previewSamples        = [];        // {t, tg, lv, m, s}
  let previewCanvas         = null;
  let previewRaf            = null;
  let previewSentCount      = 0;         // rolling count for the cmd/s readout
  let previewScript         = null;      // {t0, t1, pts:[[mediaMs,pos]], beats:[mediaMs]}
  let vibeMaxSpeed          = 500;       // funscript units/sec = full intensity
  let vibeSmooth            = 0.30;
  let vibeSubstep           = false;    // pulse below the hardware floor

  function log(msg, level = "info") {
    const prefix = "[IntifaceSync]";
    const debugOn = localStorage.getItem("intifaceSyncDebug") === "1";

    if (level === "error")      console.error(prefix, msg);
    else if (level === "debug") { if (debugOn) console.log(prefix, msg); }
    else                        console.log(prefix, msg);
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function loadSettingsFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.offsetMs   === "number")  offsetMs  = s.offsetMs;
      if (typeof s.strokeMin  === "number")  strokeMin = s.strokeMin;
      if (typeof s.strokeMax  === "number")  strokeMax = s.strokeMax;
      if (typeof s.invert     === "boolean") invert    = s.invert;
      if (typeof s.mode       === "string")  mode      = s.mode;
      if (typeof s.handyKey   === "string")  handyKey  = s.handyKey;
      if (typeof s.vibeMode     === "string") vibeMode     = s.vibeMode;
      if (typeof s.vibeMaxSpeed === "number") vibeMaxSpeed = s.vibeMaxSpeed;
      if (typeof s.vibeSmooth   === "number") vibeSmooth   = s.vibeSmooth;
      if (typeof s.vibeSubstep  === "boolean") vibeSubstep = s.vibeSubstep;
      if (typeof s.beatMs       === "number") beatMs       = s.beatMs;
      if (typeof s.beatEdge     === "string") beatEdge     = s.beatEdge;
      if (typeof s.beatProminence === "number") beatProminence = s.beatProminence;
      if (typeof s.manualLevel  === "number") manualLevel  = s.manualLevel;
      if (typeof s.manualShape  === "string") manualShape  = s.manualShape;
      if (typeof s.outputOn     === "boolean") outputOn    = s.outputOn;
      else if (typeof s.manualLevel === "number") {
        // Settings written before the slider became a master gain.
        manualLevel = 100;
        log("Migrated old manual level to master intensity 100%");
      }
      if (typeof s.manualPeriod  === "number") manualPeriod  = s.manualPeriod;
      if (typeof s.manualOnMs    === "number") manualOnMs    = s.manualOnMs;
      if (typeof s.manualDepth   === "number") manualDepth   = s.manualDepth;
      if (typeof s.manualBuild   === "number") manualBuild   = s.manualBuild;
      if (typeof s.manualCeiling === "number") manualCeiling = s.manualCeiling;
      if (typeof s.manualMicroMs === "number") manualMicroMs = s.manualMicroMs;
      if (typeof s.hotkeysOn    === "boolean") hotkeysOn   = s.hotkeysOn;
    } catch (e) {
      log(`Failed to load settings: ${e}`, "error");
    }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        offsetMs, strokeMin, strokeMax, invert, mode, handyKey,
        vibeMode, vibeMaxSpeed, vibeSmooth, vibeSubstep, beatMs, beatEdge, beatProminence,
        manualLevel, manualShape, manualPeriod,
        manualOnMs, manualDepth, manualBuild, manualCeiling, manualMicroMs,
        outputOn, hotkeysOn,
      }));
    } catch (e) {
      log(`Failed to save settings: ${e}`, "error");
    }
  }

  function sendSettings() {
    saveSettingsToStorage();
    sendMsg({
      type:      "settings",
      offsetMs:  offsetMs,
      strokeMin: strokeMin / 100,
      strokeMax: strokeMax / 100,
      invert:    invert,
      vibeMode:     vibeMode,
      vibeMaxSpeed: vibeMaxSpeed,
      vibeSmooth:   vibeSmooth,
      vibeSubstep:  vibeSubstep,
      beatMs:       beatMs,
      beatEdge:     beatEdge,
      beatProminence: beatProminence,
    });
  }

  // ── Global output toggle ───────────────────────────────────────────────────
  function sendOutput() {
    sendMsg({ type: "output", enabled: outputOn });
  }

  function setOutput(on) {
    outputOn = !!on;
    saveSettingsToStorage();
    updateOutputUI();
    sendOutput();
    log(`Output: ${outputOn ? "enabled" : "disabled"}`);
  }

  function updateOutputUI() {
    const btn = byId(`${PLUGIN_ID}-output-btn`);
    if (btn) {
      btn.textContent = outputOn ? "\u23FB  Device live" : "\u23FB  Device muted";
      btn.classList.toggle("is-live", outputOn);
      btn.classList.toggle("is-muted", !outputOn);
      btn.title = outputOn
        ? "The toy can be driven. Click to cut all output at once."
        : "Nothing reaches the toy, script or manual. Click to allow output again.";
    }
    const bar = byId(`${PLUGIN_ID}-toolbar`);
    if (bar) bar.classList.toggle("is-muted", !outputOn);
  }

  // ── Manual control ─────────────────────────────────────────────────────────
  let manualThrottle = 0;
  function throttledManual() {
    const now = Date.now();
    if (now - manualThrottle < 80) return;
    manualThrottle = now;
    sendManual();
  }

  function sendManual() {
    saveSettingsToStorage();
    sendMsg({
      type:    "manual",
      enabled: manualOn,
      level:   manualLevel / 100,
      shape:   manualShape,
      period:  manualPeriod,
      onMs:    manualOnMs,
      depth:   manualDepth / 100,
      build:   manualBuild,
      ceiling: manualCeiling / 100,
      microMs: manualMicroMs,
    });
  }

  function setManual(on, level) {
    if (typeof level === "number") manualLevel = Math.max(0, Math.min(100, Math.round(level)));
    if (typeof on === "boolean")   manualOn    = on;
    updateManualUI();
    sendManual();
    log(`Manual: ${manualOn ? "on" : "off"} @ ${manualLevel}%`, "debug");
  }

  function nudgeManual(delta) {
    // nudging while off turns it on, so one key does the obvious thing
    setManual(true, manualLevel + delta);
  }

  function updateHotkeyBtn() {
    const btn = byId(`${PLUGIN_ID}-hotkey-btn`);
    if (!btn) return;
    if (!hotkeysAllowed) {
      btn.textContent = "Shortcuts off";
      btn.title = "Disabled in Settings \u203a Plugins \u203a IntifaceSync. " +
                  "Every control is still available here in the toolbar.";
      btn.classList.remove("is-on");
      btn.classList.add("is-locked");
      return;
    }
    btn.classList.remove("is-locked");
    btn.textContent = hotkeysOn ? "Shortcuts on" : "Shortcuts off";
    btn.title = "E output \u00b7 \\ manual \u00b7 [ ] level \u00b7 0 stop";
    btn.classList.toggle("is-on", hotkeysOn);
  }

  function updateManualHint() {
    // The single most useful number is whether the peak lands above or below
    // the motor's own floor, because that decides whether Micro does anything.
    const hint = byId(`${PLUGIN_ID}-manual-hint`);
    if (!hint) return;
    const peak     = (manualLevel / 100) * (manualCeiling / 100);
    const pct      = (peak * 100).toFixed(1);
    const floorPct = (scalarStep * 100).toFixed(0);
    if (peak <= 0) {
      hint.textContent = "Silent. Raise the intensity slider.";
    } else if (peak < scalarStep) {
      hint.textContent = vibeSubstep
        ? `Peak ${pct}%, below this motor's ${floorPct}% floor. Micro pulsing is producing it.`
        : `Peak ${pct}%, below this motor's ${floorPct}% floor. Turn Micro on or it will stay silent.`;
    } else {
      hint.textContent = `Peak ${pct}%. This motor's floor is ${floorPct}%, so Micro is idle.`;
    }
  }

  function updateManualUI() {
    const btn = byId(`${PLUGIN_ID}-manual-btn`);
    if (btn) {
      btn.textContent = manualOn ? "Manual on" : "Manual";
      btn.classList.toggle("is-on", manualOn);
    }

    const sld = byId(`${PLUGIN_ID}-manual-level`);
    if (sld && String(manualLevel) !== sld.value) sld.value = String(manualLevel);
    const lbl = byId(`${PLUGIN_ID}-manual-val`);
    if (lbl) lbl.textContent = `${manualLevel}%`;

    const patBtn = byId(`${PLUGIN_ID}-pattern-btn`);
    if (patBtn) patBtn.textContent = `${shapeLabel(manualShape)} \u25BE`;

    // Highlight the chosen card.
    if (manualPop) {
      manualPop.querySelectorAll(`.${PLUGIN_ID}-card`).forEach((c) => {
        c.classList.toggle("is-sel", c.dataset.shape === manualShape);
      });
    }

    // Only show the fields the current pattern actually reads. Anything else
    // is noise the user would reasonably expect to do something.
    const burst = manualShape === "pulse" || manualShape === "tease";
    const shown = {
      period:  manualShape !== "constant",
      onms:    burst,
      depth:   manualShape === "wave" || manualShape === "ramp" || manualShape === "random",
      build:   manualShape === "tease",
      ceiling: true,
      microms: vibeSubstep,
    };
    Object.keys(shown).forEach((k) => {
      const box = byId(`${PLUGIN_ID}-manual-${k}-box`);
      if (box) box.style.display = shown[k] ? "" : "none";
    });

    // Burst patterns are "one buzz every N seconds"; the rest are a cycle
    // length. Same field, different meaning, so relabel rather than explain.
    const perBox = byId(`${PLUGIN_ID}-manual-period-box`);
    if (perBox) {
      const lab  = perBox.querySelector("label");
      const help = perBox.querySelector(`.${PLUGIN_ID}-field-help`);
      if (lab)  lab.textContent  = burst ? "Repeat every" : "Cycle length";
      if (help) help.textContent = burst
        ? "Time from the start of one buzz to the start of the next."
        : "How long one full rise and fall takes.";
    }

    // The timing section can end up with nothing in it (Steady).
    const timing = byId(`${PLUGIN_ID}-sec-timing`);
    if (timing) {
      const any = ["period", "onms", "depth", "build"].some(
        (k) => shown[k]
      );
      timing.style.display = any ? "" : "none";
    }

    const sync = (id, v) => {
      const el = byId(`${PLUGIN_ID}-manual-${id}`);
      if (el && String(v) !== el.value) el.value = String(v);
    };
    sync("period",  manualPeriod);
    sync("onms",    manualOnMs);
    sync("depth",   manualDepth);
    sync("build",   manualBuild);
    sync("ceiling", manualCeiling);
    sync("microms", manualMicroMs);

    updateManualHint();
  }

  // ── GraphQL ────────────────────────────────────────────────────────────────
  async function gqlQuery(query, variables = {}) {
    const resp = await fetch("/graphql", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ query, variables }),
    });
    const data = await resp.json();
    return data?.data ?? null;
  }

  async function getSceneDetails(sceneId) {
    const q = `
      query ($id: ID!) {
        findScene(id: $id) {
          id
          files { path }
        }
      }`;
    const data = await gqlQuery(q, { id: sceneId });
    return data?.findScene ?? null;
  }

  async function loadPluginConfig() {
    const q = `query { configuration { plugins } }`;
    const data = await gqlQuery(q);
    const plugins = data?.configuration?.plugins ?? {};
    return plugins[PLUGIN_ID] ?? {};
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function sendMsg(obj) {
    if (!isOwner) return;
    if (ws && wsReady) {
      try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }
  }

  // Tab close: best-effort hard stop. The socket may already be torn down, so
  // this is NOT what keeps you safe; the backend deadman (15 s without a
  // heartbeat) is. pagehide fires more reliably than beforeunload, incl. mobile.
  window.addEventListener("pagehide", () => {
    // isOwner may already be false here (releaseOwner runs first); ws only
    // exists in the owning tab, so that is the real test.
    if (ws && wsReady) {
      try { ws.send(JSON.stringify({ type: "stop" })); } catch (_) {}
      try { ws.close(); } catch (_) {}
    }
  });

  function autoConnectIntiface() {
    if (mode !== "intiface" || intifaceReady || connectingToIntiface) return;
    connectingToIntiface = true;
    loadPluginConfig().then((cfg) => {
      if (typeof cfg?.enableHandy === "boolean" && cfg.enableHandy !== handyEnabled) {
        handyEnabled = cfg.enableHandy;
        applyHandyVisibility();
      }
      if (typeof cfg?.disableHotkeys === "boolean") {
        hotkeysAllowed = !cfg.disableHotkeys;
        updateHotkeyBtn();
      }
      const url = cfg?.intifaceUrl || "ws://localhost:12345";
      log(`Auto-connecting to Intiface: ${url}`);
      sendMsg({ type: "connect", url });
      if (currentScenePath) pendingFindFunscripts = { videoPath: currentScenePath };
    }).catch(() => { connectingToIntiface = false; });
  }

  // Connect button: make the backend exist first, then talk to Intiface.
  // The backend is a Stash plugin task, so if the socket is down we run the task
  // ourselves rather than making the user go to Settings and start it by hand.
  function requestIntifaceConnect() {
    intifaceReady        = false;
    connectingToIntiface = false;

    if (wsReady) {
      autoConnectIntiface();
      return;
    }

    // Explicit press, so ignore the cooldown that throttles the automatic path.
    pendingIntifaceConnect = true;
    backendStartCooldown   = 0;
    autoStartCount         = 0;
    backendStartGaveUp     = false;
    updateToolbarInfo("Starting backend...");
    log("Connect pressed with backend down, starting it");
    startBackendTask(true).then(() => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectBackend, 1500);
    });
  }

  // Ask Stash to run the plugin's own "Start Backend" task.
  //
  // Guarded three ways, because a failing backend used to mean one queued task
  // every 20s forever, multiplied by every open tab:
  //   - at most MAX_AUTO_STARTS automatic attempts per page session
  //   - at most one submission per START_COOLDOWN, shared across tabs
  //   - pressing Connect resets the counter, since that is explicit intent
  async function startBackendTask(manual = false) {
    if (backendStartInFlight) return;
    if (!manual && backendStartGaveUp) return;
    if (!manual && autoStartCount >= MAX_AUTO_STARTS) {
      backendStartGaveUp = true;
      log(`Gave up after ${MAX_AUTO_STARTS} attempts; start the backend manually`, "error");
      updateToolbarInfo("Backend will not start - run Start Backend in Settings");
      return;
    }

    const now = Date.now();
    if (!manual && now - lastStartAt() < START_COOLDOWN) {
      log("Start Backend suppressed, another attempt was too recent", "debug");
      return;
    }

    backendStartInFlight = true;
    noteStartAt(now);
    backendStartCooldown = now + START_COOLDOWN;
    if (!manual) autoStartCount++;
    updateToolbarInfo("Starting backend...");
    log(`Running 'Start Backend' task (attempt ${autoStartCount}/${MAX_AUTO_STARTS}${manual ? ", manual" : ""})`);

    const m = `
      mutation ($plugin_id: ID!, $task_name: String!) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name)
      }`;
    try {
      await gqlQuery(m, { plugin_id: PLUGIN_ID, task_name: "Start Backend" });
      log("Start Backend task submitted");
    } catch (e) {
      log(`Could not run Start Backend task: ${e}`, "error");
    } finally {
      backendStartInFlight = false;
    }
  }

  // The Handy path is off unless the plugin setting turns it on. When hidden the
  // mode switch and the key panel go away and Intiface is forced.
  function applyHandyVisibility() {
    const wrap  = byId(`${PLUGIN_ID}-mode-wrap`);
    const panel = byId(`${PLUGIN_ID}-handy-panel`);
    if (wrap)  wrap.style.display  = handyEnabled ? "inline-flex" : "none";
    if (panel && !handyEnabled) panel.style.display = "none";
    if (!handyEnabled && mode !== "intiface") {
      mode = "intiface";
      saveSettingsToStorage();
      sendMsg({ type: "setMode", mode: "intiface" });
      log("Handy disabled in plugin settings, forcing Intiface mode");
    }
  }

  loadPluginConfig().then((cfg) => {
    if (typeof cfg?.enableHandy === "boolean") handyEnabled = cfg.enableHandy;
    if (typeof cfg?.disableHotkeys === "boolean") {
      hotkeysAllowed = !cfg.disableHotkeys;
      if (!hotkeysAllowed) log("Keyboard shortcuts disabled in plugin settings");
      updateHotkeyBtn();
    }
    applyHandyVisibility();
  }).catch(() => {});

  function connectBackend() {
    if (!isOwner) { updateToolbarStatus(); return; }   // spectator tab
    if (ws) { try { ws.close(); } catch (_) {} }
    ws = new WebSocket(BACKEND_URL);

    ws.addEventListener("open", () => {
      wsReady             = true;
      backendEverConnected = true;
      backendStartCooldown = 0;
      autoStartCount       = 0;
      backendStartGaveUp   = false;
      reconnectDelay       = 3000;
      clearTimeout(reconnectTimer);
      log(`Connected to backend (${BACKEND_URL})`);

      sendMsg({ type: "setMode", mode });
      sendSettings();
      sendOutput();
      if (pendingIntifaceConnect) {
        pendingIntifaceConnect = false;
        log("Backend up, resuming the requested Intiface connection");
      }
      autoConnectIntiface();

      if (pendingFindFunscripts !== null) {
        sendMsg({ type: "findFunscripts", videoPath: pendingFindFunscripts.videoPath });
        pendingFindFunscripts = null;
      }

      // Heartbeat feeds the backend deadman. While the video plays it also
      // carries currentTime, so the backend can correct clock drift instead of
      // free-running from the last play/seek.
      statusPollInterval = setInterval(() => {
        if (!wsReady) return;
        if (!intifaceReady) { sendMsg({ type: "status" }); return; }
        if (videoEl && !videoEl.paused && !videoEl.ended) {
          sendMsg({ type: "sync", time: videoEl.currentTime * 1000, rate: videoEl.playbackRate });
        } else {
          sendMsg({ type: "ping" });
        }
      }, 2000);
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleBackendMessage(msg);
    });

    ws.addEventListener("close", () => {
      wsReady       = false;
      intifaceReady = false;
      clearInterval(statusPollInterval);
      updateToolbarStatus();
      if (!isOwner) return;   // lost the lock, another tab drives now

      // Never reached the backend: it is probably not running. Start it.
      if ((!backendEverConnected || pendingIntifaceConnect) && !backendStartGaveUp) {
        startBackendTask();
        reconnectTimer = setTimeout(connectBackend, 4000);
        return;
      }

      // Given up on auto-start: keep a slow socket retry so a manually started
      // backend is still picked up, but submit no further tasks.
      if (backendStartGaveUp) {
        pendingIntifaceConnect = false;
        reconnectTimer = setTimeout(connectBackend, 15000);
        return;
      }

      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        connectBackend();
      }, reconnectDelay);
    });

    ws.addEventListener("error", () => { wsReady = false; });
  }

  // ── Backend messages ───────────────────────────────────────────────────────
  function handleBackendMessage(msg) {


    if (msg.type === "info") {
      log(`Backend: ${msg.message}`, "debug");
      updateToolbarInfo(msg.message);
      return;
    }

    if (msg.type === "event") {
      log(msg.message, msg.level);
      updateToolbarInfo(msg.message);
      eventInfoActive = true;
      clearTimeout(eventInfoTimer);
      eventInfoTimer = setTimeout(() => {
        eventInfoActive = false;
        updateToolbarStatus();
      }, 4000);

      if (msg.uploaded && videoEl && !videoEl.paused && !videoEl.ended) {
        const t = videoEl.currentTime * 1000;
        sendMsg({ type: "play", time: t });
        log(`Resume device at ${t.toFixed(0)}ms after upload`, "debug");
      }
      return;
    }


    if (msg.type === "preview") {
      if (!previewOn || !Array.isArray(msg.samples)) return;
      if (msg.script) previewScript = msg.script;
      const now = msg.samples.length ? msg.samples[msg.samples.length - 1].t : 0;
      previewSamples.push(...msg.samples);
      // trim to the visible window, plus a little slack
      const cutoff = now - PREVIEW_WINDOW_MS - 500;
      if (previewSamples.length > 4000 || (previewSamples[0] && previewSamples[0].t < cutoff)) {
        previewSamples = previewSamples.filter((p) => p.t >= cutoff);
      }
      return;
    }

    if (msg.type === "status") {
      statusData = msg;
      if (typeof msg.outputEnabled === "boolean" && msg.outputEnabled !== outputOn) {
        outputOn = msg.outputEnabled;
        updateOutputUI();
      }
      if (typeof msg.manual === "boolean" && msg.manual !== manualOn) {
        manualOn = msg.manual;
        updateManualUI();
      }
      // The device tells us its real resolution, so the panel can say how far
      // under the floor the current settings actually sit.
      if (typeof msg.scalarStep === "number" && msg.scalarStep > 0 &&
          msg.scalarStep !== scalarStep) {
        scalarStep = msg.scalarStep;
        updateManualUI();
      }
      updateToolbarStatus();
      if (msg.error) log(`Backend error: ${msg.error}`, "error");

      if (mode === "intiface") {
        if (msg.connected && !intifaceReady) {
          intifaceReady        = true;
          connectingToIntiface = false;
          // a reconnect gives us a fresh player with no script, so always re-ask
          const path = pendingFindFunscripts?.videoPath ?? currentScenePath;
          pendingFindFunscripts = null;
          if (path) {
            funscriptLoaded = false;
            sendMsg({ type: "findFunscripts", videoPath: path });
          }
        }
      } else {
        if (msg.connected && !intifaceReady) {
          intifaceReady = true;
          if (pendingFindFunscripts !== null) {
            sendMsg({ type: "findFunscripts", videoPath: pendingFindFunscripts.videoPath });
            pendingFindFunscripts = null;
          }
        }
        if (msg.tunnelUrl) updateTunnelUrlDisplay(msg.tunnelUrl);
      }

      if (!msg.error && funscriptLoaded === "pending") {
        funscriptLoaded = true;
        updateFunscriptSelector();
        if (pendingPlay !== null) {
          sendMsg({ type: "play", time: pendingPlay.time, rate: pendingPlay.rate ?? 1 });
          pendingPlay = null;
        }
      }
      return;
    }

    if (msg.type === "funscripts") {
      funscripts = msg.files ?? [];
      const defaultScript = msg.default ?? null;
      log(`Funscripts received: ${funscripts.length} file(s)`);

      if (funscripts.length === 0) {
        pendingPlay = null;
        updateFunscriptSelector();
      } else {
        selectedFunscript = defaultScript || funscripts[0];
        updateFunscriptSelector();
        loadFunscript(selectedFunscript);
      }
      return;
    }
  }


  // ── Funscript ──────────────────────────────────────────────────────────────
  function loadFunscript(path) {
    log(`Loading funscript: ${path} (invert=${invert})`);
    funscriptLoaded   = "pending";
    selectedFunscript = path;
    sendMsg({ type: "loadFile", path, invert });
    updateFunscriptSelector();
  }

  // ── Stop-Helper ────────────────────────────────────────────────────────────
  function stopPlayback(reason) {
    pendingPlay = null;
    sendMsg({ type: "pause" });
  }

  // ── Video events ───────────────────────────────────────────────────────────
  function attachVideoEvents(video) {
    if (videoEl === video) return;
    videoEl = video;

    video.addEventListener("play", () => {
      const t = video.currentTime * 1000;
      log(`Video play @ ${t.toFixed(0)}ms`, "debug");
      if (!isOwner) { tryTakeover("play"); return; }   // becomeOwner() queues the play
      writeOwner();
      if (!funscriptLoaded) pendingPlay = { time: t, rate: video.playbackRate };
      else                  sendMsg({ type: "play", time: t, rate: video.playbackRate });
    });

    // Buffering stalls the video but the backend keeps counting. Treat a stall
    // as a pause and resume from the real position when playback resumes.
    video.addEventListener("waiting", () => {
      log("Video stalled (buffering)", "debug");
      sendMsg({ type: "pause" });
    });
    video.addEventListener("playing", () => {
      if (!videoEl) return;
      sendMsg({ type: "play", time: videoEl.currentTime * 1000, rate: videoEl.playbackRate });
    });
    video.addEventListener("ratechange", () => {
      log(`Playback rate ${video.playbackRate}`, "debug");
      sendMsg({ type: "sync", time: video.currentTime * 1000, rate: video.playbackRate });
    });

    video.addEventListener("pause", () => {
      log("Video pause", "debug");
      pendingPlay = null;
      if (isOwner) writeOwner();          // let other tabs see we are idle right away
      sendMsg({ type: "pause" });
    });

    video.addEventListener("seeked", () => {
      const t = video.currentTime * 1000;
      log(`Video seek @ ${t.toFixed(0)}ms`, "debug");
      sendMsg({ type: "seek", time: t });
      if (!video.paused) {
        if (!funscriptLoaded) pendingPlay = { time: t, rate: video.playbackRate };
        else                  sendMsg({ type: "play", time: t, rate: video.playbackRate });
      }
    });

    video.addEventListener("ended", () => {
      log("Video ended", "debug");
      pendingPlay = null;
      sendMsg({ type: "pause" });
    });

    video.addEventListener("emptied", () => {
      log("Video emptied", "debug");
      pendingPlay = null;
      sendMsg({ type: "pause" });
    });
  }


  // ── Page-Lifecycle ─────────────────────────────────────────────────────────
  // Tab close is handled once, in the pagehide handler next to sendMsg.
  // No stop on visibilitychange: switching tabs must not kill playback.

  // ── Identify a change in the SPA route ─────────────────────────────────────────────
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (!/^\/scenes\/\d+/.test(lastPath)) {
        stopPlayback("route-change");
        videoEl = null;
        funscriptLoaded = false;
      }
    }
  }, 500);


  // ── Styles ──────────────────────────────────────────────────────────────────
function injectStyles() {
  if (byId(`${PLUGIN_ID}-style`)) return;
  const st = document.createElement("style");
  st.id = `${PLUGIN_ID}-style`;
  st.textContent = `
    /* ── Toolbar Container ──────────────────────────────────── */
    #${PLUGIN_ID}-toolbar {
      background: linear-gradient(180deg, rgba(20,22,28,0.92), rgba(14,16,20,0.95)) !important;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255,255,255,0.08) !important;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.4);
      color: #e8eaed !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
      font-size: 12px !important;
      padding: 8px 14px !important;
      gap: 12px !important;
    }
    #${PLUGIN_ID}-toolbar span,
    #${PLUGIN_ID}-toolbar label {
      color: #c4c8cf;
      font-weight: 500;
      letter-spacing: 0.2px;
    }

    /* ── Buttons ────────────────────────────────────────────── */
    #${PLUGIN_ID}-toolbar button {
      background: rgba(255,255,255,0.06);
      color: #e8eaed;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    #${PLUGIN_ID}-toolbar button:hover {
      background: rgba(90,169,255,0.15);
      border-color: rgba(90,169,255,0.4);
      color: #fff;
    }
    #${PLUGIN_ID}-toolbar button:active {
      transform: translateY(1px);
    }

    /* ── Number / Text Inputs ──────────────────────────────── */
    #${PLUGIN_ID}-toolbar input[type=number],
    #${PLUGIN_ID}-toolbar input[type=text] {
      background: rgba(0,0,0,0.35);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 11px;
      font-family: inherit;
      text-align: center;
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }
    #${PLUGIN_ID}-toolbar input[type=number]:focus,
    #${PLUGIN_ID}-toolbar input[type=text]:focus {
      border-color: #5aa9ff;
      box-shadow: 0 0 0 2px rgba(90,169,255,0.2);
    }
    #${PLUGIN_ID}-toolbar input[type=number]::-webkit-inner-spin-button,
    #${PLUGIN_ID}-toolbar input[type=number]::-webkit-outer-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    #${PLUGIN_ID}-toolbar input[type=number] { -moz-appearance: textfield; }

    /* ── Range Sliders ─────────────────────────────────────── */
    #${PLUGIN_ID}-toolbar input[type=range] {
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      pointer-events: none;
      height: 18px;
      padding: 0;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-runnable-track {
      height: 4px; background: transparent; border-radius: 2px;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-track {
      height: 4px; background: transparent; border-radius: 2px;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px; height: 14px; border-radius: 50%;
      background: #fff;
      border: 2px solid #5aa9ff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      cursor: pointer;
      pointer-events: all;
      margin-top: -5px;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb:hover {
      transform: scale(1.15);
      box-shadow: 0 2px 10px rgba(90,169,255,0.5);
    }
    #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-thumb {
      width: 14px; height: 14px; border-radius: 50%;
      background: #fff;
      border: 2px solid #5aa9ff;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      cursor: pointer;
      pointer-events: all;
    }

    /* ── Handy Panel ───────────────────────────────────────── */
    #${PLUGIN_ID}-handy-panel {
      display: flex; align-items: center; gap: 8px;
      flex-wrap: wrap; width: 100%;
      padding: 8px 0 4px 0;
      border-top: 1px solid rgba(255,255,255,0.08);
      margin-top: 4px;
    }
    #${PLUGIN_ID}-handy-key {
      background: rgba(0,0,0,0.35);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11px;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      letter-spacing: 1.5px;
      width: 160px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #${PLUGIN_ID}-handy-key:focus {
      border-color: #5aa9ff;
      box-shadow: 0 0 0 2px rgba(90,169,255,0.2);
    }
    #${PLUGIN_ID}-tunnel-url {
      font-size: 10px;
      color: #5aa9ff;
      opacity: 0.85;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Mode Buttons (Tab-Style) ──────────────────────────── */
    .${PLUGIN_ID}-mode-btn {
      background: rgba(255,255,255,0.05);
      color: #9aa0a6;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .${PLUGIN_ID}-mode-btn:hover {
      background: rgba(255,255,255,0.08);
      color: #e8eaed;
    }
    #${PLUGIN_ID}-toolbar .${PLUGIN_ID}-mode-btn.active {
      background: rgba(90,169,255,0.18) !important;
      color: #fff !important;
      border: 1px solid rgba(90,169,255,0.6) !important;
      box-shadow: 0 0 12px rgba(90,169,255,0.25) !important;
    }

    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-stop {
      background: rgba(255,90,90,0.12) !important;
      border: 1px solid rgba(255,90,90,0.35) !important;
      color: #ff8a8a !important;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-stop:hover {
      background: rgba(255,90,90,0.22) !important;
      border-color: rgba(255,90,90,0.6) !important;
      color: #fff !important;
    }

    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-connect-btn,
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-connect-handy-btn {
      background: rgba(90,200,120,0.12) !important;
      border: 1px solid rgba(90,200,120,0.35) !important;
      color: #8ee0a3 !important;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-connect-btn:hover,
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-connect-handy-btn:hover {
      background: rgba(90,200,120,0.22) !important;
      border-color: rgba(90,200,120,0.6) !important;
      color: #fff !important;
    }

    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-reupload-btn {
      background: rgba(230,190,80,0.12) !important;
      border: 1px solid rgba(230,190,80,0.35) !important;
      color: #e6c374 !important;
    }
    #${PLUGIN_ID}-handy-panel #${PLUGIN_ID}-reupload-btn:hover {
      background: rgba(230,190,80,0.22) !important;
      border-color: rgba(230,190,80,0.6) !important;
      color: #fff !important;
    }

    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider {
      -webkit-appearance: none; appearance: none;
      height: 4px; padding: 0; margin: 0; border: 0;
      border-radius: 2px; background: #444; cursor: pointer;
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 13px; height: 13px; border-radius: 50%;
      background: #2a6; border: 2px solid #fff; cursor: pointer;
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-moz-range-thumb {
      width: 13px; height: 13px; border-radius: 50%;
      background: #2a6; border: 2px solid #fff; cursor: pointer;
    }
    #${PLUGIN_ID}-toolbar input[type=range].${PLUGIN_ID}-slider::-moz-range-track {
      height: 4px; border-radius: 2px; background: #444;
    }
    #${PLUGIN_ID}-toolbar #${PLUGIN_ID}-invert.active {
      background: rgba(90,169,255,0.18) !important;
      color: #fff !important;
      box-shadow: 0 0 12px rgba(90,169,255,0.25) !important;
    }


    /* ── Mobile ────────────────────────────────────────────── */
    @media (max-width: 768px) {
      #${PLUGIN_ID}-toolbar {
        font-size: 14px !important;
        padding: 10px !important;
        gap: 10px !important;
      }
      #${PLUGIN_ID}-toolbar input[type=range] { height: 26px !important; }
      #${PLUGIN_ID}-toolbar input[type=range]::-webkit-slider-thumb {
        width: 20px !important; height: 20px !important; margin-top: -12px !important;
      }
      #${PLUGIN_ID}-toolbar input[type=range]::-moz-range-thumb {
        width: 20px !important; height: 20px !important;
      }
      #${PLUGIN_ID}-toolbar input[type=number] {
        width: 80px !important; font-size: 13px !important; padding: 7px 8px !important;
      }
      #${PLUGIN_ID}-toolbar button,
      .${PLUGIN_ID}-mode-btn {
        padding: 7px 14px !important; font-size: 12px !important;
      }
        #${PLUGIN_ID}-toolbar select {
        font-size: 14px !important;
        padding: 6px 10px !important;
        height: 32px !important;
      }
    }

    /* ── Grouping ───────────────────────────────────────────── */
    .${PLUGIN_ID}-group {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 3px 4px 3px 10px;
      border-left: 1px solid rgba(255,255,255,0.10);
    }
    .${PLUGIN_ID}-num {
      min-width: 40px; text-align: right;
      font-variant-numeric: tabular-nums; opacity: 0.85;
    }
    #${PLUGIN_ID}-toolbar.is-muted { opacity: 0.6; }

    /* ── Stateful buttons ───────────────────────────────────── */
    #${PLUGIN_ID}-toolbar button.${PLUGIN_ID}-primary { font-weight: 600; }
    #${PLUGIN_ID}-toolbar button.is-live {
      background: rgba(60,200,130,0.14);
      border-color: rgba(60,200,130,0.45);
      color: #7de8b4;
    }
    #${PLUGIN_ID}-toolbar button.is-muted {
      background: rgba(235,80,80,0.16);
      border-color: rgba(235,80,80,0.5);
      color: #ff9a9a;
    }
    #${PLUGIN_ID}-toolbar button.is-on {
      background: rgba(90,169,255,0.18);
      border-color: rgba(90,169,255,0.5);
      color: #9ecbff;
    }
    #${PLUGIN_ID}-toolbar button.is-locked {
      opacity: 0.45; cursor: not-allowed;
    }
    #${PLUGIN_ID}-pattern-btn { min-width: 92px; }

    /* ── Pattern popover ────────────────────────────────────── */
    #${PLUGIN_ID}-pattern-pop {
      position: fixed; left: 0; top: 0; z-index: 10050;
      width: 360px; max-height: 70vh; overflow-y: auto;
      background: rgba(22,25,31,0.98);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.65);
      padding: 14px 16px 12px;
      color: #e8eaed;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      opacity: 0; pointer-events: none; transform: translateY(4px);
      transition: opacity .12s ease, transform .12s ease;
    }
    #${PLUGIN_ID}-pattern-pop.is-open {
      opacity: 1; pointer-events: auto; transform: translateY(0);
    }
    .${PLUGIN_ID}-pop-head { margin-bottom: 10px; }
    .${PLUGIN_ID}-pop-head strong { font-size: 13px; display: block; }
    .${PLUGIN_ID}-pop-sub {
      display: block; margin-top: 2px; font-size: 11px;
      color: #8e97a3; line-height: 1.4;
    }
    .${PLUGIN_ID}-cards {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    #${PLUGIN_ID}-pattern-pop .${PLUGIN_ID}-card {
      display: flex; flex-direction: column; gap: 2px;
      text-align: left; padding: 8px 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 7px; cursor: pointer; color: inherit;
      font-family: inherit; transition: all .12s ease;
    }
    #${PLUGIN_ID}-pattern-pop .${PLUGIN_ID}-card:hover {
      background: rgba(90,169,255,0.10);
      border-color: rgba(90,169,255,0.35);
    }
    #${PLUGIN_ID}-pattern-pop .${PLUGIN_ID}-card.is-sel {
      background: rgba(90,169,255,0.18);
      border-color: rgba(90,169,255,0.65);
    }
    .${PLUGIN_ID}-card-name { font-size: 12px; font-weight: 600; }
    .${PLUGIN_ID}-card-blurb {
      font-size: 10.5px; color: #8e97a3; line-height: 1.35;
    }

    .${PLUGIN_ID}-section {
      margin-top: 14px; padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .${PLUGIN_ID}-sec-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: #737d8a; margin-bottom: 8px;
    }
    .${PLUGIN_ID}-field { margin-bottom: 10px; }
    .${PLUGIN_ID}-field:last-child { margin-bottom: 0; }
    .${PLUGIN_ID}-field-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
    }
    .${PLUGIN_ID}-field-head label { font-size: 12px; color: #d3d8de; }
    .${PLUGIN_ID}-field-ctl { display: inline-flex; align-items: center; gap: 5px; }
    #${PLUGIN_ID}-pattern-pop input[type=number] {
      width: 66px; background: rgba(0,0,0,0.35); color: #e8eaed;
      border: 1px solid rgba(255,255,255,0.14); border-radius: 5px;
      padding: 4px 6px; font-size: 12px; font-family: inherit;
      text-align: right; outline: none;
    }
    #${PLUGIN_ID}-pattern-pop input[type=number]:focus {
      border-color: rgba(90,169,255,0.6);
    }
    .${PLUGIN_ID}-unit { font-size: 11px; color: #737d8a; min-width: 34px; }
    .${PLUGIN_ID}-field-help {
      margin-top: 3px; font-size: 10.5px; color: #7c8593; line-height: 1.4;
    }
    .${PLUGIN_ID}-pop-foot {
      margin-top: 14px; padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
      font-size: 11px; color: #9aa3b0; line-height: 1.45;
    }

    @media (prefers-reduced-motion: reduce) {
      #${PLUGIN_ID}-pattern-pop { transition: none; }
    }
    @media (max-width: 520px) {
      #${PLUGIN_ID}-pattern-pop { width: calc(100vw - 24px); }
      .${PLUGIN_ID}-cards { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(st);
}

  // ── Toolbar components ─────────────────────────────────────────────────────
  // ── Signal preview (debug scope) ───────────────────────────────────────────
  function buildPreview() {
    const wrap = document.createElement("div");
    wrap.id = `${PLUGIN_ID}-preview-wrap`;
    wrap.style.cssText = "display:none;width:100%;padding-top:6px;";

    const cv = document.createElement("canvas");
    cv.id = `${PLUGIN_ID}-preview`;
    cv.style.cssText = "width:100%;height:80px;display:block;background:#111;" +
                       "border:1px solid #333;border-radius:3px;";
    wrap.appendChild(cv);
    previewCanvas = cv;

    const legend = document.createElement("div");
    legend.id = `${PLUGIN_ID}-preview-legend`;
    legend.style.cssText = "font-size:10px;opacity:0.6;padding-top:2px;" +
                           "display:flex;gap:12px;flex-wrap:wrap;";
    legend.innerHTML =
      '<span style="color:#96a0b4">\u2014 script</span>' +
      '<span style="color:#4af">\u2014 target</span>' +
      '<span style="color:#4f8">\u25AE level sent</span>' +
      '<span style="color:#fa4">| command</span>' +
      `<span id="${PLUGIN_ID}-preview-stats"></span>`;
    wrap.appendChild(legend);
    return wrap;
  }

  function drawPreview() {
    previewRaf = null;
    const cv = previewCanvas;
    if (!previewOn || !cv || !cv.isConnected) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = Math.max(1, Math.round(cv.clientWidth  * dpr));
    const h   = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }

    const g = cv.getContext("2d");
    g.clearRect(0, 0, w, h);

    const pts = previewSamples;
    // The backend stamps samples with its own monotonic clock, so anchor the
    // window to the newest sample rather than to Date.now().
    const tEnd = pts.length ? pts[pts.length - 1].t : 0;
    const tSta = tEnd - PREVIEW_WINDOW_MS;
    const X = (t) => ((t - tSta) / PREVIEW_WINDOW_MS) * w;
    const Y = (v) => h - v * (h - 2 * dpr) - dpr;

    // gridlines at 25/50/75/100%
    g.strokeStyle = "#252525"; g.lineWidth = dpr;
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      g.beginPath(); g.moveTo(0, Y(frac)); g.lineTo(w, Y(frac)); g.stroke();
    }
    // motor floor: below this a steady level is impossible without micro pulsing
    if (scalarStep > 0) {
      g.strokeStyle = "#553"; g.setLineDash([4 * dpr, 4 * dpr]);
      g.beginPath(); g.moveTo(0, Y(scalarStep)); g.lineTo(w, Y(scalarStep)); g.stroke();
      g.setLineDash([]);
    }

    // ── Funscript, drawn first so the output sits on top of it ──────────────
    // Samples carry both the backend clock (t) and media time (m), which gives
    // the mapping from script position to screen. Anchor on the newest sample
    // that has a media stamp; at playbackRate 1 one media ms is one wall ms.
    let anchor = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i].m !== null && pts[i].m !== undefined) { anchor = pts[i]; break; }
    }
    if (previewScript && anchor && previewScript.pts?.length > 1) {
      const rate = (statusData && statusData.rate) || 1;
      const mediaToX = (mediaMs) => X(anchor.t + (mediaMs - anchor.m) / rate);

      // Position track occupies the full height; it is a separate quantity
      // from intensity, so it gets its own faint styling rather than sharing
      // the 0-1 axis visually.
      g.strokeStyle = "rgba(150,160,180,0.55)";
      g.lineWidth = dpr;
      g.beginPath();
      previewScript.pts.forEach(([at, pos], i) => {
        const x = mediaToX(at);
        const y = Y(pos / 100);
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      });
      g.stroke();

      // Beat markers: where beat mode will actually fire.
      if (previewScript.beats?.length) {
        g.strokeStyle = "rgba(150,160,180,0.30)";
        for (const at of previewScript.beats) {
          const x = mediaToX(at);
          if (x < -10 || x > w + 10) continue;
          g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        }
      }

      // Playhead: where the script is being read right now.
      const px = mediaToX(anchor.m);
      g.strokeStyle = "rgba(255,255,255,0.28)";
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath(); g.moveTo(px, 0); g.lineTo(px, h); g.stroke();
      g.setLineDash([]);
    }

    if (pts.length > 1) {
      // level actually sent, as a step-held fill (that is how the toy sees it)
      g.fillStyle = "rgba(68,255,136,0.30)";
      g.beginPath(); g.moveTo(X(pts[0].t), Y(0));
      let prev = pts[0];
      for (const p of pts) {
        g.lineTo(X(p.t), Y(prev.lv));
        g.lineTo(X(p.t), Y(p.lv));
        prev = p;
      }
      g.lineTo(X(prev.t), Y(0));
      g.closePath(); g.fill();

      // target, before smoothing and quantisation
      g.strokeStyle = "#4af"; g.lineWidth = 1.2 * dpr;
      g.beginPath();
      pts.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.tg)) : g.moveTo(X(p.t), Y(p.tg))));
      g.stroke();

      // tick per actual BLE command
      g.strokeStyle = "rgba(255,170,68,0.75)"; g.lineWidth = dpr;
      let sent = 0;
      for (const p of pts) {
        if (!p.s) continue;
        sent++;
        const x = X(p.t);
        g.beginPath(); g.moveTo(x, h); g.lineTo(x, h - 6 * dpr); g.stroke();
      }
      previewSentCount = sent;
    }

    const stats = byId(`${PLUGIN_ID}-preview-stats`);
    if (stats) {
      const secs = PREVIEW_WINDOW_MS / 1000;
      const rate = (previewSentCount / secs).toFixed(1);
      const last = pts.length ? pts[pts.length - 1] : null;
      const drift = statusData && typeof statusData.driftMs === "number" ? statusData.driftMs : 0;
      stats.textContent =
        `${rate} cmd/s · now ${last ? (last.lv * 100).toFixed(0) : 0}% · ` +
        `drift ${drift > 0 ? "+" : ""}${drift}ms · ${secs}s window`;
      stats.style.color = Math.abs(drift) > 150 ? "#f84" : "";
    }
    previewRaf = requestAnimationFrame(drawPreview);
  }

  function setPreview(on) {
    previewOn = !!on;
    previewSamples = [];
    previewScript  = null;
    const wrap = byId(`${PLUGIN_ID}-preview-wrap`);
    if (wrap) wrap.style.display = previewOn ? "block" : "none";
    sendMsg({ type: "preview", enabled: previewOn });
    if (previewOn) {
      if (!previewRaf) previewRaf = requestAnimationFrame(drawPreview);
    } else if (previewRaf) {
      cancelAnimationFrame(previewRaf); previewRaf = null;
    }
    log(`Signal preview: ${previewOn ? "on" : "off"}`);
  }

  function buildOffsetInput() {
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:3px;margin-left:6px;";

    const label = document.createElement("span");
    label.textContent = "Offset:";
    wrap.appendChild(label);

    const minus = document.createElement("button");
    minus.textContent   = "−";
    minus.style.cssText = "min-width:26px;padding:4px 8px;font-weight:bold;";
    wrap.appendChild(minus);

    const input = document.createElement("input");
    input.id    = `${PLUGIN_ID}-offset`;
    input.type  = "number";
    input.value = String(offsetMs);
    input.min = -2000;
    input.max = 2000;
    input.step = 10;
    input.title = "Positive = device fires earlier (use when it reacts too late).\n" +
                  "Negative = device fires later.\nRange: -2000 to 2000 ms";
    input.style.cssText = "width:64px;";
    wrap.appendChild(input);

    const plus = document.createElement("button");
    plus.textContent   = "+";
    plus.style.cssText = "min-width:26px;padding:4px 8px;font-weight:bold;";
    wrap.appendChild(plus);

    const unit = document.createElement("span");
    unit.textContent  = "ms";
    unit.style.opacity = "0.7";
    wrap.appendChild(unit);

    function setOffset(v) {
      let val = parseInt(v, 10) || 0;
      val = Math.max(-2000, Math.min(2000, val));
      offsetMs    = val;
      input.value = String(val);
      sendSettings();
    }
    minus.addEventListener("click", () => setOffset(offsetMs - 10));
    plus .addEventListener("click", () => setOffset(offsetMs + 10));
    input.addEventListener("change", () => setOffset(input.value));
    return wrap;
  }

  function buildStrokeRange() {
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:6px;";

    const label = document.createElement("span");
    label.textContent = "Intensity limits:";
    wrap.appendChild(label);

    const track = document.createElement("span");
    track.style.cssText = "position:relative;width:140px;height:18px;display:inline-block;z-index:0;";

    const trackBg = document.createElement("span");
    trackBg.style.cssText = "position:absolute;top:7px;left:0;right:0;height:4px;" +
                            "background:rgba(255,255,255,0.1);border-radius:2px;z-index:1;pointer-events:none;";

    const trackFill = document.createElement("span");
    trackFill.style.cssText = "position:absolute;top:7px;height:4px;z-index:2;pointer-events:none;" +
                              "background:linear-gradient(90deg,#5aa9ff,#7dbcff);" +
                              "border-radius:2px;box-shadow:0 0 8px rgba(90,169,255,0.4);";

    function mkSlider() {
      const s = document.createElement("input");
      s.className = `${PLUGIN_ID}-slider`;
      s.type = "range"; s.min = "0"; s.max = "100";
      s.style.cssText = "position:absolute;top:0;left:0;width:100%;height:18px;" +
                        "background:transparent;pointer-events:none;-webkit-appearance:none;" +
                        "appearance:none;margin:0;z-index:3;";
      return s;
    }

    track.appendChild(trackBg);
    track.appendChild(trackFill);
    wrap.appendChild(track);

    const sMin = mkSlider(); sMin.value = String(strokeMin); track.appendChild(sMin);
    const sMax = mkSlider(); sMax.value = String(strokeMax); track.appendChild(sMax);

    const valLabel = document.createElement("span");
    valLabel.style.cssText = "min-width:62px;text-align:center;opacity:0.85;";
    wrap.appendChild(valLabel);

    function updateUI() {
      trackFill.style.left  = strokeMin + "%";
      trackFill.style.width = (strokeMax - strokeMin) + "%";
      valLabel.textContent  = `${strokeMin}–${strokeMax}%`;
    }

    function onChange(ev) {
      let mn = parseInt(sMin.value, 10);
      let mx = parseInt(sMax.value, 10);
      if (mx - mn < MIN_STROKE_GAP) {
        if (ev.target === sMin) { mn = mx - MIN_STROKE_GAP; sMin.value = String(mn); }
        else                    { mx = mn + MIN_STROKE_GAP; sMax.value = String(mx); }
      }
      strokeMin = mn; strokeMax = mx;
      updateUI(); sendSettings();
    }
    sMin.addEventListener("input", onChange);
    sMax.addEventListener("input", onChange);
    updateUI();
    return wrap;
  }

  // ── Handy WiFi Panel ───────────────────────────────────────────────────────
  // ── Manual mode ────────────────────────────────────────────────────────────
  // The toolbar shows only what you touch mid-scene: on/off, intensity, and
  // which pattern is running. Everything that shapes the pattern lives in a
  // popover, because those are set-once values and having eight unlabelled
  // number boxes in the player chrome made the whole bar unreadable.

  // Plain-language description of each pattern, shown on its card and echoed
  // in the popover header so the selected one is never ambiguous.
  const MANUAL_SHAPES = [
    ["constant", "Steady",  "One level, held. No movement."],
    ["wave",     "Wave",    "Rises and falls smoothly, over and over."],
    ["pulse",    "Pulse",   "A short buzz at a regular beat, silence between."],
    ["ramp",     "Ramp",    "Climbs to the top, drops, climbs again."],
    ["tease",    "Tease",   "Buzzes that start short and grow longer."],
    ["random",   "Random",  "Unpredictable level, changing on its own."],
  ];
  const shapeLabel = (v) => (MANUAL_SHAPES.find((x) => x[0] === v) || ["", v, ""])[1];
  const shapeBlurb = (v) => (MANUAL_SHAPES.find((x) => x[0] === v) || ["", "", ""])[2];

  function buildManualControls() {
    const wrap = document.createElement("span");
    wrap.className = `${PLUGIN_ID}-group`;

    const btn = document.createElement("button");
    btn.id = `${PLUGIN_ID}-manual-btn`;
    btn.className = `${PLUGIN_ID}-primary`;
    btn.title = "Drive the toy directly, ignoring the funscript.";
    btn.addEventListener("click", () => setManual(!manualOn));
    wrap.appendChild(btn);

    const sld = document.createElement("input");
    sld.id    = `${PLUGIN_ID}-manual-level`;
    sld.type  = "range";
    sld.min   = "0"; sld.max = "100"; sld.step = "1";
    sld.value = String(manualLevel);
    sld.title = "Intensity. Also scales funscript output.";
    sld.className = `${PLUGIN_ID}-slider`;
    sld.style.width = "130px";
    // Live: dragging changes output immediately, script playing or not.
    sld.addEventListener("input", () => {
      manualLevel = parseInt(sld.value, 10);
      const lbl = byId(`${PLUGIN_ID}-manual-val`);
      if (lbl) lbl.textContent = `${manualLevel}%`;
      throttledManual();
      updateManualHint();
    });
    sld.addEventListener("change", () => setManual(manualOn, manualLevel));
    wrap.appendChild(sld);

    const val = document.createElement("span");
    val.id = `${PLUGIN_ID}-manual-val`;
    val.className = `${PLUGIN_ID}-num`;
    val.textContent = `${manualLevel}%`;
    wrap.appendChild(val);

    // Opens the pattern popover and doubles as the current-pattern readout.
    const patBtn = document.createElement("button");
    patBtn.id = `${PLUGIN_ID}-pattern-btn`;
    patBtn.title = "Choose and tune the manual pattern";
    patBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleManualPopover();
    });
    wrap.appendChild(patBtn);

    return wrap;
  }

  // ── Pattern popover ────────────────────────────────────────────────────────
  let manualPop = null;

  function numRow(id, label, help, min, max, step, unit, get, set) {
    const row = document.createElement("div");
    row.id = `${PLUGIN_ID}-manual-${id}-box`;
    row.className = `${PLUGIN_ID}-field`;

    const head = document.createElement("div");
    head.className = `${PLUGIN_ID}-field-head`;

    const lab = document.createElement("label");
    lab.textContent = label;
    lab.setAttribute("for", `${PLUGIN_ID}-manual-${id}`);
    head.appendChild(lab);

    const ctl = document.createElement("div");
    ctl.className = `${PLUGIN_ID}-field-ctl`;

    const inp = document.createElement("input");
    inp.id   = `${PLUGIN_ID}-manual-${id}`;
    inp.type = "number";
    inp.min  = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(get());
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) { inp.value = String(get()); return; }
      set(Math.max(min, Math.min(max, v)));
      inp.value = String(get());
      saveSettingsToStorage();
      updateManualUI();
      sendManual();
    });
    ctl.appendChild(inp);

    if (unit) {
      const u = document.createElement("span");
      u.className = `${PLUGIN_ID}-unit`;
      u.textContent = unit;
      ctl.appendChild(u);
    }
    head.appendChild(ctl);
    row.appendChild(head);

    const hint = document.createElement("div");
    hint.className = `${PLUGIN_ID}-field-help`;
    hint.textContent = help;
    row.appendChild(hint);

    return row;
  }

  function buildManualPopover() {
    const pop = document.createElement("div");
    pop.id = `${PLUGIN_ID}-pattern-pop`;
    pop.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    const head = document.createElement("div");
    head.className = `${PLUGIN_ID}-pop-head`;
    head.innerHTML = `<strong>Manual pattern</strong>
      <span class="${PLUGIN_ID}-pop-sub">How the toy behaves when the funscript is not driving it</span>`;
    pop.appendChild(head);

    // Pattern cards
    const grid = document.createElement("div");
    grid.className = `${PLUGIN_ID}-cards`;
    MANUAL_SHAPES.forEach(([value, label, blurb]) => {
      const card = document.createElement("button");
      card.className = `${PLUGIN_ID}-card`;
      card.dataset.shape = value;
      card.innerHTML = `<span class="${PLUGIN_ID}-card-name">${label}</span>
                        <span class="${PLUGIN_ID}-card-blurb">${blurb}</span>`;
      card.addEventListener("click", () => {
        manualShape = value;
        saveSettingsToStorage();
        updateManualUI();
        sendManual();
        log(`Manual pattern: ${value}`, "debug");
      });
      grid.appendChild(card);
    });
    pop.appendChild(grid);

    // Timing, relabelled per pattern by updateManualUI()
    const timing = document.createElement("div");
    timing.className = `${PLUGIN_ID}-section`;
    timing.id = `${PLUGIN_ID}-sec-timing`;
    timing.innerHTML = `<div class="${PLUGIN_ID}-sec-title">Timing</div>`;
    timing.appendChild(numRow(
      "period", "Cycle length",
      "How long one full cycle takes.",
      0.5, 60, 0.5, "sec",
      () => manualPeriod, (v) => { manualPeriod = Math.round(v * 2) / 2; }
    ));
    timing.appendChild(numRow(
      "onms", "Buzz length",
      "How long each buzz lasts. Short reads as a tap, long as a throb.",
      60, 10000, 20, "ms",
      () => manualOnMs, (v) => { manualOnMs = Math.round(v); }
    ));
    timing.appendChild(numRow(
      "depth", "Dip to",
      "How far it falls between peaks, as a share of the peak. 0 falls to silence.",
      0, 95, 5, "%",
      () => manualDepth, (v) => { manualDepth = Math.round(v); }
    ));
    timing.appendChild(numRow(
      "build", "Build-up",
      "Cycles spent growing each buzz from its shortest to its full length. 0 turns the build off.",
      0, 200, 1, "cycles",
      () => manualBuild, (v) => { manualBuild = Math.round(v); }
    ));
    pop.appendChild(timing);

    // Output limits
    const limits = document.createElement("div");
    limits.className = `${PLUGIN_ID}-section`;
    limits.innerHTML = `<div class="${PLUGIN_ID}-sec-title">Output limits</div>`;
    limits.appendChild(numRow(
      "ceiling", "Power limit",
      "The strongest the motor may go. Lowering it stretches the whole intensity slider across a gentler range.",
      1, 100, 1, "%",
      () => manualCeiling, (v) => { manualCeiling = Math.round(v); }
    ));
    limits.appendChild(numRow(
      "microms", "Micro pulse",
      "Length of each pulse used to reach levels below the motor's floor. Short is a tick, long is a purr.",
      40, 1000, 10, "ms",
      () => manualMicroMs, (v) => { manualMicroMs = Math.round(v); }
    ));
    pop.appendChild(limits);

    const foot = document.createElement("div");
    foot.className = `${PLUGIN_ID}-pop-foot`;
    foot.id = `${PLUGIN_ID}-manual-hint`;
    pop.appendChild(foot);

    document.body.appendChild(pop);
    return pop;
  }

  function toggleManualPopover(force) {
    if (!manualPop) manualPop = buildManualPopover();
    const show = force !== undefined ? force : !manualPop.classList.contains("is-open");
    manualPop.classList.toggle("is-open", show);
    if (show) {
      positionManualPopover();
      updateManualUI();
    }
  }

  function positionManualPopover() {
    const anchor = byId(`${PLUGIN_ID}-pattern-btn`);
    if (!anchor || !manualPop) return;
    const a = anchor.getBoundingClientRect();
    const r = manualPop.getBoundingClientRect();
    const pad = 10;
    let left = a.left;
    let top  = a.top - r.height - 8;                 // above the toolbar by default
    if (top < pad) top = a.bottom + 8;               // no room, drop below
    left = Math.max(pad, Math.min(left, window.innerWidth - r.width - pad));
    manualPop.style.left = Math.round(left) + "px";
    manualPop.style.top  = Math.round(top) + "px";
  }

  document.addEventListener("pointerdown", (ev) => {
    if (manualPop && manualPop.contains(ev.target)) return;
    if (byId(`${PLUGIN_ID}-pattern-btn`)?.contains(ev.target)) return;
    toggleManualPopover(false);
  }, true);
  window.addEventListener("resize", () => {
    if (manualPop?.classList.contains("is-open")) positionManualPopover();
  });

  function buildVibeControls() {
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:4px;";

    const label = document.createElement("span");
    label.textContent  = "Script vibe:";
    label.style.cssText = "opacity:0.8;";
    wrap.appendChild(label);

    const sel = document.createElement("select");
    sel.id = `${PLUGIN_ID}-vibe-mode`;
    sel.style.cssText = "background:#222;color:#fff;border:1px solid #555;" +
                        "border-radius:3px;padding:2px 4px;font-size:11px;";
    [["auto", "Auto"], ["speed", "Speed"], ["position", "Position"], ["beat", "Beat"], ["off", "Off"]]
      .forEach(([v, t]) => {
        const o = document.createElement("option");
        o.value = v; o.textContent = t;
        sel.appendChild(o);
      });
    sel.value = vibeMode;
    sel.title = "Auto: Beat for 0/100 square-wave scripts (Cock Hero), Speed for everything else.\n" +
                "Beat: one short burst per keyframe.\nSpeed: intensity follows stroke speed.\n" +
                "Position: intensity follows stroke position.";

    // Beat controls, visible in Beat and Auto
    const beatLen = document.createElement("input");
    beatLen.type  = "number";
    beatLen.id    = `${PLUGIN_ID}-beat-ms`;
    beatLen.min   = "60"; beatLen.max = "1000"; beatLen.step = "10";
    beatLen.value = String(beatMs);
    beatLen.title = "Beat burst length in ms. Shortened automatically when beats come faster.";
    beatLen.style.cssText = "width:52px;background:#222;color:#fff;border:1px solid #555;" +
                            "border-radius:3px;padding:2px 4px;font-size:11px;";
    beatLen.addEventListener("change", () => {
      const v = parseInt(beatLen.value, 10);
      if (!isNaN(v)) {
        beatMs = Math.max(60, Math.min(1000, v));
        beatLen.value = String(beatMs);
        sendSettings();
      }
    });

    const prom = document.createElement("input");
    prom.type  = "number";
    prom.id    = `${PLUGIN_ID}-beat-prom`;
    prom.min   = "5"; prom.max = "60"; prom.step = "5";
    prom.value = String(beatProminence);
    prom.title = "Peak sensitivity for densely sampled scripts (FunGen and other trackers " +
                 "emit every video frame). Only direction changes with at least this much " +
                 "swing count as a beat. Lower = more beats.";
    prom.style.cssText = "width:46px;background:#222;color:#fff;border:1px solid #555;" +
                         "border-radius:3px;padding:2px 4px;font-size:11px;";
    prom.addEventListener("change", () => {
      const v = parseInt(prom.value, 10);
      if (!isNaN(v)) {
        beatProminence = Math.max(5, Math.min(60, v));
        prom.value = String(beatProminence);
        sendSettings();
      }
    });

    const beatSel = document.createElement("select");
    beatSel.id = `${PLUGIN_ID}-beat-edge`;
    beatSel.style.cssText = sel.style.cssText;
    beatSel.title = "Which keyframes fire: every one, only the low (0) ones, or only the high (100) ones. " +
                    "Halves the tempo if the script marks both beat and off-beat.";
    [["all", "Every"], ["low", "Low only"], ["high", "High only"]].forEach(([v, t]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = t;
      beatSel.appendChild(o);
    });
    beatSel.value = beatEdge;
    beatSel.addEventListener("change", () => {
      beatEdge = beatSel.value;
      sendSettings();
      log(`Beat edge: ${beatEdge}`, "debug");
    });

    const sens = document.createElement("input");
    sens.type  = "number";
    sens.id    = `${PLUGIN_ID}-vibe-sens`;
    sens.min   = "50"; sens.max = "2000"; sens.step = "25";
    sens.value = String(vibeMaxSpeed);
    sens.title = "Funscript speed (units/sec) that maps to 100% intensity. " +
                 "Lower = buzzier. Only used in Speed mode.";
    sens.style.cssText = "width:56px;background:#222;color:#fff;border:1px solid #555;" +
                         "border-radius:3px;padding:2px 4px;font-size:11px;";

    function refresh() {
      const beat = vibeMode === "beat" || vibeMode === "auto";
      // Speed sensitivity also sets the beat level (burst intensity comes from
      // beat pace through the same mapping), so keep it visible in beat modes.
      sens.style.display    = (vibeMode === "speed" || beat) ? "" : "none";
      beatLen.style.display = beat ? "" : "none";
      beatSel.style.display = beat ? "" : "none";
      // peak picking only applies to dense scripts; hide it otherwise
      prom.style.display    = (beat && statusData && statusData.beatPicked) ? "" : "none";
    }
    refresh();

    sel.addEventListener("change", () => {
      vibeMode = sel.value;
      refresh();
      sendSettings();
      log(`Vibe mode: ${vibeMode}`, "debug");
    });

    sens.addEventListener("change", () => {
      const v = parseInt(sens.value, 10);
      if (!isNaN(v)) {
        vibeMaxSpeed = Math.max(50, Math.min(2000, v));
        sens.value   = String(vibeMaxSpeed);
        sendSettings();
      }
    });

    wrap.appendChild(sel);
    wrap.appendChild(sens);
    wrap.appendChild(beatLen);
    wrap.appendChild(prom);
    wrap.appendChild(beatSel);
    return wrap;
  }

  function buildHandyPanel() {
    const panel = document.createElement("div");
    panel.id = `${PLUGIN_ID}-handy-panel`;

    const keyLabel = document.createElement("span");
    keyLabel.textContent  = "Connection Key:";
    keyLabel.style.cssText = "font-size:11px;";
    panel.appendChild(keyLabel);

    const keyInput = document.createElement("input");
    keyInput.id          = `${PLUGIN_ID}-handy-key`;
    keyInput.type        = "text";
    keyInput.placeholder = "XXXX-XXXX";
    keyInput.value       = handyKey;
    keyInput.maxLength   = 20;
    panel.appendChild(keyInput);

    const connectBtn = document.createElement("button");
    connectBtn.id = `${PLUGIN_ID}-connect-handy-btn`;
    connectBtn.textContent   = "Connect Handy";
    connectBtn.addEventListener("click", () => {
      const key = keyInput.value.trim();
      if (!key) return;
      handyKey = key;
      saveSettingsToStorage();
      log(`Sending connectHandy, wsReady=${wsReady}, ws=${ws?.readyState}`, "debug");
      sendMsg({ type: "connectHandy", connectionKey: key });
    });
    panel.appendChild(connectBtn);

    const tunnelLabel = document.createElement("span");
    tunnelLabel.textContent   = "Tunnel:";
    tunnelLabel.style.cssText = "font-size:11px;opacity:0.7;";
    panel.appendChild(tunnelLabel);

    const tunnelUrl = document.createElement("span");
    tunnelUrl.id          = `${PLUGIN_ID}-tunnel-url`;
    tunnelUrl.textContent = "–";
    panel.appendChild(tunnelUrl);

        panel.appendChild(tunnelUrl);

    // Reupload-Button
    const reuploadBtn = document.createElement("button");
    reuploadBtn.id          = `${PLUGIN_ID}-reupload-btn`;
    reuploadBtn.textContent = "⟳ Reupload Script";
    reuploadBtn.addEventListener("click", () => {
      if (!selectedFunscript) { log("No funscript selected for reupload", "error"); return; }
      if (ws && ws.readyState === WebSocket.OPEN) {
        log(`Reuploading funscript: ${selectedFunscript}`);
        ws.send(JSON.stringify({ type: "loadFile", path: selectedFunscript, force: true, invert: invert}));
      } else {
        log("WS not connected", "error");
      }
    });
    panel.appendChild(reuploadBtn);

    return panel;
  }

  function updateTunnelUrlDisplay(url) {
    const el = byId(`${PLUGIN_ID}-tunnel-url`);
    if (el) el.textContent = url || "–";
  }

  function updateToolbarInfo(message) {
    const el = byId(`${PLUGIN_ID}-status`);
    if (el) { el.textContent = `ℹ ${message}`; el.style.color = "#fa0"; }
  }

  // ── Toolbar ────────────────────────────────────────────────────────────────
  function buildToolbar() {
    injectStyles();

    const bar = document.createElement("div");
    bar.id    = `${PLUGIN_ID}-toolbar`;
    toolbarEl = bar;                     // byId can reach it before it is mounted
    bar.addEventListener("pointerdown", () => tryTakeover("toolbar"), true);
    bar.style.cssText = `
      display:flex; align-items:center; gap:8px;
      padding:4px 10px; background:rgba(0,0,0,0.75);
      color:#fff; font-size:12px; font-family:sans-serif;
      border-top:1px solid #444; flex-wrap:wrap; z-index:9999;
    `;

    // ── Row 1 ──────────────────────────────────────────────────────────────
    const row1 = document.createElement("div");
    row1.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap;";

    // Mode toggle
    const modeWrap = document.createElement("span");
    modeWrap.style.cssText = "display:inline-flex;gap:4px;";

    const btnIntiface = document.createElement("button");
    btnIntiface.textContent = "Intiface";
    btnIntiface.className   = `${PLUGIN_ID}-mode-btn`;

    const btnHandy = document.createElement("button");
    btnHandy.textContent = "The Handy";
    btnHandy.className   = `${PLUGIN_ID}-mode-btn`;


    btnIntiface.addEventListener("click", () => {
      if (mode === "intiface") return;
      mode          = "intiface";
      intifaceReady = false;
      statusData    = { connected: false, playing: false };
      saveSettingsToStorage();
      log("Mode switched to intiface");
      sendMsg({ type: "setMode", mode: "intiface" });
      updateModeButtons();
      updateToolbarStatus();
    });

    btnHandy.addEventListener("click", () => {
      if (mode === "handy_wifi") return;
      mode          = "handy_wifi";
      intifaceReady = false;
      statusData    = { connected: false, playing: false };
      saveSettingsToStorage();
      log("Mode switched to handy_wifi");
      sendMsg({ type: "setMode", mode: "handy_wifi" });
      updateModeButtons();
      updateToolbarStatus();
    });

    modeWrap.id = `${PLUGIN_ID}-mode-wrap`;
    modeWrap.appendChild(btnIntiface);
    modeWrap.appendChild(btnHandy);
    row1.appendChild(modeWrap);

    // Funscript selector
    const selectEl = document.createElement("select");
    selectEl.id    = `${PLUGIN_ID}-select`;
    selectEl.style.cssText = "background:#222;color:#fff;border:1px solid #555;" +
                             "border-radius:3px;padding:3px 6px;font-size:11px;" +
                             "max-width:260px;text-overflow:ellipsis;flex:0 1 260px;";
    selectEl.addEventListener("change", () => {
      if (selectEl.value) loadFunscript(selectEl.value);
    });

    // Row 1 shows only the script in use. The picker lives in the advanced row
    // and only appears when the folder actually holds more than one candidate.
    const scriptLabel = document.createElement("span");
    scriptLabel.id = `${PLUGIN_ID}-script-name`;
    scriptLabel.style.cssText =
      "font-size:11px;opacity:0.85;max-width:260px;flex:0 1 auto;min-width:0;" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    row1.appendChild(scriptLabel);


    // Master kill switch. "Output ON/OFF" read as a verb to some people and a
    // state to others, so say which it is and show it.
    const outBtn = document.createElement("button");
    outBtn.id = `${PLUGIN_ID}-output-btn`;
    outBtn.className = `${PLUGIN_ID}-primary`;
    outBtn.addEventListener("click", () => setOutput(!outputOn));
    row1.appendChild(outBtn);

    row1.appendChild(buildManualControls());

    // Advanced toggle
    const gearBtn = document.createElement("button");
    gearBtn.textContent = "\u2699";
    gearBtn.title = "Advanced settings";
    row1.appendChild(gearBtn);

    // Connect (Intiface only)
    const connectBtn = document.createElement("button");
    connectBtn.id         = `${PLUGIN_ID}-connect-btn`;
    connectBtn.textContent  = "Connect";
    connectBtn.addEventListener("click", requestIntifaceConnect);
    row1.appendChild(connectBtn);

    // Stop
    const stopBtn = document.createElement("button");
    stopBtn.textContent   = "Stop";
    stopBtn.id = `${PLUGIN_ID}-stop`;
    stopBtn.addEventListener("click", () => {
      log("Stop button clicked", "debug");
      sendMsg({ type: "stop" });
    });
    row1.appendChild(stopBtn);

    // Spacer
    const spacer = document.createElement("span");
    spacer.style.cssText = "flex:1 1 auto;";
    row1.appendChild(spacer);

    // Status (with Ellipsis + Tooltip)
    const statusEl = document.createElement("span");
    statusEl.id    = `${PLUGIN_ID}-status`;
    statusEl.style.cssText =
      "opacity:0.8; flex:0 1 auto; min-width:0; " +
      "overflow:hidden; text-overflow:ellipsis; " +
      "white-space:nowrap; text-align:right;";
    row1.appendChild(statusEl);


    bar.appendChild(row1);

    // ── Row 2: advanced, hidden by default ────────────────────────────────
    const row2 = document.createElement("div");
    row2.id = `${PLUGIN_ID}-advanced`;
    row2.style.cssText = "display:none;align-items:center;gap:10px;width:100%;" +
                         "flex-wrap:wrap;padding-top:4px;border-top:1px solid #333;";
    const pickWrap = document.createElement("span");
    pickWrap.id = `${PLUGIN_ID}-script-pick`;
    pickWrap.style.cssText = "display:none;align-items:center;gap:6px;";
    const pickLabel = document.createElement("span");
    pickLabel.textContent  = "Funscript:";
    pickLabel.style.cssText = "opacity:0.8;";
    pickWrap.appendChild(pickLabel);
    pickWrap.appendChild(selectEl);
    row2.appendChild(pickWrap);

    row2.appendChild(modeWrap);
    row2.appendChild(buildVibeControls());
    row2.appendChild(buildOffsetInput());
    row2.appendChild(buildStrokeRange());

    const subBtn = document.createElement("button");
    function updateSubBtn() {
      const floorPct = (scalarStep * 100).toFixed(0);
      subBtn.textContent = vibeSubstep ? "Micro pulsing on" : "Micro pulsing off";
      subBtn.classList.toggle("is-on", vibeSubstep);
      subBtn.title =
        `Gets you below the motor's own floor of ${floorPct}%. It rapidly ` +
        "pulses between silence and one step, and the motor's inertia averages " +
        "that into something gentler than the hardware can hold steady.\n\n" +
        `It only does anything when the requested level is under ${floorPct}%, ` +
        "so if the panel says Micro is idle, lower the max % in manual mode " +
        "until the peak drops under the floor.";
    }
    updateSubBtn();
    subBtn.addEventListener("click", () => {
      vibeSubstep = !vibeSubstep;
      updateSubBtn();
      saveSettingsToStorage();
      sendSettings();
      updateManualUI();
      log(`Micro pulsing: ${vibeSubstep ? "on" : "off"}`);
    });
    row2.appendChild(subBtn);

    const hotkeyBtn = document.createElement("button");
    hotkeyBtn.id = `${PLUGIN_ID}-hotkey-btn`;
    hotkeyBtn.addEventListener("click", () => {
      if (!hotkeysAllowed) return;      // the plugin setting wins
      hotkeysOn = !hotkeysOn;
      updateHotkeyBtn();
      saveSettingsToStorage();
    });
    row2.appendChild(hotkeyBtn);
    updateHotkeyBtn();        // only after mounting: byId cannot see it before

    const scopeBtn = document.createElement("button");
    function updateScopeBtn() {
      scopeBtn.textContent = previewOn ? "Signal preview on" : "Signal preview";
      scopeBtn.classList.toggle("is-on", previewOn);
      scopeBtn.title = "Live scope of what is actually being sent to the toy. " +
                       "Debug only: it streams ~25 samples/sec from the backend, " +
                       "so leave it off during normal use.";
    }
    updateScopeBtn();
    scopeBtn.addEventListener("click", () => {
      setPreview(!previewOn);
      updateScopeBtn();
    });
    row2.appendChild(scopeBtn);



    gearBtn.addEventListener("click", () => {
      advancedOpen = !advancedOpen;
      row2.style.display = advancedOpen ? "flex" : "none";
      gearBtn.classList.toggle("is-on", advancedOpen);
      // closing the panel hides the scope, so stop paying for the stream
      if (!advancedOpen && previewOn) { setPreview(false); updateScopeBtn(); }
    });

    bar.appendChild(row2);
    row2.appendChild(buildPreview());

    // ── Row 3: Handy Panel (visible only in mobile mode) ───────────────────
    const handyPanel = buildHandyPanel();

    function updateModeButtons() {
      btnIntiface.classList.toggle("active", mode === "intiface");
      btnHandy   .classList.toggle("active", mode === "handy_wifi");

      handyPanel.style.display = (handyEnabled && mode === "handy_wifi") ? "flex" : "none";
      connectBtn.style.display = mode === "intiface"   ? ""     : "none";
    }


    bar.appendChild(handyPanel);

    // Set mode buttons to their default values
    updateModeButtons();
    applyHandyVisibility();
    updateManualUI();
    updateOutputUI();

    return bar;
  }

  // ── Status Display ─────────────────────────────────────────────────────────
  function updateToolbarStatus() {
    if (eventInfoActive) return;
    const statusEl = byId(`${PLUGIN_ID}-status`);
    if (!statusEl) return;

    if (!isOwner) {
      const o = readOwner();
      statusEl.textContent = (o && o.playing)
        ? "◌ Another tab is playing to the device"
        : "◌ Another tab controls the device";
      statusEl.style.color = "#888";
      statusEl.title = "One tab drives the toy at a time. Press play here, use a hotkey, " +
                       "or click this text to take over.";
      statusEl.style.cursor = "pointer";
      statusEl.onclick = () => {
        claimOwner(true);
        refreshOwnership();
        statusEl.onclick = null;
        statusEl.style.cursor = "";
      };
      return;
    }
    statusEl.onclick = null;
    statusEl.style.cursor = "";

    if (!wsReady) {
      statusEl.textContent = `⚠ Backend unreachable (${BACKEND_URL})`;
      statusEl.style.color = "#f90";
      statusEl.title = statusEl.textContent;
      return;
    }

    if (!outputOn) {
      statusEl.textContent = "⛔ Output disabled (E)";
      statusEl.style.color = "#f66";
      statusEl.title = "All device output is cut. Press E to resume.";
      return;
    }

    if (mode === "intiface") {
      const { connected, playing, devices, error } = statusData;
      let devNames = (devices || []).map(d => d.name).join(", ") || "–";
      if (statusData.beatScript) {
        devNames += statusData.vibeEffective === "beat" ? " ♩beat" : " ♩(beat script, mode not beat)";
      } else if (statusData.beatPicked && statusData.vibeEffective === "beat") {
        devNames += ` ♩${statusData.beatPeaks} peaks`;
      }
      if (error)           { statusEl.textContent = `⚠ ${error}`;              statusEl.style.color = "#f90"; }
      else if (!connected) { statusEl.textContent = "● Intiface: disconnected"; statusEl.style.color = "#f44"; }
      else if (playing)    { statusEl.textContent = `▶ ${devNames}`;            statusEl.style.color = "#4f4"; }
      else                 { statusEl.textContent = `■ ${devNames}`;            statusEl.style.color = "#aaa"; }
    } else {
      const { connected, playing, error } = statusData;
      if (error)           { statusEl.textContent = `⚠ ${error}`;              statusEl.style.color = "#f90"; }
      else if (!connected) { statusEl.textContent = "● Handy: disconnected";   statusEl.style.color = "#f44"; }
      else if (playing)    { statusEl.textContent = "▶ Handy: playing";         statusEl.style.color = "#4f4"; }
      else                 { statusEl.textContent = "■ Handy: connected";       statusEl.style.color = "#aaa"; }
    }
    statusEl.title = statusEl.textContent;
  }

  function baseName(path) {
    return String(path || "").split(/[\\/]/).pop();
  }

  function updateFunscriptSelector() {
    const sel   = byId(`${PLUGIN_ID}-select`);
    const label = byId(`${PLUGIN_ID}-script-name`);
    const pick  = byId(`${PLUGIN_ID}-script-pick`);

    if (label) {
      if (funscripts.length === 0) {
        label.textContent = "No funscript found";
        label.style.opacity = "0.55";
        label.title = "Nothing matching this video was found next to it.";
      } else {
        const name    = baseName(selectedFunscript);
        const pending = funscriptLoaded === "pending";
        label.textContent   = pending ? `♪ ${name} …` : `♪ ${name}`;
        label.style.opacity = pending ? "0.6" : "0.85";
        label.title = funscripts.length > 1
          ? `${selectedFunscript}\n\n${funscripts.length} candidates in this folder; ` +
            "switch under ⚙ Advanced."
          : selectedFunscript;
      }
    }

    // The picker is only worth showing when there is a real choice to make.
    if (pick) pick.style.display = funscripts.length > 1 ? "inline-flex" : "none";

    if (!sel) return;
    sel.innerHTML = "";
    if (funscripts.length === 0) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No funscript found";
      sel.appendChild(opt);
      return;
    }
    funscripts.forEach((path) => {
      const opt = document.createElement("option");
      opt.value       = path;
      opt.textContent = baseName(path);
      if (path === selectedFunscript) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function injectToolbar() {
    const existing = byId(`${PLUGIN_ID}-toolbar`);
    if (existing) {
      existing.remove();
      toolbarInjected = false;
    }
    if (toolbarInjected) return;
    const player = document.querySelector(".VideoPlayer, .video-player, #player");
    if (!player) return;
    player.appendChild(buildToolbar());
    toolbarInjected = true;
    applyHandyVisibility();
    updateManualUI();
    updateOutputUI();
    updateToolbarStatus();
    updateFunscriptSelector();
    log("Toolbar injected", "debug");
  }


  function retryInjectToolbar(attempts = 0) {
    injectToolbar();
    const video = document.querySelector("video");
    if (video) attachVideoEvents(video);
    if ((!toolbarInjected || !video) && attempts < 20) {
      setTimeout(() => retryInjectToolbar(attempts + 1), 500);
    }
  }

  // ── Scene detection ────────────────────────────────────────────────────────
  function getSceneIdFromUrl() {
    const m = window.location.pathname.match(/\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }

  async function onSceneLoad(sceneId) {
    log(`Scene loaded: ${sceneId}`);
    funscriptLoaded       = false;
    pendingPlay           = null;
    pendingFindFunscripts = null;
    funscripts            = [];
    selectedFunscript     = null;

    const scene = await getSceneDetails(sceneId);
    if (!scene) return;

    const videoPath  = scene.files?.[0]?.path ?? null;
    currentScenePath = videoPath;

    if (videoPath) {
      if (wsReady) sendMsg({ type: "findFunscripts", videoPath });
      else         pendingFindFunscripts = { videoPath };
    }

    toolbarInjected = false;
    retryInjectToolbar();
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  let lastUrl = location.href;
  let lastSceneId = null;

  function watchNavigation() {
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; onUrlChange(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const origPush    = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    history.pushState    = (...a) => { origPush(...a);    onUrlChange(); };
    history.replaceState = (...a) => { origReplace(...a); onUrlChange(); };
    window.addEventListener("popstate", onUrlChange);
  }

  function onUrlChange() {
    const sceneId = getSceneIdFromUrl();
    if (!sceneId) {
      lastSceneId = null;
      return;
    }
    if (sceneId === lastSceneId) return;
    lastSceneId = sceneId;

    const old = byId(`${PLUGIN_ID}-toolbar`);
    if (old) old.remove();
    toolbarInjected       = false;
    videoEl               = null;
    funscripts            = [];
    selectedFunscript     = null;
    funscriptLoaded       = false;
    pendingPlay           = null;
    pendingFindFunscripts = null;
    onSceneLoad(sceneId);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function typingInAField(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function installHotkeys() {
    document.addEventListener("keydown", (e) => {
      if (!hotkeysOn || !hotkeysAllowed) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typingInAField(e.target)) return;
      if (!byId(`${PLUGIN_ID}-toolbar`)) return;

      if (!isOwner && ["e", "E", "\\", "[", "]", "0"].includes(e.key)) tryTakeover("hotkey");

      switch (e.key) {
        case "e":
        case "E": setOutput(!outputOn);   break;
        case "\\": setManual(!manualOn);  break;
        case "[":  nudgeManual(-5);        break;
        case "]":  nudgeManual(+5);        break;
        case "0":  setManual(false);       break;
        default:   return;
      }
      e.preventDefault();
      e.stopPropagation();
    }, true);
    log("Hotkeys installed: \\ [ ] 0", "debug");
  }

  function init() {
    isOwner  = claimOwner();
    initDone = true;
    if (!isOwner) log("Another tab owns the device, this tab is a spectator");
    installHotkeys();
    log(`Plugin initialized (backend: ${BACKEND_URL})`);
    loadSettingsFromStorage();
    connectBackend();
    watchNavigation();
    const sceneId = getSceneIdFromUrl();
    if (sceneId) {
      lastSceneId = sceneId;
      onSceneLoad(sceneId);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
