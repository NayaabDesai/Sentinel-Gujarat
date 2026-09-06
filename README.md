# Sentinel Gujarat

Unified CCTV **Central Registry & GIS Platform (Model 1)** with on-demand live video for 80,000+ cameras across Gujarat government departments.

## Stack

| Layer | Tech |
|-------|------|
| GIS DB | PostgreSQL 16 + PostGIS 3.4 |
| Cache / sessions | Redis 7 |
| API | FastAPI + Async SQLAlchemy + GeoAlchemy2 |
| Capture | OpenCV (RTSP over TCP) + PTS timing |
| Frontend | React (Vite) + MapLibre GL + WHEP / HLS.js |

## Quick start

```bash
cd sentinel-gujarat
cp .env.example .env
# Set SANDBOX_EMAIL / SANDBOX_PASSWORD in .env (portal credentials)

docker compose up --build
```

- API: http://localhost:8000/docs  
- UI: http://localhost:5173  
- Health: http://localhost:8000/health  

### Local (without Docker)

```bash
# DB: run PostGIS 16 somehow, then:
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

cd ../frontend && npm install && npm run dev

cd ../worker && pip install -r requirements.txt
python capture_worker.py
```

## Sandbox contracts (do not hardcode camera URLs)

| Contract | URL |
|----------|-----|
| Catalog | `GET https://cctv.corp8.cloud/cameras.json` |
| HLS | `https://cctv.corp8.cloud/<id>/index.m3u8` |
| RTSP | `rtsp://<email>:<password>@103.250.160.189:8554/stream/<id>` |
| WHEP | `http://<email>:<password>@103.250.160.189:8889/stream/<id>/whep` |

Camera IDs (`cam01`…`cam30`) and stream URLs are discovered dynamically by `catalog_sync` and the capture worker. Encode `@` in email as `%40` in RTSP/WHEP URLs (the app does this automatically from `SANDBOX_EMAIL` / `SANDBOX_PASSWORD`).

## Sandbox rules implemented

1. **RTSP over TCP** — `OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp` in worker + compose  
2. **Dynamic catalog** — polls `cameras.json` on a timer; never hardcodes stream URLs  
3. **Monotonic PTS** — velocity from `CAP_PROP_POS_MSEC` ΔPTS only  
4. **Backoff reconnect** — 2s → 30s cap  
5. **Non-fatal join** — pre-IDR decode warnings logged and skipped  
6. **Scene discontinuity** — tracker + MOG2 reset on loop/PTS jumps  
7. **On-demand ingest** — RTSP opens only for cameras with active `/api/v1/stream` sessions  
8. **Auth** — email+password embedded for RTSP; Basic auth header for WHEP/HLS browser clients  

## Multi-modal onboarding

- Manual: `POST /api/v1/cameras`  
- Bulk: `POST /api/v1/cameras/bulk` (CSV / Excel / GeoJSON) via UI  
- Automated: sandbox sync `POST /api/v1/ingest/sync`  

## Key APIs

- `GET /api/v1/cameras` / `GET /api/v1/cameras/geojson` / `GET /api/v1/cameras/spatial`  
- `GET /api/v1/analytics/gaps` — PostGIS blind-spot fishnet  
- `POST /api/v1/stream/sessions` + heartbeat — on-demand preview lifecycle  

## Project layout

See repository tree under `backend/`, `worker/`, and `frontend/` as scaffolded for the hackathon Model 1 foundation.
