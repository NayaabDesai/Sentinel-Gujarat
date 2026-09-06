import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Camera } from "../../lib/api";
import StreamPlayer from "./StreamPlayer";

type Props = {
  camera: Camera | null;
  open: boolean;
  starting?: boolean;
  onClose: () => void;
};

function ApproxGeoBadge({ cam }: { cam: Camera }) {
  if (!cam.meta || cam.meta.geo_source !== "inferred") return null;
  return (
    <span className="mt-1 inline-flex border border-saffron-500/40 bg-saffron-500/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-saffron-400">
      ⚠ Approx. Geo-Location (Inferred from Title)
    </span>
  );
}

/** Modal live preview — portaled to document.body so MapLibre cannot cover it. */
export default function StreamPreviewModal({ camera, open, starting, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !camera) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Camera live preview"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-3xl flex-col overflow-hidden rounded-sm border-2 border-white/25 bg-[#121826] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/10 bg-[#0e1420] px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-saffron-400">
              Live preview · session
            </p>
            <h2 className="truncate text-lg font-medium text-white">{camera.name}</h2>
            <p className="font-mono text-[10px] text-white/55">
              {camera.external_id}
              {camera.latitude != null && camera.longitude != null && (
                <>
                  {" "}
                  · {camera.latitude.toFixed(4)}, {camera.longitude.toFixed(4)}
                </>
              )}
            </p>
            <ApproxGeoBadge cam={camera} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 border border-white/20 bg-white/5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-white/80 hover:border-rose-400/50 hover:text-rose-300"
          >
            Close
          </button>
        </div>

        <div className="relative aspect-video w-full bg-black">
          {starting ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2">
              <div className="h-8 w-8 animate-pulse border border-forest-500/40 border-t-forest-400" />
              <span className="font-mono text-[10px] uppercase tracking-wider text-white/50">
                Starting session…
              </span>
            </div>
          ) : (
            <StreamPlayer
              key={camera.id}
              cameraId={camera.id}
              externalId={camera.external_id}
              whepUrl={camera.whep_url}
              hlsUrl={camera.hls_url}
              rtspUrl={camera.rtsp_url}
              className="h-full min-h-[240px] w-full"
            />
          )}
        </div>

        <p className="border-t border-white/10 px-4 py-2 font-mono text-[9px] text-white/40">
          On-demand MJPEG via RTSP. Close the Corp8 portal tab — one web session per IP. Esc to
          close.
        </p>
      </div>
    </div>,
    document.body
  );
}
