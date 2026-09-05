import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
  hlsUrl: string;
  className?: string;
};

/**
 * HLS.js fallback: http://<HOST>/live/stream/<id>/index.m3u8
 */
export default function HlsPlayer({ hlsUrl, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
      video.play().catch(() => undefined);
      return () => {
        video.removeAttribute("src");
        video.load();
      };
    }

    if (!Hls.isSupported()) {
      setError("HLS not supported in this browser");
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });
    hls.loadSource(hlsUrl);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setError(data.type);
        hls.destroy();
      }
    });

    return () => {
      hls.destroy();
    };
  }, [hlsUrl]);

  return (
    <div className={`relative overflow-hidden bg-ink-950 ${className || ""}`}>
      <video ref={videoRef} controls autoPlay muted playsInline className="h-full w-full object-contain" />
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70 text-sm text-chalk/70">
          HLS error: {error}
        </div>
      )}
      <span className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-forest-400">
        HLS fallback
      </span>
    </div>
  );
}
