import { useEffect, useMemo, useRef, useState } from "react";
import type { Camera } from "../../lib/api";

type Props = {
  cameras: Camera[];
  onSelect: (cam: Camera) => void;
};

/**
 * Sticky tactical search — Ctrl+K or `/` focuses.
 * Filters by external_id, name, department, status (client-side, no map remount).
 */
export default function CameraSearch({ cameras, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return cameras
      .filter((c) => {
        const blob = [c.external_id, c.name, c.department_code || "", c.status]
          .join(" ")
          .toLowerCase();
        return blob.includes(needle);
      })
      .slice(0, 12);
  }, [cameras, q]);

  return (
    <div className="relative z-30">
      <div className="flex items-center gap-2 border border-white/10 bg-ink-950/90 px-2 py-1.5 backdrop-blur">
        <span className="font-mono text-[9px] text-chalk/35">⌘K</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search cam id / name / dept / status…"
          className="w-full bg-transparent font-mono text-xs text-chalk outline-none placeholder:text-chalk/30"
        />
        {q && (
          <button
            type="button"
            className="font-mono text-[10px] text-chalk/40"
            onClick={() => {
              setQ("");
              setOpen(false);
            }}
          >
            CLR
          </button>
        )}
      </div>
      {open && hits.length > 0 && (
        <ul className="absolute left-0 right-0 top-full mt-1 max-h-64 overflow-y-auto border border-white/10 bg-ink-900 shadow-panel">
          {hits.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/5"
                onClick={() => {
                  onSelect(c);
                  setQ(c.external_id);
                  setOpen(false);
                }}
              >
                <span className="truncate text-sm text-chalk">{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-chalk/40">
                  {c.external_id} · {c.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
