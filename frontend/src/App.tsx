import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GisMap from "./components/Map/GisMap";
import NearbyPanel from "./components/Map/NearbyPanel";
import CameraSearch from "./components/Map/CameraSearch";
import CameraMarker from "./components/Map/CameraMarker";
import StreamPreviewModal from "./components/Stream/StreamPreviewModal";
import BulkUpload from "./components/Ingestion/BulkUpload";
import GapReport from "./components/Dashboard/GapReport";
import Navbar from "./components/Layout/Navbar";
import JudgeWalkthrough from "./components/Layout/JudgeWalkthrough";
import Login from "./components/Auth/Login";
import { useAuth } from "./context/AuthContext";
import { api, type Camera, type Department, ApiError } from "./lib/api";

type Tab = "map" | "ingest" | "analytics";

const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ui-${crypto.randomUUID()}`
    : `ui-${Math.random().toString(36).slice(2)}`;

function Dashboard() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("map");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [department, setDepartment] = useState<string>("");
  const [showFov, setShowFov] = useState(true);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewStarting, setPreviewStarting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [radar, setRadar] = useState<{ lat: number; lon: number } | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const [nearby, setNearby] = useState<Camera[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [knnFallback, setKnnFallback] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraRowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const canSync = user?.role === "ADMIN";
  const canWrite = user?.role === "ADMIN" || user?.role === "OPERATOR";

  const load = useCallback(async () => {
    try {
      const [cams, deps] = await Promise.all([
        api.cameras(department || undefined),
        api.departments(),
      ]);
      setCameras(cams);
      setDepartments(deps);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) logout();
      console.error(e);
    }
  }, [department, logout]);

  useEffect(() => {
    load();
  }, [load]);

  const onSelectCamera = useCallback(
    async (cameraId: string, props: Record<string, unknown>) => {
      const fromList = cameras.find((c) => c.id === cameraId);
      const lat =
        fromList?.latitude ??
        (typeof props.latitude === "number" ? props.latitude : null) ??
        (props.latitude != null ? Number(props.latitude) : null);
      const lon =
        fromList?.longitude ??
        (typeof props.longitude === "number" ? props.longitude : null) ??
        (props.longitude != null ? Number(props.longitude) : null);

      const full =
        fromList ||
        ({
          id: cameraId,
          external_id: String(props.external_id || ""),
          name: String(props.name || "Camera"),
          department_code:
            (props.department as string) || (props.department_code as string) || null,
          latitude: Number.isFinite(lat as number) ? (lat as number) : null,
          longitude: Number.isFinite(lon as number) ? (lon as number) : null,
          heading_deg: null,
          fov_deg: null,
          range_m: null,
          status: String(props.status || "unknown"),
          is_active: true,
          whep_url: null,
          hls_url: null,
          last_seen_at: null,
          meta:
            props.geo_source === "inferred"
              ? { geo_source: "inferred" }
              : fromList?.meta || null,
        } satisfies Camera);

      setSelected(full);
      setPreviewOpen(true);
      setPreviewStarting(true);
      setTab("map");

      if (
        full.longitude != null &&
        full.latitude != null &&
        Number.isFinite(full.longitude) &&
        Number.isFinite(full.latitude)
      ) {
        window.dispatchEvent(
          new CustomEvent("sentinel-flyto", {
            detail: { lon: full.longitude, lat: full.latitude, zoom: 16 },
          })
        );
      }

      try {
        if (sessionId) {
          await api.endSession(sessionId, CLIENT_ID).catch(() => undefined);
        }
        const session = await api.startSession(full.id, CLIENT_ID, "whep");
        setSessionId(session.session_id);
        setSelected({
          ...full,
          whep_url: session.whep_url,
          hls_url: session.hls_url,
          rtsp_url: session.rtsp_url,
        });
      } catch (e) {
        console.error(e);
      } finally {
        setPreviewStarting(false);
      }
    },
    [cameras, sessionId]
  );

  const closePreview = useCallback(async () => {
    setPreviewOpen(false);
    setPreviewStarting(false);
    if (sessionId) {
      await api.endSession(sessionId, CLIENT_ID).catch(() => undefined);
      setSessionId(null);
    }
  }, [sessionId]);

  const fetchNearby = useCallback(
    async (lat: number, lon: number, radius: number) => {
      setNearbyLoading(true);
      try {
        const rows = await api.nearby(lat, lon, radius, 12, department || undefined);
        setNearby(rows);
        setKnnFallback(false);
      } catch (e) {
        console.error(e);
        setNearby([]);
      } finally {
        setNearbyLoading(false);
      }
    },
    [department]
  );

  const onMapTap = useCallback(
    (lat: number, lon: number) => {
      setRadar({ lat, lon });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetchNearby(lat, lon, radiusMeters);
      }, 300);
    },
    [fetchNearby, radiusMeters]
  );

  useEffect(() => {
    if (!radar) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchNearby(radar.lat, radar.lon, radiusMeters);
    }, 300);
  }, [radiusMeters, radar, fetchNearby]);

  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => {
      api.heartbeat(sessionId, CLIENT_ID).catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, [sessionId]);

  useEffect(() => {
    if (!selected?.id) return;
    const el = cameraRowRefs.current.get(selected.id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected?.id]);

  useEffect(() => {
    return () => {
      if (sessionId) api.endSession(sessionId, CLIENT_ID).catch(() => undefined);
    };
  }, [sessionId]);

  const filtered = useMemo(
    () =>
      department ? cameras.filter((c) => c.department_code === department) : cameras,
    [cameras, department]
  );

  const syncCatalog = async () => {
    if (!canSync) {
      setSyncMsg("ADMIN role required for sandbox sync");
      return;
    }
    try {
      const res = await api.syncIngest();
      setSyncMsg(
        `Synced: fetched ${res.fetched}, created ${res.created}, updated ${res.updated}`
      );
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setSyncMsg("403 Forbidden — ADMIN required");
      } else {
        setSyncMsg(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const onFovTrace = (cam: Camera) => {
    if (cam.longitude != null && cam.latitude != null) {
      window.dispatchEvent(
        new CustomEvent("sentinel-flyto", {
          detail: { lon: cam.longitude, lat: cam.latitude, zoom: 16 },
        })
      );
    }
    setShowFov(true);
    onSelectCamera(cam.id, cam as unknown as Record<string, unknown>);
  };

  return (
    <div className="flex h-dvh max-h-dvh flex-col overflow-hidden">
      <Navbar tab={tab} onTab={setTab} />

      <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col gap-2 overflow-hidden p-2 md:gap-2 md:p-3">
        <div className="shrink-0">
          <JudgeWalkthrough />
        </div>

        {tab === "map" && (
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(220px,1fr)_minmax(0,22vh)_minmax(0,22vh)] gap-2 lg:grid-cols-[240px_minmax(0,1fr)_300px] lg:grid-rows-1">
            {/* Map is first / largest so it is immediately usable */}
            <section className="relative order-1 min-h-0 lg:order-2">
              <div className="absolute left-3 right-14 top-3 z-30">
                <CameraSearch
                  cameras={filtered}
                  onSelect={(c) =>
                    onSelectCamera(c.id, c as unknown as Record<string, unknown>)
                  }
                />
              </div>
              <GisMap
                department={department || undefined}
                showFov={showFov}
                radiusMeters={radiusMeters}
                radar={radar}
                selectedCameraId={selected?.id}
                onSelectCamera={onSelectCamera}
                onMapTap={onMapTap}
              />
            </section>

            <aside className="order-2 flex min-h-0 flex-col overflow-hidden border border-white/10 bg-ink-900/50 lg:order-1">
              <div className="shrink-0 space-y-2 border-b border-white/10 p-2.5">
                <label className="block font-mono text-[10px] uppercase tracking-wider text-chalk/45">
                  Department
                  <select
                    className="mt-1 w-full border border-white/10 bg-ink-950 px-2 py-1.5 text-sm text-chalk"
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                  >
                    <option value="">All departments</option>
                    {departments.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.name} ({d.camera_count})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-sm text-chalk/70">
                    <input
                      type="checkbox"
                      checked={showFov}
                      onChange={(e) => setShowFov(e.target.checked)}
                    />
                    FOV
                  </label>
                  <button
                    type="button"
                    onClick={syncCatalog}
                    disabled={!canSync}
                    title={
                      canSync
                        ? "Pull cameras.json once via server session (ADMIN)"
                        : "ADMIN only"
                    }
                    className="border border-forest-500/40 bg-forest-500/15 px-2 py-1 text-xs text-forest-400 hover:bg-forest-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Sync catalog
                  </button>
                </div>
                {syncMsg && (
                  <p className="font-mono text-[10px] text-chalk/45">{syncMsg}</p>
                )}
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
                {filtered.map((c) => (
                  <CameraMarker
                    key={c.id}
                    ref={(el) => {
                      if (el) cameraRowRefs.current.set(c.id, el);
                      else cameraRowRefs.current.delete(c.id);
                    }}
                    name={c.name}
                    status={c.status}
                    department={c.department_code}
                    selected={selected?.id === c.id}
                    onClick={() =>
                      onSelectCamera(c.id, c as unknown as Record<string, unknown>)
                    }
                  />
                ))}
                {filtered.length === 0 && (
                  <p className="p-3 text-sm text-chalk/45">No cameras yet. Sync catalog.</p>
                )}
              </div>
            </aside>

            <aside className="order-3 flex min-h-0 flex-col overflow-hidden border border-white/10 bg-ink-900/50 p-2.5 lg:order-3">
              <NearbyPanel
                active={radar != null}
                lat={radar?.lat ?? null}
                lon={radar?.lon ?? null}
                radiusMeters={radiusMeters}
                loading={nearbyLoading}
                cameras={nearby}
                knnFallback={knnFallback}
                onClear={() => {
                  setRadar(null);
                  setNearby([]);
                  setKnnFallback(false);
                }}
                onStream={(cam) =>
                  onSelectCamera(cam.id, cam as unknown as Record<string, unknown>)
                }
                onLock={(lat, lon) => {
                  window.dispatchEvent(
                    new CustomEvent("sentinel-flyto", {
                      detail: { lon, lat, zoom: 14 },
                    })
                  );
                }}
                onFovTrace={onFovTrace}
                onRadiusChange={setRadiusMeters}
              />
            </aside>
          </div>
        )}

        <StreamPreviewModal
          open={previewOpen}
          camera={selected}
          starting={previewStarting}
          onClose={() => {
            void closePreview();
          }}
        />

        {tab === "ingest" && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-2xl border border-white/10 bg-ink-900/50 p-6">
              <BulkUpload canWrite={canWrite} />
            </div>
          </div>
        )}

        {tab === "analytics" && (
          <div className="min-h-0 flex-1 overflow-y-auto border border-white/10 bg-ink-900/50 p-6">
            <GapReport />
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center font-mono text-xs text-chalk/40">
        Initialising command center…
      </div>
    );
  }

  if (!user) return <Login />;
  return <Dashboard />;
}
