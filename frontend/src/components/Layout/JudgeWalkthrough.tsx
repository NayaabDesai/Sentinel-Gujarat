import { useState } from "react";

const STEPS = [
  "Sync Catalog (Admin)",
  "Locate Junction (Search /)",
  "Test Video Stream",
  "View PostGIS Gap Report + Export",
];

export default function JudgeWalkthrough() {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(0);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-saffron-500/30 bg-saffron-500/10 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-saffron-400"
      >
        Judge walkthrough
      </button>
    );
  }

  return (
    <div className="border border-saffron-500/30 bg-saffron-500/10 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-saffron-400">
          Evaluator walkthrough · Model 1
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="font-mono text-[10px] text-chalk/40 hover:text-chalk"
        >
          Collapse
        </button>
      </div>
      <ol className="mt-2 flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => setStep(i)}
              className={`border px-2 py-1 font-mono text-[10px] ${
                i === step
                  ? "border-saffron-500/50 bg-saffron-500/20 text-saffron-400"
                  : i < step
                    ? "border-forest-500/30 text-forest-400"
                    : "border-white/10 text-chalk/45"
              }`}
            >
              {i + 1}. {label}
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-chalk/55">
        {step === 0 && "Login as admin → click Sync sandbox catalog (one IP session — brief)."}
        {step === 1 && "Press / or Ctrl+K → type cam04 or Paldi → map flies to camera."}
        {step === 2 && "Open Live preview — WHEP → HLS CDN → HLS Proxy waterfall."}
        {step === 3 && "Open Analytics → Export Gap Report CSV for Model 1 deliverable."}
      </p>
    </div>
  );
}
