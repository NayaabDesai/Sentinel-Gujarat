import { useCallback, useEffect, useRef } from "react";
import maplibregl, { Map, GeoJSONSource, LngLatLike, MapMouseEvent } from "maplibre-gl";
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
          dark: {
            type: "raster",
            tiles: ["https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png"],
            tileSize: 256,
            attribution: "© CARTO · © OpenStreetMap",
          },
        },
        layers: [{ id: "dark", type: "raster", source: "dark" }],
      },
      center: GUJARAT_CENTER,
      zoom: 6.5,
      maxPitch: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    map.on("load", () => {
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
          "line-color": "#10b981",
          "line-width": 1.5,
          "line-opacity": 0.85,
          "line-dasharray": [2, 1],
        },
      });

      map.addLayer({
        id: "fov-fill",
        type: "fill",
        source: "fov",
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.16 },
      });
      map.addLayer({
        id: "fov-outline",
        type: "line",
        source: "fov",
        paint: { "line-color": "#fbbf24", "line-width": 1, "line-opacity": 0.5 },
      });

      map.addLayer({
        id: "selected-halo",
        type: "circle",
        source: "selected",
        paint: {
          "circle-radius": 18,
          "circle-color": "#f59e0b",
          "circle-opacity": 0.25,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fbbf24",
          "circle-stroke-opacity": 0.9,
        },
      });
      map.addLayer({
        id: "selected-core",
        type: "circle",
        source: "selected",
        paint: {
          "circle-radius": 7,
          "circle-color": "#fbbf24",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#090d16",
        },
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#10b981",
          "circle-radius": ["step", ["get", "point_count"], 15, 25, 20, 100, 28],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#090d16",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "cameras",
        filter: ["has", "point_count"],
        layout: { "text-field": "{point_count_abbreviated}", "text-size": 11 },
        paint: { "text-color": "#090d16" },
      });
      map.addLayer({
        id: "camera-points",
        type: "circle",
        source: "cameras",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": 6,
          "circle-color": [
            "match",
            ["get", "status"],
            "online",
            "#10b981",
            "degraded",
            "#f59e0b",
            "offline",
            "#f43f5e",
            "#64748b",
          ],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#e8eef7",
        },
      });

      // Pulse halo via paint animation
      let t0 = performance.now();
      const pulse = () => {
        if (!mapRef.current) return;
        const t = ((performance.now() - t0) / 1000) % 1.6;
        const r = 14 + Math.sin(t * Math.PI * 2) * 6;
        const op = 0.15 + Math.sin(t * Math.PI * 2) * 0.12;
        try {
          if (map.getLayer("selected-halo")) {
            map.setPaintProperty("selected-halo", "circle-radius", r);
            map.setPaintProperty("selected-halo", "circle-opacity", Math.max(0.08, op));
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

      map.on("click", "camera-points", (e) => {
        e.originalEvent.stopPropagation();
        const f = e.features?.[0];
        if (!f?.properties) return;
        const id = String(f.properties.id);
        onSelectRef.current(id, f.properties as Record<string, unknown>);
        const geom = f.geometry as { coordinates: number[] };
        new maplibregl.Popup({ closeButton: false, maxWidth: "220px" })
          .setLngLat(geom.coordinates as [number, number])
          .setHTML(
            `<strong>${f.properties.name}</strong><br/><span style="opacity:.7;font-family:monospace;font-size:10px">${f.properties.department || "—"} · ${f.properties.status}</span>`
          )
          .addTo(map);
      });

      map.on("click", (e: MapMouseEvent) => {
        const hits = map.queryRenderedFeatures(e.point, {
          layers: ["camera-points", "clusters"],
        });
        if (hits.length) return;
        onTapRef.current(e.lngLat.lat, e.lngLat.lng);
      });

      map.on("mouseenter", "camera-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "camera-points", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
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

        // Refresh selected halo after setData (search fly may precede geojson load)
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

  // Selected camera halo — setData only, no remount
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
        <div className="pointer-events-none absolute left-3 top-3 border border-forest-500/30 bg-ink-950/80 px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-forest-400">
          Sector scan · {radiusMeters} m
        </div>
      )}
    </div>
  );
}
