import { useEffect, useRef, useState } from "react";

type Props = {
  whepUrl: string;
  /** HTTP Basic Authorization header value from session (e.g. "Basic …") */
  mediaAuth?: string | null;
  className?: string;
  onFailure?: () => void;
};

/**
 * Native WebRTC WHEP player for sub-second preview.
 * Endpoint: http://103.250.160.189:8889/stream/<id>/whep (+ Basic auth)
 */
export default function WhepPlayer({ whepUrl, mediaAuth, className, onFailure }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"connecting" | "live" | "failed">("connecting");

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    pcRef.current = pc;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (ev) => {
      if (cancelled) return;
      if (video.srcObject !== ev.streams[0]) {
        video.srcObject = ev.streams[0];
      }
      setState("live");
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        setState("failed");
        setError(`WebRTC ${pc.connectionState}`);
        onFailure?.();
      }
    };

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
          setTimeout(resolve, 1500);
        });

        const headers: Record<string, string> = {
          "Content-Type": "application/sdp",
        };
        if (mediaAuth) {
          headers.Authorization = mediaAuth;
        }

        const res = await fetch(whepUrl, {
          method: "POST",
          headers,
          body: pc.localDescription?.sdp || offer.sdp,
        });

        if (!res.ok) {
          throw new Error(`WHEP ${res.status}: ${await res.text()}`);
        }

        const answer = await res.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setState("failed");
        onFailure?.();
      }
    })();

    return () => {
      cancelled = true;
      pc.close();
      pcRef.current = null;
      if (video.srcObject) {
        (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
    };
  }, [whepUrl, mediaAuth, onFailure]);

  return (
    <div className={`relative overflow-hidden bg-ink-950 ${className || ""}`}>
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
      {state !== "live" && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70 text-sm text-chalk/70">
          {state === "connecting" ? "Connecting WHEP…" : error || "WHEP failed"}
        </div>
      )}
      <span className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-saffron-400">
        WebRTC · WHEP
      </span>
    </div>
  );
}
