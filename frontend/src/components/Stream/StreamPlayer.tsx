import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { API_BASE, getToken } from "../../lib/api";

type Props = {
  cameraId: string | null;
  externalId: string | null;
  whepUrl: string | null;
  hlsUrl: string | null;
  rtspUrl?: string | null;
  className?: string;
};

type Protocol = "whep" | "hls-cdn" | "hls-proxy" | "mjpeg" | "none";
type Phase = "connecting" | "live" | "failed";

const WHEP_TIMEOUT_MS = 3500;
const HLS_CDN_TIMEOUT_MS = 4000;
const MJPEG_TIMEOUT_MS = 8000;

/**
 * Waterfall:
 * 1) WHEP via backend signaling proxy
 * 2) Direct CDN HLS
 * 3) Backend HLS proxy
 * 4) On-demand RTSP→MJPEG relay (reliable path when Corp8 blocks browser HLS)
 * 5) Offline HUD
 */
export default function StreamPlayer({
  cameraId,
  externalId,
  whepUrl,
  hlsUrl,
  rtspUrl,
  className,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [protocol, setProtocol] = useState<Protocol>("none");
  const [latencyHint, setLatencyHint] = useState("—");
  const [diag, setDiag] = useState<string>("");
  const [retryKey, setRetryKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [mjpegSrc, setMjpegSrc] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  const proxyUrl =
    cameraId != null ? `${API_BASE}/api/v1/stream/proxy/${cameraId}/index.m3u8` : null;
  const whepProxyUrl =
    cameraId != null ? `${API_BASE}/api/v1/stream/whep/${cameraId}` : null;

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setMjpegSrc(null);
    const video = videoRef.current;
    if (video) {
      if (video.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
      video.removeAttribute("src");
      video.load();
    }
  }, []);

  const markLive = (proto: Protocol) => {
    const ms = Date.now() - startedAt.current;
    setLatencyHint(
      proto === "whep"
        ? `${ms}ms`
        : proto === "hls-cdn"
          ? "CDN"
          : proto === "hls-proxy"
            ? "PROXY"
            : "RTSP"
    );
    setProtocol(proto);
    setPhase("live");
  };

  const startMjpeg = useCallback(
    (reason: string) => {
      setDiag(reason);
      if (!cameraId) {
        setPhase("failed");
        setProtocol("none");
        return;
      }
      const token = getToken();
      if (!token) {
        setDiag(`${reason} → no JWT for MJPEG`);
        setPhase("failed");
        setProtocol("none");
        return;
      }
      setProtocol("mjpeg");
      setPhase("connecting");
      pcRef.current?.close();
      pcRef.current = null;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      const url = `${API_BASE}/api/v1/stream/proxy/${cameraId}/mjpeg?token=${encodeURIComponent(token)}`;
      setMjpegSrc(url);

      const timer = setTimeout(() => {
        // If still connecting after timeout, fail (img onLoad/onError should fire earlier)
        setPhase((p) => {
          if (p === "connecting") {
            setDiag(`${reason} → MJPEG timeout`);
            setProtocol("none");
            return "failed";
          }
          return p;
        });
      }, MJPEG_TIMEOUT_MS);

      // Cleanup timer when effect re-runs via img handlers using data attribute
      const img = imgRef.current;
      if (img) {
        (img as HTMLImageElement & { _mjpegTimer?: ReturnType<typeof setTimeout> })._mjpegTimer =
          timer;
      }
    },
    [cameraId]
  );

  const playHls = useCallback(
    (url: string, proto: Protocol, onFatal: () => void) => {
      const video = videoRef.current;
      if (!video) {
        onFatal();
        return;
      }
      pcRef.current?.close();
      pcRef.current = null;
      setMjpegSrc(null);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      setProtocol(proto);
      setPhase("connecting");

      const withAuth = (xhr: XMLHttpRequest) => {
        const token = getToken();
        if (token && url.includes("/api/v1/stream/proxy")) {
          xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }
      };

      if (video.canPlayType("application/vnd.apple.mpegurl") && proto === "hls-cdn") {
        video.src = url;
        const t = setTimeout(() => {
          if (video.readyState < 2) onFatal();
        }, HLS_CDN_TIMEOUT_MS);
        video.onloadeddata = () => {
          clearTimeout(t);
          video.play().catch(() => undefined);
          markLive(proto);
        };
        video.onerror = () => {
          clearTimeout(t);
          onFatal();
        };
        return;
      }

      if (!Hls.isSupported()) {
        onFatal();
        return;
      }

      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup: (xhr) => withAuth(xhr),
      });
      hlsRef.current = hls;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          onFatal();
        }
      }, HLS_CDN_TIMEOUT_MS);

      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.play().catch(() => undefined);
        markLive(proto);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && !settled) {
          settled = true;
          clearTimeout(timer);
          onFatal();
        }
      });
    },
    []
  );

  const startProxy = useCallback(
    (reason: string) => {
      setDiag(reason);
      if (!proxyUrl) {
        startMjpeg(`${reason} → no HLS proxy URL`);
        return;
      }
      playHls(proxyUrl, "hls-proxy", () => startMjpeg(`${reason} → HLS proxy failed`));
    },
    [playHls, proxyUrl, startMjpeg]
  );

  const startCdnHls = useCallback(
    (reason: string) => {
      setDiag(reason);
      if (!hlsUrl) {
        startProxy(`${reason} → no CDN URL`);
        return;
      }
      playHls(hlsUrl, "hls-cdn", () => startProxy(`${reason} → CDN HLS failed`));
    },
    [hlsUrl, playHls, startProxy]
  );

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    startedAt.current = Date.now();
    setPhase("connecting");
    setProtocol("none");
    setLatencyHint("—");
    setDiag("");
    cleanup();

    const video = videoRef.current;
    if (!video) return;

    if (!whepProxyUrl && !whepUrl) {
      startCdnHls("no WHEP URL");
      return () => {
        cancelled = true;
        cleanup();
      };
    }

    setProtocol("whep");
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    let whepLive = false;

    pc.ontrack = (ev) => {
      if (cancelled) return;
      whepLive = true;
      if (timeoutId) clearTimeout(timeoutId);
      video.srcObject = ev.streams[0];
      video.play().catch(() => undefined);
      markLive("whep");
    };

    pc.onconnectionstatechange = () => {
      if (cancelled || whepLive) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        startCdnHls(`WebRTC ${pc.connectionState}`);
      }
    };

    timeoutId = setTimeout(() => {
      if (cancelled || whepLive) return;
      startCdnHls("WHEP timeout 3.5s");
    }, WHEP_TIMEOUT_MS);

    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
          setTimeout(resolve, 1200);
        });
        if (cancelled || whepLive) return;

        const token = getToken();
        const headers: Record<string, string> = { "Content-Type": "application/sdp" };
        if (token) headers.Authorization = `Bearer ${token}`;

        // Prefer backend signaling (Basic Auth stays server-side)
        const signalingUrl = whepProxyUrl || whepUrl!;
        const res = await fetch(signalingUrl, {
          method: "POST",
          headers,
          body: pc.localDescription?.sdp || offer.sdp,
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const answer = await res.text();
        if (cancelled || whepLive) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch (e) {
        if (cancelled || whepLive) return;
        startCdnHls(e instanceof Error ? e.message : "WHEP error");
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
    };
  }, [whepUrl, whepProxyUrl, hlsUrl, cameraId, retryKey, cleanup, startCdnHls]);

  const pill =
    protocol === "whep" && phase === "live"
      ? `WHEP ${latencyHint}`
      : protocol === "hls-cdn" && phase === "live"
        ? `HLS CDN`
        : protocol === "hls-proxy" && phase === "live"
          ? `HLS PROXY`
          : protocol === "mjpeg" && phase === "live"
            ? `MJPEG RTSP`
            : phase === "connecting"
              ? "HANDSHAKE…"
              : "OFFLINE";

  const pillClass =
    protocol === "whep" && phase === "live"
      ? "border-forest-500/40 bg-forest-500/20 text-forest-400"
      : (protocol === "hls-cdn" || protocol === "hls-proxy" || protocol === "mjpeg") &&
          phase === "live"
        ? "border-saffron-500/40 bg-saffron-500/15 text-saffron-400"
        : phase === "failed"
          ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
          : "border-white/10 bg-black/40 text-chalk/60";

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

  return (
    <div className={`relative overflow-hidden bg-ink-950 ${className || ""}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-contain ${mjpegSrc ? "hidden" : ""}`}
      />
      {mjpegSrc && (
        <img
          ref={imgRef}
          src={mjpegSrc}
          alt={externalId || "camera feed"}
          className="h-full w-full object-contain"
          onLoad={() => {
            markLive("mjpeg");
          }}
          onError={() => {
            setDiag((d) => `${d || "proxy"} → MJPEG failed`);
            setPhase("failed");
            setProtocol("none");
            setMjpegSrc(null);
          }}
        />
      )}

      {phase === "connecting" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/75">
          <div className="h-8 w-8 animate-pulse border border-forest-500/40 border-t-forest-400" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-chalk/50">
            Establishing feed…
          </span>
          {diag && <span className="max-w-[90%] truncate font-mono text-[9px] text-chalk/35">{diag}</span>}
        </div>
      )}

      {phase === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/90 px-3 text-center">
          <span className="font-mono text-[10px] uppercase tracking-wider text-rose-400">
            Feed offline / RTSP direct only
          </span>
          <p className="font-mono text-[9px] text-chalk/45">
            {externalId || "camera"} · ping {latencyHint} · {diag || "all stages failed"}
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
        className={`absolute left-2 top-2 border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${pillClass}`}
      >
        {pill}
      </span>
      {phase === "live" && (
        <button
          type="button"
          onClick={copyRtsp}
          className="absolute bottom-2 right-2 border border-white/10 bg-black/50 px-1.5 py-0.5 font-mono text-[8px] text-chalk/50 hover:text-chalk"
          title={ffplayCmd}
        >
          {copied ? "COPIED" : "RTSP CLI"}
        </button>
      )}
    </div>
  );
}
