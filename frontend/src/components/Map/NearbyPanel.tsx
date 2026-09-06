import type { Camera } from "../../lib/api";

type Props = {
  open: boolean;
  lat: number | null;
  lon: number | null;
  radiusMeters: number;
  loading: boolean;
  cameras: Camera[];
  knnFallback: boolean;
  onClose: () => void;
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

export default function NearbyPanel({
  open,
  lat,
  lon,
  radiusMeters,
  loading,
  cameras,
  knnFallback,
  onClose,
  onStream,
  onLock,
  onFovTrace,
  onRadiusChange,
}: Props) {
  if (!open) return null;

  return (
    <div className="pointer-events-auto absolute bottom-3 right-3 z-20 flex w-[min(100%,340px)] flex-col border border-white/10 bg-ink-900/95 shadow-panel backdrop-blur">
      <div className="flex items-start justify-between border-b border-white/10 px-3 py-2.5">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-saffron-400">
            Tactical scan
          </p>
          <h3 className="text-sm font-semibold text-chalk">Nearby cameras</h3>
          {lat != null && lon != null && (
            <p className="mt-0.5 font-mono text-[10px] text-chalk/45">
              {lat.toFixed(5)}, {lon.toFixed(5)}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-xs text-chalk/40 hover:text-chalk"
        >
          ✕
        </button>
      </div>

      <div className="space-y-2 border-b border-white/10 px-3 py-2">
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
        {knnFallback && (
          <p className="font-mono text-[9px] text-saffron-400">
            No hits in radius — showing nearest KNN results
          </p>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto">
        {loading && (
          <p className="p-4 font-mono text-[11px] text-chalk/40">Scanning sector…</p>
        )}
        {!loading && cameras.length === 0 && (
          <p className="p-4 text-sm text-chalk/45">No cameras in this sector.</p>
        )}
        {!loading &&
          cameras.map((c) => (
            <div
              key={c.id}
              className="border-b border-white/5 px-3 py-2.5 hover:bg-white/[0.03]"
            >
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
    </div>
  );
}
