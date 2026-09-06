import { useState } from "react";
import { api, ApiError } from "../../lib/api";

type Props = {
  canWrite?: boolean;
};

export default function BulkUpload({ canWrite = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    total: number;
    created: number;
    updated: number;
    errors: { row?: number; error: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | null) => {
    if (!file || !canWrite) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.bulkUpload(file);
      setResult(res);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError("403 Forbidden — VIEWER cannot bulk upload");
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl text-chalk">Bulk onboarding</h2>
        <p className="mt-1 text-sm text-chalk/60">
          CSV, Excel, or GeoJSON — camera IDs and coordinates register into PostGIS.
        </p>
      </div>

      {!canWrite && (
        <p
          className="border border-saffron-500/30 bg-saffron-500/10 px-3 py-2 font-mono text-[11px] text-saffron-400"
          title="VIEWER accounts are read-only"
        >
          Bulk upload disabled — VIEWER role is read-only (POST returns 403).
        </p>
      )}

      <label
        title={canWrite ? undefined : "VIEWER cannot upload — ADMIN/OPERATOR only"}
        className={`flex flex-col items-center justify-center gap-2 border border-dashed border-white/20 bg-ink-900/60 px-6 py-10 transition ${
          canWrite
            ? "cursor-pointer hover:border-saffron-400/50 hover:bg-ink-800/40"
            : "cursor-not-allowed opacity-40"
        }`}
      >
        <span className="font-medium text-chalk">
          {busy ? "Uploading…" : canWrite ? "Drop file or click to browse" : "Upload locked"}
        </span>
        <span className="font-mono text-xs text-chalk/45">.csv · .xlsx · .geojson</span>
        <input
          type="file"
          accept=".csv,.txt,.xlsx,.xls,.geojson,.json"
          className="hidden"
          disabled={busy || !canWrite}
          onChange={(e) => onFile(e.target.files?.[0] || null)}
        />
      </label>

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3 rounded-md border border-white/10 bg-ink-900/70 p-4 text-sm">
          <div className="flex flex-wrap gap-4 font-mono text-xs uppercase tracking-wide text-chalk/70">
            <span>Total {result.total}</span>
            <span className="text-forest-400">Created {result.created}</span>
            <span className="text-saffron-400">Updated {result.updated}</span>
            <span className="text-red-300">Errors {result.errors.length}</span>
          </div>
          {result.errors.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-auto font-mono text-xs text-red-200/90">
              {result.errors.map((err, i) => (
                <li key={i}>
                  Row {err.row ?? "?"}: {err.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
