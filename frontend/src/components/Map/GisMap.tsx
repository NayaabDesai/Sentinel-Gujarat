import { useCallback, useEffect, useRef } from "react";
import maplibregl, { Map, GeoJSONSource, LngLatBoundsLike, LngLatLike, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { api } from "../../lib/api";

type Props = {
  department?: string;
  showFov: boolean;
  radiusMeters: number;
  radar: { lon: number; lat: number } | null;
  selectedCameraId?: string | null;
  onSelectCamera: (cameraId: string, props: Record<string, unknown>) => void;
  onMapTap: (lat: number, lon: number) => void;
};

const GUJARAT_CENTER: LngLatLike = [71.2, 22.5];
/** SW → NE — keeps pan inside Gujarat / near-Gujarat */
const GUJARAT_BOUNDS: LngLatBoundsLike = [
  [68.1, 20.1],
  [74.5, 24.7],
];

/** Canvas-drawn red location pin for MapLibre symbol layer (no external asset). */
function createRedPinImage(): ImageData {
  const w = 48;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = 22;
  const r = 14;

  // Drop shadow
  ctx.beginPath();
  ctx.ellipse(cx, h - 6, 8, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.fill();

  // Pin body
  ctx.beginPath();
  ctx.moveTo(cx, h - 8);
  ctx.bezierCurveTo(cx - 2, h - 22, cx - r - 2, cy + 10, cx - r, cy);
  ctx.arc(cx, cy, r, Math.PI * 0.85, Math.PI * 0.15, true);
  ctx.bezierCurveTo(cx + r + 2, cy + 10, cx + 2, h - 22, cx, h - 8);
  ctx.closePath();
  ctx.fillStyle = "#ef4444";
  ctx.fill();
  ctx.strokeStyle = "#b91c1c";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Inner white dot
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  return ctx.getImageData(0, 0, w, h);
}

function fovPolygon(
  lon: number,
  lat: number,
  heading: number,
  fov: number,
  rangeM: number
): number[][] {
  const mLat = 111320;
  const mLon = 111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const half = fov / 2;
  const ring: number[][] = [[lon, lat]];
  for (let i = 0; i <= 8; i++) {
    const angle = ((heading - half + (fov * i) / 8) * Math.PI) / 180;
    ring.push([lon + (rangeM * Math.sin(angle)) / mLon, lat + (rangeM * Math.cos(angle)) / mLat]);
  }
  ring.push([lon, lat]);
  return ring;
}

function circlePolygon(lon: number, lat: number, radiusM: number, steps = 64): number[][] {
  const mLat = 111320;
  const mLon = 111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const ring: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ring.push([lon + (radiusM * Math.cos(a)) / mLon, lat + (radiusM * Math.sin(a)) / mLat]);
  }
  return ring;
}

export default function GisMap({
  department,
  showFov,
  radiusMeters,
  radar,
  selectedCameraId,
  onSelectCamera,
  onMapTap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const geojsonRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const hoverPopupRef = useRef<maplibregl.Popup | null>(null);
  const selectedIdRef = useRef(selectedCameraId);
  const onSelectRef = useRef(onSelectCamera);
  const onTapRef = useRef(onMapTap);
  onSelectRef.current = onSelectCamera;
  onTapRef.current = onMapTap;
  selectedIdRef.current = selectedCameraId;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          basemap: {
            type: "raster",
            // Free OSM raster tiles — no API key (Carto Positron now watermarks without one)
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
            maxzoom: 19,
          },
        },
        layers: [{ id: "basemap", type: "raster", source: "basemap" }],
      },
      center: GUJARAT_CENTER,
      zoom: 6.8,
      minZoom: 5.5,
      maxZoom: 18,
      maxBounds: GUJARAT_BOUNDS,
      maxPitch: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    // Keep tiles sharp when the flex layout settles / window resizes
    const ro = new ResizeObserver(() => {
      map.resize();
    });
    ro.observe(containerRef.current);

    map.on("load", () => {
      map.resize();
      map.fitBounds(GUJARAT_BOUNDS, { padding: 28, duration: 0, maxZoom: 7.2 });

      if (!map.hasImage("red-pin")) {
        map.addImage("red-pin", createRedPinImage(), { pixelRatio: 2 });
      }

      map.addSource("cameras", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 50,
      });

      map.addSource("fov", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addSource("radar", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addSource("selected", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "radar-fill",
        type: "fill",
        source: "radar",
        paint: { "fill-color": "#10b981", "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: "radar-line",
        type: "line",
        source: "radar",
        paint: {
          "line-color": "#059669",
          "line-width": 1.5,
          "line-opacity": 0.85,
          "line-dasharray": [2, 1],
        },
      });

      map.addLayer({
        id: "fov-fill",
        type: "fill",
        source: "fov",
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "fov-outline",
        type: "line",
        source: "fov",
        paint: { "line-color": "#d97706", "line-width": 1, "line-opacity": 0.55 },
      });

      // Selected halo under pins
      map.addLayer({
        id: "selected-halo",
        type: "circle",
        source: "selected",
        paint: {
          "circle-radius": 22,
          "circle-color": "#ef4444",
          "circle-opacity": 0.35,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#f59e0b",
          "circle-stroke-opacity": 0.95,
        },
      });

      // Slate clusters (readable on light basemap)
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#334155",
          "circle-radius": ["step", ["get", "point_count"], 16, 25, 22, 100, 30],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "cameras",
        filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-size": 12 },
        paint: { "text-color": "#ffffff" },
      });

      // Unclustered = red pin symbols
      map.addLayer({
        id: "camera-pins",
        type: "symbol",
        source: "cameras",
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": "red-pin",
          "icon-size": 0.75,
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      let t0 = performance.now();
      const pulse = () => {
        if (!mapRef.current) return;
        const t = ((performance.now() - t0) / 1000) % 1.6;
        const r = 18 + Math.sin(t * Math.PI * 2) * 7;
        const op = 0.22 + Math.sin(t * Math.PI * 2) * 0.14;
        try {
          if (map.getLayer("selected-halo")) {
            map.setPaintProperty("selected-halo", "circle-radius", r);
            map.setPaintProperty("selected-halo", "circle-opacity", Math.max(0.12, op));
          }
        } catch {
          /* map torn down */
        }
        requestAnimationFrame(pulse);
      };
      requestAnimationFrame(pulse);

      map.on("click", "clusters", async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource("cameras") as GeoJSONSource;
        if (clusterId == null) return;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const geom = features[0].geometry as { coordinates: number[] };
        map.easeTo({ center: geom.coordinates as [number, number], zoom });
      });

      map.on("click", "camera-pins", (e) => {
        e.originalEvent.stopPropagation();
        const f = e.features?.[0];
        if (!f?.properties) return;
        const id = String(f.properties.id);
        onSelectRef.current(id, f.properties as Record<string, unknown>);
      });

      map.on("click", (e: MapMouseEvent) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["camera-pins", "clusters"],
        });
        if (hits.length) return;
        onTapRef.current(e.lngLat.lat, e.lngLat.lng);
      });

      map.on("mouseenter", "camera-pins", (e) => {
        map.getCanvas().style.cursor = "pointer";
        const f = e.features?.[0];
        if (!f?.properties || f.geometry.type !== "Point") return;
        const coords = f.geometry.coordinates as [number, number];
        hoverPopupRef.current?.remove();
        hoverPopupRef.current = new maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 18,
          className: "sentinel-pin-popup",
          maxWidth: "220px",
        })
          .setLngLat(coords)
          .setHTML(
            `<strong>${f.properties.name || "Camera"}</strong><br/><span style="opacity:.7;font-family:monospace;font-size:10px">${f.properties.department || "—"} · ${f.properties.status || ""}</span>`
          )
          .addTo(map);
      });

      map.on("mouseleave", "camera-pins", () => {
        map.getCanvas().style.cursor = "";
        hoverPopupRef.current?.remove();
        hoverPopupRef.current = null;
      });

      map.on("mouseenter", "clusters", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "clusters", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      hoverPopupRef.current?.remove();
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const apply = async () => {
      try {
        const fc = await api.geojson(department || undefined);
        geojsonRef.current = fc as unknown as GeoJSON.FeatureCollection;
        const camSrc = map.getSource("cameras") as GeoJSONSource | undefined;
        const fovSrc = map.getSource("fov") as GeoJSONSource | undefined;
        if (!camSrc) return;
        camSrc.setData(fc as unknown as GeoJSON.FeatureCollection);

        const fovFeatures = showFov
          ? fc.features
              .map((f) => {
                const p = f.properties || {};
                const coords = f.geometry.coordinates;
                const heading = Number(p.heading_deg);
                const fov = Number(p.fov_deg);
                const range = Number(p.range_m);
                if (!coords || Number.isNaN(heading) || !fov || !range) return null;
                return {
                  type: "Feature" as const,
                  geometry: {
                    type: "Polygon" as const,
                    coordinates: [fovPolygon(coords[0], coords[1], heading, fov, range)],
                  },
                  properties: { id: p.id },
                };
              })
              .filter(Boolean)
          : [];

        fovSrc?.setData({
          type: "FeatureCollection",
          features: fovFeatures as GeoJSON.Feature[],
        });

        const selSrc = map.getSource("selected") as GeoJSONSource | undefined;
        const sid = selectedIdRef.current;
        if (selSrc && sid) {
          const feat = (fc as GeoJSON.FeatureCollection).features.find(
            (f) => String(f.properties?.id) === sid
          );
          selSrc.setData({
            type: "FeatureCollection",
            features: feat ? [feat] : [],
          });
        }
      } catch (err) {
        console.error("Failed to load camera geojson", err);
      }
    };

    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [department, showFov]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("selected") as GeoJSONSource | undefined;
    if (!src) return;
    if (!selectedCameraId || !geojsonRef.current) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const feat = geojsonRef.current.features.find(
      (f) => String(f.properties?.id) === selectedCameraId
    );
    if (!feat) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src.setData({ type: "FeatureCollection", features: [feat] });
  }, [selectedCameraId, department, showFov]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("radar") as GeoJSONSource | undefined;
    if (!src) return;
    if (!radar) {
      src.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    src.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [circlePolygon(radar.lon, radar.lat, radiusMeters)],
          },
          properties: {},
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [radar.lon, radar.lat] },
          properties: { kind: "center" },
        },
      ],
    });
  }, [radar, radiusMeters]);

  const flyTo = useCallback((lon: number, lat: number, zoom = 16) => {
    mapRef.current?.flyTo({ center: [lon, lat], zoom, essential: true, duration: 280 });
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { lon: number; lat: number; zoom?: number };
      if (detail) flyTo(detail.lon, detail.lat, detail.zoom ?? 16);
    };
    window.addEventListener("sentinel-flyto", handler);
    return () => window.removeEventListener("sentinel-flyto", handler);
  }, [flyTo]);

  return (
    <div className="relative h-full w-full overflow-hidden border border-white/10 shadow-panel">
      <div ref={containerRef} className="h-full w-full" aria-label="Gujarat CCTV GIS map" />
      {radar && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 border border-forest-500/30 bg-ink-950/80 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-forest-400">
          Sector scan · {radiusMeters} m
        </div>
      )}
    </div>
  );
}
