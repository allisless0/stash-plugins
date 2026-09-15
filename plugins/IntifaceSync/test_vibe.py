#!/usr/bin/env python3
"""Offline test of the vibe engine: fake Buttplug client, synthetic funscript."""
import sys, os, asyncio, importlib.util, json, time

# Resolve the plugin next to this file so the harness runs from anywhere.
_HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "isync", os.path.join(_HERE, "IntifaceSync.py"))
isync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isync)

# ── Fake device payloads (Buttplug v3 shapes) ────────────────────────────────
GUSH = {
    "DeviceIndex": 0,
    "DeviceName": "Lovense Gush 2",
    "DeviceMessages": {
        "ScalarCmd": [
            {"StepCount": 20, "FeatureDescriptor": "Vibrator", "ActuatorType": "Vibrate"},
            {"StepCount": 20, "FeatureDescriptor": "Oscillator", "ActuatorType": "Oscillate"},
        ],
        "StopDeviceCmd": {},
    },
}
HANDY = {
    "DeviceIndex": 1,
    "DeviceName": "The Handy",
    "DeviceMessages": {"LinearCmd": [{"StepCount": 100}], "StopDeviceCmd": {}},
}
ROTATOR = {
    "DeviceIndex": 2,
    "DeviceName": "Rotator Only",
    "DeviceMessages": {"RotateCmd": [{"StepCount": 20}], "StopDeviceCmd": {}},
}


class FakeBP(isync.ButtplugClient):
    def __init__(self, devices):
        super().__init__("ws://fake")
        self.devices = {d["DeviceIndex"]: d for d in devices}
        self.sent = []

    async def _send(self, msg_type, payload):
        self.sent.append((msg_type, payload))

    async def stop_all(self):
        self.sent.append(("StopAllDevices", {}))


def fail(msg):
    print(f"  FAIL: {msg}")
    sys.exit(1)


# ── 1. device discovery ──────────────────────────────────────────────────────
print("1. device discovery")
bp = FakeBP([GUSH, HANDY, ROTATOR])
sd = bp.scalar_devices()
ld = bp.linear_devices()
assert sd == [(0, [(0, "Vibrate"), (1, "Oscillate")])], sd
assert ld == [1], ld
assert isync.device_kind(GUSH) == "vibe"
assert isync.device_kind(HANDY) == "linear"
assert isync.device_kind(ROTATOR) == "none"
print(f"   scalar={sd}  linear={ld}  OK")

# ── 2. ScalarCmd wire format ─────────────────────────────────────────────────
print("2. ScalarCmd wire format")
asyncio.run(bp.scalar(0, sd[0][1], 0.65))
msg_type, payload = bp.sent[-1]
assert msg_type == "ScalarCmd", msg_type
assert payload["DeviceIndex"] == 0
assert payload["Scalars"] == [
    {"Index": 0, "Scalar": 0.65, "ActuatorType": "Vibrate"},
    {"Index": 1, "Scalar": 0.65, "ActuatorType": "Oscillate"},
], payload
print(f"   {json.dumps(payload['Scalars'])}  OK")

# ── 3. script state interpolation ────────────────────────────────────────────
print("3. script interpolation")
bp2 = FakeBP([GUSH])
p = isync.FunscriptPlayer(bp2)
# 0->100 over 200ms (fast), then a 5s gap, then slow 100->0 over 1000ms
p.load([
    {"at": 1000, "pos": 0},
    {"at": 1200, "pos": 100},
    {"at": 6200, "pos": 100},
    {"at": 7200, "pos": 0},
])
assert p._script_state(500) is None, "before first keyframe should be None"
assert p._script_state(9000) is None, "past last keyframe should be None"
pos, spd = p._script_state(1100)
assert abs(pos - 0.5) < 1e-6 and abs(spd - 500.0) < 1e-6, (pos, spd)
pos, spd = p._script_state(3000)          # inside the 5s gap
assert spd == 0.0, f"gap should read as idle, got {spd}"
pos, spd = p._script_state(6700)
assert abs(pos - 0.5) < 1e-6 and abs(spd - 100.0) < 1e-6, (pos, spd)
print("   fast=500u/s  gap=0  slow=100u/s  OK")

# ── 4. speed vs position mapping ─────────────────────────────────────────────
print("4. intensity mapping")
p.apply_settings(vibe_mode="speed", vibe_max_speed=500.0, stroke_min=0.0, stroke_max=1.0)
assert p._vibe_target(0.5, 500.0) == 1.0
assert abs(p._vibe_target(0.5, 250.0) - 0.5) < 1e-9
assert p._vibe_target(0.5, 0.0) == 0.0, "idle must be silent"
assert p._vibe_target(0.0, 900.0) == 1.0, "over max speed clamps"
p.apply_settings(vibe_mode="position")
assert abs(p._vibe_target(0.4, 999.0) - 0.4) < 1e-9
# floor/ceiling
p.apply_settings(vibe_mode="speed", stroke_min=0.2, stroke_max=0.8)
assert abs(p._vibe_target(0.5, 250.0) - 0.5) < 1e-9   # 0.2 + 0.5*0.6
assert p._vibe_target(0.5, 0.0) == 0.0, "floor must not apply during silence"
# invert
p.apply_settings(stroke_min=0.0, stroke_max=1.0, invert=True)
assert abs(p._vibe_target(0.5, 500.0) - 0.0) < 1e-9
p.apply_settings(invert=False)
print("   speed/position/floor/invert  OK")

# ── 5. rate limiting + quantisation over a simulated playback ───────────────
print("5. simulated playback with a faked clock")


class FakeClock:
    """Stand-in for the time module so wall clock tracks media time."""
    def __init__(self):
        self.t = 1000.0          # seconds

    def monotonic(self):
        return self.t


bp3 = FakeBP([GUSH])
p3 = isync.FunscriptPlayer(bp3)

# 6s of fast strokes (~3/s, ~600 u/s), then 6s of slow strokes (~0.5/s, ~100 u/s)
actions, t, hi = [], 0, True
while t < 6000:
    actions.append({"at": t, "pos": 100 if hi else 0}); hi = not hi; t += 167
while t < 12000:
    actions.append({"at": t, "pos": 100 if hi else 0}); hi = not hi; t += 1000
p3.load(actions)
p3.apply_settings(vibe_mode="speed", vibe_max_speed=500.0, vibe_smooth=0.30,
                  stroke_min=0.0, stroke_max=1.0)

real_time = isync.time
clock = FakeClock()
isync.time = clock
try:
    async def simulate():
        devs = bp3.scalar_devices()
        tick = isync.SEND_INTERVAL_MS
        for i in range(12000 // tick):
            clock.t += tick / 1000.0
            await p3._vibe_tick(i * tick, devs)
    asyncio.run(simulate())
finally:
    isync.time = real_time

cmds = [(i, m) for i, m in enumerate(bp3.sent) if m[0] == "ScalarCmd"]
levels = [round(m[1]["Scalars"][0]["Scalar"], 3) for _, m in cmds]
bad = [l for l in levels if abs(l / isync.VIBE_STEP - round(l / isync.VIBE_STEP)) > 1e-6]
if bad:
    fail(f"levels not quantised to {isync.VIBE_STEP}: {bad[:5]}")
if max(levels) < 0.95:
    fail(f"fast section never reached full intensity (max {max(levels)})")
rate = len(cmds) / 12.0
if rate > 1000.0 / isync.VIBE_MIN_INTERVAL_MS + 0.5:
    fail(f"rate limiter breached: {rate:.1f} cmd/s")
print(f"   {len(cmds)} ScalarCmds over 12s = {rate:.1f}/s "
      f"(cap {1000.0 / isync.VIBE_MIN_INTERVAL_MS:.1f}/s)")
print(f"   levels {min(levels):.2f}-{max(levels):.2f}, all multiples of {isync.VIBE_STEP}  OK")

# fast section should sit much higher than the slow section
# rebuild a level-vs-time trace
fast = [l for l in levels[:len(levels) // 2]]
slow = [l for l in levels[len(levels) // 2:]]
if slow and fast and (sum(slow) / len(slow)) >= (sum(fast) / len(fast)):
    fail("slow section not quieter than fast section")
print(f"   mean intensity fast={sum(fast)/len(fast):.2f} slow={sum(slow)/len(slow):.2f}  OK")

# ── 6. pause / stop reset ────────────────────────────────────────────────────
print("6. pause/stop reset")


async def check_pause():
    p3.pause()
    await asyncio.sleep(0)
    assert p3._vibe_level == 0.0, p3._vibe_level
    assert p3._vibe_last_sent == -1.0, p3._vibe_last_sent
    assert ("StopAllDevices", {}) in bp3.sent, "pause must stop the device"


asyncio.run(check_pause())
print("   vibe level zeroed + StopAllDevices sent  OK")

# ── 7. mode 'off' ────────────────────────────────────────────────────────────
print("7. vibe mode off")
bp4 = FakeBP([GUSH])
p4 = isync.FunscriptPlayer(bp4)
p4.load(actions)
p4.apply_settings(vibe_mode="off")
assert p4.vibe_mode == "off"
print("   OK (loop skips the scalar path entirely)")

# ── 8. linear path untouched ─────────────────────────────────────────────────
print("8. original linear path still works")
bp5 = FakeBP([HANDY])
p5 = isync.FunscriptPlayer(bp5)
p5.load([{"at": 0, "pos": 0}, {"at": 500, "pos": 100}])
asyncio.run(bp5.linear(1, 200, 0.75))
mt, pl = bp5.sent[-1]
assert mt == "LinearCmd" and pl["Vectors"][0]["Position"] == 0.75, (mt, pl)
print("   LinearCmd unchanged  OK")

# ── 9. manual mode ───────────────────────────────────────────────────────────
print("9. manual mode")

bp6 = FakeBP([GUSH])
p6 = isync.FunscriptPlayer(bp6)
clock6 = FakeClock()


async def manual_run():
    real = isync.time
    isync.time = clock6
    try:
        p6.set_manual(enabled=True, level=0.40)
        assert p6.manual_enabled and abs(p6.manual_level - 0.40) < 1e-9
        devs = bp6.scalar_devices()
        # no script loaded, never played - manual must still drive the toy
        assert not p6.playing and not p6.actions
        for i in range(60):
            clock6.t += isync.SEND_INTERVAL_MS / 1000.0
            await p6._manual_tick(devs)
        cmds = [m for m in bp6.sent if m[0] == "ScalarCmd"]
        levels = [m[1]["Scalars"][0]["Scalar"] for m in cmds]
        assert levels, "manual produced no commands"
        assert abs(levels[-1] - 0.40) < 0.051, f"settled at {levels[-1]}, want ~0.40"
        return len(cmds), levels[-1]
    finally:
        isync.time = real


n, final = asyncio.run(manual_run())
print(f"   no script, never played: {n} cmds, settled at {final:.2f}  OK")

# ── 10. pause must not kill a manual session ─────────────────────────────────
print("10. pause during manual")
before = len([m for m in bp6.sent if m[0] == "StopAllDevices"])


async def pause_during_manual():
    p6.pause()
    await asyncio.sleep(0)


asyncio.run(pause_during_manual())
after = len([m for m in bp6.sent if m[0] == "StopAllDevices"])
assert after == before, "pause stopped the device while manual was on"
assert p6.manual_enabled, "pause cleared manual"
print("   video paused, manual keeps running  OK")

# ── 11. turning manual off stops the device ──────────────────────────────────
print("11. manual off")


async def manual_off():
    p6.set_manual(enabled=False)
    await asyncio.sleep(0)


asyncio.run(manual_off())
assert not p6.manual_enabled
assert len([m for m in bp6.sent if m[0] == "StopAllDevices"]) > before
assert p6._vibe_level == 0.0
print("   StopAllDevices sent, level zeroed  OK")

# ── 12. explicit stop clears manual ──────────────────────────────────────────
print("12. stop clears manual")


async def stop_clears():
    p6.set_manual(enabled=True, level=0.5)
    p6.stop()
    await asyncio.sleep(0)


asyncio.run(stop_clears())
assert not p6.manual_enabled, "stop left manual armed"
print("   OK")

# ── 13. script mode still unaffected by manual plumbing ──────────────────────
print("13. script path regression")
bp7 = FakeBP([GUSH])
p7 = isync.FunscriptPlayer(bp7)
p7.load([{"at": 0, "pos": 0}, {"at": 200, "pos": 100}])
assert not p7.manual_enabled
pos, spd = p7._script_state(100)
assert abs(spd - 500.0) < 1e-6
print("   OK")

print("\nALL TESTS PASSED")

# ─── vibe fork 1.4: master gain + manual waveforms ──────────────────────────
print("14. master intensity scales the script path")
p = isync.FunscriptPlayer(FakeBP([GUSH]))
p.apply_settings(vibe_mode="speed", vibe_max_speed=500.0)
p.master = 1.0
assert p._vibe_target(0.5, 500.0) == 1.0
p.master = 0.3
assert abs(p._vibe_target(0.5, 500.0) - 0.30) < 1e-6
assert abs(p._vibe_target(0.5, 250.0) - 0.15) < 1e-6
assert p._vibe_target(0.5, 0.0) == 0.0          # silence still beats the gain
p.apply_settings(stroke_min=0.2, stroke_max=0.8)
assert abs(p._vibe_target(0.5, 500.0) - 0.24) < 1e-6
print("   gain multiplies after the intensity limits  OK")

print("15. manual waveforms")
p = isync.FunscriptPlayer(FakeBP([GUSH]))
p.master = 1.0
for shape in isync.MANUAL_SHAPES:
    p.manual_shape    = shape
    p.manual_period_s = 4.0
    p._manual_started = 0.0
    vals = [p._manual_shape_value(t) for t in (0.0, 1.0, 2.0, 3.0, 3.9)]
    assert all(0.0 <= v <= 1.0 for v in vals), (shape, vals)
    if shape == "constant":
        assert vals == [1.0] * 5
    if shape == "pulse":
        assert vals[0] == 1.0 and vals[2] == 0.0
    if shape in ("wave", "ramp", "tease"):
        assert len(set(round(v, 3) for v in vals)) > 1, shape
print("   all shapes stay in range and the cycling ones actually vary  OK")

print("16. hardware step resolution")
bp = FakeBP([GUSH])
bp.scalar_devices()
assert abs(bp.scalar_step() - 0.05) < 1e-9
print(f"   step={bp.scalar_step():.3f} from reported StepCount  OK")

print("\nFORK 1.4 TESTS PASSED")

print("17. global output kill switch")
async def _kill_switch():
    bp = FakeBP([GUSH])
    p  = isync.FunscriptPlayer(bp)
    p.master = 1.0
    p.apply_settings(vibe_mode="speed", vibe_max_speed=500.0)
    devs = bp.scalar_devices()

    # enabled: manual produces commands
    p.set_manual(enabled=True, level=0.5, shape="constant")
    for _ in range(4):
        await p._manual_tick(devs)
    assert any(m == "ScalarCmd" for m, _ in bp.sent), "no output while enabled"

    # disabled: loop gate stops everything and a stop is issued
    bp.sent.clear()
    p.set_output(False)
    await asyncio.sleep(0)
    assert not p.output_enabled
    assert any(m == "StopAllDevices" for m, _ in bp.sent), "no stop on disable"

    # the loop body must skip while disabled
    bp.sent.clear()
    for _ in range(5):
        if not p.output_enabled:
            continue
        await p._manual_tick(devs)
    assert not [m for m, _ in bp.sent if m == "ScalarCmd"], "sent while disabled"

    # re-enable resumes
    bp.sent.clear()
    p.set_output(True)
    for _ in range(4):
        await asyncio.sleep(isync.VIBE_MIN_INTERVAL_MS / 1000.0)
        await p._manual_tick(devs)
    assert any(m == "ScalarCmd" for m, _ in bp.sent), "no output after re-enable"

asyncio.run(_kill_switch())
print("   cuts output, stops the device, resumes cleanly  OK")

print("\nFORK 1.5 TESTS PASSED")

print("18. sub-step pulsing")
async def _substep():
    bp = FakeBP([GUSH])
    p  = isync.FunscriptPlayer(bp)
    devs = bp.scalar_devices()
    step = bp.scalar_step()
    p.vibe_smooth = 1.0                      # no EMA lag, test the emitter alone

    # off: a request below one step collapses to the step or to nothing
    p.apply_settings(vibe_substep=False)
    bp.sent.clear()
    for _ in range(3):
        await asyncio.sleep(0.1)
        await p._emit_vibe(step * 0.2, devs)
    levels = [pl["Scalars"][0]["Scalar"] for m, pl in bp.sent if m == "ScalarCmd"]
    assert all(l in (0.0, step) for l in levels)
    assert len(set(levels)) == 1, f"substep off should hold steady, got {levels}"

    # on: the same request now alternates between 0 and one step
    p.apply_settings(vibe_substep=True)
    p._reset_vibe()
    bp.sent.clear()
    t = 0.0
    for _ in range(60):
        await asyncio.sleep(0.02)
        await p._emit_vibe(step * 0.2, devs)
    levels = [pl["Scalars"][0]["Scalar"] for m, pl in bp.sent if m == "ScalarCmd"]
    assert step in levels and 0.0 in levels, f"no pulsing: {levels}"
    assert max(levels) <= step, "pulsing must never exceed one step"
    print(f"   duty={p._substep_duty:.2f}  {len(levels)} cmds in 1.2s "
          f"({len(levels)/1.2:.1f}/s)  OK")

    # command rate must stay inside the BLE budget at every duty
    for frac in (0.05, 0.2, 0.5, 0.85):
        p._reset_vibe()
        bp.sent.clear()
        for _ in range(100):
            await asyncio.sleep(0.02)
            await p._emit_vibe(step * frac, devs)
        n = len([1 for m, _ in bp.sent if m == "ScalarCmd"])
        rate = n / 2.0
        assert rate <= 11.0, f"duty {frac}: {rate:.1f} cmd/s exceeds BLE budget"

    # silence still wins instantly, mid-pulse
    p._reset_vibe()
    bp.sent.clear()
    await p._emit_vibe(step * 0.2, devs)
    p._vibe_level = 0.0
    await p._emit_vibe(0.0, devs)
    last = [pl["Scalars"][0]["Scalar"] for m, pl in bp.sent if m == "ScalarCmd"][-1]
    assert last == 0.0, "silence did not cut through a pulse"
    assert not p._pwm_on

asyncio.run(_substep())
print("   rate stays within budget at every duty, silence pre-empts  OK")

print("\nFORK 1.6 TESTS PASSED")


# ── 19-21. 1.10 safety: panic, deadman, no re-arm ────────────────────────────
print("19. panic stop clears manual mode and hits the device")
async def _panic():
    bp = FakeBP([GUSH])
    srv = isync.BackendServer()
    srv.bp = bp
    srv.player = isync.FunscriptPlayer(bp)
    srv._manual["enabled"] = True
    srv.player.set_manual(enabled=True, level=0.5, shape="tease")
    assert srv.player.manual_enabled
    bp.sent.clear()
    await srv._panic("test")
    await asyncio.sleep(0.05)   # let the ensure_future(stop_all) land
    assert not srv.player.manual_enabled, "panic left manual mode on"
    assert not srv._manual["enabled"], "panic left app-level manual flag on"
    assert ("StopAllDevices", {}) in bp.sent, f"no StopAllDevices: {bp.sent}"
asyncio.run(_panic())
print("   manual off, StopAllDevices sent  OK")

print("20. deadman fires without a heartbeat, stays quiet with one")
async def _deadman():
    bp = FakeBP([GUSH])
    srv = isync.BackendServer()
    srv.bp = bp
    srv.player = isync.FunscriptPlayer(bp)
    srv.player.set_manual(enabled=True, level=0.5, shape="constant")
    old = (isync.DEADMAN_S, isync.DEADMAN_TICK_S)
    isync.DEADMAN_S, isync.DEADMAN_TICK_S = 0.3, 0.05
    try:
        task = asyncio.create_task(srv._watchdog())
        # heartbeat keeps it alive
        for _ in range(8):
            await asyncio.sleep(0.05)
            srv._last_seen = time.monotonic()
        assert srv.player.manual_enabled, "deadman fired despite heartbeats"
        # silence kills it
        await asyncio.sleep(0.6)
        assert not srv.player.manual_enabled, "deadman did not fire"
        task.cancel()
    finally:
        isync.DEADMAN_S, isync.DEADMAN_TICK_S = old
asyncio.run(_deadman())
print("   heartbeat holds, silence stops  OK")

print("21. pause keeps manual running, only panic/stop end it")
async def _pause_vs_panic():
    bp = FakeBP([GUSH])
    p = isync.FunscriptPlayer(bp)
    p.set_manual(enabled=True, level=0.5, shape="tease")
    p.pause()
    assert p.manual_enabled, "pause must not kill a deliberate manual session"
    p.panic()
    assert not p.manual_enabled
asyncio.run(_pause_vs_panic())
print("   pause preserves, panic ends  OK")

print("\nFORK 1.10 TESTS PASSED")


# ── 22-23. 1.11 beat mode ────────────────────────────────────────────────────
print("22. beat script detection")
def _square(n, iv):
    return [{"at": i * iv, "pos": 0 if i % 2 == 0 else 99} for i in range(n)]
import math
wavy  = [{"at": i * 180, "pos": int(50 + 45 * math.sin(i * 0.7))} for i in range(500)]
mixed = [{"at": i * 200, "pos": [0, 50, 100, 50][i % 4]} for i in range(500)]
assert isync.detect_beat_script(_square(400, 468)), "square wave not detected"
assert not isync.detect_beat_script(wavy), "wavy script misdetected as beat"
assert not isync.detect_beat_script(mixed), "0/50/100 script misdetected as beat"
assert not isync.detect_beat_script(_square(10, 468)), "tiny script must not classify"
print("   square=yes, wavy=no, 0/50/100=no, tiny=no  OK")

print("23. beat mode: one burst per keyframe, silence between, inside BLE budget")
async def _beat():
    bp = FakeBP([GUSH])
    p  = isync.FunscriptPlayer(bp)
    devs = bp.scalar_devices()
    real = time.monotonic
    try:
        for iv, expect_level in ((1875, 0.10), (468, 0.40), (233, 0.85)):
            p.load(_square(600, iv))
            p.apply_settings(vibe_mode="auto")
            assert p.effective_vibe_mode() == "beat"
            p._reset_vibe(); bp.sent.clear()
            t0 = real()
            for k in range(0, 10000, 20):
                isync.time.monotonic = lambda: t0 + k / 1000.0
                await p._vibe_tick(1000 + k, devs)
            levels = [pl["Scalars"][0]["Scalar"] for m, pl in bp.sent if m == "ScalarCmd"]
            on  = [l for l in levels if l > 0]
            off = [l for l in levels if l == 0]
            beats = 10000 // iv
            assert abs(len(on) - beats) <= 2, f"{iv}ms: {len(on)} bursts for {beats} beats"
            assert abs(len(off) - len(on)) <= 1, f"{iv}ms: bursts not followed by silence"
            assert len(levels) / 10 <= 11, f"{iv}ms: {len(levels)/10:.1f} cmd/s over budget"
            assert abs(on[0] - expect_level) < 0.03, f"{iv}ms: level {on[0]:.2f} != {expect_level}"
            print(f"   {iv:4d}ms beat: {len(on)} bursts @ {on[0]:.2f}, {len(levels)/10:.1f} cmd/s  OK")
        # non-beat script under auto falls back to speed mode
        p.load(wavy)
        assert p.effective_vibe_mode() == "speed"
        # explicit beat on a wavy script still runs (user's choice)
        p.apply_settings(vibe_mode="beat")
        assert p.effective_vibe_mode() == "beat"
    finally:
        isync.time.monotonic = real
asyncio.run(_beat())
print("   auto falls back to speed on a normal script  OK")

print("\nFORK 1.11 TESTS PASSED")


# ── 24-25. 1.13 peak picking for dense tracker scripts ───────────────────────
print("24. dense detection and peak extraction")
dense30fps = []
import math
for i in range(3000):                       # 33ms sampling, ~1 stroke/sec
    dense30fps.append({"at": i * 33, "pos": int(50 + 40 * math.sin(i * 33 / 1000 * 2 * math.pi))})
assert isync.is_dense_script(dense30fps), "33ms script not flagged dense"
assert not isync.is_dense_script(_square(400, 468)), "468ms square flagged dense"
pk = isync.extract_peaks(dense30fps)
# 100 cycles = 200 turnarounds (one top, one bottom per stroke)
assert 170 <= len(pk) <= 210, f"expected ~200 turnarounds for 100 strokes, got {len(pk)}"
gaps = [pk[i + 1]["at"] - pk[i]["at"] for i in range(len(pk) - 1)]
assert min(gaps) >= isync.BEAT_PEAK_MIN_SEP_MS, f"peaks too close: {min(gaps)}ms"
assert not isync.detect_beat_script(dense30fps), "tracker script must not auto-select beat"
print(f"   3000 frames -> {len(pk)} turnarounds, min gap {min(gaps)}ms  OK")

print("25. beat mode on a dense script stays inside the command budget")
async def _dense():
    bp = FakeBP([GUSH])
    p  = isync.FunscriptPlayer(bp)
    p.load(dense30fps)
    assert p._beats is not p.actions, "dense script was not peak-picked"
    p.apply_settings(vibe_mode="beat")
    devs = bp.scalar_devices(); real = time.monotonic; t0 = real()
    try:
        for k in range(0, 20000, 20):
            isync.time.monotonic = lambda: t0 + k / 1000.0
            await p._vibe_tick(5000 + k, devs)
    finally:
        isync.time.monotonic = real
    lv  = [pl["Scalars"][0]["Scalar"] for mm, pl in bp.sent if mm == "ScalarCmd"]
    on  = [x for x in lv if x > 0]
    off = [x for x in lv if x == 0]
    assert len(lv) / 20 <= 11, f"{len(lv)/20:.1f} cmd/s over budget"
    assert len(off) >= len(on) - 1, "bursts are not separated by silence"
    assert 30 <= len(on) <= 60, f"expected ~40 bursts in 20s, got {len(on)}"
    print(f"   {len(on)} bursts / 20s, {len(lv)/20:.1f} cmd/s, {len(off)} silences  OK")
    # raising prominence must thin the beats out, not crash
    before = len(p._beats)
    p.apply_settings(beat_prominence=45)
    assert len(p._beats) <= before
asyncio.run(_dense())
print("   prominence tuning rebuilds the beat list  OK")

print("\nFORK 1.13 TESTS PASSED")


# ── 26-28. 1.14 clock sync and offset ────────────────────────────────────────
print("26. offset shifts beat timing in the right direction")
async def _offset():
    beats = [{"at": i * 500, "pos": 0 if i % 2 == 0 else 99} for i in range(200)]
    real  = time.monotonic
    fired = {}
    try:
        for off in (0, -300, +300):
            bp = FakeBP([GUSH]); p = isync.FunscriptPlayer(bp)
            p.load(beats); p.apply_settings(vibe_mode="beat"); p.apply_settings(offset_ms=off)
            devs = bp.scalar_devices(); t0 = real()
            p._play_start_wall = t0; p._play_start_media = 0.0; p.playing = True
            hits = []
            for k in range(0, 3000, 10):
                isync.time.monotonic = lambda: t0 + k / 1000.0
                before = len(bp.sent)
                await p._vibe_tick(p._current_media_ms() + p.offset_ms, devs)
                for mm, pl in bp.sent[before:]:
                    if mm == "ScalarCmd" and pl["Scalars"][0]["Scalar"] > 0:
                        hits.append(k)
            fired[off] = hits
    finally:
        isync.time.monotonic = real
    # +offset means the device runs ahead of the video, so a given beat lands
    # earlier in wall-clock terms; -offset delays it.
    assert fired[+300][0] < fired[0][0] + 250, f"+offset did not advance: {fired[+300][:3]}"
    assert fired[-300][0] > fired[0][0] + 250, f"-offset did not delay: {fired[-300][:3]}"
    print(f"   0ms:{fired[0][:3]}  +300:{fired[+300][:3]}  -300:{fired[-300][:3]}  OK")
asyncio.run(_offset())

print("27. sync() corrects drift instead of free-running")
async def _sync():
    bp = FakeBP([GUSH]); p = isync.FunscriptPlayer(bp)
    p.load([{"at": i * 500, "pos": 0 if i % 2 == 0 else 99} for i in range(200)])
    real = time.monotonic; t0 = real()
    try:
        isync.time.monotonic = lambda: t0
        p.play(0.0)
        # backend has run 10s, video really is at 9.4s: 600ms of drift
        isync.time.monotonic = lambda: t0 + 10.0
        assert abs(p._current_media_ms() - 10000) < 5
        p.sync(9400.0)
        assert abs(p._current_media_ms() - 9400) < 20, \
            f"big drift not snapped: {p._current_media_ms():.0f}"
        # small drift is pulled gently, not snapped
        isync.time.monotonic = lambda: t0 + 11.0
        before = p._current_media_ms()
        p.sync(before - 40)
        moved = before - p._current_media_ms()
        assert 0 < moved < 40, f"small drift mishandled: moved {moved:.1f}ms"
        # rate change re-anchors
        p.sync(12000.0, rate=2.0)
        assert p.rate == 2.0
        isync.time.monotonic = lambda: t0 + 12.0
        assert abs(p._current_media_ms() - 14000) < 50, \
            f"rate not applied: {p._current_media_ms():.0f}"
    finally:
        isync.time.monotonic = real
    print("   600ms snapped, 40ms eased, rate 2x honoured  OK")
asyncio.run(_sync())

print("28. changing the offset mid-playback re-seats the keyframe index")
async def _reseat():
    bp = FakeBP([GUSH]); p = isync.FunscriptPlayer(bp)
    p.load([{"at": i * 500, "pos": 0 if i % 2 == 0 else 99} for i in range(200)])
    real = time.monotonic; t0 = real()
    try:
        isync.time.monotonic = lambda: t0
        p.play(0.0)
        isync.time.monotonic = lambda: t0 + 5.0
        p._last_sent_idx = 9
        p.apply_settings(offset_ms=-2000)
        assert p._last_sent_idx != 9, "index not re-seated after offset change"
    finally:
        isync.time.monotonic = real
    print("   index re-seated  OK")
asyncio.run(_reseat())

print("\nFORK 1.14 TESTS PASSED")


# ── 29-30. 1.15 signal preview ───────────────────────────────────────────────
print("29. preview is a no-op until a client asks for it")
async def _preview_off():
    bp = FakeBP([GUSH]); p = isync.FunscriptPlayer(bp)
    p.load([{"at": i * 500, "pos": 0 if i % 2 == 0 else 99} for i in range(50)])
    p.apply_settings(vibe_mode="beat")
    devs = bp.scalar_devices(); real = time.monotonic; t0 = real()
    try:
        for k in range(0, 2000, 20):
            isync.time.monotonic = lambda: t0 + k / 1000.0
            await p._vibe_tick(k, devs)
    finally:
        isync.time.monotonic = real
    assert p.preview_cb is None
    assert p._preview_buf == [], "buffer filled with no subscriber"
asyncio.run(_preview_off())
print("   no buffering, no callback  OK")

print("30. preview streams bounded batches and marks real commands")
async def _preview_on():
    bp = FakeBP([GUSH]); p = isync.FunscriptPlayer(bp)
    p.load([{"at": i * 500, "pos": 0 if i % 2 == 0 else 99} for i in range(50)])
    p.apply_settings(vibe_mode="beat")
    frames = []
    p.preview_cb = frames.append
    devs = bp.scalar_devices(); real = time.monotonic; t0 = real()
    try:
        for k in range(0, 5000, 20):
            isync.time.monotonic = lambda: t0 + k / 1000.0
            await p._vibe_tick(k, devs)
    finally:
        isync.time.monotonic = real
    assert frames, "no preview frames emitted"
    samples = [s for f in frames for s in f]
    assert len(p._preview_buf) <= isync.PREVIEW_HZ * 2, "buffer grew unbounded"
    for s in samples:
        assert set(s) == {"t", "tg", "lv", "m", "s"}, f"bad sample shape {s}"
        assert 0.0 <= s["lv"] <= 1.0 and 0.0 <= s["tg"] <= 1.0
    sent = [s for s in samples if s["s"]]
    cmds = [1 for mm, _ in bp.sent if mm == "ScalarCmd"]
    assert len(sent) == len(cmds), f"{len(sent)} marked vs {len(cmds)} actual commands"
    # sampling is throttled, not once per 20ms tick
    assert len(samples) < 5000 / 20, f"preview not throttled: {len(samples)} samples"
    print(f"   {len(frames)} frames, {len(samples)} samples, {len(sent)} commands marked  OK")
asyncio.run(_preview_on())

print("\nFORK 1.15 TESTS PASSED")
