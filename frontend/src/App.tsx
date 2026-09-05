import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GisMap from "./components/Map/GisMap";
import NearbyPanel from "./components/Map/NearbyPanel";
import CameraMarker from "./components/Map/CameraMarker";
import StreamPlayer from "./components/Stream/StreamPlayer";
import BulkUpload from "./components/Ingestion/BulkUpload";
import GapReport from "./components/Dashboard/GapReport";
import Navbar from "./components/Layout/Navbar";
import Login from "./components/Auth/Login";
import { useAuth } from "./context/AuthContext";
import { api, type Camera, type Department, ApiError } from "./lib/api";

type Tab = "map" | "ingest" | "analytics";

const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ui-${crypto.randomUUID()}`
    : `ui-${Math.random().toString(36).slice(2)}`;

function Dashboard() {
  const { logout } = useAuth();
  const [tab, setTab] = useState<Tab>("map");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [department, setDepartment] = useState<string>("");
  const [showFov, setShowFov] = useState(true);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Nearby tap state
  const [radar, setRadar] = useState<{ lat: number; lon: number } | null>(null);
  const [radiusMeters, setRadiusMeters] = useState(500);
  const [nearby, setNearby] = useState<Camera[]>([]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [knnFallback, setKnnFallback] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          department_code: (props.department as string) || null,
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
        } satisfies Camera);

      setSelected(full);
      setTab("map");

      // Fly map to this camera's exact coordinates
      if (
        full.longitude != null &&
        full.latitude != null &&
        Number.isFinite(full.longitude) &&
        Number.isFinite(full.latitude)
      ) {
        window.dispatchEvent(
          new CustomEvent("sentinel-flyto", {
            detail: { lon: full.longitude, lat: full.latitude, zoom: 15 },
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
        });
      } catch (e) {
        console.error(e);
      }
    },
    [cameras, sessionId]
  );

  const fetchNearby = useCallback(
    async (lat: number, lon: number, radius: number) => {
      setNearbyLoading(true);
      try {
        const rows = await api.nearby(lat, lon, radius, 12, department || undefined);
        setNearby(rows);
        setKnnFallback(rows.some((r) => r.knn_fallback) || rows.every((r) => (r.distance_meters || 0) > radius));
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
      setDrawerOpen(true);
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
    try {
      const res = await api.syncIngest();
      setSyncMsg(
        `Synced: fetched ${res.fetched}, created ${res.created}, updated ${res.updated}`
      );
      await load();
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const onFovTrace = (cam: Camera) => {
    if (cam.longitude != null && cam.latitude != null) {
      window.dispatchEvent(
        new CustomEvent("sentinel-flyto", {
          detail: { lon: cam.longitude, lat: cam.latitude, zoom: 15 },
        })
      );
    }
    setShowFov(true);
    onSelectCamera(cam.id, cam as unknown as Record<string, unknown>);
  };

  return (
    <div className="flex min-h-full flex-col">
      <Navbar tab={tab} onTab={setTab} />

      <main className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col gap-3 p-3 md:p-5">
        {tab === "map" && (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_1fr_340px]">
            <aside className="flex max-h-[70vh] flex-col border border-white/10 bg-ink-900/50 lg:max-h-none">
              <div className="space-y-3 border-b border-white/10 p-3">
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
                <label className="flex items-center gap-2 text-sm text-chalk/70">
                  <input
                    type="checkbox"
                    checked={showFov}
                    onChange={(e) => setShowFov(e.target.checked)}
                  />
                  FOV cones
                </label>
                <button
                  type="button"
                  onClick={syncCatalog}
                  className="w-full border border-forest-500/40 bg-forest-500/15 px-2 py-1.5 text-sm text-forest-400 hover:bg-forest-500/25"
                >
                  Sync sandbox catalog
                </button>
                {syncMsg && (
                  <p className="font-mono text-[10px] text-chalk/45">{syncMsg}</p>
                )}
                <p className="font-mono text-[9px] text-chalk/35">
                  Tip: tap empty map to scan nearby cameras
                </p>
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
                {filtered.map((c) => (
                  <CameraMarker
                    key={c.id}
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
                  <p className="p-3 text-sm text-chalk/45">
                    No cameras yet. Sync ingest or upload a CSV.
                  </p>
                )}
              </div>
            </aside>

            <section className="relative min-h-[420px] lg:min-h-[640px]">
              <GisMap
                department={department || undefined}
                showFov={showFov}
                radiusMeters={radiusMeters}
                radar={radar}
                onSelectCamera={onSelectCamera}
                onMapTap={onMapTap}
              />
              <NearbyPanel
                open={drawerOpen}
                lat={radar?.lat ?? null}
                lon={radar?.lon ?? null}
                radiusMeters={radiusMeters}
                loading={nearbyLoading}
                cameras={nearby}
                knnFallback={knnFallback}
                onClose={() => {
                  setDrawerOpen(false);
                  setRadar(null);
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
            </section>

            <aside className="flex flex-col gap-3 border border-white/10 bg-ink-900/50 p-3">
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-[11px] uppercase tracking-wider text-chalk/55">
                  Live preview
                </h2>
                {selected && (
                  <span className="font-mono text-[9px] text-forest-400">SESSION</span>
                )}
              </div>
              {!selected ? (
                <p className="text-sm text-chalk/45">
                  Select a camera or tap the map for a sector scan.
                </p>
              ) : (
                <>
                  <div>
                    <div className="font-medium text-chalk">{selected.name}</div>
                    <div className="font-mono text-[10px] text-chalk/40">
                      {selected.external_id}
                      {selected.latitude != null && selected.longitude != null && (
                        <> · {selected.latitude.toFixed(4)}, {selected.longitude.toFixed(4)}</>
                      )}
                    </div>
                  </div>
                  <div className="aspect-video overflow-hidden border border-white/10">
                    <StreamPlayer
                      whepUrl={selected.whep_url}
                      hlsUrl={selected.hls_url}
                      className="h-full w-full"
                    />
                  </div>
                  <p className="font-mono text-[9px] leading-relaxed text-chalk/35">
                    On-demand session — WHEP primary, HLS auto-failover at 3.5s. Feed opens only
                    while this preview heartbeats.
                  </p>
                </>
              )}
            </aside>
          </div>
        )}

        {tab === "ingest" && (
          <div className="mx-auto w-full max-w-2xl border border-white/10 bg-ink-900/50 p-6">
            <BulkUpload />
          </div>
        )}

        {tab === "analytics" && (
          <div className="border border-white/10 bg-ink-900/50 p-6">
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
      <div className="flex min-h-full items-center justify-center font-mono text-xs text-chalk/40">
        Initialising command center…
      </div>
    );
  }

  if (!user) return <Login />;
  return <Dashboard />;
}
