#!/usr/bin/env python3
"""IntifaceSync Backend – Intiface Central + The Handy WiFi (HSSP) mode."""

import sys
import os
import json
import asyncio
import logging
import tempfile
import time
import signal
import subprocess
import hashlib
import threading
import re
import math
import random
import socket
import select
from logging.handlers import RotatingFileHandler
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import unquote

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DEBUG = os.path.exists(os.path.join(PLUGIN_DIR, "debug"))
LOG_FILE = os.path.join(PLUGIN_DIR, "intiface_sync.log")


LEVEL_PREFIX = {
    logging.DEBUG:    "\x02",  # Debug
    logging.INFO:     "\x03",  # Info
    logging.WARNING:  "\x04",  # Warning
    logging.ERROR:    "\x05",  # Error
    logging.CRITICAL: "\x05",  # Critical
}


class StashFormatter(logging.Formatter):
    def format(self, record):
        prefix = LEVEL_PREFIX.get(record.levelno, "\x03")
        msg = super().format(record)
        return "\n".join(prefix + line for line in msg.splitlines())


class StashHandler(logging.StreamHandler):
    def emit(self, record):
        try:
            super().emit(record)
            self.flush()
        except Exception:
            self.handleError(record)


stash_handler = StashHandler(sys.stdout)
stash_handler.setFormatter(StashFormatter("[IntifaceSync] %(message)s"))

file_handler = RotatingFileHandler(LOG_FILE, maxBytes=500_000, backupCount=1, encoding="utf-8")
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

root = logging.getLogger()
root.handlers.clear()
root.addHandler(stash_handler)
root.addHandler(file_handler)
root.setLevel(logging.DEBUG if DEBUG else logging.INFO)

log = logging.getLogger("IntifaceSync")


def log_debug(msg):
    log.debug(msg)



try:
    import websockets
    from websockets.asyncio.server import serve as ws_serve
except ImportError:
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "--quiet"])
    except subprocess.CalledProcessError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "--quiet", "--break-system-packages"])
    import websockets
    try:
        from websockets.asyncio.server import serve as ws_serve
    except ImportError:
        from websockets.server import serve as ws_serve

try:
    import aiohttp
except ImportError:
    try:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "aiohttp", "--quiet"])
    except subprocess.CalledProcessError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "aiohttp", "--quiet", "--break-system-packages"])
    import aiohttp

BACKEND_PORT      = 7880
BACKEND_HOST      = "0.0.0.0"
FUNSCRIPT_PORT    = 7881
LOCK_FILE         = os.path.join(tempfile.gettempdir(), "intiface_sync.lock")
BUTTPLUG_CLIENT   = "IntifaceSync/Stash"
BUTTPLUG_MSG_VER  = 3
SEND_INTERVAL_MS  = 20
MIN_DURATION_MS   = 30
DISCONNECT_WAIT_S = 0.5
LOOKAHEAD_MS      = 40
HANDY_API_BASE    = "https://www.handyfeeling.com/api/handy/v2"

# ─── Vibe engine (scalar / vibrating devices e.g. Lovense) ───────────────────
SCALAR_ACTUATORS      = ("Vibrate", "Oscillate")
VIBE_MIN_INTERVAL_MS  = 90      # cap command rate; Lovense BLE chokes above ~11/s
VIBE_MIN_DELTA        = 0.04    # don't resend unless intensity moved this much
VIBE_STEP             = 0.05    # quantise to 20 levels (Lovense native StepCount)
VIBE_GAP_MS           = 1500    # keyframe gap longer than this = idle, go silent
VIBE_DEFAULT_MAXSPEED = 500.0   # funscript units/sec that maps to full intensity
VIBE_DEFAULT_SMOOTH   = 0.30    # EMA alpha per tick (1.0 = no smoothing)
VIBE_MODES            = ("off", "speed", "position", "beat", "auto", "flow")
# Flow mode: the whole script is rendered to an intensity track when it loads.
# See render_flow() for why this beats working it out tick by tick.
FLOW_STEP_MS          = 25      # resolution of the rendered track
FLOW_DEFAULT_SMOOTH   = 0.50    # 0 follows each stroke, 1 follows the scene
FLOW_DEFAULT_RHYTHM   = 0.30    # 0 smooth level, 1 a burst per stroke turn
FLOW_DEFAULT_GAIN     = 1.00    # sensitivity around the script's own level
FLOW_REF_PCT          = 0.90    # envelope percentile that means "full"
FLOW_CUTOFF           = 0.05    # below this the tail of a release is silence
FLOW_CURVE            = 0.75    # <1 lifts quiet passages; linear left slow scenes near the floor
FLOW_OVERVIEW_POINTS  = 400     # whole-scene intensity strip for the UI
# beat mode: one short burst per keyframe, silence between. For Cock Hero style
# scripts that are nothing but 0/100 square waves locked to the music.
BEAT_DEFAULT_ON_MS    = 120     # burst length
BEAT_MIN_GAP_MS       = 80      # burst must leave at least this much silence before the next beat
BEAT_GAP_MS           = 3000    # keyframes further apart than this are a pause, not a slow beat
BEAT_DETECT_EDGE      = 5       # a "beat" keyframe sits within this of 0 or 100
BEAT_DETECT_FRAC      = 0.95    # fraction of keyframes that must be edge values
BEAT_DETECT_MIN       = 40      # do not classify tiny scripts
# Graded beat scripts ("Cock Hero Colors" and friends) alternate on every
# keyframe like a square wave but never reach 0/100, because the swing height
# is carrying the intensity instead. Structurally a beat script, so detect it
# on the structure and read the level off the swing rather than the pace.
BEAT_ALT_FRAC         = 0.90    # fraction of moves that must reverse direction
BEAT_MIN_MEDIAN_SWING = 25      # median swing, keeps low-amplitude ripple out
BEAT_GRID_FRAC        = 0.60    # intervals that must sit on the tempo grid
BEAT_GRID_TOL         = 0.08    # ...within this fraction of the subdivision
BEAT_AMP_PCT          = 0.90    # swing percentile mapped to full intensity
BEAT_AMP_REF_MIN      = 40.0    # ...clamped, so a timid script still reaches the top
BEAT_AMP_REF_MAX      = 100.0   # ...and a spiky one is not normalised into a drone
BEAT_AMP_FLOOR        = 0.15    # smallest swing still worth a burst
BEAT_THIN_MIN_MS      = 190     # beats closer than this get merged, see _thin_beats.
                                # Each beat costs two commands (on, off), so this
                                # is what holds beat mode under ~11 cmd/s: 150
                                # measured 13.3/s, 180 measured 11.1/s.
# Peak picking: FunGen and other trackers emit at a fixed frame rate (33ms at
# 30fps), so most keyframes are interpolation points, not stroke turnarounds.
# Beat mode runs on extracted turning points instead of the raw list.
BEAT_PEAK_PROMINENCE  = 20      # minimum swing (pos units) for a turn to count
BEAT_PEAK_MIN_SEP_MS  = 190     # never two peaks closer than this; 180 was 11.1 cmd/s
BEAT_DENSE_MEDIAN_MS  = 150     # median gap below this = dense script, peak-pick it
# Clock sync. The backend extrapolates media time from a monotonic clock, which
# drifts against the browser's video clock (buffering, dropped frames, rate
# changes). The frontend reports currentTime on the heartbeat and we correct.
SYNC_SNAP_MS          = 150     # drift beyond this: re-anchor hard
SYNC_GAIN             = 0.25    # otherwise pull this fraction of the drift per report
PREVIEW_HZ            = 25      # signal preview sample rate, off unless the user asks
PREVIEW_BATCH_MS      = 200     # bundle samples into one frame to keep the socket quiet
PREVIEW_SCRIPT_MS     = 500     # resend the visible slice of the script this often
PREVIEW_SCRIPT_BACK   = 9000    # ms of script history the scope can show
PREVIEW_SCRIPT_AHEAD  = 3000    # ms of lookahead, so you see what is coming
PREVIEW_SCRIPT_MAX    = 260     # points per window; more than this is invisible anyway
MANUAL_DEFAULT_LEVEL  = 1.00    # master intensity starts at full; pull it down to taste
# Sub-step intensity. The hardware floor is one step (5% on every Lovense toy).
# To get below it, pulse between 0 and one step and let the motor's own inertia
# average it out. The on-pulse is fixed and the gap varies, so the command rate
# falls as the requested level drops instead of climbing.
SUBSTEP_PULSE_MS      = 120     # length of each on-pulse
SUBSTEP_MIN_GAP_MS    = 110     # never two commands closer than this
SUBSTEP_MIN_PERIOD_MS = 240     # ceiling on command rate (~8/s)
SUBSTEP_MAX_PERIOD_MS = 3000    # below this duty it is a tick, not a vibration
SUBSTEP_MIN_DUTY      = 0.04
SUBSTEP_MAX_DUTY      = 0.90    # above this just hold one step steady

MANUAL_SHAPES         = ("constant", "wave", "pulse", "ramp", "random", "tease")
MANUAL_DEFAULT_SHAPE  = "constant"
MANUAL_DEFAULT_PERIOD = 4.0     # seconds per cycle for the shaped manual modes
MANUAL_PULSE_DUTY     = 0.5     # legacy, kept so old saved settings still import

# Manual mode gets its own timing so the script-following smoother cannot blur
# its edges, and its own ceiling so the whole slider can live in the low band.
MANUAL_DEFAULT_ON_MS   = 400    # burst length for pulse / tease, milliseconds
MANUAL_MIN_ON_MS       = 60     # shorter than this and the motor never spins up
MANUAL_DEFAULT_DEPTH   = 0.15   # how far wave / ramp dip, as a fraction of peak
MANUAL_DEFAULT_BUILD   = 0      # tease: cycles spent escalating, 0 = no build
MANUAL_DEFAULT_BUILD_AMP = 0    # tease: cycles spent growing buzz strength, 0 = off
MANUAL_DEFAULT_AMP_FROM  = 0.20 # tease: strength of the first buzz, as a share of peak
DEADMAN_S              = 15     # stop device after this many seconds without a frontend message
DEADMAN_TICK_S         = 2      # watchdog poll interval
WS_PING_INTERVAL_S     = 5      # detect dead browser sockets quickly
WS_PING_TIMEOUT_S      = 8
MANUAL_DEFAULT_CEILING = 1.00   # slider 100% maps to this much motor output
MANUAL_DEFAULT_SMOOTH  = 1.00   # 1.0 = instant, no EMA on manual waveforms
MANUAL_DEFAULT_MICROMS = 120    # on-pulse length used for sub-step output
SSH_KEY_PATH = os.path.join(PLUGIN_DIR, "tunnel_key")


# ─── SSH / Tunnel ────────────────────────────────────────────────────────────

def ensure_ssh() -> bool:
    """Install SSH if it is not already installed."""
    try:
        subprocess.run(["ssh", "-V"], capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        log.info("SSH not found, installing...")
        for cmd in [
            ["apk", "add", "openssh-client", "--no-cache"],
            ["apt-get", "install", "-y", "openssh-client"],
        ]:
            try:
                subprocess.run(cmd, capture_output=True, check=True)
                log.info("SSH installed.")
                return True
            except Exception:
                continue
        log.error("Failed to install SSH.")
        return False


def ensure_ssh_key() -> bool:
    """Create an SSH key if one does not already exist."""
    if os.path.exists(SSH_KEY_PATH):
        return True
    try:
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-f", SSH_KEY_PATH, "-N", ""],
            capture_output=True, check=True
        )
        log.info(f"SSH key created: {SSH_KEY_PATH}")
        return True
    except Exception as e:
        log.error(f"Failed to create SSH key: {e}")
        return False


class TunnelManager:

    def __init__(self):
        self._proc    = None
        self._url     = None
        self._lock    = asyncio.Lock()
        self._handy_connected = False
        self._handy_playing = False

    @property
    def url(self) -> str | None:
        return self._url

    async def start(self, local_port: int) -> str | None:
        async with self._lock:
            if self._proc and self._proc.returncode is None:
                return self._url

            if not ensure_ssh():
                return None
            if not ensure_ssh_key():
                return None

            log.info(f"Starting tunnel for port {local_port}...")
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    "ssh",
                    "-i", SSH_KEY_PATH,
                    "-o", "StrictHostKeyChecking=no",
                    "-o", "ServerAliveInterval=30",
                    "-o", "ServerAliveCountMax=3",
                    "-R", f"80:localhost:{local_port}",
                    "nokey@localhost.run",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )

                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    try:
                        line = await asyncio.wait_for(
                            self._proc.stdout.readline(), timeout=2.0
                        )
                        line = line.decode("utf-8", errors="replace").strip()
                        log_debug(f"Tunnel raw: {line!r}")
                        if "tunneled" in line and "https://" in line:
                            for part in line.split():
                                part = part.rstrip(".,")
                                if part.startswith("https://"):
                                    self._url = part
                                    log.info(f"Tunnel established: {self._url}")
                                    return self._url
                    except asyncio.TimeoutError:
                        continue

                log.error("Tunnel started but no URL received within timeout.")
                return None

            except Exception as e:
                log.error(f"Failed to start tunnel: {e}")
                return None

    async def stop(self) -> None:
        async with self._lock:
            had_proc = self._proc is not None
            self._url = None
            if self._proc and self._proc.returncode is None:
                try:
                    self._proc.terminate()
                    await asyncio.wait_for(self._proc.wait(), timeout=5.0)
                except Exception:
                    try:
                        self._proc.kill()
                    except Exception:
                        pass
            self._proc = None
            if had_proc:
                log.info("Tunnel stopped.")


# ─── Funscript HTTP Server ────────────────────────────────────────────────────

class FunscriptHandler(BaseHTTPRequestHandler):

    funscript_path: str | None = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        path = self.__class__.funscript_path
        if not path or not os.path.isfile(path):
            self.send_error(404, "No funscript loaded")
            return
        if not path.lower().endswith(".funscript"):
            self.send_error(403, "Forbidden")
            return
        try:
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            log.error(f"Failed to serve funscript {path!r}: {e}")
            self.send_error(500, str(e))

class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except (AttributeError, OSError):
            pass
        super().server_bind()


class FunscriptServer:

    def __init__(self, port: int = FUNSCRIPT_PORT):
        self._port   = port
        self._server = None
        self._thread = None

    def serve(self, funscript_path: str) -> None:
        FunscriptHandler.funscript_path = funscript_path
        if self._server is None:
            try:
                self._server = ReusableHTTPServer(("0.0.0.0", self._port), FunscriptHandler)
            except OSError as e:
                log.error(f"Failed to bind funscript server port {self._port}: {e}")
                raise
            self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
            self._thread.start()
            log.info(f"Funscript HTTP server listening on port {self._port} ({funscript_path})")
        else:
            log_debug(f"Funscript server updated: {funscript_path}")

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
            self._thread = None
            log.info("Funscript HTTP server stopped.")


# ─── The Handy API ───────────────────────────────────────────────────────────

class HandyClient:

    def __init__(self, connection_key: str):
        self.key      = connection_key
        self._session = None

    def _headers(self) -> dict:
        return {"X-Connection-Key": self.key, "Content-Type": "application/json"}

    async def set_slide(self, min_pos: float, max_pos: float) -> dict:
        """min_pos/max_pos: 0.0–1.0"""
        return await self._put("/slide", {
            "min": round(min_pos * 100),
            "max": round(max_pos * 100),
        })

    async def _session_get(self):
        if self._session is None or self._session.closed:
            log_debug(f"Creating new aiohttp session for Handy API")
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _get(self, path: str) -> dict:
        s = await self._session_get()
        async with s.get(f"{HANDY_API_BASE}{path}", headers=self._headers()) as r:
            return await r.json()

    async def _put(self, path: str, body: dict) -> dict:
        s = await self._session_get()
        log_debug(f"Handy PUT {path} body={body}")
        try:
            async with s.put(f"{HANDY_API_BASE}{path}", headers=self._headers(), json=body) as r:
                return await r.json()
        except Exception as e:
            log.error(f"Handy PUT {path} failed: {type(e).__name__}: {e}")
            raise

    async def is_connected(self) -> bool:
        try:
            result = await self._get("/info")
            log_debug(f"Handy /info response: {result}")
            return bool(result.get("sessionId"))
        except Exception as e:
            log.warning(f"Handy connection check failed: {e}")
            return False

    async def setup_hssp(self, script_url: str, sha256: str) -> dict:
        return await self._put("/hssp/setup", {
            "url":    script_url,
            "sha256": sha256,
        })

    async def play(self, start_time_ms: float = 0) -> dict:
        # Servertime for Sync
        server_time = await self._get_server_time()
        return await self._put("/hssp/play", {
            "estimatedServerTime": server_time,
            "startTime":           int(start_time_ms),
        })

    async def pause(self) -> dict:
        return await self._put("/hssp/stop", {})

    async def seek(self, time_ms: float, resume: bool = False) -> None:
        await self.pause()
        await asyncio.sleep(0.1)
        if resume:
            await self.play(time_ms)

    async def _get_server_time(self) -> int:
        """Estimate server time (round-trip / 2)."""
        try:
            t0 = int(time.time() * 1000)
            result = await self._get("/servertime")
            t1 = int(time.time() * 1000)
            server_time = result.get("serverTime", t0)
            rtd = (t1 - t0) // 2
            return server_time + rtd
        except Exception as e:
            log.warning(f"Failed to fetch Handy server time, using local: {e}")
            return int(time.time() * 1000)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ─── Buttplug (Intiface) ─────────────────────────────────────────────────────

def device_kind(dev: dict) -> str:
    """'linear', 'vibe', 'both' or 'none' – what we can actually drive."""
    msgs = dev.get("DeviceMessages", {})
    if not isinstance(msgs, dict):
        return "none"
    linear = "LinearCmd" in msgs
    scalars = msgs.get("ScalarCmd")
    vibe = isinstance(scalars, list) and any(
        isinstance(a, dict) and a.get("ActuatorType") in SCALAR_ACTUATORS for a in scalars
    )
    if linear and vibe:
        return "both"
    if linear:
        return "linear"
    if vibe:
        return "vibe"
    return "none"


class ButtplugClient:

    def __init__(self, url: str):
        self.url                  = url
        self.ws                   = None
        self.devices              = {}
        self._msg_id              = 1
        self._connected           = False
        self._listeners           = {}
        self._linear_device_cache = None
        self._scalar_device_cache = None
        self._scalar_steps = 0

    def _next_id(self) -> int:
        mid = self._msg_id
        self._msg_id += 1
        return mid

    def _wrap(self, msg_type: str, payload: dict) -> str:
        payload["Id"] = self._next_id()
        return json.dumps([{msg_type: payload}])

    def _is_ws_open(self) -> bool:
        if self.ws is None:
            return False
        try:
            return self.ws.state.name == "OPEN"
        except AttributeError:
            try:
                return not self.ws.closed
            except AttributeError:
                return False

    async def _send(self, msg_type: str, payload: dict) -> None:
        if not self._is_ws_open():
            return
        try:
            await self.ws.send(self._wrap(msg_type, payload))
        except Exception as e:
            log.warning(f"Buttplug send failed ({msg_type}): {e}")

    async def _recv_loop(self) -> None:
        try:
            async for raw in self.ws:
                try:
                    for msg_obj in json.loads(raw):
                        for msg_type, payload in msg_obj.items():
                            await self._dispatch(msg_type, payload)
                except Exception as e:
                    log.warning(f"Failed to parse Buttplug message: {e}")
        except websockets.exceptions.ConnectionClosed:
            log.info("Disconnected from Intiface.")
            self._connected = False
        except Exception as e:
            log.warning(f"Buttplug receive loop ended: {e}")
            self._connected = False

    async def _dispatch(self, msg_type: str, payload: dict) -> None:
        if msg_type == "DeviceAdded":
            idx = payload["DeviceIndex"]
            self.devices[idx] = payload
            self._linear_device_cache = None
            self._scalar_device_cache = None
            self._scalar_steps = 0
            log.info(f"Device connected: [{idx}] {payload.get('DeviceName', '?')}")
        elif msg_type == "DeviceRemoved":
            idx = payload["DeviceIndex"]
            name = self.devices.pop(idx, {}).get("DeviceName", "?")
            self._linear_device_cache = None
            self._scalar_device_cache = None
            self._scalar_steps = 0
            log.info(f"Device disconnected: [{idx}] {name}")
        elif msg_type == "Error":
            log.warning(f"Buttplug error: {payload}")
        for cb in self._listeners.get(msg_type, []):
            try:
                await cb(payload)
            except Exception as e:
                log.warning(f"Listener error ({msg_type}): {e}")

    def on(self, msg_type: str, callback) -> None:
        self._listeners.setdefault(msg_type, []).append(callback)

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> bool:
        try:
            self.ws = await websockets.connect(self.url)
            await self._send("RequestServerInfo", {
                "ClientName":     BUTTPLUG_CLIENT,
                "MessageVersion": BUTTPLUG_MSG_VER,
            })
            for msg_obj in json.loads(await self.ws.recv()):
                if "ServerInfo" in msg_obj:
                    log.info(f"Connected to Intiface: {msg_obj['ServerInfo'].get('ServerName', '?')}")
                    self._connected = True
                elif "Error" in msg_obj:
                    log.error(f"Intiface handshake error: {msg_obj['Error']}")
                    return False

            if not self._connected:
                return False

            await self._send("RequestDeviceList", {})
            for msg_obj in json.loads(await self.ws.recv()):
                if "DeviceList" in msg_obj:
                    for dev in msg_obj["DeviceList"].get("Devices", []):
                        self.devices[dev["DeviceIndex"]] = dev
                        log.info(f"Device found: [{dev['DeviceIndex']}] {dev.get('DeviceName', '?')}")
            self._linear_device_cache = None
            self._scalar_device_cache = None
            self._scalar_steps = 0

            await self._send("StartScanning", {})
            asyncio.ensure_future(self._recv_loop())
            return True

        except Exception as e:
            log.error(f"Failed to connect to Intiface ({self.url}): {e}")
            return False

    async def disconnect(self) -> None:
        was_connected = self._connected
        self._connected = False
        self._linear_device_cache = None
        self._scalar_device_cache = None
        self._scalar_steps = 0
        if self.ws is not None:
            if self._is_ws_open():
                try:
                    await self.stop_all()
                except Exception:
                    pass
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
        await asyncio.sleep(DISCONNECT_WAIT_S)
        if was_connected:
            log.info("Intiface disconnected.")

    async def stop_all(self) -> None:
        await self._send("StopAllDevices", {})

    async def linear(self, device_index: int, duration_ms: int, position: float) -> None:
        position = max(0.0, min(1.0, position))
        await self._send("LinearCmd", {
            "DeviceIndex": device_index,
            "Vectors": [{"Index": 0, "Duration": int(duration_ms), "Position": position}],
        })

    def linear_devices(self) -> list:
        if self._linear_device_cache is not None:
            return self._linear_device_cache
        result = [
            idx for idx, dev in self.devices.items()
            if isinstance(dev.get("DeviceMessages", {}), dict)
            and "LinearCmd" in dev.get("DeviceMessages", {})
        ]
        if not result and self.devices:
            log.debug(f"No linear devices found. All devices: {list(self.devices.keys())}")
        self._linear_device_cache = result
        return result

    def scalar_devices(self) -> list:
        """[(device_index, [(actuator_index, actuator_type), ...]), ...]"""
        if self._scalar_device_cache is not None:
            return self._scalar_device_cache
        result = []
        for idx, dev in self.devices.items():
            msgs = dev.get("DeviceMessages", {})
            if not isinstance(msgs, dict):
                continue
            attrs = msgs.get("ScalarCmd")
            if not isinstance(attrs, list):
                continue
            acts = [
                (i, a.get("ActuatorType"))
                for i, a in enumerate(attrs)
                if isinstance(a, dict) and a.get("ActuatorType") in SCALAR_ACTUATORS
            ]
            if acts:
                result.append((idx, acts))
                steps = [a.get("StepCount") for i, a in enumerate(attrs)
                         if isinstance(a, dict) and a.get("ActuatorType") in SCALAR_ACTUATORS]
                steps = [int(x) for x in steps if isinstance(x, int) and x > 0]
                if steps:
                    self._scalar_steps = min(self._scalar_steps or 10**6, min(steps))
                log_debug(f"Scalar device [{idx}] {dev.get('DeviceName', '?')} "
                          f"actuators={acts} steps={steps}")
        if not result and self.devices:
            log.debug(f"No scalar devices found. All devices: {list(self.devices.keys())}")
        self._scalar_device_cache = result
        if self._scalar_steps:
            log.info(f"Scalar resolution: {self._scalar_steps} steps "
                     f"(minimum non-zero output {100.0/self._scalar_steps:.0f}%)")
        return result

    def scalar_step(self) -> float:
        """Smallest intensity change the hardware can actually act on."""
        if self._scalar_steps and self._scalar_steps > 0:
            return 1.0 / self._scalar_steps
        return VIBE_STEP

    async def scalar(self, device_index: int, actuators: list, intensity: float) -> None:
        intensity = max(0.0, min(1.0, intensity))
        await self._send("ScalarCmd", {
            "DeviceIndex": device_index,
            "Scalars": [
                {"Index": i, "Scalar": intensity, "ActuatorType": t}
                for i, t in actuators
            ],
        })


# ─── Funscript Player (Intiface Modus) ───────────────────────────────────────

def extract_peaks(actions: list,
                  prominence: float = BEAT_PEAK_PROMINENCE,
                  min_sep_ms: float = BEAT_PEAK_MIN_SEP_MS) -> list:
    """Reduce a densely sampled script to its stroke turnarounds.

    A point is kept when the direction of travel reverses there, the swing
    since the last kept point is at least `prominence`, and it is at least
    `min_sep_ms` after the last kept point. Flat runs are skipped so a paused
    section does not emit a peak per frame."""
    if len(actions) < 3:
        return list(actions)
    # Pass 1: every direction change, ignoring flat runs.
    turns: list = []
    direction = 0
    for i in range(1, len(actions)):
        delta = actions[i]["pos"] - actions[i - 1]["pos"]
        if delta == 0:
            continue
        nd = 1 if delta > 0 else -1
        if direction and nd != direction:
            turns.append(actions[i - 1])
        direction = nd
    if actions and direction:
        turns.append(actions[-1])
    if not turns:
        return []

    # Pass 2: keep a turn when the swing since the last KEPT turn is big enough
    # and it is far enough away in time. The anchor seeds from the first turn,
    # not from actions[0], which is usually mid-stroke and would make every
    # swing look half-size.
    out: list = [turns[0]]
    for cand in turns[1:]:
        if (abs(cand["pos"] - out[-1]["pos"]) >= prominence
                and cand["at"] - out[-1]["at"] >= min_sep_ms):
            out.append(cand)
    return out


def render_flow(actions: list, turns: list, smooth: float = FLOW_DEFAULT_SMOOTH,
                rhythm: float = FLOW_DEFAULT_RHYTHM, gain: float = FLOW_DEFAULT_GAIN,
                step_ms: int = FLOW_STEP_MS) -> tuple[int, list]:
    """Render a stroke script to a vibration track: (t0_ms, [level 0-1 per step]).

    Why render instead of computing each tick: with the whole script in hand
    the level can be normalised to this script's own busy parts (so no global
    sensitivity guess), smoothed with lookahead (so it rises with the action
    instead of after it), faded out when the action stops, and inspected or
    tested as a plain list.

    1. Stroke speed on a fixed grid, zero across idle gaps.
    2. Envelope follower: fast attack, slower release, both set by `smooth`.
       Shifted earlier by most of the attack so rises land on the action.
    3. Normalised so the envelope's FLOW_REF_PCT percentile over active time
       is 1.0, times `gain`, then through a gentle curve (FLOW_CURVE) so slow
       passages stay above the motor floor. Release tails below FLOW_CUTOFF
       are cut to zero, or a floor in the intensity limits would hum for
       seconds after a scene.
    4. Rhythm. Between consecutive turning points the level is held constant:
       on for the first part of the stroke, then dipped by `rhythm`. Holding
       it constant is what keeps this inside the BLE budget: one beat is at
       most two commands, and turning points are at least BEAT_PEAK_MIN_SEP_MS
       apart.
    """
    if len(actions) < 2:
        return (0, [])
    smooth = max(0.0, min(1.0, float(smooth)))
    rhythm = max(0.0, min(1.0, float(rhythm)))
    gain   = max(0.05, float(gain))
    att_ms = 60.0 + smooth * 300.0
    rel_ms = 250.0 + smooth * 1750.0

    t0 = int(actions[0]["at"])
    t_end = int(actions[-1]["at"] + rel_ms * 3)
    n = max(1, (t_end - t0) // step_ms + 1)

    # 1. speed per grid step
    speed = [0.0] * n
    for i in range(len(actions) - 1):
        a, b = actions[i], actions[i + 1]
        span = b["at"] - a["at"]
        if span <= 0 or span > VIBE_GAP_MS:
            continue
        v = abs(b["pos"] - a["pos"]) / span * 1000.0
        if v <= 0:
            continue
        j0 = max(0, int((a["at"] - t0) // step_ms))
        j1 = min(n, int((b["at"] - t0) // step_ms) + 1)
        for j in range(j0, j1):
            if v > speed[j]:
                speed[j] = v

    # 2. envelope, then lookahead shift
    k_att = 1.0 - math.exp(-step_ms / att_ms)
    k_rel = 1.0 - math.exp(-step_ms / rel_ms)
    env = [0.0] * n
    e = 0.0
    for j in range(n):
        v = speed[j]
        e += (v - e) * (k_att if v > e else k_rel)
        env[j] = e
    shift = int(att_ms * 0.7 // step_ms)
    if shift:
        env = env[shift:] + [env[-1]] * shift

    # 3. normalise against this script's own busy parts
    active = sorted(env[j] for j in range(n) if speed[j] > 0)
    if not active:
        return (t0, [0.0] * n)
    ref = active[min(len(active) - 1, int(len(active) * FLOW_REF_PCT))]
    if ref <= 0:
        return (t0, [0.0] * n)
    lvl = [0.0] * n
    for j in range(n):
        x = env[j] / ref * gain
        lvl[j] = 0.0 if x < FLOW_CUTOFF else (1.0 if x > 1.0 else x ** FLOW_CURVE)

    # 4. rhythm: hold each beat at one level, dip after the on-part
    if rhythm > 0.0 and len(turns) >= 2:
        for i in range(len(turns) - 1):
            ta, tb = turns[i]["at"], turns[i + 1]["at"]
            iv = tb - ta
            if iv <= 0 or iv > BEAT_GAP_MS:
                continue
            j0 = max(0, int((ta - t0) // step_ms))
            j1 = min(n, int((tb - t0) // step_ms))
            if j1 <= j0:
                continue
            level = max(lvl[j0:j1])
            if level <= 0.0:
                continue
            on_ms = max(MANUAL_MIN_ON_MS, min(400.0, iv * 0.45, iv - BEAT_MIN_GAP_MS))
            j_on = min(j1, j0 + max(1, int(on_ms // step_ms)))
            low = level * (1.0 - rhythm)
            for j in range(j0, j_on):
                lvl[j] = level
            for j in range(j_on, j1):
                lvl[j] = low
    return (t0, lvl)


def is_dense_script(actions: list) -> bool:
    """Fixed-rate tracker output: keyframes closer together than a stroke."""
    if len(actions) < BEAT_DETECT_MIN:
        return False
    gaps = [actions[i + 1]["at"] - actions[i]["at"] for i in range(len(actions) - 1)]
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return False
    gaps.sort()
    return gaps[len(gaps) // 2] < BEAT_DENSE_MEDIAN_MS


def tempo_grid_score(actions: list) -> float:
    """How musically quantised the timing is: the fraction of intervals that
    are a simple subdivision or multiple of the modal interval.

    This is what separates a Cock Hero script from an ordinary hand-scripted
    stroker file. Both alternate on nearly every keyframe with big swings, so
    shape alone cannot tell them apart, but only one is locked to a beat grid.
    """
    gaps = [actions[i + 1]["at"] - actions[i]["at"] for i in range(len(actions) - 1)]
    gaps = [g for g in gaps if 0 < g <= BEAT_GAP_MS]
    if len(gaps) < BEAT_DETECT_MIN:
        return 0.0
    counts: dict = {}
    for g in gaps:
        k = round(g / 10) * 10
        counts[k] = counts.get(k, 0) + 1
    base = max(counts, key=counts.get)
    if base <= 0:
        return 0.0
    on_grid = 0
    for g in gaps:
        r = g / base
        for n in (0.25, 1 / 3, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0):
            if abs(r - n) <= BEAT_GRID_TOL * max(1.0, n):
                on_grid += 1
                break
    return on_grid / len(gaps)


def detect_beat_script(actions: list) -> str:
    """Classify a Cock Hero style script. Returns "edge", "graded" or "".

    "edge"   nearly every keyframe is 0 or 100 and they alternate. Intensity
             lives in the beat rate, so beat level comes from the pace.
    "graded" every keyframe is still a turnaround, but the swings are graded
             (11<->90, 34<->81). Intensity lives in the swing height, so beat
             level comes from the amplitude.
    ""       a normal script; speed mode handles it.
    """
    if len(actions) < BEAT_DETECT_MIN:
        return ""

    # Path A: classic 0/100 square wave.
    edge = 0
    alternations = 0
    last_side = None
    for a in actions:
        p = a["pos"]
        side = "lo" if p <= BEAT_DETECT_EDGE else ("hi" if p >= 100 - BEAT_DETECT_EDGE else None)
        if side is None:
            continue
        edge += 1
        if last_side is not None and side != last_side:
            alternations += 1
        last_side = side
    # a stroker script that happens to hit both ends still alternates; the
    # give-away is that it does so on essentially every keyframe
    if (edge / len(actions) >= BEAT_DETECT_FRAC
            and alternations >= (edge - 1) * 0.9):
        return "edge"

    # Path B: graded square wave. Judge the shape, not the absolute positions.
    # A dense tracker script fails this twice over: it runs several samples in
    # one direction, and its per-sample swings are small.
    if is_dense_script(actions):
        return ""
    turns = moves = 0
    direction = 0
    swings: list = []
    for i in range(1, len(actions)):
        d = actions[i]["pos"] - actions[i - 1]["pos"]
        if d == 0:
            continue
        moves += 1
        swings.append(abs(d))
        nd = 1 if d > 0 else -1
        if direction and nd != direction:
            turns += 1
        direction = nd
    if moves < BEAT_DETECT_MIN:
        return ""
    swings.sort()
    if (turns / moves >= BEAT_ALT_FRAC
            and swings[len(swings) // 2] >= BEAT_MIN_MEDIAN_SWING
            and tempo_grid_score(actions) >= BEAT_GRID_FRAC):
        return "graded"
    return ""


class FunscriptPlayer:

    def __init__(self, buttplug: ButtplugClient):
        self.bp                = buttplug
        self.actions           = []
        self.playing           = False
        self.offset_ms         = 0
        self.rate              = 1.0     # video playbackRate
        self._sync_drift_ms    = 0.0     # last measured drift, for logging
        # signal preview (debug scope), disabled unless a client asks for it
        self.preview_cb        = None    # callable(list_of_samples) -> None
        self._preview_buf      = []
        self._preview_last_s   = 0.0
        self._preview_flush_s  = 0.0
        self._preview_script_s = 0.0
        self.stroke_min        = 0.0
        self.stroke_max        = 1.0
        self.invert            = False
        self._play_start_wall  = None
        self._play_start_media = None
        self._task             = None
        self._last_sent_idx    = -1
        self._last_log_s       = 0
        # vibe engine
        self.vibe_mode          = "speed"    # see VIBE_MODES
        self.beat_on_ms         = BEAT_DEFAULT_ON_MS
        self.beat_edge          = "all"      # "all" | "low" | "high": which keyframes count as beats
        self.beat_prominence    = BEAT_PEAK_PROMINENCE
        self._script_is_beat    = False
        self._script_beat_kind  = ""     # "" | "edge" | "graded"
        self._beat_level_src    = "speed"  # "speed" | "amp"
        self._beat_amp_ref      = BEAT_AMP_REF_MAX  # swing that means full intensity
        self._beats_peak_picked = False  # dense script reduced to turnarounds
        self._beats             = []     # keyframes beat mode fires on
        # flow mode: rendered intensity track, rebuilt on load and on tuning
        self.flow_smooth        = FLOW_DEFAULT_SMOOTH
        self.flow_rhythm        = FLOW_DEFAULT_RHYTHM
        self.flow_gain          = FLOW_DEFAULT_GAIN
        self._flow_t0           = 0
        self._flow              = []
        self._flow_turns        = []
        self.overview_cb        = None    # callable(dict) when the rendered track changes
        # dedicated vibrator track, played as intensity when present and enabled
        self.vibe_track         = []
        self.vibe_track_enabled = True
        self.vibe_max_speed     = VIBE_DEFAULT_MAXSPEED
        self.vibe_smooth        = VIBE_DEFAULT_SMOOTH
        self._vibe_level        = 0.0
        self._vibe_last_sent    = -1.0
        self._vibe_last_send_ms = 0.0
        self._vibe_last_log_s   = 0
        # global kill switch: when off nothing reaches the device at all
        self.output_enabled     = True
        # sub-step pulsing, for intensities below one hardware step
        self.substep_enabled    = False
        self._pwm_on            = False
        self._pwm_next_ms       = 0.0
        self._substep_duty      = 0.0
        # master intensity: scales everything the toy is told to do, script or not
        self.master             = MANUAL_DEFAULT_LEVEL
        # manual mode: drive the toy directly, no script involved
        self.manual_enabled     = False
        self.manual_shape       = MANUAL_DEFAULT_SHAPE
        self.manual_period_s    = MANUAL_DEFAULT_PERIOD
        self.manual_on_ms       = MANUAL_DEFAULT_ON_MS
        self.manual_depth       = MANUAL_DEFAULT_DEPTH
        self.manual_build       = MANUAL_DEFAULT_BUILD
        self.manual_build_amp   = MANUAL_DEFAULT_BUILD_AMP
        self.manual_amp_from    = MANUAL_DEFAULT_AMP_FROM
        self.manual_ceiling     = MANUAL_DEFAULT_CEILING
        self.manual_smooth      = MANUAL_DEFAULT_SMOOTH
        self.manual_micro_ms    = MANUAL_DEFAULT_MICROMS
        self._manual_started    = None
        self._manual_rand       = 0.5
        self._manual_rand_next  = 0.0
        self._manual_cycle      = 0
        self._manual_last_phase = 0.0
        self._manual_on_scale   = 1.0

    @property
    def manual_level(self) -> float:
        return self.master

    @manual_level.setter
    def manual_level(self, v: float) -> None:
        self.master = max(0.0, min(1.0, float(v)))

    def apply_settings(self, offset_ms=None, stroke_min=None, stroke_max=None, invert=None,
                       vibe_mode=None, vibe_max_speed=None, vibe_smooth=None,
                       vibe_substep=None, beat_on_ms=None, beat_edge=None,
                       beat_prominence=None, vibe_track=None, flow_smooth=None,
                       flow_rhythm=None, flow_gain=None):
        if offset_ms is not None and int(offset_ms) != self.offset_ms:
            self.offset_ms = int(offset_ms)
            # the stroker index was seated against the old offset
            if self._play_start_wall is not None:
                self._reset_index_for_time(self._current_media_ms() + self.offset_ms)
        if stroke_min is not None: self.stroke_min = float(stroke_min)
        if stroke_max is not None: self.stroke_max = float(stroke_max)
        if invert     is not None: self.invert     = bool(invert)
        if vibe_mode in VIBE_MODES:
            self.vibe_mode = vibe_mode
        if beat_on_ms is not None:
            self.beat_on_ms = max(MANUAL_MIN_ON_MS, min(1000.0, float(beat_on_ms)))
        if beat_edge in ("all", "low", "high"):
            self.beat_edge = beat_edge
        if beat_prominence is not None:
            newp = max(5.0, min(60.0, float(beat_prominence)))
            if abs(newp - self.beat_prominence) > 0.01:
                self.beat_prominence = newp
                self._rebuild_beats()
                self._flow_turns = extract_peaks(self.actions, self.beat_prominence,
                                                 BEAT_PEAK_MIN_SEP_MS) if self.actions else []
                self._render_flow()
        if vibe_max_speed is not None:
            self.vibe_max_speed = max(50.0, float(vibe_max_speed))
        if vibe_smooth is not None:
            self.vibe_smooth = max(0.05, min(1.0, float(vibe_smooth)))
        if vibe_track is not None:
            self.vibe_track_enabled = bool(vibe_track)
        flow_changed = False
        for name, val, lo, hi in (("flow_smooth", flow_smooth, 0.0, 1.0),
                                  ("flow_rhythm", flow_rhythm, 0.0, 1.0),
                                  ("flow_gain",   flow_gain,   0.25, 4.0)):
            if val is not None:
                v = max(lo, min(hi, float(val)))
                if abs(v - getattr(self, name)) > 1e-4:
                    setattr(self, name, v)
                    flow_changed = True
        if flow_changed:
            self._render_flow()
        if vibe_substep is not None:
            self.substep_enabled = bool(vibe_substep)
            if not self.substep_enabled:
                self._pwm_on      = False
                self._pwm_next_ms = 0.0
        log.info(f"Settings: offset={self.offset_ms}ms "
                 f"range=[{self.stroke_min:.2f},{self.stroke_max:.2f}] invert={self.invert} "
                 f"vibe={self.vibe_mode}/{self.vibe_max_speed:.0f}/{self.vibe_smooth:.2f} "
                 f"substep={self.substep_enabled} "
                 f"beat={self.beat_on_ms:.0f}ms/{self.beat_edge}/prom{self.beat_prominence:.0f} "
                 f"flow={self.flow_smooth:.2f}/{self.flow_rhythm:.2f}/x{self.flow_gain:.2f}")

    def _reset_vibe(self) -> None:
        self._vibe_level     = 0.0
        self._vibe_last_sent = -1.0
        self._pwm_on         = False
        self._pwm_next_ms    = 0.0
        self._substep_duty   = 0.0

    def _script_state(self, t_ms: float):
        """Interpolated (position 0-1, speed in funscript units/sec) at t, or None."""
        actions = self.actions
        if not actions:
            return None
        nxt = self._find_next_keyframe_idx(t_ms)
        if nxt is None or nxt == 0:
            return None                        # before first / past last keyframe
        a, b = actions[nxt - 1], actions[nxt]
        span = b["at"] - a["at"]
        if span <= 0:
            return (b["pos"] / 100.0, 0.0)
        if span > VIBE_GAP_MS:
            return (a["pos"] / 100.0, 0.0)     # long gap = script is idle here
        frac  = (t_ms - a["at"]) / span
        pos   = (a["pos"] + (b["pos"] - a["pos"]) * frac) / 100.0
        speed = abs(b["pos"] - a["pos"]) / span * 1000.0
        return (pos, speed)

    @staticmethod
    def _annotate_beats(beats: list) -> list:
        """Attach the pace and swing each beat is judged by, so thinning can
        merge a run of beats without losing how hard that run was."""
        out: list = []
        for i, b in enumerate(beats):
            ref = amp = None
            if i + 1 < len(beats):
                iv = beats[i + 1]["at"] - b["at"]
                if 0 < iv <= BEAT_GAP_MS:
                    ref, amp = iv, abs(beats[i + 1]["pos"] - b["pos"])
            if ref is None and i > 0:
                iv = b["at"] - beats[i - 1]["at"]
                if 0 < iv <= BEAT_GAP_MS:
                    ref, amp = iv, abs(b["pos"] - beats[i - 1]["pos"])
            nb = dict(b)
            nb["_ref"] = ref
            nb["_amp"] = amp
            out.append(nb)
        return out

    @staticmethod
    def _thin_beats(beats: list) -> list:
        """Drop beats no scalar device can articulate. A burst needs
        MANUAL_MIN_ON_MS to spin the motor up and BEAT_MIN_GAP_MS of silence
        after it, and the on-edge command is held off by VIBE_MIN_INTERVAL_MS
        for the BLE link. Below BEAT_THIN_MIN_MS apart that is unsatisfiable:
        the rate limiter swallows most of the beats and the rest smear into a
        solid buzz. Keep one beat per window and carry the loudest swing of the
        run onto it, so a fast passage still reads as a loud passage."""
        if not beats:
            return beats
        out = [beats[0]]
        for b in beats[1:]:
            if b["at"] - out[-1]["at"] >= BEAT_THIN_MIN_MS:
                out.append(b)
                continue
            prev = out[-1]
            if (b.get("_amp") or 0) > (prev.get("_amp") or 0):
                prev["_amp"] = b["_amp"]
        return out

    def _rebuild_beats(self) -> None:
        """Beat mode fires on turnarounds. A square-wave beat script already IS
        turnarounds, so it is used as-is; a densely sampled tracker script gets
        peak-picked first. Graded scripts, and anything beating faster than the
        device can follow, get annotated and thinned on top."""
        self._beats_peak_picked = False     # before the early return, or an
        if not self.actions:                # empty load keeps the last flag
            self._beats = self.actions
            return
        if self._script_is_beat or not is_dense_script(self.actions):
            base = self.actions
        else:
            peaks = extract_peaks(self.actions, self.beat_prominence, BEAT_PEAK_MIN_SEP_MS)
            # If picking collapsed the script to almost nothing the settings are
            # wrong for this file; fall back rather than go silent.
            base = peaks if len(peaks) >= BEAT_DETECT_MIN else self.actions
            self._beats_peak_picked = base is peaks

        # Normalise amplitude against this script's own reach, not the 0-100
        # nominal range: a script that tops out at 70 should still get to full.
        swings = sorted(abs(base[i + 1]["pos"] - base[i]["pos"])
                        for i in range(len(base) - 1))
        if swings:
            ref = swings[min(len(swings) - 1, int(len(swings) * BEAT_AMP_PCT))]
            self._beat_amp_ref = max(BEAT_AMP_REF_MIN, min(BEAT_AMP_REF_MAX, float(ref)))

        needs_thinning = any(0 < base[i + 1]["at"] - base[i]["at"] < BEAT_THIN_MIN_MS
                             for i in range(len(base) - 1))
        if not needs_thinning and self._beat_level_src != "amp":
            self._beats = base          # unchanged path, keeps identity
            return
        self._beats = self._thin_beats(self._annotate_beats(base))

    def using_vibe_track(self) -> bool:
        return bool(self.vibe_track_enabled and self.vibe_track and self.vibe_mode != "off")

    def load_vibe_track(self, actions: list) -> None:
        self.vibe_track = sorted(actions or [], key=lambda a: a["at"])
        if self.vibe_track:
            log.info(f"Vibrator track loaded: {len(self.vibe_track)} keyframes")

    def _vibe_track_level(self, t_ms: float) -> float:
        """Linear interpolation of the vibe track. Unlike a stroke script a long
        gap is held, not treated as idle: 50 for ten seconds means buzz at 50."""
        acts = self.vibe_track
        if not acts or t_ms < acts[0]["at"] or t_ms > acts[-1]["at"]:
            return 0.0
        i = self._beat_index(acts, t_ms)
        a = acts[max(0, i)]
        if i + 1 >= len(acts):
            return a["pos"] / 100.0
        b = acts[i + 1]
        span = b["at"] - a["at"]
        if span <= 0:
            return b["pos"] / 100.0
        return (a["pos"] + (b["pos"] - a["pos"]) * (t_ms - a["at"]) / span) / 100.0

    def effective_vibe_mode(self) -> str:
        if self.vibe_mode == "auto":
            return "beat" if self._script_is_beat else "flow"
        return self.vibe_mode

    def _render_flow(self) -> None:
        t = time.monotonic()
        self._flow_t0, self._flow = render_flow(self.actions, self._flow_turns,
                                                self.flow_smooth, self.flow_rhythm,
                                                self.flow_gain)
        ms = (time.monotonic() - t) * 1000.0
        if self._flow:
            log_debug(f"Flow rendered: {len(self._flow)} steps in {ms:.0f}ms")
        if self.overview_cb is not None:
            try:
                self.overview_cb(self.flow_overview())
            except Exception as e:
                log.debug(f"Overview callback failed: {e}")

    def _flow_level(self, t_ms: float) -> float:
        if not self._flow:
            return 0.0
        j = int((t_ms - self._flow_t0) // FLOW_STEP_MS)
        return self._flow[j] if 0 <= j < len(self._flow) else 0.0

    def flow_overview(self, points: int = FLOW_OVERVIEW_POINTS) -> dict:
        """Peak level per bucket across the whole scene, for the intensity strip."""
        f = self._flow
        if not f:
            return {"t0": 0, "t1": 0, "levels": []}
        per = max(1, math.ceil(len(f) / points))
        levels = [round(max(f[i:i + per]), 3) for i in range(0, len(f), per)]
        return {"t0": self._flow_t0, "t1": self._flow_t0 + len(f) * FLOW_STEP_MS,
                "levels": levels}

    @staticmethod
    def _beat_index(actions: list, t_ms: float) -> int:
        """Index of the last beat at or before t_ms, -1 if t is before the first."""
        lo, hi = 0, len(actions) - 1
        if t_ms < actions[0]["at"]:
            return -1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if actions[mid]["at"] <= t_ms:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def _beat_target(self, t_ms: float) -> float:
        """Burst level at t: nonzero only inside the first beat_on_ms after a
        keyframe. Level comes from the local pace (interval to the neighbouring
        keyframe) through the same speed mapping as speed mode, so vibe_max_speed
        and the intensity limits still apply."""
        actions = self._beats or self.actions
        if not actions:
            return 0.0
        i = self._beat_index(actions, t_ms)
        if i < 0:
            return 0.0
        if i < 0:
            return 0.0
        a = actions[i]
        if self.beat_edge == "low"  and a["pos"] > 50: return 0.0
        if self.beat_edge == "high" and a["pos"] < 50: return 0.0

        # pace reference: the interval to the next keyframe, or the previous one
        # at the end of a section. Two long gaps around it = isolated, stay quiet.
        if "_ref" in a:
            ref, dpos = a["_ref"], a["_amp"]      # precomputed, survives thinning
        else:
            ref = dpos = None
            if i + 1 < len(actions):
                iv = actions[i + 1]["at"] - a["at"]
                if 0 < iv <= BEAT_GAP_MS:
                    ref, dpos = iv, abs(actions[i + 1]["pos"] - a["pos"])
            if ref is None and i > 0:
                iv = a["at"] - actions[i - 1]["at"]
                if 0 < iv <= BEAT_GAP_MS:
                    ref, dpos = iv, abs(a["pos"] - actions[i - 1]["pos"])
        if ref is None:
            return 0.0

        on_ms = min(self.beat_on_ms, max(MANUAL_MIN_ON_MS, ref - BEAT_MIN_GAP_MS))
        if t_ms - a["at"] > on_ms:
            return 0.0
        if self._beat_level_src == "amp":
            # Graded script: the swing carries the intensity. Pace is already
            # expressed as how often the bursts land, so using it again here
            # would cancel the swing out (they move together by construction).
            target = self._shape(max(BEAT_AMP_FLOOR, min(1.0, dpos / self._beat_amp_ref)))
        else:
            target = self._vibe_target(1.0, dpos / ref * 1000.0)
        if target <= 0.0:
            return 0.0
        # never hand a burst to the sub-step pulser; one step is the floor here
        step = self.bp.scalar_step() if hasattr(self.bp, "scalar_step") else VIBE_STEP
        return max(step, target)

    def _shape(self, raw: float, allow_invert: bool = True) -> float:
        """Intensity limits, invert and master, applied to a 0..1 request."""
        raw = max(0.0, min(1.0, raw))
        if self.invert and allow_invert:
            raw = 1.0 - raw
        if raw <= 0.001:
            return 0.0                         # true silence, ignore the floor
        lo, hi = self.stroke_min, self.stroke_max
        shaped = lo + raw * (hi - lo)
        return max(0.0, min(1.0, shaped * self.master))

    def _vibe_target(self, pos: float, speed: float) -> float:
        if self.vibe_mode == "position":
            raw = pos
        else:
            raw = speed / self.vibe_max_speed if self.vibe_max_speed > 0 else 0.0
        return self._shape(raw)

    def _preview_script_window(self, media_ms: float) -> dict | None:
        """The slice of the funscript the scope can currently show.

        Sent alongside the samples so the preview can draw what the toy is
        reacting to, not just what it did. Downsampled by stride rather than by
        interpolation: keeping real keyframes means the beat markers still line
        up with the points the player actually fires on."""
        actions = self.actions
        if not actions:
            return None
        lo = media_ms - PREVIEW_SCRIPT_BACK
        hi = media_ms + PREVIEW_SCRIPT_AHEAD
        i0 = max(0, self._beat_index(actions, lo))
        pts = []
        i = i0
        while i < len(actions) and actions[i]["at"] <= hi:
            pts.append(actions[i])
            i += 1
        if not pts:
            return None
        stride = max(1, len(pts) // PREVIEW_SCRIPT_MAX + 1)
        thinned = pts[::stride]
        if thinned[-1] is not pts[-1]:
            thinned.append(pts[-1])

        # The first kept point sits at or before `lo` on purpose: without it the
        # drawn line would begin part-way across the scope. Report the bounds of
        # what is actually in the window rather than the requested range.
        out = {
            "t0":  round(thinned[0]["at"]),
            "t1":  round(thinned[-1]["at"]),
            "pts": [[round(a["at"]), a["pos"]] for a in thinned],
        }
        # Beat mode fires on turnarounds, which for a dense script are a small
        # subset of the keyframes. Mark them so the scope shows why a burst
        # happened where it did.
        if self.effective_vibe_mode() == "flow" and self._flow and not self.using_vibe_track():
            j0 = max(0, int((lo - self._flow_t0) // FLOW_STEP_MS))
            j1 = min(len(self._flow), int((hi - self._flow_t0) // FLOW_STEP_MS) + 1)
            stride = max(1, (j1 - j0) // PREVIEW_SCRIPT_MAX + 1)
            out["flow"] = [[round(self._flow_t0 + j * FLOW_STEP_MS), round(self._flow[j], 3)]
                           for j in range(j0, j1, stride)]
        if self.effective_vibe_mode() == "beat" and self._beats:
            b0 = max(0, self._beat_index(self._beats, lo))
            beats = []
            j = b0
            while j < len(self._beats) and self._beats[j]["at"] <= hi:
                beats.append(round(self._beats[j]["at"]))
                j += 1
                if len(beats) > PREVIEW_SCRIPT_MAX:
                    break
            out["beats"] = beats
        return out

    def _preview_sample(self, target: float, level: float,
                        media_ms: float | None = None, sent: bool = False) -> None:
        """Buffer one point for the debug scope. Cheap no-op when disabled."""
        if self.preview_cb is None:
            return
        now_s = time.monotonic()
        if not sent and (now_s - self._preview_last_s) < (1.0 / PREVIEW_HZ):
            return
        self._preview_last_s = now_s
        self._preview_buf.append({
            "t":  round(now_s * 1000.0, 1),
            "tg": round(max(0.0, min(1.0, target)), 3),
            "lv": round(max(0.0, min(1.0, level)), 3),
            "m":  (round(media_ms) if media_ms is not None else None),
            "s":  1 if sent else 0,
        })
        if (now_s - self._preview_flush_s) * 1000.0 >= PREVIEW_BATCH_MS:
            self._preview_flush_s = now_s
            buf, self._preview_buf = self._preview_buf, []
            script = None
            if (media_ms is not None
                    and (now_s - self._preview_script_s) * 1000.0 >= PREVIEW_SCRIPT_MS):
                self._preview_script_s = now_s
                script = self._preview_script_window(media_ms)
            try:
                self.preview_cb(buf, script)
            except Exception as e:
                log.debug(f"Preview callback failed: {e}")
        elif len(self._preview_buf) > PREVIEW_HZ * 2:
            self._preview_buf = self._preview_buf[-PREVIEW_HZ:]   # never grow unbounded

    async def _send_level(self, level: float, devices: list, now_wall: float) -> None:
        self._vibe_last_sent    = level
        self._vibe_last_send_ms = now_wall
        self._preview_sample(self._vibe_level, level, sent=True)
        for idx, acts in devices:
            try:
                await self.bp.scalar(idx, acts, level)
            except Exception as e:
                log.warning(f"ScalarCmd failed (device {idx}): {e}")

    async def _emit_substep(self, desired: float, step: float,
                            now_wall: float, devices: list) -> float:
        """Pulse between 0 and one step so the average lands below the floor.

        The on-pulse is a fixed length and the gap grows as the requested level
        drops, which keeps the command rate low exactly when the level is low.
        Below roughly a fifth duty this stops reading as vibration and starts
        reading as a repeating tick.
        """
        duty = max(SUBSTEP_MIN_DUTY, min(SUBSTEP_MAX_DUTY, desired / step))
        pulse_ms = max(40.0, min(1000.0, float(self.manual_micro_ms)))

        # Both halves of the cycle have to be long enough: the on-pulse so the
        # motor actually spins up, the gap so consecutive commands stay far
        # enough apart for BLE. Stretch the period until both fit, rather than
        # fixing the pulse and letting the duty drift away from what was asked.
        period = max(SUBSTEP_MIN_PERIOD_MS,
                     pulse_ms          / duty,
                     SUBSTEP_MIN_GAP_MS / (1.0 - duty))
        period = min(SUBSTEP_MAX_PERIOD_MS, period)
        on_ms  = duty * period
        self._substep_duty = duty

        if now_wall < self._pwm_next_ms:
            return step if self._pwm_on else 0.0

        if self._pwm_on:
            self._pwm_on      = False
            self._pwm_next_ms = now_wall + (period - on_ms)
            level = 0.0
        else:
            self._pwm_on      = True
            self._pwm_next_ms = now_wall + on_ms
            level = step

        await self._send_level(level, devices, now_wall)
        return level

    async def _emit_vibe(self, target: float, devices: list) -> float:
        """Smooth toward target, quantise, rate-limit, send. Returns the level."""
        self._vibe_level += (target - self._vibe_level) * self.vibe_smooth
        step     = self.bp.scalar_step() if hasattr(self.bp, "scalar_step") else VIBE_STEP
        desired  = max(0.0, min(1.0, self._vibe_level))
        now_wall = time.monotonic() * 1000.0

        # Silence always wins, and always cancels a pulse in progress.
        if target <= 0.0 and desired < step * 0.25:
            if self._pwm_on or self._vibe_last_sent != 0.0:
                self._pwm_on      = False
                self._pwm_next_ms = 0.0
                await self._send_level(0.0, devices, now_wall)
            return 0.0

        if self.substep_enabled and 0.0 < desired < step * SUBSTEP_MAX_DUTY:
            return await self._emit_substep(desired, step, now_wall, devices)

        self._pwm_on       = False
        self._pwm_next_ms  = 0.0
        self._substep_duty = 0.0

        level = round(desired / step) * step
        level = max(0.0, min(1.0, level))
        # A non-zero request must not round down into silence.
        if level == 0.0 and target > 0.0 and desired > step * 0.25:
            level = step

        to_zero  = level == 0.0 and self._vibe_last_sent != 0.0
        changed  = abs(level - self._vibe_last_sent) >= VIBE_MIN_DELTA
        if not (to_zero or changed):
            return level
        if not to_zero and now_wall - self._vibe_last_send_ms < VIBE_MIN_INTERVAL_MS:
            return level

        await self._send_level(level, devices, now_wall)
        return level

    async def _vibe_tick(self, now_ms: float, devices: list) -> None:
        mode = self.effective_vibe_mode()
        if self.using_vibe_track():
            mode   = "track"
            raw    = self._vibe_track_level(now_ms)
            target = self._shape(raw, allow_invert=False)
            self._vibe_level = target          # authored edges, no EMA
            state  = (raw, 0.0)
        elif mode == "flow":
            raw    = self._flow_level(now_ms)
            target = self._shape(raw)
            self._vibe_level = target          # already smoothed by the render
            state  = (raw, 0.0)
        elif mode == "beat":
            target = self._beat_target(now_ms)
            self._vibe_level = target          # no EMA: bursts must have sharp edges
            state  = (1.0 if target > 0 else 0.0, 0.0)
        else:
            state  = self._script_state(now_ms)
            target = 0.0 if state is None else self._vibe_target(*state)
        level  = await self._emit_vibe(target, devices)
        self._preview_sample(target, self._vibe_last_sent, media_ms=now_ms)

        now_s = time.monotonic()
        if now_s - self._vibe_last_log_s > 10.0:
            self._vibe_last_log_s = now_s
            p, s = state if state else (0.0, 0.0)
            sub = f" duty={self._substep_duty:.2f}" if self._substep_duty else ""
            log.debug(f"Vibe: now={now_ms:.0f}ms mode={mode}{sub} "
                      f"pos={p:.2f} speed={s:.0f} level={level:.2f} "
                      f"devices={[d[0] for d in devices]}")

    def _manual_shape_value(self, now_s: float) -> float:
        """Waveform value 0-1 before master intensity and ceiling are applied.

        Timing is in wall-clock seconds, not fractions of the cycle, so the
        burst modes really do fire one buzz of a known length once per period
        no matter how long the period is.
        """
        shape = self.manual_shape
        if shape == "constant":
            return 1.0

        period = max(0.2, float(self.manual_period_s))
        if self._manual_started is None:
            self._manual_started    = now_s
            self._manual_cycle      = 0
            self._manual_last_phase = 0.0

        elapsed = now_s - self._manual_started
        phase_s = elapsed % period
        phase   = phase_s / period

        # count completed cycles by watching the phase wrap
        if phase < self._manual_last_phase:
            self._manual_cycle += 1
        self._manual_last_phase = phase

        depth = max(0.0, min(0.95, float(self.manual_depth)))
        on_s  = max(MANUAL_MIN_ON_MS / 1000.0, float(self.manual_on_ms) / 1000.0)
        on_s  = min(on_s, period * 0.95)
        # Below the motor floor a burst cannot get quieter, only shorter, so
        # _manual_tick hands us a scale factor instead of a lower amplitude.
        on_s  = max(MANUAL_MIN_ON_MS / 1000.0, on_s * self._manual_on_scale)

        if shape == "wave":
            # sine that dips to `depth`, so it breathes instead of stuttering
            return depth + (1.0 - depth) * (0.5 - 0.5 * math.cos(2.0 * math.pi * phase))

        if shape == "pulse":
            # square wave: full for on_s, silent for the rest of the period
            return 1.0 if phase_s < on_s else 0.0

        if shape == "ramp":
            # climb across the whole period from `depth` to full, then drop
            return depth + (1.0 - depth) * phase

        if shape == "tease":
            # exactly one buzz per period, placed at the start of the cycle.
            # With build > 0 the buzz grows from MANUAL_MIN_ON_MS up to on_s
            # over that many cycles, then holds.
            build = max(0, int(self.manual_build))
            if build > 0:
                frac    = min(1.0, self._manual_cycle / float(build))
                min_s   = MANUAL_MIN_ON_MS / 1000.0
                this_on = min_s + (on_s - min_s) * frac
            else:
                this_on = on_s
            if phase_s >= this_on:
                return 0.0
            # Strength builds on its own count, so a tease can grow louder,
            # longer, or both. Same cycle counter as the length build.
            build_amp = max(0, int(self.manual_build_amp))
            if build_amp > 0:
                start = max(0.0, min(1.0, float(self.manual_amp_from)))
                frac  = min(1.0, self._manual_cycle / float(build_amp))
                return start + (1.0 - start) * frac
            return 1.0

        if shape == "random":
            if now_s >= self._manual_rand_next:
                self._manual_rand      = random.uniform(max(0.05, depth), 1.0)
                self._manual_rand_next = now_s + period * random.uniform(0.5, 1.5)
            return self._manual_rand

        return 1.0

    def _manual_is_gate(self) -> bool:
        """True for shapes that are on/off rather than continuous."""
        return self.manual_shape in ("pulse", "tease")

    async def _emit_manual(self, target: float, devices: list) -> float:
        """Manual output path. Keeps hard edges and honours the micro floor.

        Deliberately separate from _emit_vibe: the script path smooths and
        rate-limits to survive noisy funscripts, and that smoothing is exactly
        what was rounding the manual waveforms into mush.
        """
        step     = self.bp.scalar_step() if hasattr(self.bp, "scalar_step") else VIBE_STEP
        now_wall = time.monotonic() * 1000.0
        alpha    = max(0.02, min(1.0, float(self.manual_smooth)))

        # Gate shapes must not be smoothed or they lose the edge that makes
        # them readable at low intensity.
        if self._manual_is_gate() or alpha >= 0.999:
            self._vibe_level = target
        else:
            self._vibe_level += (target - self._vibe_level) * alpha
        desired = max(0.0, min(1.0, self._vibe_level))

        # Silence wins immediately and cancels any micro pulse in progress.
        if target <= 0.0:
            self._vibe_level = 0.0
            if self._pwm_on or self._vibe_last_sent != 0.0:
                self._pwm_on      = False
                self._pwm_next_ms = 0.0
                self._substep_duty = 0.0
                await self._send_level(0.0, devices, now_wall)
            return 0.0

        # Below one hardware step the only thing left to modulate is time.
        if self.substep_enabled and desired < step:
            return await self._emit_substep(desired, step, now_wall, devices)

        self._pwm_on       = False
        self._pwm_next_ms  = 0.0
        self._substep_duty = 0.0

        level = round(desired / step) * step
        level = max(step, min(1.0, level))    # a live request never rounds to silence

        changed = abs(level - self._vibe_last_sent) >= step * 0.5
        if not changed:
            return level
        if now_wall - self._vibe_last_send_ms < VIBE_MIN_INTERVAL_MS:
            return level

        await self._send_level(level, devices, now_wall)
        return level

    async def _manual_tick(self, devices: list) -> None:
        now_s   = time.monotonic()
        step    = self.bp.scalar_step() if hasattr(self.bp, "scalar_step") else VIBE_STEP
        ceiling = max(0.01, min(1.0, float(self.manual_ceiling)))
        peak    = self.master * ceiling

        # A burst shorter than the micro pulse period would be swallowed whole
        # by the sub-step duty cycle, so it would sometimes fire and sometimes
        # not. For the burst shapes, trade amplitude for on-time instead: run
        # the motor at its floor and shorten the buzz in proportion.
        gate_floor = (self._manual_is_gate() and self.substep_enabled
                      and 0.0 < peak < step)
        self._manual_on_scale = max(0.15, peak / step) if gate_floor else 1.0

        shaped = self._manual_shape_value(now_s)
        if gate_floor and shaped > 0.0:
            target = step
        else:
            target = max(0.0, min(1.0, shaped * peak))
            # A tease strength build can ask for a buzz below the motor floor
            # while the peak is above it. The pulser would chop that buzz into
            # ticks, so hold it at one step instead, as beat mode does.
            if self._manual_is_gate() and shaped > 0.0 and 0.0 < target < step:
                target = step
        level = await self._emit_manual(target, devices)
        self._preview_sample(target, self._vibe_last_sent)
        if now_s - self._vibe_last_log_s > 30.0:
            self._vibe_last_log_s = now_s
            sub = f" duty={self._substep_duty:.2f}" if self._substep_duty else ""
            log.debug(f"Manual: shape={self.manual_shape} wave={shaped:.2f} "
                      f"master={self.master:.2f} ceil={ceiling:.2f}{sub} "
                      f"target={target:.3f} level={level:.2f} "
                      f"devices={[d[0] for d in devices]}")

    def set_output(self, enabled: bool) -> None:
        was = self.output_enabled
        self.output_enabled = bool(enabled)
        if was and not self.output_enabled:
            self._reset_vibe()
            self._last_sent_idx = -1
            try:
                asyncio.ensure_future(self.bp.stop_all())
            except RuntimeError:
                pass
        if self.output_enabled and (self.manual_enabled or self.playing):
            self._ensure_loop()
        log.info(f"Output: {'enabled' if self.output_enabled else 'DISABLED'}")

    def set_manual(self, enabled=None, level=None, shape=None, period=None,
                   on_ms=None, depth=None, build=None, ceiling=None,
                   smooth=None, micro_ms=None, build_amp=None,
                   amp_from=None) -> None:
        if level is not None:
            self.master = max(0.0, min(1.0, float(level)))
        if shape in MANUAL_SHAPES:
            if shape != self.manual_shape:
                self._manual_started   = None
                self._manual_rand_next = 0.0
                self._manual_cycle     = 0
            self.manual_shape = shape
        if period is not None:
            self.manual_period_s = max(0.2, min(60.0, float(period)))
        if on_ms is not None:
            self.manual_on_ms = max(MANUAL_MIN_ON_MS, min(10000.0, float(on_ms)))
        if depth is not None:
            self.manual_depth = max(0.0, min(0.95, float(depth)))
        if build is not None:
            self.manual_build = max(0, min(200, int(build)))
        if build_amp is not None:
            self.manual_build_amp = max(0, min(200, int(build_amp)))
        if amp_from is not None:
            self.manual_amp_from = max(0.0, min(1.0, float(amp_from)))
        if ceiling is not None:
            self.manual_ceiling = max(0.01, min(1.0, float(ceiling)))
        if smooth is not None:
            self.manual_smooth = max(0.02, min(1.0, float(smooth)))
        if micro_ms is not None:
            self.manual_micro_ms = max(40.0, min(1000.0, float(micro_ms)))
        if enabled is not None:
            was = self.manual_enabled
            self.manual_enabled = bool(enabled)
            if not was and self.manual_enabled:
                self._manual_started   = None
                self._manual_rand_next = 0.0
            if was and not self.manual_enabled:
                self._reset_vibe()
                try:
                    asyncio.ensure_future(self.bp.stop_all())
                except RuntimeError:
                    pass
        if self.manual_enabled:
            self._ensure_loop()
        step = self.bp.scalar_step() if hasattr(self.bp, "scalar_step") else VIBE_STEP
        peak = self.master * self.manual_ceiling
        log.info(f"Manual: enabled={self.manual_enabled} shape={self.manual_shape} "
                 f"period={self.manual_period_s:.1f}s on={self.manual_on_ms:.0f}ms "
                 f"depth={self.manual_depth:.2f} build={self.manual_build} "
                 f"build_amp={self.manual_build_amp}/{self.manual_amp_from:.2f} "
                 f"master={self.master:.2f} ceiling={self.manual_ceiling:.2f} "
                 f"peak={peak:.3f} ({'sub-step' if peak < step else 'above floor'})")

    def _ensure_loop(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.ensure_future(self._loop())

    def _map_position(self, raw: float) -> float:
        pos = self.stroke_min + raw * (self.stroke_max - self.stroke_min)
        if self.invert:
            pos = self.stroke_min + self.stroke_max - pos
        return max(0.0, min(1.0, pos))

    def load(self, actions: list) -> None:
        self.actions = sorted(actions, key=lambda a: a["at"])
        self._last_sent_idx = -1
        self._script_beat_kind = detect_beat_script(self.actions)
        self._script_is_beat   = bool(self._script_beat_kind)
        self._beat_level_src   = "amp" if self._script_beat_kind == "graded" else "speed"
        self._rebuild_beats()
        self._flow_turns = (extract_peaks(self.actions, self.beat_prominence, BEAT_PEAK_MIN_SEP_MS)
                            if self.actions else [])
        self._render_flow()
        if self.actions:
            extra = ""
            if self._script_is_beat:
                extra = f" [beat script: {self._script_beat_kind}]"
                if len(self._beats) < len(self.actions):
                    extra += (f", thinned {len(self.actions)} -> {len(self._beats)} "
                              f"beats for the device")
            elif self._beats_peak_picked:
                extra = (f" [dense, {len(self._beats)} peaks extracted "
                         f"for beat mode]")
            elif len(self._beats) < len(self.actions):
                # A fast non-beat script can be thinned without being picked;
                # calling that "dense" sent debugging the wrong way.
                extra = (f" [thinned {len(self.actions)} -> {len(self._beats)} "
                         f"beats for beat mode]")
            log.info(f"Funscript loaded: {len(self.actions)} keyframes "
                     f"({self.actions[0]['at']}ms – {self.actions[-1]['at']}ms)" + extra)
        else:
            log.warning("Funscript loaded but empty.")

    def play(self, media_time_ms: float, rate: float | None = None) -> None:
        if rate is not None and rate > 0:
            self.rate = float(rate)
        self._play_start_wall  = time.monotonic()
        self._play_start_media = media_time_ms
        self._reset_index_for_time(media_time_ms + self.offset_ms)
        self.playing = True
        self._ensure_loop()
        log_debug(f"Play @ {media_time_ms:.0f}ms ({len(self.actions)} keyframes)")

    def pause(self) -> None:
        self.playing        = False
        self._last_sent_idx = -1
        if self.manual_enabled:
            log_debug("Paused (manual mode still running)")
            return
        self._reset_vibe()
        asyncio.ensure_future(self.bp.stop_all())
        log_debug(f"Paused")

    def seek(self, media_time_ms: float) -> None:
        self._play_start_wall  = time.monotonic()
        self._play_start_media = media_time_ms
        self._reset_index_for_time(media_time_ms + self.offset_ms)
        log_debug(f"Seek @ {media_time_ms:.0f}ms")

    def stop(self) -> None:
        self.playing        = False
        self._last_sent_idx = -1
        self.manual_enabled = False
        self._reset_vibe()
        if self._task and not self._task.done():
            self._task.cancel()
        asyncio.ensure_future(self.bp.stop_all())

    def panic(self) -> None:
        """Hard stop: script, manual shape and device output. Loop stays alive."""
        self.playing         = False
        self._last_sent_idx  = -1
        self.manual_enabled  = False
        self._manual_started = None
        self._reset_vibe()
        asyncio.ensure_future(self.bp.stop_all())

    def _current_media_ms(self) -> float:
        if self._play_start_wall is None:
            return 0.0
        return (self._play_start_media
                + (time.monotonic() - self._play_start_wall) * 1000.0 * self.rate)

    def sync(self, media_time_ms: float, rate: float | None = None) -> None:
        """Re-anchor to the browser's clock. Called from the frontend heartbeat
        while the video plays. Without this the backend free-runs from the last
        play/seek and slowly slides against the video, which looks exactly like
        a broken offset setting."""
        if rate is not None and rate > 0 and abs(rate - self.rate) > 0.01:
            log.info(f"Playback rate {self.rate:.2f} -> {rate:.2f}")
            self.rate = float(rate)
            self._play_start_wall  = time.monotonic()
            self._play_start_media = media_time_ms
            self._reset_index_for_time(media_time_ms + self.offset_ms)
            return
        if not self.playing or self._play_start_wall is None:
            return
        drift = self._current_media_ms() - media_time_ms   # >0: backend is ahead
        self._sync_drift_ms = drift
        if abs(drift) >= SYNC_SNAP_MS:
            log.debug(f"Clock re-anchored, drift {drift:+.0f}ms")
            self._play_start_wall  = time.monotonic()
            self._play_start_media = media_time_ms
            self._reset_index_for_time(media_time_ms + self.offset_ms)
        elif drift:
            # gentle pull, no audible jump
            self._play_start_media -= drift * SYNC_GAIN

    def _find_next_keyframe_idx(self, t_ms: float) -> int | None:
        actions = self.actions
        if not actions:
            return None
        lo, hi = 0, len(actions)
        while lo < hi:
            mid = (lo + hi) // 2
            if actions[mid]["at"] < t_ms:
                lo = mid + 1
            else:
                hi = mid
        return lo if lo < len(actions) else None

    def _reset_index_for_time(self, t_ms: float) -> None:
        nxt = self._find_next_keyframe_idx(t_ms)
        if nxt is None:
            self._last_sent_idx = len(self.actions) - 1
        else:
            self._last_sent_idx = nxt - 1

    async def _loop(self) -> None:
        interval_s = SEND_INTERVAL_MS / 1000.0
        while True:
            await asyncio.sleep(interval_s)

            # kill switch: stay in the loop so re-enabling is instant, send nothing
            if not self.output_enabled:
                continue

            # manual mode wins: constant level, no script, ignores play state
            if self.manual_enabled:
                if self.vibe_mode != "off":
                    manual_devs = self.bp.scalar_devices()
                    if manual_devs:
                        await self._manual_tick(manual_devs)
                continue

            if not self.playing or not self.actions:
                continue

            now_ms  = self._current_media_ms() + self.offset_ms

            # vibrating devices (Lovense etc.) – continuous intensity
            if self.vibe_mode != "off":
                scalar_devs = self.bp.scalar_devices()
                # With the preview on, tick even with no device attached: the
                # scope should show what would be sent. _send_level() loops the
                # device list, so an empty one emits nothing.
                if scalar_devs or self.preview_cb is not None:
                    await self._vibe_tick(now_ms, scalar_devs)

            # stroking devices – keyframe driven (original behaviour)
            devices = self.bp.linear_devices()
            if not devices:
                continue

            last_kf       = None
            last_duration = 0

            while self._last_sent_idx + 1 < len(self.actions):
                kf_idx = self._last_sent_idx + 1
                kf     = self.actions[kf_idx]
                if kf["at"] > now_ms + LOOKAHEAD_MS:
                    break

                if kf_idx + 1 < len(self.actions):
                    next_kf  = self.actions[kf_idx + 1]
                    duration = max(MIN_DURATION_MS, int(next_kf["at"] - now_ms))
                else:
                    duration = MIN_DURATION_MS

                kf_pos = self._map_position(kf["pos"] / 100.0)

                for idx in devices:
                    try:
                        await self.bp.linear(idx, duration, kf_pos)
                    except Exception as e:
                        log.warning(f"LinearCmd failed (device {idx}): {e}")

                self._last_sent_idx += 1
                last_kf       = kf
                last_duration = duration

            if last_kf is not None:
                now_s = time.monotonic()
                if now_s - self._last_log_s > 10.0:
                    self._last_log_s = now_s
                    log.debug(f"Loop: now={now_ms:.0f}ms kf={last_kf['at']:.0f}ms "
                              f"pos={self._map_position(last_kf['pos']/100.0):.2f} "
                              f"dur={last_duration}ms devices={devices}")


# ─── Utility ─────────────────────────────────────────────────────────────────

# axis suffixes used by multi-axis scripts; these should never win over the main script
AXIS_SUFFIXES = ("roll", "pitch", "yaw", "twist", "sway", "surge", "suck", "vib",
                 "l0", "l1", "l2", "r0", "r1", "r2", "alpha", "beta")
# A dedicated vibrator track ("video.vib.funscript", the multi-axis convention,
# plus the spellings people actually use). Its position IS the intensity, so it
# beats anything derived from stroke motion. Never the main script: a stroker
# still follows the main one.
VIBE_TRACK_SUFFIXES = ("vib", "vibe", "vibes", "vibrate", "vibration", "vibrator", "v0")


def _tail_after(base: str, stem: str) -> str | None:
    """The suffix of `base` after `stem`, or None if base does not start with it."""
    if len(base) <= len(stem) or not base.lower().startswith(stem.lower()):
        return None
    return base[len(stem):].strip(" ._-").lower()


def is_vibe_track_name(script_path: str) -> bool:
    stem  = os.path.splitext(os.path.basename(script_path or ""))[0]
    parts = [x for x in re.split(r"[ ._-]+", stem) if x]
    return len(parts) > 1 and parts[-1].lower() in VIBE_TRACK_SUFFIXES


def find_vibe_track(script_path: str) -> str | None:
    """The vibrator track that belongs to `script_path`, if there is one.

    Matched on the script's own name, not the video's, so it follows whatever
    script the user picked. A script that is itself a vibe track has none."""
    if not script_path:
        return None
    d    = os.path.dirname(script_path)
    stem = os.path.splitext(os.path.basename(script_path))[0]
    if is_vibe_track_name(script_path):
        return None
    try:
        names = sorted(os.listdir(d))
    except Exception:
        return None
    for name in names:
        if not name.lower().endswith(".funscript"):
            continue
        base = os.path.splitext(name)[0]
        if _tail_after(base, stem) in VIBE_TRACK_SUFFIXES:
            return os.path.join(d, name)
    return None


def _norm_name(s: str) -> str:
    """Collapse to comparable form: lowercase alphanumerics only.

    Generators sanitise filenames differently (FunGen turns spaces and brackets
    into underscores), so exact basename matching misses constantly.
    """
    return re.sub(r"[^a-z0-9]+", "", s.lower())


def _best_match(video_name: str, funscripts: list) -> str:
    target = _norm_name(video_name)
    exact, normal, prefix = [], [], []

    for fs in funscripts:
        base = os.path.splitext(os.path.basename(fs))[0]
        if base.lower() == video_name.lower():
            exact.append(fs)
            continue
        nb = _norm_name(base)
        if nb == target:
            normal.append(fs)
        elif target and nb.startswith(target):
            # e.g. "video.roll.funscript" - keep, but rank below a clean match
            tail = base[len(video_name):].strip(" ._-").lower() if len(base) > len(video_name) else ""
            prefix.append((tail in AXIS_SUFFIXES, fs))

    if exact:
        return exact[0]
    if normal:
        log.info(f"Matched funscript by normalised name: {os.path.basename(normal[0])}")
        return normal[0]
    if prefix:
        prefix.sort(key=lambda x: x[0])          # non-axis variants first
        log.info(f"Matched funscript by name prefix: {os.path.basename(prefix[0][1])}")
        return prefix[0][1]

    log.warning(f"No funscript name matches {video_name!r}; "
                f"defaulting to {os.path.basename(funscripts[0])}. "
                f"Pick the right one from the dropdown if this is wrong.")
    return funscripts[0]


def find_funscripts(video_path: str) -> tuple[list, str | None]:
    if not video_path:
        return [], None
    try:
        video_path = unquote(video_path)
    except Exception:
        pass

    video_dir  = os.path.dirname(video_path)
    video_name = os.path.splitext(os.path.basename(video_path))[0]

    if not video_dir or not os.path.isdir(video_dir):
        log.warning(f"Invalid video directory: {video_dir!r}")
        return [], None

    try:
        all_files = os.listdir(video_dir)
    except Exception as e:
        log.error(f"Cannot read directory {video_dir!r}: {e}")
        return [], None

    funscripts = sorted([
        os.path.join(video_dir, f)
        for f in all_files
        if f.lower().endswith(".funscript")
    ])

    if not funscripts:
        log_debug(f"No funscripts found in {video_dir!r}")
        return [], None

    default_script = _best_match(video_name, funscripts)

    if funscripts[0] != default_script:
        funscripts.remove(default_script)
        funscripts.insert(0, default_script)

    log.info(f"Found {len(funscripts)} funscript(s), default: {os.path.basename(default_script)}")
    return funscripts, default_script


def load_funscript_file(path: str, invert: bool = False) -> list | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        actions = data.get("actions", [])
        if invert:
            actions = [{**a, "pos": 100 - a.get("pos", 0)} for a in actions]
        log.info(f"Funscript read: {path} ({len(actions)} keyframes, invert={invert})")
        return actions
    except Exception as e:
        log.error(f"Failed to read funscript {path!r}: {e}")
        return None




# ─── Backend Server ───────────────────────────────────────────────────────────

class BackendServer:

    def __init__(self):
        self.clients          = set()
        self._last_seen       = time.monotonic()   # deadman: last frontend message
        self._preview_on      = False              # debug scope, opt-in per session
        self._mode            = "intiface"   # "intiface" | "handy_wifi"
        self._pending_actions = None
        self._current_script_path: str | None = None
        self._vibe_track_path: str | None = None
        self._output          = True
        self._manual          = {"enabled": False, "level": MANUAL_DEFAULT_LEVEL,
                                 "shape": MANUAL_DEFAULT_SHAPE,
                                 "period": MANUAL_DEFAULT_PERIOD,
                                 "on_ms": MANUAL_DEFAULT_ON_MS,
                                 "depth": MANUAL_DEFAULT_DEPTH,
                                 "build": MANUAL_DEFAULT_BUILD,
                                 "build_amp": MANUAL_DEFAULT_BUILD_AMP,
                                 "amp_from": MANUAL_DEFAULT_AMP_FROM,
                                 "ceiling": MANUAL_DEFAULT_CEILING,
                                 "smooth": MANUAL_DEFAULT_SMOOTH,
                                 "micro_ms": MANUAL_DEFAULT_MICROMS}

        # Intiface. The client and player exist before anything is connected so
        # script loading and the signal preview work without a device attached;
        # ButtplugClient._send() is a no-op while its socket is closed, so an
        # idle player cannot drive anything.
        self._intiface_url    = "ws://localhost:12345"
        self.bp               = ButtplugClient(self._intiface_url)
        self.player           = FunscriptPlayer(self.bp)
        self._last_overview   = None
        self.player.overview_cb = self._overview_emit

        # Handy WiFi
        self._handy_key       = ""
        self._handy           = None
        self._handy_playing   = False
        self._handy_connected = False
        self._tunnel          = TunnelManager()
        self._fs_server       = FunscriptServer()
        self._tunnel_url      = None
        self._last_setup_path = None
        self._last_setup_tunnel = None

    def _preview_emit(self, samples: list, script: dict | None = None) -> None:
        """Called from the player's audio-rate loop, so it must not await."""
        if not self._preview_on or not self.clients:
            return
        msg = {"type": "preview", "samples": samples}
        if script:
            msg["script"] = script
        try:
            asyncio.ensure_future(self._broadcast(msg))
        except RuntimeError:
            pass

    def _overview_emit(self, overview: dict) -> None:
        """The rendered Flow track changed: send the whole-scene strip."""
        self._last_overview = overview
        if not self.clients:
            return
        try:
            asyncio.ensure_future(self._broadcast({"type": "overview", **overview}))
        except RuntimeError:
            pass

    # ── Safety: panic stop + deadman ──────────────────────────────────────────

    async def _panic(self, reason: str) -> None:
        log.info(f"PANIC stop ({reason})")
        self._manual["enabled"] = False
        if self._mode == "intiface":
            if self.player:
                self.player.panic()
            if self.bp:
                try:
                    await self.bp.stop_all()
                except Exception as e:
                    log.warning(f"stop_all failed during panic: {e}")
        else:
            try:
                await self._handy_pause()
            except Exception as e:
                log.warning(f"Handy pause failed during panic: {e}")

    def _device_active(self) -> bool:
        if self._mode == "intiface":
            return bool(self.player and (self.player.manual_enabled or self.player.playing))
        return bool(self._handy_playing)

    async def _watchdog(self) -> None:
        """Stop output if no frontend has spoken for DEADMAN_S seconds.
        Covers browser crash, laptop sleep, network drop: cases where no
        close frame ever reaches us."""
        while True:
            await asyncio.sleep(DEADMAN_TICK_S)
            idle = time.monotonic() - self._last_seen
            if idle > DEADMAN_S and self._device_active():
                await self._panic(f"deadman timeout, {idle:.0f}s without frontend")
                self._last_seen = time.monotonic()
                try:
                    await self._broadcast_status("Stopped: no frontend heartbeat")
                except Exception:
                    pass

    # ── Status Broadcast ──────────────────────────────────────────────────────

    async def _broadcast_status(self, error: str = "") -> None:
        if not self.clients:
            return

        if self._mode == "intiface":
            await self._broadcast({
                "type":      "status",
                "mode":      "intiface",
                "connected": self.bp.connected if self.bp else False,
                "playing":   self.player.playing if self.player else False,
                "manual":    bool(self.player.manual_enabled) if self.player
                             else self._manual.get("enabled", False),
                "manualLevel": (self.player.manual_level if self.player
                                else self._manual.get("level", MANUAL_DEFAULT_LEVEL)),
                "outputEnabled": (bool(self.player.output_enabled) if self.player
                                  else self._output),
                "manualShape": (self.player.manual_shape if self.player
                                else self._manual.get("shape", MANUAL_DEFAULT_SHAPE)),
                "manualPeriod": (self.player.manual_period_s if self.player
                                 else self._manual.get("period", MANUAL_DEFAULT_PERIOD)),
                "manualOnMs": (self.player.manual_on_ms if self.player
                               else self._manual.get("on_ms", MANUAL_DEFAULT_ON_MS)),
                "manualDepth": (self.player.manual_depth if self.player
                                else self._manual.get("depth", MANUAL_DEFAULT_DEPTH)),
                "manualBuild": (self.player.manual_build if self.player
                                else self._manual.get("build", MANUAL_DEFAULT_BUILD)),
                "manualBuildAmp": (self.player.manual_build_amp if self.player
                                   else self._manual.get("build_amp", MANUAL_DEFAULT_BUILD_AMP)),
                "manualAmpFrom": (self.player.manual_amp_from if self.player
                                  else self._manual.get("amp_from", MANUAL_DEFAULT_AMP_FROM)),
                "manualCeiling": (self.player.manual_ceiling if self.player
                                  else self._manual.get("ceiling", MANUAL_DEFAULT_CEILING)),
                "manualMicroMs": (self.player.manual_micro_ms if self.player
                                  else self._manual.get("micro_ms", MANUAL_DEFAULT_MICROMS)),
                "scalarStep": (self.bp.scalar_step() if self.bp else VIBE_STEP),
                "beatScript": bool(self.player and self.player._script_is_beat),
                "beatKind": (self.player._script_beat_kind if self.player else ""),
                "beatPeaks": (len(self.player._beats) if self.player else 0),
                "driftMs": (round(self.player._sync_drift_ms) if self.player else 0),
                "previewOn": self._preview_on,
                "rate": (self.player.rate if self.player else 1.0),
                "beatPicked": bool(self.player and self.player._beats_peak_picked),
                "vibeEffective": ("track" if self.player and self.player.using_vibe_track()
                                  else self.player.effective_vibe_mode() if self.player else "speed"),
                "vibeTrack": (os.path.basename(self._vibe_track_path)
                              if self._vibe_track_path and self.player and self.player.vibe_track
                              else ""),
                "devices":   [
                    {"index": idx, "name": dev.get("DeviceName", "?"),
                     "kind": device_kind(dev)}
                    for idx, dev in (self.bp.devices.items() if self.bp else {})
                ],
                "error": error,
            })
        else:
            await self._broadcast({
                "type":       "status",
                "mode":       "handy_wifi",
                "connected":  self._handy_connected,
                "playing":    self._handy_playing,
                "tunnelUrl":  self._tunnel_url,
                "error":      error,
            })

    async def _broadcast(self, msg: dict) -> None:
        if not self.clients:
            return
        try:
            data = json.dumps(msg)
        except TypeError as e:
            log.error(f"Failed to serialize broadcast message: {e} | msg={msg!r}")
            return
        dead = set()
        for ws in self.clients:
            try:
                await ws.send(data)
            except Exception:
                dead.add(ws)
        self.clients -= dead

    async def _broadcast_event(self, level: str, message: str, **extra):
        payload = json.dumps({
            "type": "event",
            "level": level,
            "message": message,
            **extra,
        })
        for ws in list(self.clients):
            try:
                await ws.send(payload)
            except Exception:
                pass

    # ── Message Handler ───────────────────────────────────────────────────────

    async def _handle(self, ws, msg: dict) -> None:
        if msg.get("type") == "ping":
            return   # heartbeat only, _last_seen already touched by the handler

        if msg.get("type") == "preview":
            self._preview_on = bool(msg.get("enabled"))
            if self.player:
                self.player.preview_cb = self._preview_emit if self._preview_on else None
                self.player._preview_buf = []
                # Without a device the loop may not be running; the scope needs
                # it to produce anything at all.
                if self._preview_on and (self.player.playing or self.player.manual_enabled):
                    self.player._ensure_loop()
            log.info(f"Signal preview: {'on' if self._preview_on else 'off'}")
            await self._broadcast_status()
            return

        if msg.get("type") == "sync":
            if self._mode == "intiface" and self.player:
                self.player.sync(float(msg.get("time", 0.0)), msg.get("rate"))
            return
        t = msg.get("type", "")
        log_debug(f"Message: {t} – {str(msg)[:300]}")

        # ── Modus wechseln ────────────────────────────────────────────────────
        if t == "setMode":
            new_mode = msg.get("mode", "intiface")
            if new_mode not in ("intiface", "handy_wifi"):
                await self._broadcast_status("Unknown mode")
                return
            await self._switch_mode(new_mode)
            return

        # ── Intiface: Connect ─────────────────────────────────────────────────
        if t == "connect":
            if self._mode != "intiface":
                log.info("connect received but mode != intiface → switching to intiface")
                await self._switch_mode("intiface")

            url = msg.get("url", self._intiface_url)
            self._intiface_url = url

            if self.player:
                self.player.stop()
            if self.bp is not None:
                try:
                    await self.bp.disconnect()
                except Exception as e:
                    log_debug(f"Disconnect before reconnect failed (ignored): {e}")

            carried       = self.player.actions if self.player else None
            carried_track = self.player.vibe_track if self.player else []
            carried_track_on = self.player.vibe_track_enabled if self.player else True

            self.bp     = ButtplugClient(url)
            self.player = FunscriptPlayer(self.bp)
            self.player.overview_cb = self._overview_emit

            # A script loaded while idle must survive the swap, or connecting a
            # device would silently unload it.
            if carried and self._pending_actions is None:
                self.player.load(carried)
                self.player.load_vibe_track(carried_track)
            self.player.vibe_track_enabled = carried_track_on
            if self._pending_actions is not None:
                log.info(f"Loading buffered funscript ({len(self._pending_actions)} actions)")
                self.player.load(self._pending_actions)
                self._pending_actions = None

            async def on_device_change(_):
                await self._broadcast_status()
            self.bp.on("DeviceAdded",   on_device_change)
            self.bp.on("DeviceRemoved", on_device_change)

            ok = await self.bp.connect()
            if ok:
                # a reconnect builds a fresh player, so re-arm it with whatever
                # script was loaded before, otherwise playback silently does nothing
                if not self.player.actions and self._current_script_path:
                    log.info(f"Reconnect: reloading {os.path.basename(self._current_script_path)}")
                    await self._load_script(
                        self._current_script_path,
                        invert=getattr(self, "_current_invert", False),
                    )
                self.player.set_output(self._output)
                if self._preview_on:
                    self.player.preview_cb = self._preview_emit
                # restore shape/period/depth, never the on-switch
                self._manual["enabled"] = False
                self.player.set_manual(**{**self._manual, "enabled": False})
            await self._broadcast_status("" if ok else f"Failed to connect to {url}")
            return

        # ── Handy WiFi: Connect ───────────────────────────────────────────────
        if t == "connectHandy":
            if self._mode != "handy_wifi":
                log.info("connectHandy received but mode != handy_wifi → switching")
                await self._switch_mode("handy_wifi")

            key = msg.get("connectionKey", "").strip()
            if not key:
                await self._broadcast_status("No connection key provided")
                return

            self._handy_key = key
            if self._handy:
                await self._handy.close()

            self._handy = HandyClient(key)
            self._handy_connected = False

            result = await self._handy._get("/info")
            log_debug(f"Handy /info response: {result}")
            ok = bool(result.get("sessionId"))
            if not ok:
                log.warning("Handy not reachable – no sessionId in /info response")
                await self._handy.close()
                self._handy = None
                self._handy_connected = False
                await self._broadcast_status("Handy not reachable – check connection key and WiFi")
                return

            self._handy_connected = True
            log.info("Handy connected.")

            # start Tunnel
            await self._broadcast({"type": "info", "message": "Starting tunnel..."})
            self._tunnel_url = await self._tunnel.start(FUNSCRIPT_PORT)
            if not self._tunnel_url:
                await self._handy.close()
                self._handy = None
                self._handy_connected = False
                await self._broadcast_status("Failed to start tunnel")
                return

            # If Funscript is already loaded → set it up right away
            if self._current_script_path:
                await self._handy_setup_script(
                    self._current_script_path,
                    invert=getattr(self, "_current_invert", False),
                )

            await self._broadcast_status()
            return

        # ── Find Funscripts ─────────────────────────────────────────────────
        if t == "findFunscripts":
            video_path = msg.get("videoPath", "")
            files, default = find_funscripts(video_path)
            await self._broadcast({"type": "funscripts", "files": files, "default": default})
            return

        # ── Loading Funscript ───────────────────────────────────────────────────
        if t == "loadFile":
            path   = msg.get("path", "")
            force  = bool(msg.get("force", False))
            invert = bool(msg.get("invert", False))
            log.info(f"loadFile: path={path!r} force={force} invert={invert}")
            await self._load_script(path, force=force, invert=invert)
            return

        # ── Play ──────────────────────────────────────────────────────────────
        if t == "play":
            time_ms = float(msg.get("time", 0))
            if self._mode == "intiface":
                if self.player:
                    if not self.player.actions:
                        log.warning("Play requested but no funscript is loaded "
                                    f"(script path: {self._current_script_path!r})")
                    self.player.play(time_ms, msg.get("rate"))
            else:
                await self._handy_play(time_ms)
            await self._broadcast_status()
            return

        # ── Pause ─────────────────────────────────────────────────────────────
        if t == "pause":
            if self._mode == "intiface":
                if self.player:
                    self.player.pause()
            else:
                await self._handy_pause()
            await self._broadcast_status()
            return

        # ── Seek ──────────────────────────────────────────────────────────────
        if t == "seek":
            time_ms = float(msg.get("time", 0))
            if self._mode == "intiface":
                if self.player:
                    self.player.seek(time_ms)
            else:
                if self._handy_playing:
                    await self._handy_seek(time_ms)
                elif self._handy and self._handy_connected:
                    await self._handy.pause()
                    await asyncio.sleep(0.1)
            return

        # ── Settings ───────────────────────────────────────────
        if t == "settings":
            if self._mode == "intiface":
                if self.player:
                    self.player.apply_settings(
                        offset_ms      = msg.get("offsetMs"),
                        stroke_min     = msg.get("strokeMin"),
                        stroke_max     = msg.get("strokeMax"),
                        invert         = msg.get("invert"),
                        vibe_mode      = msg.get("vibeMode"),
                        vibe_max_speed = msg.get("vibeMaxSpeed"),
                        vibe_smooth    = msg.get("vibeSmooth"),
                        vibe_substep   = msg.get("vibeSubstep"),
                        beat_on_ms     = msg.get("beatMs"),
                        beat_edge      = msg.get("beatEdge"),
                        beat_prominence = msg.get("beatProminence"),
                        vibe_track     = msg.get("vibeTrack"),
                        flow_smooth    = msg.get("flowSmooth"),
                        flow_rhythm    = msg.get("flowRhythm"),
                        flow_gain      = msg.get("flowGain"),
                    )
            else:
                # Handy-Mode
                if msg.get("offsetMs") is not None:
                    self._handy_offset_ms = int(msg.get("offsetMs"))
                stroke_min = msg.get("strokeMin")
                stroke_max = msg.get("strokeMax")
                if (stroke_min is not None or stroke_max is not None) and self._handy:
                    mn = float(stroke_min) if stroke_min is not None else 0.0
                    mx = float(stroke_max) if stroke_max is not None else 1.0
                    await self._handy.set_slide(mn, mx)
            await self._broadcast_status()
            return

        # ── Global output toggle ──────────────────────────────────────────────
        if t == "output":
            self._output = bool(msg.get("enabled", True))
            if self.player:
                self.player.set_output(self._output)
            elif not self._output and self.bp:
                try:
                    await self.bp.stop_all()
                except Exception:
                    pass
            await self._broadcast_status()
            return

        # ── Manual control ────────────────────────────────────────────────────
        if t == "manual":
            if msg.get("enabled") is not None:
                self._manual["enabled"] = bool(msg.get("enabled"))
            if msg.get("level") is not None:
                self._manual["level"] = max(0.0, min(1.0, float(msg.get("level"))))
            if msg.get("shape") in MANUAL_SHAPES:
                self._manual["shape"] = msg.get("shape")
            if msg.get("period") is not None:
                self._manual["period"] = max(0.2, min(60.0, float(msg.get("period"))))
            if msg.get("onMs") is not None:
                self._manual["on_ms"] = max(MANUAL_MIN_ON_MS,
                                            min(10000.0, float(msg.get("onMs"))))
            if msg.get("depth") is not None:
                self._manual["depth"] = max(0.0, min(0.95, float(msg.get("depth"))))
            if msg.get("build") is not None:
                self._manual["build"] = max(0, min(200, int(msg.get("build"))))
            if msg.get("buildAmp") is not None:
                self._manual["build_amp"] = max(0, min(200, int(msg.get("buildAmp"))))
            if msg.get("ampFrom") is not None:
                self._manual["amp_from"] = max(0.0, min(1.0, float(msg.get("ampFrom"))))
            if msg.get("ceiling") is not None:
                self._manual["ceiling"] = max(0.01, min(1.0, float(msg.get("ceiling"))))
            if msg.get("smooth") is not None:
                self._manual["smooth"] = max(0.02, min(1.0, float(msg.get("smooth"))))
            if msg.get("microMs") is not None:
                self._manual["micro_ms"] = max(40.0, min(1000.0, float(msg.get("microMs"))))
            if self._mode != "intiface":
                await self._broadcast_status("Manual mode is Intiface only")
                return
            if not self.player:
                await self._broadcast_status("Connect to Intiface first")
                return
            self.player.set_manual(**self._manual)
            await self._broadcast_status()
            return

        # ── Stop ──────────────────────────────────────────────────────────────
        if t == "stop":
            # Tab close and Disconnect both land here. player.stop() alone left
            # the app-level manual flag set, so a later manual message could
            # re-arm tease; _panic() is the one path that clears everything.
            await self._panic("stop requested")
            if self._mode == "intiface":
                if self.player:
                    self.player.stop()
                if self.bp:
                    try:
                        await self.bp.disconnect()
                    except Exception:
                        pass
            else:
                await self._tunnel.stop()
                self._tunnel_url = None
                if self._handy:
                    await self._handy.close()
                    self._handy = None
                    self._last_setup_path = None
                    self._last_setup_tunnel = None
                self._handy_connected = False
                self._handy_playing = False
            await self._broadcast_status()
            return

        # ── Status ────────────────────────────────────────────────────────────
        if t == "status":
            await self._broadcast_status()
            return
    # ── Switch Mode ────────────────────────────────────────────────────────

    async def _switch_mode(self, new_mode: str) -> None:
        if new_mode == self._mode:
            await self._broadcast_status()
            return

        log.info(f"Switching mode: {self._mode} → {new_mode}")

        if self._mode == "intiface":
            if self.player:
                self.player.stop()
            if self.bp:
                try:
                    await self.bp.disconnect()
                except Exception as e:
                    log_debug(f"Disconnect during mode switch failed (ignored): {e}")
        else:
            await self._handy_pause()
            await self._tunnel.stop()
            self._tunnel_url = None
            if self._handy:
                await self._handy.close()
                self._handy = None
                self._last_setup_path = None
                self._last_setup_tunnel = None
            # ← Reset Handy-State
            self._handy_connected = False
            self._handy_playing   = False

        self._mode = new_mode
        await self._broadcast_status()

    # ── Handy Helpfunctions ─────────────────────────────────────────────────

    async def _handy_setup_script(self, path: str, force: bool = False, invert: bool = False) -> bool:
        log_debug(f"_handy_setup_script: path={path} force={force} invert={invert}")
        if not self._handy or not self._tunnel_url:
            log.warning("Cannot setup HSSP script: Handy or tunnel not ready")
            return False
        if not force and getattr(self, "_last_setup_path", None) == path \
                and getattr(self, "_last_setup_tunnel", None) == self._tunnel_url \
                and getattr(self, "_last_setup_invert", None) == invert:  # invert check
            log_debug(f"HSSP setup skipped (already set): {path}")
            return True

        await self._broadcast_event("info", f"Script upload started: {os.path.basename(path)}")
        try:
            # Create a temporary inverted file if necessary
            if invert:
                actions = load_funscript_file(path, invert=True)
                if actions is None:
                    raise ValueError("Failed to load funscript for invert")
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data["actions"] = actions
                tmp_path = path + ".inverted.funscript"
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(data, f)
                serve_path = tmp_path
            else:
                serve_path = path

            self._fs_server.serve(serve_path)
            script_url = f"{self._tunnel_url}/script.funscript"
            sha        = sha256_file(serve_path)
            result = await self._handy.setup_hssp(script_url, sha)
            log.info(f"HSSP setup OK: {os.path.basename(path)} (invert={invert})")
            log_debug(f"HSSP setup full response: {result}")
            self._last_setup_path   = path
            self._last_setup_tunnel = self._tunnel_url
            self._last_setup_invert = invert
            await self._broadcast_event("success", "Script upload successful", uploaded=True)
            return True
        except Exception as e:
            log.error(f"HSSP setup failed: {e}")
            await self._broadcast_event("error", f"Script upload failed: {e}")
            await self._broadcast_status(f"HSSP setup failed: {e}")
            return False


    async def _handy_play(self, time_ms: float) -> None:
        if not self._handy or not self._handy_connected:
            log_debug(f"Handy play skipped: not connected")
            return
        try:
            adjusted = time_ms + getattr(self, "_handy_offset_ms", 0)
            result = await self._handy.play(adjusted)
            if isinstance(result, dict) and result.get("error"):
                self._handy_playing = False
                err = result["error"]
                log.warning(f"Handy play returned error: {err}")
                if err.get("name") in ("DeviceTimeout", "DeviceNotConnected"):
                    self._handy_connected = False
                    await self._broadcast_status(f"Handy disconnected: {err.get('message','')}")
            else:
                self._handy_playing = True
                log_debug(f"Handy play @ {adjusted:.0f}ms")
        except Exception as e:
            log.error(f"Handy play failed: {e}")
            await self._broadcast_status(f"Handy play failed: {e}")

    async def _handy_pause(self) -> None:
        if not self._handy or not self._handy_connected:
            self._handy_playing = False
            return
        result = await self._handy._put("/hssp/stop", {})
        self._handy_playing = False
        if result.get("error") and result["error"]["name"] in ("DeviceTimeout", "DeviceNotConnected"):
            self._handy_connected = False
            log.warning(f"Handy pause: device disconnected ({result['error']})")
        else:
            log_debug(f"Handy paused")
            log_debug(f"Handy pause response: {result}")

    async def _handy_seek(self, time_ms: float) -> None:
        if not self._handy:
            return
        try:
            adjusted = time_ms + getattr(self, "_handy_offset_ms", 0)
            if self._handy:
                await self._handy.pause()
            await asyncio.sleep(0.1)
            await self._handy.play(adjusted)
            self._handy_playing = True
            log_debug(f"Handy seek @ {adjusted:.0f}ms")
        except Exception as e:
            log.error(f"Handy seek failed: {e}")

    # ── Load script (both modes) ─────────────────────────────────────────────

    async def _load_script(self, path: str, force: bool = False, invert: bool = False) -> None:
        log.info(f"Loading script: {os.path.basename(path) if path else '(empty)'} (force={force}, invert={invert})")
        if not path:
            return

        self._current_script_path = path
        self._current_invert = invert

        if self._mode == "intiface":
            actions = load_funscript_file(path, invert=invert)
            if actions is None:
                await self._broadcast_status(f"Failed to load: {path}")
                return
            if not self.player:
                log.info(f"Player not ready – buffering ({len(actions)} actions)")
                self._pending_actions = actions
                await self._broadcast_status()
                return
            self.player.load(actions)
            self._pending_actions = None
            # Never inverted: invert flips stroke direction, and a vibe track's
            # position is already an intensity.
            # The picked script may itself be the vibe track (a folder with
            # nothing else in it); then it is its own track.
            track = path if is_vibe_track_name(path) else find_vibe_track(path)
            track_actions = (load_funscript_file(track) if track and track != path
                             else [dict(a) for a in actions] if track else None)
            self.player.load_vibe_track(track_actions or [])
            self._vibe_track_path = track if track_actions else None

        else:  # handy_wifi
            if self._handy and self._tunnel_url:
                await self._handy_setup_script(path, force=force, invert=invert)
            else:
                log.info("Handy not connected yet – script will be sent on connect")

        await self._broadcast_status()

    # ── WebSocket Handler ─────────────────────────────────────────────────────

    async def _ws_handler(self, ws) -> None:
        self.clients.add(ws)
        log.info(f"Frontend connected: {ws.remote_address} (clients={len(self.clients)})")
        try:
            await self._broadcast_status()
            if self._last_overview:
                await ws.send(json.dumps({"type": "overview", **self._last_overview}))
            async for raw in ws:
                self._last_seen = time.monotonic()
                try:
                    await self._handle(ws, json.loads(raw))
                except json.JSONDecodeError:
                    log.warning(f"Invalid JSON from frontend: {raw[:200]}")
                except Exception as e:
                    log.error(f"Handler error: {e}", exc_info=True)
                    try:
                        await self._broadcast_status(str(e))
                    except Exception:
                        pass
        except websockets.exceptions.ConnectionClosed:
            log_debug(f"Frontend connection closed: {ws.remote_address}")
        except Exception as e:
            log.warning(f"WS handler ended unexpectedly: {e}")
        finally:
            self.clients.discard(ws)
            log.info(f"Frontend disconnected (remaining clients={len(self.clients)})")
            if not self.clients:
                try:
                    await self._panic("no clients left")
                except Exception as e:
                    log.warning(f"Panic on disconnect failed: {e}")

                # Reset Handy-State, damit nach Page-Reload neu verbunden werden muss
                if self._mode == "handy_wifi":
                    try:
                        await self._tunnel.stop()
                    except Exception as e:
                        log_debug(f"Tunnel stop on disconnect failed (ignored): {e}")
                    self._tunnel_url = None
                    if self._handy:
                        try:
                            await self._handy.close()
                        except Exception as e:
                            log_debug(f"Handy close on disconnect failed (ignored): {e}")
                        self._handy = None
                    self._handy_connected   = False
                    self._handy_playing     = False
                    self._last_setup_path   = None
                    self._last_setup_tunnel = None

    async def run(self) -> None:
        log.info(f"Backend starting on ws://{BACKEND_HOST}:{BACKEND_PORT}")
        loop       = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        loop.add_signal_handler(signal.SIGTERM, stop_event.set)
        loop.add_signal_handler(signal.SIGINT,  stop_event.set)

        watchdog = asyncio.create_task(self._watchdog())
        async with ws_serve(self._ws_handler, BACKEND_HOST, BACKEND_PORT,
                            ping_interval=WS_PING_INTERVAL_S,
                            ping_timeout=WS_PING_TIMEOUT_S):
            log.info(f"Backend ready, listening on ws://{BACKEND_HOST}:{BACKEND_PORT} "
                     f"(deadman {DEADMAN_S}s)")
            await stop_event.wait()
        watchdog.cancel()

        log.info("Shutdown signal received, cleaning up...")
        # Cleanup: stop the device first, "Stop Backend" must never leave it running
        try:
            await self._panic("backend shutdown")
            if self.bp:
                await self.bp.disconnect()
        except Exception as e:
            log.warning(f"Device stop on shutdown failed: {e}")
        self._fs_server.stop()
        await self._tunnel.stop()
        if self._handy:
            await self._handy.close()
        log.info("Server stopped.")


# ─── Daemon / Main ────────────────────────────────────────────────────────────

def release_lock() -> None:
    try:
        os.remove(LOCK_FILE)
    except OSError:
        pass


def daemonize(ready_fd: int = -1) -> None:
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    sys.stdout.flush()
    sys.stderr.flush()
    with open(os.devnull, "r") as f:
        os.dup2(f.fileno(), sys.stdin.fileno())

    log_fh = open(LOG_FILE, "a")
    os.dup2(log_fh.fileno(), sys.stdout.fileno())
    os.dup2(log_fh.fileno(), sys.stderr.fileno())

    logging.root.handlers.clear()
    logging.basicConfig(
        level=logging.DEBUG if DEBUG else logging.INFO,
        format="%(asctime)s [IntifaceSync] %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )



def _wait_pid_gone(pid: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.1)
    return False


def _port_open(host: str, port: int, timeout: float = 0.2) -> bool:
    with socket.socket() as s:
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            return True
        except OSError:
            return False


def main() -> None:
    mode = "startBackend"
    try:
        mode = json.loads(sys.stdin.read()).get("args", {}).get("mode", "startBackend")
    except Exception:
        pass

    if mode == "stopBackend":
        if not os.path.exists(LOCK_FILE):
            log.info("No running backend found.")
            return
        try:
            with open(LOCK_FILE) as f:
                pid = int(f.read().strip())
        except Exception as e:
            log.warning(f"Failed to read lock file: {e}")
            return
        try:
            os.kill(pid, signal.SIGTERM)
            log.info(f"Stop signal sent to PID {pid}, waiting...")
        except ProcessLookupError:
            log.info(f"PID {pid} already gone, cleaning lock.")
            try: os.remove(LOCK_FILE)
            except OSError: pass
            return
        except Exception as e:
            log.warning(f"Failed to stop backend: {e}")
            return

        if _wait_pid_gone(pid, timeout=5.0):
            log.info(f"Backend (PID {pid}) stopped cleanly.")
        else:
            log.warning(f"Backend (PID {pid}) did not stop in time, sending SIGKILL.")
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _wait_pid_gone(pid, timeout=2.0)
            log.info(f"Backend (PID {pid}) force-killed.")
        if os.path.exists(LOCK_FILE):
            try: os.remove(LOCK_FILE)
            except OSError: pass
        return

    if mode == "startBackend":
        if os.path.exists(LOCK_FILE):
            try:
                with open(LOCK_FILE) as f:
                    pid = int(f.read().strip())
                os.kill(pid, 0)
                log.info(f"Backend already running (PID {pid}), exiting.")
                return
            except (ProcessLookupError, ValueError, OSError):
                log_debug(f"Stale lock file found, will be replaced.")

        log.info("Starting backend as daemon...")
        r, w = os.pipe()
        os.set_inheritable(w, True)

        pid = os.fork()
        if pid > 0:
            os.close(w)
            deadline = time.time() + 10.0
            ready = False
            while time.time() < deadline:
                rlist, _, _ = select.select([r], [], [], 0.2)
                if r in rlist:
                    data = os.read(r, 1)
                    if data == b"":
                        ready = True
                        break
                    if data == b"K":
                        ready = True
                        break
            os.close(r)
            os.waitpid(pid, 0)
            if ready and _port_open("127.0.0.1", BACKEND_PORT):
                log.info(f"Backend is up and listening on port {BACKEND_PORT}.")
            elif ready:
                log.error(f"Daemon signaled ready but port {BACKEND_PORT} not open.")
            else:
                log.error(f"Timeout waiting for backend startup (port {BACKEND_PORT}).")
            return

        os.close(r)
        daemonize(ready_fd=w)

        with open(LOCK_FILE, "w") as f:
            f.write(str(os.getpid()))

        log.info(f"Daemon started (PID {os.getpid()}), log: {LOG_FILE}")

        server = BackendServer()

        async def _run_with_ready():
            async def _signal_when_ready():
                for _ in range(100):
                    if _port_open("127.0.0.1", BACKEND_PORT):
                        break
                    await asyncio.sleep(0.1)
                try:
                    os.write(w, b"K")
                    os.close(w)
                except OSError:
                    pass

            asyncio.create_task(_signal_when_ready())
            await server.run()

        try:
            asyncio.run(_run_with_ready())
        finally:
            try: os.close(w)
            except OSError: pass
        release_lock()




if __name__ == "__main__":
    main()
