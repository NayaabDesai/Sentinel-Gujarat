import type { Camera } from "../../lib/api";

type Props = {
  /** When false and no coordinates, show idle hint (sidebar mode). */
  active: boolean;
  lat: number | null;
  lon: number | null;
  radiusMeters: number;
  loading: boolean;
  cameras: Camera[];
  knnFallback: boolean;
  onClear?: () => void;
  onStream: (cam: Camera) => void;
  onLock: (lat: number, lon: number) => void;
  onFovTrace: (cam: Camera) => void;
  onRadiusChange: (r: number) => void;
};

function fmtDist(m?: number) {
  if (m == null) return "—";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

const STATUS_DOT: Record<string, string> = {
  online: "bg-forest-500",
  offline: "bg-rose-500",
  degraded: "bg-saffron-500",
  unknown: "bg-chalk/40",
};

/** Right-rail tactical scan (replaces the old live-preview column). */
export default function NearbyPanel({
  active,
  lat,
  lon,
  radiusMeters,
  loading,
  cameras,
  knnFallback,
  onClear,
  onStream,
  onLock,
  onFovTrace,
  onRadiusChange,
}: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between border-b border-white/10 px-1 pb-2.5">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-saffron-400">
            Tactical scan
          </p>
          <h3 className="text-sm font-semibold text-chalk">Nearby cameras</h3>
          {active && lat != null && lon != null ? (
            <p className="mt-0.5 font-mono text-[10px] text-chalk/45">
              {lat.toFixed(5)}, {lon.toFixed(5)}
            </p>
          ) : (
            <p className="mt-1 text-xs text-chalk/45">
              Tap empty map to scan cameras near that point.
            </p>
          )}
        </div>
        {active && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-xs text-chalk/40 hover:text-chalk"
          >
            CLR
          </button>
        )}
      </div>

      {!active ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 py-8 text-center">
          <div className="h-10 w-10 border border-dashed border-white/15" />
          <p className="font-mono text-[10px] uppercase tracking-wider text-chalk/40">
            Awaiting map tap
          </p>
          <p className="max-w-[220px] text-xs text-chalk/35">
            Click a blank area on the Gujarat map to run a PostGIS nearby sector scan. Click a red
            pin for live preview popup.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-2 border-b border-white/10 py-2">
            <label className="flex items-center justify-between gap-2 font-mono text-[10px] text-chalk/50">
              <span>Radius</span>
              <span className="text-forest-400">{radiusMeters} m</span>
            </label>
            <input
              type="range"
              min={100}
              max={5000}
              step={100}
              value={radiusMeters}
              onChange={(e) => onRadiusChange(Number(e.target.value))}
              className="w-full accent-forest-500"
            />
            {lat != null && lon != null && (
              <button
                type="button"
                onClick={() => onLock(lat, lon)}
                className="w-full border border-white/10 py-1 font-mono text-[10px] uppercase tracking-wider text-chalk/55 hover:border-saffron-500/40 hover:text-saffron-400"
              >
                Lock coordinates
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && (
              <p className="p-4 font-mono text-[11px] text-chalk/40">Scanning sector…</p>
            )}
            {!loading && cameras.length === 0 && (
              <p className="p-4 text-sm text-chalk/45">
                No cameras inside {radiusMeters} m of this point.
              </p>
            )}
            {!loading &&
              cameras.map((c) => (
                <div key={c.id} className="border-b border-white/5 py-2.5 hover:bg-white/[0.03]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            STATUS_DOT[c.status] || STATUS_DOT.unknown
                          }`}
                        />
                        <span className="truncate text-sm text-chalk">{c.name}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-chalk/40">
                        {c.external_id} · {c.department_code || "—"} · {fmtDist(c.distance_meters)}
                      </div>
                      {c.meta?.geo_source === "inferred" && (
                        <span className="mt-1 inline-block border border-saffron-500/40 bg-saffron-500/15 px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-saffron-400">
                          ⚠ Approx. Geo-Location (Inferred from Title)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex gap-1">
                    <button
                      type="button"
                      onClick={() => onStream(c)}
                      className="flex-1 border border-forest-500/30 bg-forest-500/10 py-1 font-mono text-[9px] uppercase tracking-wider text-forest-400 hover:bg-forest-500/20"
                    >
                      Stream live
                    </button>
                    <button
                      type="button"
                      onClick={() => onFovTrace(c)}
                      className="flex-1 border border-white/10 py-1 font-mono text-[9px] uppercase tracking-wider text-chalk/50 hover:text-chalk"
                    >
                      FOV trace
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
