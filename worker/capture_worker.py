"""
Sentinel Gujarat — OpenCV capture worker

Sandbox rules enforced (per integrator guide at sentinel.gujarat.gov.in):
1. RTSP over TCP only — UDP fails across NAT/firewalls (OPENCV_FFMPEG_CAPTURE_OPTIONS)
2. Dynamic catalog via cctv.corp8.cloud/cameras.json (and on-demand via backend)
3. Monotonic PTS via CAP_PROP_POS_MSEC — never wall-clock or CAP_PROP_FPS
4. Exponential backoff reconnect: 2s → 30s cap
5. Non-fatal H.264/H.265 join warnings until first IDR
6. Scene discontinuity handling for looping sandbox feeds
7. On-demand: only open RTSP when UI/worker sessions are active
8. HLS fallback when RTSP port 8554 is blocked
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import time
import warnings
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse, urlunparse

import cv2
import httpx
import numpy as np

# --- Rule 1: Force RTSP over TCP (never UDP) ---
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("sentinel.capture")

# ---------------------------------------------------------------------------
# Environment / sandbox configuration
# ---------------------------------------------------------------------------
SANDBOX_INGEST_URL  = os.environ.get("SANDBOX_INGEST_URL",  "https://cctv.corp8.cloud/cameras.json")
SANDBOX_HLS_BASE    = os.environ.get("SANDBOX_HLS_BASE",    "https://cctv.corp8.cloud")
SANDBOX_WHEP_BASE   = os.environ.get("SANDBOX_WHEP_BASE",   "http://103.250.160.189:8889/stream")
SANDBOX_RTSP_HOST   = os.environ.get("SANDBOX_RTSP_HOST",   "103.250.160.189:8554")
SANDBOX_EMAIL       = os.environ.get("SANDBOX_EMAIL",        "")
SANDBOX_PASSWORD    = os.environ.get("SANDBOX_PASSWORD",     "")
BACKEND_URL         = os.environ.get("BACKEND_URL",          "http://localhost:8000")
INTERNAL_SERVICE_KEY = os.environ.get("INTERNAL_SERVICE_KEY", "sentinel-worker-internal-key")
CATALOG_REFRESH_SECONDS = int(os.environ.get("CATALOG_REFRESH_SECONDS", "60"))
ACTIVE_POLL_SECONDS     = float(os.environ.get("ACTIVE_POLL_SECONDS", "5"))

BACKOFF_START        = 2.0
BACKOFF_CAP          = 30.0
PTS_JUMP_THRESHOLD_MS = 2000.0   # scene discontinuity / loop cut


def _service_headers() -> dict[str, str]:
    return {"X-Service-Key": INTERNAL_SERVICE_KEY}


# ---------------------------------------------------------------------------
# URL builders  (mirror config.py helpers so worker is self-contained)
# ---------------------------------------------------------------------------
def _encoded_email() -> str:
    return SANDBOX_EMAIL.replace("@", "%40")


def build_rtsp_url(cam_id: str) -> str:
    """rtsp://email%40domain:password@103.250.160.189:8554/stream/cam01"""
    if SANDBOX_EMAIL and SANDBOX_PASSWORD:
        return f"rtsp://{_encoded_email()}:{SANDBOX_PASSWORD}@{SANDBOX_RTSP_HOST}/stream/{cam_id}"
    return f"rtsp://{SANDBOX_RTSP_HOST}/stream/{cam_id}"


def build_hls_url(cam_id: str) -> str:
    """https://cctv.corp8.cloud/cam01/index.m3u8  (CDN, no creds in URL)"""
    return f"{SANDBOX_HLS_BASE.rstrip('/')}/{cam_id}/index.m3u8"


def build_whep_url(cam_id: str) -> str:
    """http://email%40domain:password@103.250.160.189:8889/stream/cam01/whep"""
    base = SANDBOX_WHEP_BASE.rstrip("/")
    if SANDBOX_EMAIL and SANDBOX_PASSWORD:
        parsed = urlparse(base)
        netloc = f"{_encoded_email()}:{SANDBOX_PASSWORD}@{parsed.netloc}"
        base = urlunparse(parsed._replace(netloc=netloc))
    return f"{base}/{cam_id}/whep"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------
@dataclass
class TrackState:
    """Simple centroid tracker keyed by local id — resets on scene cuts."""
    next_id: int = 1
    tracks: dict[int, dict[str, Any]] = field(default_factory=dict)
    last_pts_ms: float | None = None


@dataclass
class CameraCapture:
    external_id: str
    rtsp_url: str
    hls_url: str = ""
    cap: cv2.VideoCapture | None = None
    backoff: float = BACKOFF_START
    joined: bool = False
    decode_warnings: int = 0
    tracker: TrackState = field(default_factory=TrackState)
    bg_subtractor: Any = None
    last_open_attempt: float = 0.0
    using_hls: bool = False          # True when HLS fallback is active


# ---------------------------------------------------------------------------
# Supervisor
# ---------------------------------------------------------------------------
class CaptureSupervisor:
    def __init__(self) -> None:
        self._running = True
        self._cameras: dict[str, CameraCapture] = {}
        # catalog: cam_id -> {"rtsp": ..., "hls": ...}
        self._catalog: dict[str, dict[str, str]] = {}
        self._last_catalog_fetch = 0.0

    def stop(self, *_args: Any) -> None:
        self._running = False
        logger.info("Shutting down capture supervisor...")

    # -----------------------------------------------------------------------
    # Rule 2: Dynamic catalog — prefer backend DB (no sandbox web session).
    # Sandbox allows only ONE web session per IP; never login from the worker.
    # -----------------------------------------------------------------------
    def refresh_catalog(self) -> None:
        now = time.monotonic()
        if now - self._last_catalog_fetch < CATALOG_REFRESH_SECONDS and self._catalog:
            return

        catalog: dict[str, dict[str, str]] = {}
        try:
            # Read cameras already synced into our backend (no cctv.corp8.cloud login)
            with httpx.Client(timeout=15.0) as client:
                resp = client.get(
                    f"{BACKEND_URL.rstrip('/')}/api/v1/cameras",
                    headers=_service_headers(),
                )
                resp.raise_for_status()
                items = resp.json()
            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    cam_id = str(item.get("external_id") or item.get("id") or "").strip()
                    if not cam_id:
                        continue
                    rtsp = item.get("rtsp_url") or build_rtsp_url(cam_id)
                    hls = item.get("hls_url") or build_hls_url(cam_id)
                    # Prefer built credentialed RTSP for sandbox cam IDs
                    if cam_id.startswith("cam"):
                        rtsp = build_rtsp_url(cam_id)
                        hls = build_hls_url(cam_id)
                    catalog[cam_id] = {"rtsp": str(rtsp), "hls": str(hls)}
            self._catalog = catalog
            self._last_catalog_fetch = now
            logger.info("Catalog refreshed: %d cameras from backend", len(catalog))
        except Exception as e:
            logger.error("Catalog refresh from backend failed: %s", e)

    # -----------------------------------------------------------------------
    # Rule 7: On-demand — only open feeds requested by active sessions
    # -----------------------------------------------------------------------
    def fetch_active_sessions(self) -> set[str]:
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(
                    f"{BACKEND_URL.rstrip('/')}/api/v1/stream/active",
                    headers=_service_headers(),
                )
                resp.raise_for_status()
                data = resp.json()
            active: set[str] = set()
            for cam in data.get("active_cameras", []):
                eid = cam.get("external_id")
                if eid:
                    active.add(str(eid))
                    # Accept RTSP URL from session payload if catalog is missing it
                    if cam.get("rtsp_url") and eid not in self._catalog:
                        self._catalog[eid] = {
                            "rtsp": cam["rtsp_url"],
                            "hls": build_hls_url(eid),
                        }
            return active
        except Exception as e:
            logger.warning("Active session poll failed (will not open new feeds): %s", e)
            return set()

    # -----------------------------------------------------------------------
    # Stream open / close
    # -----------------------------------------------------------------------
    def open_capture(self, state: CameraCapture) -> bool:
        now = time.monotonic()
        if now - state.last_open_attempt < state.backoff:
            return False
        state.last_open_attempt = now

        # Rule 1: TCP transport every time
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

        # Try RTSP first; fall back to HLS if RTSP fails (Rule 8)
        urls_to_try = [(state.rtsp_url, False)]
        if state.hls_url:
            urls_to_try.append((state.hls_url, True))

        for url, is_hls in urls_to_try:
            proto = "HLS" if is_hls else "RTSP (TCP)"
            logger.info("Opening %s for %s (backoff=%.1fs)", proto, state.external_id, state.backoff)
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            if cap.isOpened():
                state.cap = cap
                state.using_hls = is_hls
                state.joined = False
                state.decode_warnings = 0
                state.backoff = BACKOFF_START
                state.tracker = TrackState()
                state.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
                    history=200, varThreshold=32, detectShadows=False
                )
                return True
            cap.release()
            logger.warning("Failed to open %s via %s", state.external_id, proto)

        # Both failed — apply backoff
        state.backoff = min(state.backoff * 2.0, BACKOFF_CAP)
        logger.warning("All transports failed for %s — retry in %.1fs", state.external_id, state.backoff)
        return False

    def close_capture(self, state: CameraCapture) -> None:
        if state.cap is not None:
            try:
                state.cap.release()
            except Exception:
                pass
            state.cap = None
        state.joined = False
        state.using_hls = False

    # -----------------------------------------------------------------------
    # Rule 6: Scene discontinuity (looping sandbox feeds)
    # -----------------------------------------------------------------------
    def handle_scene_discontinuity(self, state: CameraCapture, pts_ms: float) -> bool:
        prev = state.tracker.last_pts_ms
        state.tracker.last_pts_ms = pts_ms
        if prev is None:
            return False
        delta = pts_ms - prev
        if delta < -100 or abs(delta) > PTS_JUMP_THRESHOLD_MS:
            logger.info(
                "Scene discontinuity on %s (ΔPTS=%.1f ms) — resetting tracker/BG",
                state.external_id, delta,
            )
            state.tracker = TrackState(last_pts_ms=pts_ms)
            if state.bg_subtractor is not None:
                state.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
                    history=200, varThreshold=32, detectShadows=False
                )
            return True
        return False

    # -----------------------------------------------------------------------
    # Rule 3: Frame processing — PTS-driven, never wall-clock / CAP_PROP_FPS
    # -----------------------------------------------------------------------
    def process_frame(self, state: CameraCapture, frame: np.ndarray, pts_ms: float) -> None:
        discontinuity = self.handle_scene_discontinuity(state, pts_ms)
        if discontinuity or state.bg_subtractor is None:
            return

        # Lightweight motion blobs for demo tracking
        fg = state.bg_subtractor.apply(frame)
        _, thresh = cv2.threshold(fg, 200, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        detections: list[tuple[float, float]] = []
        for cnt in contours:
            if cv2.contourArea(cnt) < 400:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            detections.append((x + w / 2.0, y + h / 2.0))

        # Associate by nearest centroid; velocity from ΔPTS only (Rule 3)
        prev_tracks = state.tracker.tracks
        new_tracks: dict[int, dict[str, Any]] = {}
        used: set[int] = set()

        for cx, cy in detections:
            best_id, best_dist = None, 80.0
            for tid, t in prev_tracks.items():
                if tid in used:
                    continue
                dist = ((t["x"] - cx) ** 2 + (t["y"] - cy) ** 2) ** 0.5
                if dist < best_dist:
                    best_id, best_dist = tid, dist

            if best_id is not None:
                used.add(best_id)
                prev = prev_tracks[best_id]
                dt_ms = pts_ms - prev["pts_ms"]
                if dt_ms > 0:
                    vx = (cx - prev["x"]) / dt_ms
                    vy = (cy - prev["y"]) / dt_ms
                    speed = (vx * vx + vy * vy) ** 0.5
                else:
                    vx = vy = speed = 0.0
                new_tracks[best_id] = {
                    "x": cx, "y": cy, "pts_ms": pts_ms,
                    "vx": vx, "vy": vy, "speed": speed,
                }
            else:
                tid = state.tracker.next_id
                state.tracker.next_id += 1
                new_tracks[tid] = {
                    "x": cx, "y": cy, "pts_ms": pts_ms,
                    "vx": 0.0, "vy": 0.0, "speed": 0.0,
                }

        state.tracker.tracks = new_tracks

    # -----------------------------------------------------------------------
    # Frame read loop
    # -----------------------------------------------------------------------
    def read_loop_once(self, state: CameraCapture) -> None:
        if state.cap is None:
            if not self.open_capture(state):
                return

        assert state.cap is not None
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                ok, frame = state.cap.read()
        except Exception as e:
            state.decode_warnings += 1
            if not state.joined:
                logger.debug(
                    "Pre-IDR decode warning on %s (#%d): %s",
                    state.external_id, state.decode_warnings, e,
                )
            else:
                logger.warning("Read error on %s: %s", state.external_id, e)
            ok, frame = False, None

        if not ok or frame is None:
            if not state.joined:
                state.decode_warnings += 1
                if state.decode_warnings % 50 == 1:
                    logger.info(
                        "Waiting for IDR/keyframe on %s (warnings=%d)",
                        state.external_id, state.decode_warnings,
                    )
                return
            logger.warning("Frame drop / EOS on %s — reconnecting with backoff", state.external_id)
            self.close_capture(state)
            state.backoff = min(max(state.backoff, BACKOFF_START) * 2.0, BACKOFF_CAP)
            return

        if not state.joined:
            state.joined = True
            proto = "HLS" if state.using_hls else "RTSP"
            logger.info(
                "Joined stream %s via %s after %d pre-IDR warnings",
                state.external_id, proto, state.decode_warnings,
            )

        # Rule 3: monotonic PTS from CAP_PROP_POS_MSEC
        pts_ms = float(state.cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        self.process_frame(state, frame, pts_ms)

    # -----------------------------------------------------------------------
    # Reconcile open captures with active session list
    # -----------------------------------------------------------------------
    def reconcile(self, active: set[str]) -> None:
        for eid in active:
            urls = self._catalog.get(eid)
            if not urls:
                logger.debug("Active session for %s but no URL in catalog yet", eid)
                continue
            if eid not in self._cameras:
                self._cameras[eid] = CameraCapture(
                    external_id=eid,
                    rtsp_url=urls["rtsp"],
                    hls_url=urls.get("hls", build_hls_url(eid)),
                )
            else:
                self._cameras[eid].rtsp_url = urls["rtsp"]
                self._cameras[eid].hls_url  = urls.get("hls", build_hls_url(eid))

        for eid in list(self._cameras.keys()):
            if eid not in active:
                logger.info("No active sessions for %s — closing capture", eid)
                self.close_capture(self._cameras[eid])
                del self._cameras[eid]

    # -----------------------------------------------------------------------
    # Main loop
    # -----------------------------------------------------------------------
    def run(self) -> None:
        signal.signal(signal.SIGINT,  self.stop)
        signal.signal(signal.SIGTERM, self.stop)
        logger.info(
            "Capture worker started (catalog=%s rtsp_host=%s hls_base=%s tcp=forced)",
            SANDBOX_INGEST_URL, SANDBOX_RTSP_HOST, SANDBOX_HLS_BASE,
        )

        while self._running:
            self.refresh_catalog()
            active = self.fetch_active_sessions()
            self.reconcile(active)

            for state in list(self._cameras.values()):
                try:
                    self.read_loop_once(state)
                except Exception as e:
                    logger.exception("Unhandled error on %s: %s", state.external_id, e)
                    self.close_capture(state)
                    state.backoff = min(state.backoff * 2.0, BACKOFF_CAP)

            if not self._cameras:
                time.sleep(ACTIVE_POLL_SECONDS)
            else:
                time.sleep(0.01)   # mild yield while processing

        for state in self._cameras.values():
            self.close_capture(state)
        logger.info("Capture worker stopped")


def main() -> None:
    # Double-check env before any VideoCapture
    if "rtsp_transport;tcp" not in os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS", ""):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        logger.warning("Reinforced OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp")
    CaptureSupervisor().run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
