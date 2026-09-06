const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const SANDBOX_HOST = import.meta.env.VITE_SANDBOX_HOST || "localhost";

export { API_BASE, SANDBOX_HOST };

const TOKEN_KEY = "sentinel_jwt";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export type UserProfile = {
  id: string;
  email: string;
  full_name: string | null;
  department_code: string | null;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  is_active: boolean;
};

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
  rtsp_url?: string | null;
  last_seen_at: string | null;
  meta?: { geo_source?: string; geo_disclaimer?: string; [k: string]: unknown } | null;
  distance_meters?: number;
  knn_fallback?: boolean;
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
  active: boolean;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError(401, "Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  login: async (email: string, password: string) => {
    const body = new URLSearchParams();
    body.set("username", email);
    body.set("password", password);
    const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, text || "Login failed");
    }
    return res.json() as Promise<{ access_token: string; token_type: string }>;
  },
  me: () => json<UserProfile>("/api/v1/auth/me"),
  cameras: (department?: string) =>
    json<Camera[]>(`/api/v1/cameras${department ? `?department=${encodeURIComponent(department)}` : ""}`),
  geojson: (department?: string) =>
    json<GeoJSON.FeatureCollection>(
      `/api/v1/cameras/geojson${department ? `?department=${encodeURIComponent(department)}` : ""}`
    ),
  nearby: (lat: number, lon: number, radius_meters = 500, limit = 10, department?: string) => {
    const q = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      radius_meters: String(radius_meters),
      limit: String(limit),
    });
    if (department) q.set("department", department);
    return json<Camera[]>(`/api/v1/cameras/nearby?${q}`);
  },
  departments: () => json<Department[]>("/api/v1/cameras/meta/departments"),
  gaps: () => json<Record<string, unknown>>("/api/v1/analytics/gaps"),
  uptime: () => json<Record<string, unknown>>("/api/v1/analytics/uptime"),
  aging: () => json<Record<string, unknown>>("/api/v1/analytics/aging"),
  syncIngest: () => json<Record<string, unknown>>("/api/v1/ingest/sync", { method: "POST" }),
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
      body: JSON.stringify({ camera_id, client_id, protocol }),
    }),
  heartbeat: (session_id: string, client_id: string) =>
    json("/api/v1/stream/sessions/heartbeat", {
      method: "POST",
      body: JSON.stringify({ session_id, client_id }),
    }),
  endSession: (session_id: string, client_id: string) =>
    json(`/api/v1/stream/sessions/${session_id}?client_id=${encodeURIComponent(client_id)}`, {
      method: "DELETE",
    }),
  /** Authenticated blob download for Model 1 CSV exports */
  downloadExport: async (path: string, fallbackName: string) => {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${API_BASE}${path}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, text || res.statusText);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const match = /filename="?([^"]+)"?/i.exec(cd);
    const name = match?.[1] || fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  },
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
