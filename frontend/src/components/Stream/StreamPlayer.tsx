import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, getToken } from "../../lib/api";

type Props = {
  cameraId: string | null;
  externalId: string | null;
  whepUrl?: string | null;
  hlsUrl?: string | null;
  rtspUrl?: string | null;
  className?: string;
};

type Protocol = "mjpeg" | "none";
type Phase = "connecting" | "live" | "failed";

const MJPEG_ASSUME_LIVE_MS = 1500;
const MJPEG_TIMEOUT_MS = 30000;

/**
 * On-demand preview: RTSP → MJPEG via backend (reliable on this sandbox).
 * WHEP/HLS are blocked for most client networks / Corp8 browser rules.
 */
export default function StreamPlayer({
  cameraId,
  externalId,
  rtspUrl,
  className,
}: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [protocol, setProtocol] = useState<Protocol>("none");
  const [diag, setDiag] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [mjpegSrc, setMjpegSrc] = useState<string | null>(null);

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };

  const startMjpeg = useCallback(() => {
    clearTimers();
    if (!cameraId) {
      setPhase("failed");
      setDiag("No camera id");
      return;
    }
    const token = getToken();
    if (!token) {
      setPhase("failed");
      setDiag("Not logged in");
      return;
    }

    setPhase("connecting");
    setProtocol("mjpeg");
    setDiag("Opening RTSP → MJPEG…");
    const url = `${API_BASE}/api/v1/stream/proxy/${cameraId}/mjpeg?token=${encodeURIComponent(token)}&t=${Date.now()}`;
    setMjpegSrc(url);

    const assumeLive = setTimeout(() => {
      setPhase((p) => (p === "connecting" ? "live" : p));
      setDiag("");
    }, MJPEG_ASSUME_LIVE_MS);

    const hardFail = setTimeout(() => {
      setPhase((p) => {
        if (p !== "connecting") return p;
        setDiag("RTSP/MJPEG timeout — close Corp8 portal tab, then Retry");
        setMjpegSrc(null);
        setProtocol("none");
        return "failed";
      });
    }, MJPEG_TIMEOUT_MS);

    timersRef.current = [assumeLive, hardFail];
  }, [cameraId]);

  useEffect(() => {
    startMjpeg();
    return () => {
      clearTimers();
      setMjpegSrc(null);
    };
  }, [cameraId, retryKey, startMjpeg]);

  const ffplayCmd = rtspUrl
    ? `ffplay -rtsp_transport tcp "${rtspUrl}"`
    : externalId
      ? `# No RTSP URL — external_id=${externalId}`
      : "# No RTSP";

  const copyRtsp = async () => {
    try {
      await navigator.clipboard.writeText(ffplayCmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  const pill =
    protocol === "mjpeg" && phase === "live"
      ? "MJPEG RTSP"
      : phase === "connecting"
        ? "CONNECTING…"
        : "OFFLINE";

  const pillClass =
    phase === "live"
      ? "border-saffron-500/40 bg-saffron-500/15 text-saffron-400"
      : phase === "failed"
        ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
        : "border-white/10 bg-black/50 text-chalk/60";

  return (
    <div className={`relative overflow-hidden bg-black ${className || ""}`}>
      {mjpegSrc ? (
        <img
          ref={imgRef}
          src={mjpegSrc}
          alt={externalId || "camera feed"}
          className="h-full w-full object-contain"
          onLoad={() => {
            clearTimers();
            setPhase("live");
            setProtocol("mjpeg");
            setDiag("");
          }}
          onError={() => {
            clearTimers();
            setPhase("failed");
            setProtocol("none");
            setMjpegSrc(null);
            setDiag("MJPEG request failed");
          }}
        />
      ) : (
        <div className="flex h-full min-h-[240px] w-full items-center justify-center bg-ink-950" />
      )}

      {phase === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/70">
          <div className="h-8 w-8 animate-pulse border border-forest-500/40 border-t-forest-400" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-chalk/60">
            Connecting feed…
          </span>
          {diag && <span className="font-mono text-[9px] text-chalk/40">{diag}</span>}
        </div>
      )}

      {phase === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/95 px-3 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wider text-rose-400">
            Feed offline / RTSP direct only
          </span>
          <p className="font-mono text-[9px] text-chalk/45">
            {externalId || "camera"} · {diag || "failed"}
          </p>
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => setRetryKey((k) => k + 1)}
              className="border border-forest-500/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-forest-400 hover:bg-forest-500/15"
            >
              Retry handshake
            </button>
            <button
              type="button"
              onClick={copyRtsp}
              className="border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-chalk/60 hover:text-chalk"
            >
              {copied ? "Copied" : "Copy ffplay RTSP"}
            </button>
          </div>
        </div>
      )}

      <span
        className={`absolute left-2 top-2 z-10 border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${pillClass}`}
      >
        {pill}
      </span>
      {phase === "live" && (
        <button
          type="button"
          onClick={copyRtsp}
          className="absolute bottom-2 right-2 z-10 border border-white/10 bg-black/60 px-1.5 py-0.5 font-mono text-[8px] text-chalk/50 hover:text-chalk"
          title={ffplayCmd}
        >
          {copied ? "COPIED" : "RTSP CLI"}
        </button>
      )}
    </div>
  );
}
