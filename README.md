# Sentinel Gujarat

Unified CCTV **Central Registry & GIS Platform (Model 1)** — Police Command & Control evaluation build with PostGIS gap analysis, on-demand live video (WHEP → HLS → proxy), and department-scoped RBAC.

## Architecture

```
┌─────────────┐     JWT      ┌──────────────────┐
│ React 18 UI │─────────────▶│ FastAPI (async)  │
│ MapLibre GL │◀─────────────│ GeoAlchemy2 API  │
│ HLS.js/WHEP │   GeoJSON    └────────┬─────────┘
└─────────────┘                       │
                                      ▼
                    ┌─────────────────────────────────┐
                    │ PostgreSQL 16 + PostGIS 3.4     │
                    │ Redis 7 (session / cache)       │
                    └─────────────────────────────────┘
                                      ▲
                    ┌─────────────────┴───────────────┐
                    │ OpenCV capture worker            │
                    │ (on-demand RTSP via X-Service-Key)│
                    └─────────────────────────────────┘
                                      │
                    ┌─────────────────▼───────────────┐
                    │ Sandbox: cctv.corp8.cloud         │
                    │ Catalog · WHEP :8889 · HLS CDN   │
                    │ (ONE web session per IP)         │
                    └─────────────────────────────────┘
```

## Stack

| Layer | Tech |
|-------|------|
| GIS DB | PostgreSQL 16 + PostGIS 3.4 |
| Cache / sessions | Redis 7 |
| API | FastAPI + Async SQLAlchemy + GeoAlchemy2 |
| Capture | OpenCV (RTSP over TCP) + PTS timing |
| Frontend | React 18 (Vite) + Tailwind + MapLibre GL + WHEP / HLS.js |

## 60-second evaluator quickstart (`sentinel.bat`)

From the repo root on Windows:

```bat
copy .env.example .env
REM Edit .env: SANDBOX_* URLs and portal credentials stay server-side only

cmd /c sentinel.bat build
cmd /c sentinel.bat up
```

| Surface | URL |
|---------|-----|
| UI | http://localhost:5173 |
| API docs | http://localhost:8000/docs |
| Health | http://localhost:8000/health |

**Judge walkthrough (in-app banner):**  
1. Sync Catalog (Admin) → 2. Locate Junction (`/` or Ctrl+K) → 3. Test Video Stream → 4. Analytics → Export Gap Report.

## Seed credentials

| Email | Password | Role | Scope |
|-------|----------|------|-------|
| `admin@police.gujarat.gov.in` | `Sentinel@2026` | ADMIN | Full R/W, sync, bulk, cross-dept |
| `amc.traffic@gujarat.gov.in` | `Sentinel@2026` | OPERATOR | Read all; write limited to assigned dept (`TRAFFIC` / AMC traffic scope) |
| `viewer@police.gujarat.gov.in` | `Sentinel@2026` | VIEWER | Read-only — sync/bulk UI disabled; POST → **403** |

## Sandbox URL contracts

Configure via `.env` (never expose portal password to the browser):

| Contract | Env / pattern |
|----------|----------------|
| Portal host | `SANDBOX_HOST` → `cctv.corp8.cloud` |
| Catalog | Server fetches `cameras.json` during sync only |
| WHEP | `SANDBOX_WHEP_BASE` → `http://<HOST>:8889/stream/<id>/whep` |
| HLS CDN | `SANDBOX_HLS_BASE` → `http://<HOST>/live/stream/<id>/index.m3u8` |
| RTSP | Host/port in env — used by worker + CLI copy |

### Single-session safety (critical)

`cctv.corp8.cloud` allows **one web login session per IP**. Sentinel:

- Logs into the portal **only on the backend** during catalog sync or rare HLS proxy auth fallback
- **Logs out immediately** after the fetch
- Does **not** poll `cameras.json` from the browser
- Does **not** put sandbox credentials in the frontend bundle
- Sets `CATALOG_AUTO_SYNC=false` by default — sync is an explicit Admin click

If HLS CDN is cookie/CORS blocked, the UI falls through to  
`GET /api/v1/stream/proxy/{camera_id}/index.m3u8` (JWT-authenticated).

## Stream playback waterfall

1. **WHEP** WebRTC (~3.5s timeout)  
2. **Direct CDN HLS** (~4s)  
3. **Backend HLS proxy** (Bearer token via hls.js `xhrSetup`)  
4. Offline HUD with Retry + copy `ffplay` RTSP command  

## Key APIs

| Endpoint | Notes |
|----------|-------|
| `POST /api/v1/auth/login` | OAuth2 password → JWT |
| `GET /api/v1/cameras` / `geojson` / `nearby` | Registry + GIS |
| `POST /api/v1/ingest/sync` | ADMIN only |
| `POST /api/v1/cameras/bulk` | ADMIN/OPERATOR (dept-scoped) |
| `POST /api/v1/stream/sessions` | On-demand preview |
| `GET /api/v1/stream/proxy/{id}/index.m3u8` | Authenticated HLS proxy |
| `GET /api/v1/analytics/gaps` | PostGIS fishnet |
| `GET /api/v1/analytics/export/csv` | Full metadata CSV |
| `GET /api/v1/analytics/export/gaps-csv` | Gap report CSV |

## Docker / local

```bash
docker compose up --build
```

Or without Docker: run PostGIS + Redis, then `uvicorn` (backend), `npm run dev` (frontend), and `python capture_worker.py` (worker).

## Out of scope (this sprint)

- Simultaneous FFmpeg restreamers for all cameras  
- YOLO / ANPR (Models 2/4)  
- User self-registration / password reset  
