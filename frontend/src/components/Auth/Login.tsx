import { FormEvent, useState } from "react";
import { useAuth } from "../../context/AuthContext";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("admin@police.gujarat.gov.in");
  const [password, setPassword] = useState("Sentinel@2026");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md border border-white/10 bg-ink-900/80 p-8 shadow-panel backdrop-blur">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center border border-forest-500/40 bg-forest-500/10 font-mono text-lg font-bold text-forest-400">
            SG
          </div>
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-saffron-400">
            Gujarat Police · Command & Control
          </p>
          <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-chalk">
            Sentinel Gujarat
          </h1>
          <p className="mt-2 text-sm text-chalk/50">
            Restricted tactical access — authorised personnel only
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <label className="block text-[11px] uppercase tracking-wider text-chalk/45">
            Official email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-sm text-chalk outline-none focus:border-forest-500/50"
              autoComplete="username"
            />
          </label>
          <label className="block text-[11px] uppercase tracking-wider text-chalk/45">
            Access password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full border border-white/10 bg-ink-950 px-3 py-2.5 font-mono text-sm text-chalk outline-none focus:border-forest-500/50"
              autoComplete="current-password"
            />
          </label>

          {error && (
            <div className="border border-rose-500/30 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full border border-forest-500/40 bg-forest-500/20 py-2.5 text-sm font-medium text-forest-400 transition hover:bg-forest-500/30 disabled:opacity-50"
          >
            {busy ? "Authenticating…" : "Enter Command Center"}
          </button>
        </form>

        <p className="mt-6 font-mono text-[10px] leading-relaxed text-chalk/35">
          Seeded: admin@police.gujarat.gov.in · amc.traffic@gujarat.gov.in · Sentinel@2026
        </p>
      </div>
    </div>
  );
}
