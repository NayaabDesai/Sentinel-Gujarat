import { useAuth } from "../../context/AuthContext";

type Tab = "map" | "ingest" | "analytics";

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
};

const ROLE_STYLE: Record<string, string> = {
  ADMIN: "border-saffron-500/40 bg-saffron-500/15 text-saffron-400",
  OPERATOR: "border-forest-500/40 bg-forest-500/15 text-forest-400",
  VIEWER: "border-white/15 bg-white/5 text-chalk/60",
};

export default function Navbar({ tab, onTab }: Props) {
  const { user, logout } = useAuth();
  const canWrite = user?.role === "ADMIN" || user?.role === "OPERATOR";

  return (
    <header className="shrink-0 border-b border-white/10 bg-ink-900/60 px-4 py-2 backdrop-blur md:px-6">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center border border-forest-500/40 bg-forest-500/10 font-mono text-xs font-bold text-forest-400">
            SG
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.22em] text-saffron-400">
              C2 · Model 1 Registry
            </p>
            <h1 className="font-display text-lg font-semibold tracking-tight text-chalk">
              Sentinel Gujarat
            </h1>
          </div>
        </div>

        <nav className="flex gap-0.5 border border-white/10 bg-ink-950/80 p-0.5">
          {(
            [
              ["map", "GIS & Live", true],
              ["ingest", "Onboarding", canWrite],
              ["analytics", "Analytics", true],
            ] as const
          ).map(([id, label, enabled]) => (
            <button
              key={id}
              type="button"
              disabled={!enabled}
              title={
                !enabled
                  ? "VIEWER is read-only — bulk upload disabled"
                  : undefined
              }
              onClick={() => enabled && onTab(id)}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                tab === id
                  ? "bg-forest-500/20 text-forest-400"
                  : enabled
                    ? "text-chalk/50 hover:text-chalk"
                    : "cursor-not-allowed text-chalk/25"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          {user && (
            <>
              <div className="hidden text-right sm:block">
                <div className="font-mono text-[10px] text-chalk/45">{user.email}</div>
                <div className="flex items-center justify-end gap-1.5">
                  <span
                    className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${
                      ROLE_STYLE[user.role] || ROLE_STYLE.VIEWER
                    }`}
                  >
                    {user.role}
                  </span>
                  {user.department_code && (
                    <span className="font-mono text-[10px] text-chalk/50">
                      {user.department_code}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={logout}
                className="border border-white/10 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-chalk/50 hover:border-rose-500/40 hover:text-rose-400"
              >
                Logout
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
