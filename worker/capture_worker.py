"""
Sentinel Gujarat — OpenCV capture worker

Sandbox rules enforced:
1. RTSP over TCP only (OPENCV_FFMPEG_CAPTURE_OPTIONS)
2. Dynamic catalog via /api/ingest (and on-demand via backend /stream/active)
3. Monotonic PTS via CAP_PROP_POS_MSEC — never wall-clock / CAP_PROP_FPS for velocity
4. Exponential backoff reconnect: 2s → 30s cap
5. Non-fatal H.264/H.265 join warnings until first IDR
6. Scene discontinuity handling for looping sandbox feeds
7. On-demand: only open RTSP when UI/worker sessions are active
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

SANDBOX_INGEST_URL = os.environ.get("SANDBOX_INGEST_URL", "http://localhost/api/ingest")
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
CATALOG_REFRESH_SECONDS = int(os.environ.get("CATALOG_REFRESH_SECONDS", "60"))
ACTIVE_POLL_SECONDS = float(os.environ.get("ACTIVE_POLL_SECONDS", "5"))
BACKOFF_START = 2.0
BACKOFF_CAP = 30.0
PTS_JUMP_THRESHOLD_MS = 2000.0  # scene discontinuity / loop cut


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
    cap: cv2.VideoCapture | None = None
    backoff: float = BACKOFF_START
    joined: bool = False
    decode_warnings: int = 0
    tracker: TrackState = field(default_factory=TrackState)
    bg_subtractor: Any = None
    last_open_attempt: float = 0.0


class CaptureSupervisor:
    def __init__(self) -> None:
        self._running = True
        self._cameras: dict[str, CameraCapture] = {}
        self._catalog: dict[str, str] = {}  # external_id -> rtsp_url
        self._last_catalog_fetch = 0.0

    def stop(self, *_args: Any) -> None:
        self._running = False
        logger.info("Shutting down capture supervisor…")

    # --- Rule 2: Dynamic catalog discovery ---
    def refresh_catalog(self) -> None:
        now = time.monotonic()
        if now - self._last_catalog_fetch < CATALOG_REFRESH_SECONDS and self._catalog:
            return
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.get(SANDBOX_INGEST_URL)
                resp.raise_for_status()
                data = resp.json()
            items = data if isinstance(data, list) else data.get("cameras") or data.get("streams") or data.get("data") or []
            catalog: dict[str, str] = {}
            for item in items:
                if not isinstance(item, dict):
                    continue
                eid = str(item.get("id") or item.get("camera_id") or item.get("stream_id") or "").strip()
                rtsp = item.get("rtsp_url") or item.get("rtsp") or item.get("url")
                if eid and rtsp:
                    catalog[eid] = str(rtsp)
            self._catalog = catalog
            self._last_catalog_fetch = now
            logger.info("Catalog refreshed: %d cameras from %s", len(catalog), SANDBOX_INGEST_URL)
        except Exception as e:
            logger.error("Catalog refresh failed: %s", e)

    def fetch_active_sessions(self) -> set[str]:
        """Rule 7: only open feeds requested by active UI / inference sessions."""
        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.get(f"{BACKEND_URL.rstrip('/')}/api/v1/stream/active")
                resp.raise_for_status()
                data = resp.json()
            active: set[str] = set()
            for cam in data.get("active_cameras", []):
                eid = cam.get("external_id")
                if eid:
                    active.add(str(eid))
                    # Prefer live URL from session payload if catalog missing
                    if cam.get("rtsp_url") and eid not in self._catalog:
                        self._catalog[eid] = cam["rtsp_url"]
            return active
        except Exception as e:
            logger.warning("Active session poll failed (will not open new feeds): %s", e)
            return set()

    def open_capture(self, state: CameraCapture) -> bool:
        now = time.monotonic()
        if now - state.last_open_attempt < state.backoff:
            return False
        state.last_open_attempt = now

        # Ensure TCP transport is set before every open
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

        logger.info(
            "Opening RTSP (TCP) for %s (backoff=%.1fs)", state.external_id, state.backoff
        )
        cap = cv2.VideoCapture(state.rtsp_url, cv2.CAP_FFMPEG)
        if not cap.isOpened():
            # Rule 4: exponential backoff
            state.backoff = min(state.backoff * 2.0, BACKOFF_CAP)
            logger.warning(
                "Failed to open %s — next retry in %.1fs", state.external_id, state.backoff
            )
            return False

        state.cap = cap
        state.joined = False
        state.decode_warnings = 0
        state.backoff = BACKOFF_START
        state.tracker = TrackState()
        state.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
            history=200, varThreshold=32, detectShadows=False
        )
        return True

    def close_capture(self, state: CameraCapture) -> None:
        if state.cap is not None:
            try:
                state.cap.release()
            except Exception:
                pass
            state.cap = None
        state.joined = False

    def handle_scene_discontinuity(self, state: CameraCapture, pts_ms: float) -> bool:
        """
        Rule 6: sandbox feeds loop — abrupt PTS jumps / scene cuts must not
        crash background subtraction or leave stale track IDs.
        """
        prev = state.tracker.last_pts_ms
        state.tracker.last_pts_ms = pts_ms
        if prev is None:
            return False
        delta = pts_ms - prev
        # Loop rewind (PTS resets) or large forward jump
        if delta < -100 or abs(delta) > PTS_JUMP_THRESHOLD_MS:
            logger.info(
                "Scene discontinuity on %s (ΔPTS=%.1f ms) — resetting tracker/BG",
                state.external_id,
                delta,
            )
            state.tracker = TrackState(last_pts_ms=pts_ms)
            if state.bg_subtractor is not None:
                state.bg_subtractor = cv2.createBackgroundSubtractorMOG2(
                    history=200, varThreshold=32, detectShadows=False
                )
            return True
        return False

    def process_frame(self, state: CameraCapture, frame: np.ndarray, pts_ms: float) -> None:
        """
        Rule 3: velocity / motion timing STRICTLY from ΔPTS (CAP_PROP_POS_MSEC).
        Never use wall-clock or CAP_PROP_FPS.
        """
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

        # Associate by nearest centroid; compute velocity from ΔPTS only
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
                    # pixels per millisecond from ΔPTS (monotonic media time)
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

    def read_loop_once(self, state: CameraCapture) -> None:
        if state.cap is None:
            if not self.open_capture(state):
                return

        assert state.cap is not None
        try:
            # Suppress noisy decoder chatter; treat as non-fatal until IDR (Rule 5)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                ok, frame = state.cap.read()
        except Exception as e:
            state.decode_warnings += 1
            if not state.joined:
                logger.debug(
                    "Pre-IDR decode warning on %s (#%d): %s",
                    state.external_id,
                    state.decode_warnings,
                    e,
                )
            else:
                logger.warning("Read error on %s: %s", state.external_id, e)
            ok, frame = False, None

        if not ok or frame is None:
            if not state.joined:
                # Still waiting for first keyframe — do not tear down aggressively
                state.decode_warnings += 1
                if state.decode_warnings % 50 == 1:
                    logger.info(
                        "Waiting for IDR/keyframe on %s (warnings=%d)",
                        state.external_id,
                        state.decode_warnings,
                    )
                return
            logger.warning("Frame drop / EOS on %s — reconnecting with backoff", state.external_id)
            self.close_capture(state)
            state.backoff = min(max(state.backoff, BACKOFF_START) * 2.0, BACKOFF_CAP)
            return

        # First successful frame ⇒ joined past IDR
        if not state.joined:
            state.joined = True
            logger.info("Joined stream %s after %d pre-IDR warnings", state.external_id, state.decode_warnings)

        # Rule 3: monotonic PTS from CAP_PROP_POS_MSEC
        pts_ms = float(state.cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        self.process_frame(state, frame, pts_ms)

    def reconcile(self, active: set[str]) -> None:
        # Open on-demand
        for eid in active:
            rtsp = self._catalog.get(eid)
            if not rtsp:
                logger.debug("Active session for %s but no RTSP in catalog yet", eid)
                continue
            if eid not in self._cameras:
                self._cameras[eid] = CameraCapture(external_id=eid, rtsp_url=rtsp)
            else:
                self._cameras[eid].rtsp_url = rtsp

        # Close inactive
        for eid in list(self._cameras.keys()):
            if eid not in active:
                logger.info("No active sessions for %s — closing RTSP", eid)
                self.close_capture(self._cameras[eid])
                del self._cameras[eid]

    def run(self) -> None:
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)
        logger.info(
            "Capture worker started (ingest=%s backend=%s tcp=forced)",
            SANDBOX_INGEST_URL,
            BACKEND_URL,
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
                # Mild yield so we don't spin tight when waiting on network
                time.sleep(0.01)

        for state in self._cameras.values():
            self.close_capture(state)
        logger.info("Capture worker stopped")


def main() -> None:
    # Double-check env before any VideoCapture
    if "rtsp_transport;tcp" not in os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS", ""):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
        logger.warning("Reinforced OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp")

    supervisor = CaptureSupervisor()
    supervisor.run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
