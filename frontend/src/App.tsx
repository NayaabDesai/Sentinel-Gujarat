import { useCallback, useEffect, useMemo, useState } from "react";
import GisMap from "./components/Map/GisMap";
import CameraMarker from "./components/Map/CameraMarker";
import WhepPlayer from "./components/Stream/WhepPlayer";
import HlsPlayer from "./components/Stream/HlsPlayer";
import BulkUpload from "./components/Ingestion/BulkUpload";
import GapReport from "./components/Dashboard/GapReport";
import { api, type Camera, type Department } from "./lib/api";

type Tab = "map" | "ingest" | "analytics";

const CLIENT_ID =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `ui-${crypto.randomUUID()}`
    : `ui-${Math.random().toString(36).slice(2)}`;

export default function App() {
  const [tab, setTab] = useState<Tab>("map");
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [department, setDepartment] = useState<string>("");
  const [showFov, setShowFov] = useState(true);
  const [selected, setSelected] = useState<Camera | null>(null);
  const [useHls, setUseHls] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mediaAuth, setMediaAuth] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cams, deps] = await Promise.all([
      api.cameras(department || undefined),
      api.departments(),
    ]);
    setCameras(cams);
    setDepartments(deps);
  }, [department]);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const onSelectCamera = useCallback(
    async (cameraId: string, props: Record<string, unknown>) => {
      const cam =
        cameras.find((c) => c.id === cameraId) ||
        ({
          id: cameraId,
          external_id: String(props.external_id || ""),
          name: String(props.name || "Camera"),
          department_code: (props.department as string) || null,
          latitude: null,
          longitude: null,
          heading_deg: null,
          fov_deg: null,
          range_m: null,
          status: String(props.status || "unknown"),
          is_active: true,
          whep_url: null,
          hls_url: null,
          last_seen_at: null,
        } satisfies Camera);

      // Prefer full record from list
      const full = cameras.find((c) => c.id === cameraId) || cam;
      setSelected(full);
      setUseHls(false);
      setTab("map");

      try {
        if (sessionId) {
          await api.endSession(sessionId, CLIENT_ID).catch(() => undefined);
        }
        const session = await api.startSession(full.id, CLIENT_ID, "whep");
        setSessionId(session.session_id);
        setMediaAuth(session.media_auth);
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

  // Heartbeat while preview is open (keeps on-demand ingest alive)
  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => {
      api.heartbeat(sessionId, CLIENT_ID).catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (sessionId) {
        api.endSession(sessionId, CLIENT_ID).catch(() => undefined);
      }
    };
  }, [sessionId]);

  const filtered = useMemo(
    () =>
      department
        ? cameras.filter((c) => c.department_code === department)
        : cameras,
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

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-white/10 px-4 py-4 md:px-8">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-saffron-400">
              Model 1 · Central Registry & GIS
            </p>
            <h1 className="font-display text-3xl font-semibold tracking-tight text-chalk md:text-4xl">
              Sentinel Gujarat
            </h1>
            <p className="mt-1 max-w-xl text-sm text-chalk/55">
              Unified surveillance registry for 80,000+ CCTV cameras across 26 departments —
              dynamic ingest, PostGIS coverage, on-demand WHEP/HLS preview.
            </p>
          </div>
          <nav className="flex gap-1 rounded-lg border border-white/10 bg-ink-900/60 p-1">
            {(
              [
                ["map", "GIS & Live"],
                ["ingest", "Onboarding"],
                ["analytics", "Analytics"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  tab === id
                    ? "bg-saffron-500/20 text-saffron-400"
                    : "text-chalk/60 hover:text-chalk"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-4 p-4 md:p-8">
        {tab === "map" && (
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_1fr_360px]">
            <aside className="flex max-h-[70vh] flex-col rounded-lg border border-white/10 bg-ink-900/40 lg:max-h-none">
              <div className="space-y-3 border-b border-white/10 p-3">
                <label className="block text-xs uppercase tracking-wider text-chalk/45">
                  Department
                  <select
                    className="mt-1 w-full rounded-md border border-white/10 bg-ink-950 px-2 py-1.5 text-sm text-chalk"
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
                  className="w-full rounded-md border border-forest-500/40 bg-forest-600/20 px-2 py-1.5 text-sm text-forest-400 hover:bg-forest-600/30"
                >
                  Sync sandbox catalog
                </button>
                {syncMsg && <p className="font-mono text-[11px] text-chalk/50">{syncMsg}</p>}
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
                {filtered.map((c) => (
                  <CameraMarker
                    key={c.id}
                    name={c.name}
                    status={c.status}
                    department={c.department_code}
                    selected={selected?.id === c.id}
                    onClick={() => onSelectCamera(c.id, c as unknown as Record<string, unknown>)}
                  />
                ))}
                {filtered.length === 0 && (
                  <p className="p-3 text-sm text-chalk/45">
                    No cameras yet. Sync ingest or upload a CSV.
                  </p>
                )}
              </div>
            </aside>

            <section className="min-h-[420px] lg:min-h-[640px]">
              <GisMap
                department={department || undefined}
                showFov={showFov}
                onSelectCamera={onSelectCamera}
              />
            </section>

            <aside className="flex flex-col gap-3 rounded-lg border border-white/10 bg-ink-900/40 p-3">
              <h2 className="font-display text-lg text-chalk">Live preview</h2>
              {!selected ? (
                <p className="text-sm text-chalk/50">Select a camera on the map or list.</p>
              ) : (
                <>
                  <div>
                    <div className="font-medium">{selected.name}</div>
                    <div className="font-mono text-xs text-chalk/45">{selected.external_id}</div>
                  </div>
                  <div className="aspect-video overflow-hidden rounded-md border border-white/10">
                    {!useHls && selected.whep_url ? (
                      <WhepPlayer
                        whepUrl={selected.whep_url}
                        mediaAuth={mediaAuth}
                        className="h-full w-full"
                        onFailure={() => setUseHls(true)}
                      />
                    ) : selected.hls_url ? (
                      <HlsPlayer
                        hlsUrl={selected.hls_url}
                        mediaAuth={mediaAuth}
                        className="h-full w-full"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-chalk/50">
                        No stream URL
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs ${
                        !useHls ? "bg-saffron-500/20 text-saffron-400" : "bg-white/5 text-chalk/60"
                      }`}
                      onClick={() => setUseHls(false)}
                    >
                      WHEP
                    </button>
                    <button
                      type="button"
                      className={`flex-1 rounded-md px-2 py-1.5 text-xs ${
                        useHls ? "bg-forest-500/20 text-forest-400" : "bg-white/5 text-chalk/60"
                      }`}
                      onClick={() => setUseHls(true)}
                    >
                      HLS
                    </button>
                  </div>
                  <p className="font-mono text-[10px] leading-relaxed text-chalk/40">
                    On-demand session active — RTSP/WHEP opens only while this preview heartbeats.
                  </p>
                </>
              )}
            </aside>
          </div>
        )}

        {tab === "ingest" && (
          <div className="mx-auto w-full max-w-2xl rounded-lg border border-white/10 bg-ink-900/40 p-6">
            <BulkUpload />
          </div>
        )}

        {tab === "analytics" && (
          <div className="rounded-lg border border-white/10 bg-ink-900/40 p-6">
            <GapReport />
          </div>
        )}
      </main>
    </div>
  );
}
