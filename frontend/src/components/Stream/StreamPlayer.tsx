import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type Props = {
  whepUrl: string | null;
  hlsUrl: string | null;
  className?: string;
};

type Protocol = "whep" | "hls" | "none";
type Phase = "connecting" | "live" | "fallback" | "failed";

const WHEP_TIMEOUT_MS = 3500;

/**
 * Unified tactical stream player: WHEP first, auto-failover to HLS at 3.5s.
 */
export default function StreamPlayer({ whepUrl, hlsUrl, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [protocol, setProtocol] = useState<Protocol>("none");
  const [latencyHint, setLatencyHint] = useState<string>("—");
  const [retryKey, setRetryKey] = useState(0);
  const startedAt = useRef(Date.now());

  const cleanup = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
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

  const startHls = useCallback(
    (reason: string) => {
      const video = videoRef.current;
      if (!video || !hlsUrl) {
        setPhase("failed");
        setProtocol("none");
        return;
      }
      // Tear down WHEP before HLS
      pcRef.current?.close();
      pcRef.current = null;
      video.srcObject = null;

      setPhase("fallback");
      setProtocol("hls");
      setLatencyHint("~3s");
      console.info("[StreamPlayer] HLS fallback:", reason);

      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsUrl;
        video.play().catch(() => undefined);
        setPhase("live");
        return;
      }
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
        hlsRef.current = hls;
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => undefined);
          setPhase("live");
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setPhase("failed");
        });
      } else {
        setPhase("failed");
      }
    },
    [hlsUrl]
  );

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    startedAt.current = Date.now();
    setPhase("connecting");
    setProtocol("none");
    setLatencyHint("—");
    cleanup();

    const video = videoRef.current;
    if (!video) return;

    if (!whepUrl) {
      startHls("no WHEP URL");
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
      const ms = Date.now() - startedAt.current;
      setLatencyHint(`${ms}ms`);
      setProtocol("whep");
      setPhase("live");
    };

    pc.onconnectionstatechange = () => {
      if (cancelled || whepLive) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        startHls(`WebRTC ${pc.connectionState}`);
      }
    };

    timeoutId = setTimeout(() => {
      if (cancelled || whepLive) return;
      startHls("WHEP timeout 3.5s");
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

        const res = await fetch(whepUrl, {
          method: "POST",
          headers: { "Content-Type": "application/sdp" },
          body: pc.localDescription?.sdp || offer.sdp,
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const answer = await res.text();
        if (cancelled || whepLive) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch (e) {
        if (cancelled || whepLive) return;
        startHls(e instanceof Error ? e.message : "WHEP error");
      }
    })();

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      cleanup();
    };
  }, [whepUrl, hlsUrl, retryKey, cleanup, startHls]);

  const pill =
    protocol === "whep" && phase === "live"
      ? `LIVE · WHEP ${latencyHint}`
      : protocol === "hls" && (phase === "live" || phase === "fallback")
        ? `FALLBACK · HLS ${latencyHint}`
        : phase === "connecting"
          ? "CONNECTING…"
          : "OFFLINE";

  const pillClass =
    protocol === "whep" && phase === "live"
      ? "border-forest-500/40 bg-forest-500/20 text-forest-400"
      : protocol === "hls"
        ? "border-saffron-500/40 bg-saffron-500/15 text-saffron-400"
        : phase === "failed"
          ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
          : "border-white/10 bg-black/40 text-chalk/60";

  return (
    <div className={`relative overflow-hidden bg-ink-950 ${className || ""}`}>
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />

      {(phase === "connecting" || phase === "fallback") && phase !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950/75">
          <div className="h-8 w-8 animate-pulse border border-forest-500/40 border-t-forest-400" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-chalk/50">
            {phase === "fallback" ? "Switching to HLS…" : "Establishing feed…"}
          </span>
        </div>
      )}

      {phase === "failed" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/85">
          <span className="font-mono text-xs text-rose-400">Feed unavailable</span>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            className="border border-white/15 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-chalk/70 hover:border-forest-500/40 hover:text-forest-400"
          >
            Retry
          </button>
        </div>
      )}

      <span
        className={`absolute left-2 top-2 border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${pillClass}`}
      >
        {pill}
      </span>
    </div>
  );
}
