const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const SANDBOX_HOST = import.meta.env.VITE_SANDBOX_HOST || "localhost";

export { API_BASE, SANDBOX_HOST };

export type Camera = {
  id: string;
  external_id: string;
  name: string;
  department_code: string | null;
  latitude: number | null;
  longitude: number | null;
  heading_deg: number | null;
  fov_deg: number | null;
  range_m: number | null;
  status: string;
  is_active: boolean;
  whep_url: string | null;
  hls_url: string | null;
  last_seen_at: string | null;
};

export type Department = {
  id: string;
  code: string;
  name: string;
  camera_count: number;
};

export type StreamSession = {
  session_id: string;
  camera_id: string;
  external_id: string;
  protocol: string;
  whep_url: string;
  hls_url: string;
  rtsp_url: string | null;
  media_auth: string | null;
  active: boolean;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  cameras: (department?: string) =>
    json<Camera[]>(`/api/v1/cameras${department ? `?department=${encodeURIComponent(department)}` : ""}`),
  geojson: (department?: string) =>
    json<GeoJSON.FeatureCollection>(
      `/api/v1/cameras/geojson${department ? `?department=${encodeURIComponent(department)}` : ""}`
    ),
  departments: () => json<Department[]>("/api/v1/cameras/meta/departments"),
  gaps: () => json<Record<string, unknown>>("/api/v1/analytics/gaps"),
  uptime: () => json<Record<string, unknown>>("/api/v1/analytics/uptime"),
  aging: () => json<Record<string, unknown>>("/api/v1/analytics/aging"),
  syncIngest: () =>
    json<Record<string, unknown>>("/api/v1/ingest/sync", { method: "POST" }),
  bulkUpload: async (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return json<{
      total: number;
      created: number;
      updated: number;
      errors: { row?: number; error: string }[];
    }>("/api/v1/cameras/bulk", { method: "POST", body: fd });
  },
  startSession: (camera_id: string, client_id: string, protocol: "whep" | "hls" = "whep") =>
    json<StreamSession>("/api/v1/stream/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id, client_id, protocol }),
    }),
  heartbeat: (session_id: string, client_id: string) =>
    json("/api/v1/stream/sessions/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id, client_id }),
    }),
  endSession: (session_id: string, client_id: string) =>
    json(`/api/v1/stream/sessions/${session_id}?client_id=${encodeURIComponent(client_id)}`, {
      method: "DELETE",
    }),
};

declare global {
  namespace GeoJSON {
    type FeatureCollection = {
      type: "FeatureCollection";
      features: Feature[];
    };
    type Feature = {
      type: "Feature";
      geometry: { type: string; coordinates: number[] };
      properties: Record<string, unknown>;
    };
  }
}
