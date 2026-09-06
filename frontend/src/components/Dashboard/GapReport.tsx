import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../../lib/api";

const PIE_COLORS = ["#3d9a6a", "#c44b4b", "#e8872a", "#7a8aa0"];

export default function GapReport() {
  const [gaps, setGaps] = useState<Record<string, unknown> | null>(null);
  const [uptime, setUptime] = useState<Record<string, unknown> | null>(null);
  const [aging, setAging] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [g, u, a] = await Promise.all([api.gaps(), api.uptime(), api.aging()]);
        setGaps(g);
        setUptime(u);
        setAging(a);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const exportCsv = async (kind: "cameras" | "gaps") => {
    setExportMsg(null);
    try {
      if (kind === "cameras") {
        await api.downloadExport("/api/v1/analytics/export/csv", "sentinel_cameras.csv");
        setExportMsg("Downloaded camera metadata CSV");
      } else {
        await api.downloadExport("/api/v1/analytics/export/gaps-csv", "sentinel_gap_report.csv");
        setExportMsg("Downloaded gap analysis report");
      }
    } catch (e) {
      setExportMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const uptimePie = uptime
    ? [
        { name: "Online", value: Number(uptime.online || 0) },
        { name: "Offline", value: Number(uptime.offline || 0) },
        { name: "Degraded", value: Number(uptime.degraded || 0) },
        { name: "Unknown", value: Number(uptime.unknown || 0) },
      ]
    : [];

  const coverageBar = gaps
    ? [
        { name: "Covered", value: Number(gaps.covered_cells || 0) },
        { name: "Blind spots", value: Number(gaps.gap_cells || 0) },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-chalk">Coverage & health</h2>
          <p className="mt-1 text-sm text-chalk/60">
            PostGIS blind-spot fishnet, fleet uptime, and aging infrastructure.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => exportCsv("cameras")}
            className="border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-chalk/70 hover:border-forest-500/40 hover:text-forest-400"
          >
            Export metadata CSV
          </button>
          <button
            type="button"
            onClick={() => exportCsv("gaps")}
            className="border border-saffron-500/40 bg-saffron-500/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-saffron-400 hover:bg-saffron-500/20"
          >
            Export Gap Report
          </button>
        </div>
      </div>
      {exportMsg && (
        <p className="font-mono text-[10px] text-chalk/45">{exportMsg}</p>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          label="Fleet uptime"
          value={`${uptime?.uptime_pct ?? "—"}%`}
          hint={`${uptime?.online ?? 0} / ${uptime?.total ?? 0} online`}
        />
        <Stat
          label="Coverage"
          value={`${gaps?.coverage_pct ?? "—"}%`}
          hint={`${gaps?.gap_cells ?? "—"} gap cells · ${gaps?.mode ?? ""}`}
        />
        <Stat
          label="Aging assets"
          value={String(aging?.aging_count ?? "—")}
          hint={`Installed > ${aging?.threshold_years ?? 5} years`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartPanel title="Status mix">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={uptimePie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}>
                {uptimePie.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1a2740", border: "1px solid rgba(255,255,255,.1)" }}
              />
            </PieChart>
          </ResponsiveContainer>
        </ChartPanel>

        <ChartPanel title="Blind-spot cells">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={coverageBar}>
              <CartesianGrid stroke="rgba(255,255,255,.08)" vertical={false} />
              <XAxis dataKey="name" stroke="#8a9bb5" fontSize={12} />
              <YAxis stroke="#8a9bb5" fontSize={12} />
              <Tooltip
                contentStyle={{ background: "#1a2740", border: "1px solid rgba(255,255,255,.1)" }}
              />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                <Cell fill="#2d7a52" />
                <Cell fill="#e8872a" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>

      {Array.isArray(aging?.cameras) && (aging.cameras as unknown[]).length > 0 && (
        <div className="overflow-hidden rounded-lg border border-white/10">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-800/80 text-xs uppercase tracking-wide text-chalk/50">
              <tr>
                <th className="px-3 py-2">Camera</th>
                <th className="px-3 py-2">Installed</th>
                <th className="px-3 py-2">Age (y)</th>
              </tr>
            </thead>
            <tbody>
              {(aging.cameras as { name: string; installed_at: string; age_years: number }[]).map(
                (c, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-chalk/60">
                      {c.installed_at?.slice(0, 10)}
                    </td>
                    <td className="px-3 py-2 font-mono text-saffron-400">{c.age_years}</td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-ink-900/50 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-chalk/45">{label}</div>
      <div className="mt-1 font-display text-3xl text-chalk">{value}</div>
      <div className="mt-1 text-xs text-chalk/50">{hint}</div>
    </div>
  );
}

function ChartPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/10 bg-ink-900/40 p-4">
      <h3 className="mb-3 text-sm font-medium text-chalk/80">{title}</h3>
      {children}
    </div>
  );
}
