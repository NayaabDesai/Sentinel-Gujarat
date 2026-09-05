import { useEffect, useId, useRef } from "react";
import maplibregl, { Map, GeoJSONSource, LngLatLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { api } from "../../lib/api";

type Props = {
  department?: string;
  showFov: boolean;
  onSelectCamera: (cameraId: string, props: Record<string, unknown>) => void;
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

export default function GisMap({ department, showFov, onSelectCamera }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const mapId = useId();

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap",
          },
        },
        layers: [
          {
            id: "osm",
            type: "raster",
            source: "osm",
            paint: { "raster-saturation": -0.35, "raster-brightness-min": 0.15 },
          },
        ],
      },
      center: GUJARAT_CENTER,
      zoom: 6.4,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current = map;

    map.on("load", async () => {
      map.addSource("cameras", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 48,
      });

      map.addSource("fov", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });

      map.addLayer({
        id: "fov-fill",
        type: "fill",
        source: "fov",
        paint: {
          "fill-color": "#e8872a",
          "fill-opacity": 0.18,
        },
      });
      map.addLayer({
        id: "fov-outline",
        type: "line",
        source: "fov",
        paint: { "line-color": "#f0a04b", "line-width": 1, "line-opacity": 0.55 },
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "cameras",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#2d7a52",
          "circle-radius": ["step", ["get", "point_count"], 16, 25, 22, 100, 30],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#e8eef7",
        },
      });

      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "cameras",
        filter: ["has", "point_count"],
        layout: {
          "text-field": "{point_count_abbreviated}",
          "text-size": 12,
        },
        paint: { "text-color": "#e8eef7" },
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
            "#3d9a6a",
            "degraded",
            "#e8872a",
            "offline",
            "#c44b4b",
            "#7a8aa0",
          ],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#e8eef7",
        },
      });

      map.on("click", "clusters", async (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        const clusterId = features[0]?.properties?.cluster_id;
        const source = map.getSource("cameras") as GeoJSONSource;
        if (clusterId == null) return;
        const zoom = await source.getClusterExpansionZoom(clusterId);
        const geom = features[0].geometry as { type: string; coordinates: number[] };
        const coords = geom.coordinates as [number, number];
        map.easeTo({ center: coords, zoom });
      });

      map.on("click", "camera-points", (e) => {
        const f = e.features?.[0];
        if (!f?.properties) return;
        const id = String(f.properties.id);
        onSelectCamera(id, f.properties as Record<string, unknown>);
        const geom = f.geometry as { type: string; coordinates: number[] };
        new maplibregl.Popup()
          .setLngLat(geom.coordinates as [number, number])
          .setHTML(
            `<strong>${f.properties.name}</strong><br/><span style="opacity:.75">${f.properties.department || "—"} · ${f.properties.status}</span>`
          )
          .addTo(map);
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
  }, [mapId, onSelectCamera]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const load = async () => {
      try {
        const fc = await api.geojson(department || undefined);
        const apply = () => {
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
        };

        if (map.isStyleLoaded()) apply();
        else map.once("load", apply);
      } catch (err) {
        console.error("Failed to load camera geojson", err);
      }
    };

    load();
  }, [department, showFov]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-lg border border-white/10 shadow-panel"
      aria-label="Gujarat CCTV GIS map"
    />
  );
}
