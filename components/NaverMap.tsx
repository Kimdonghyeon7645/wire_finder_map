/** biome-ignore-all lint/correctness/useExhaustiveDependencies: <explanation> */
/** biome-ignore-all lint/suspicious/noArrayIndexKey: <explanation> */
/** biome-ignore-all lint/suspicious/useIterableCallbackReturn: <explanation> */
"use client";

import type { Feature, FeatureCollection, MultiPolygon, Point, Polygon } from "geojson";
import Supercluster from "supercluster";
import { useEffect, useMemo, useRef, useState } from "react";

const CADASTRAL_MIN_ZOOM = 18;

// dl_nms 문자열에서 결정론적 HSL 색상 생성
function dlNmsColor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0x7fffffff;
  return `hsl(${h % 360}, 65%, 42%)`;
}

interface VWorldOverlayInstance {
  setMap(map: naver.maps.Map | null): void;
}

// VWorld Data API 프록시(/api/vworld)를 통해 지번 폴리곤 GeoJSON을 받아
// naver.maps.Polygon으로 직접 렌더링하는 레이어
type ParcelInfo = { ri: string; jibun: string; dl_nms?: string };

class VWorldCadastralLayer implements VWorldOverlayInstance {
  private _map: naver.maps.Map | null = null;
  private _polygons: naver.maps.Polygon[] = [];
  private _markers: naver.maps.Marker[] = [];
  private _listeners: naver.maps.MapEventListener[] = [];
  private _drawTimer: ReturnType<typeof setTimeout> | null = null;
  private _abortController: AbortController | null = null;
  private _parcelCache = new Map<string, ParcelInfo>();

  setMap(map: naver.maps.Map | null) {
    if (this._map) this._detach();
    this._map = map;
    if (map) this._attach();
  }

  private _attach() {
    const map = this._map;
    if (!map) return;
    this._listeners = [
      naver.maps.Event.addListener(map, "dragend", () => this._request()),
      naver.maps.Event.addListener(map, "zoom_changed", () => this._request(300)),
      naver.maps.Event.addListener(map, "size_changed", () => this._request()),
    ];
    this._request();
  }

  private _detach() {
    if (this._drawTimer) clearTimeout(this._drawTimer);
    this._abortController?.abort();
    this._clearOverlays();
    for (const l of this._listeners) naver.maps.Event.removeListener(l);
    this._listeners = [];
    this._map = null;
  }

  private _request(delay = 0) {
    if (this._drawTimer) clearTimeout(this._drawTimer);
    this._drawTimer = setTimeout(() => this._fetchAndDraw(), delay);
  }

  private async _fetchAndDraw() {
    const map = this._map;
    if (!map || map.getZoom() < CADASTRAL_MIN_ZOOM) {
      this._clearOverlays();
      return;
    }

    this._abortController?.abort();
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    const bounds = map.getBounds() as naver.maps.LatLngBounds;
    const sw = bounds.getSW();
    const ne = bounds.getNE();
    const bbox = `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`;

    try {
      const res = await fetch(`/api/vworld?bbox=${encodeURIComponent(bbox)}&size=1000`, { signal });
      const data = await res.json();
      const features: {
        geometry: { type: string; coordinates: number[][][][] | number[][][] };
        properties: Record<string, unknown>;
      }[] = data?.response?.result?.featureCollection?.features ?? [];

      this._clearOverlays();

      // 1단계: 폴리곤 경로·키 수집 (아직 그리지 않음)
      type RawItem = {
        paths: naver.maps.LatLng[][];
        key: string;
        jibun: string;
        jimok: string;
        pos: naver.maps.LatLng;
      };
      const rawItems: RawItem[] = [];

      for (const feature of features) {
        const { type, coordinates } = feature.geometry;
        const rings: number[][][][] = type === "Polygon" ? [coordinates as number[][][]] : (coordinates as number[][][][]);

        const props = feature.properties ?? {};
        const sido = String(props.sido_nm ?? "");
        const sgg = String(props.sgg_nm ?? "");
        const emd = String(props.emd_nm ?? "");
        const ri = String(props.ri_nm ?? "");
        const jibunRaw = String(props.jibun ?? "");
        const jibun = jibunRaw.replace(/[가-힣]+$/, "");
        const jimok = String(props.jimok ?? "");
        const key = sido && sgg && emd && jibun ? `${sido}_${sgg}_${emd}_${ri}_${jibun}` : "";

        for (const ring of rings) {
          const [outer, ...holes] = ring;
          const paths = [
            outer.map(([lng, lat]) => new naver.maps.LatLng(lat, lng)),
            ...holes.map((h) => h.map(([lng, lat]) => new naver.maps.LatLng(lat, lng))),
          ];
          const sum = outer.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
          const pos = new naver.maps.LatLng(sum[1] / outer.length, sum[0] / outer.length);
          rawItems.push({ paths, key, jibun, jimok, pos });
        }
      }

      // 2단계: 캐시 미스 key만 API 조회 후 캐시 저장
      const uniqueKeys = [...new Set(rawItems.filter((i) => i.key).map((i) => i.key))];
      const uncachedKeys = uniqueKeys.filter((k) => !this._parcelCache.has(k));
      if (uncachedKeys.length > 0) {
        const BATCH = 50;
        const chunks: string[][] = [];
        for (let i = 0; i < uncachedKeys.length; i += BATCH) chunks.push(uncachedKeys.slice(i, i + BATCH));
        const batches = await Promise.all(
          chunks.map((c) => fetch(`/api/parcel?keys=${encodeURIComponent(c.join(","))}`, { signal }).then((r) => r.json())),
        );
        const fetched: Record<string, ParcelInfo> = Object.assign({}, ...batches);
        for (const [k, v] of Object.entries(fetched)) this._parcelCache.set(k, v);
        // 조회됐지만 DB에 없는 key도 캐시 (빈 값으로) → 재요청 방지
        for (const k of uncachedKeys) if (!this._parcelCache.has(k)) this._parcelCache.set(k, { ri: "", jibun: "", dl_nms: "" });
      }

      // 3단계: parcel 정보 기반으로 폴리곤·라벨 색상 결정 후 렌더링
      for (const { paths, key, jibun, jimok, pos } of rawItems) {
        const info = key ? this._parcelCache.get(key) : undefined;
        const dlNms = info?.dl_nms || "";
        const color = dlNms ? dlNmsColor(dlNms) : "#9ca3af";
        const fillOpacity = dlNms ? 0.3 : 0.12;

        this._polygons.push(
          new naver.maps.Polygon({
            map,
            paths,
            fillColor: color,
            fillOpacity,
            strokeColor: color,
            strokeWeight: 1,
            strokeOpacity: dlNms ? 0.8 : 0.4,
          }),
        );

        if (!key || !dlNms) continue; // dl_nms 없으면 라벨 생략
        const displayJibun = info?.jibun ?? jibun;
        const jibunLabel = `${displayJibun}${jimok}`;
        const subStyle = `font-size:9px;font-weight:400;color:rgba(255,255,255,0.85);`;
        const content = `<div class="cadastral-label" style="background:${color};color:#fff">${dlNms}<br><span style="${subStyle}">${jibunLabel}</span></div>`;

        this._markers.push(
          new naver.maps.Marker({
            map,
            position: pos,
            icon: { content, anchor: new naver.maps.Point(0, 0) },
          }),
        );
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("[VWorld]", e);
    }
  }

  private _clearOverlays() {
    for (const p of this._polygons) p.setMap(null);
    this._polygons = [];
    for (const m of this._markers) m.setMap(null);
    this._markers = [];
  }
}

function createVWorldCadastralOverlay(): VWorldOverlayInstance {
  return new VWorldCadastralLayer();
}

export interface EssPoint {
  label: string;
  lat: number;
  lon: number;
}

export interface EssArrow {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
}

export interface PowerPlantPoint {
  id: string;
  lat: number;
  lng: number;
  coordinates: [number, number];
  plantCount: number;
  addressCount: number;
  totalCapacityKw: number;
  addresses: string[];
  firstPlantName: string;
}

interface PowerPlantDetail extends PowerPlantPoint {
  plants: {
    name?: string;
    type?: string;
    capacityKw?: number | null;
    region?: string;
    address?: string;
    originalAddress?: string;
    permitNo?: string;
    permitDate?: string;
    constructionReportDate?: string;
    businessStartDate?: string;
    preparationFrom?: string;
    preparationTo?: string;
  }[];
}

interface NaverMapProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  className?: string;
  pipOpen?: boolean;
  darkMode?: boolean;
  satelliteMode?: boolean;
  cadastralMode?: boolean;
  vworldMode?: boolean;
  geojson?: FeatureCollection | null;
  points?: EssPoint[];
  arrows?: EssArrow[];
  powerPlantPoints?: PowerPlantPoint[];
  searchQuery?: string;
  onPipClose?: () => void;
  onPipOpen?: () => void;
}

function coordsToLatLng(ring: number[][]): naver.maps.LatLng[] {
  return ring.map(([lng, lat]) => new naver.maps.LatLng(lat, lng));
}

function centroid(ring: number[][]): naver.maps.LatLng {
  const sum = ring.reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
  return new naver.maps.LatLng(sum[1] / ring.length, sum[0] / ring.length);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Overlay = { polygons: naver.maps.Polygon[]; markers: naver.maps.Marker[] };

type PowerPlantFeatureProps = {
  id: string;
  label: string;
  plantCount: number;
  addressCount: number;
  totalCapacityKw: number;
};

type PowerPlantClusterProps = {
  id?: string;
  label?: string;
  plantCount: number;
  addressCount: number;
  totalCapacityKw: number;
};

function isPowerPlantCluster(
  props:
    | PowerPlantFeatureProps
    | (PowerPlantClusterProps & {
        cluster: true;
        cluster_id: number;
        point_count: number;
        point_count_abbreviated: string | number;
      }),
): props is PowerPlantClusterProps & {
  cluster: true;
  cluster_id: number;
  point_count: number;
  point_count_abbreviated: string | number;
} {
  return "cluster" in props && props.cluster === true;
}

function powerPlantMarkerContent(label: string, variant: "plant" | "plant-cluster") {
  const style =
    "--pin-accent:#16a34a;--pin-accent-soft:rgba(22,163,74,0.22);--pin-label-bg:rgba(22,163,74,0.92);--pin-label-border:rgba(255,255,255,0.42);--pin-label-text:#fff;";
  if (variant === "plant-cluster") {
    return `<div class="plant-cluster-marker">${escapeHtml(label)}</div>`;
  }
  return `<div class="map-pin map-pin--plant" style="${style}"><div class="map-pin__label"><span class="map-pin__symbol">☀</span><span class="map-pin__text">${escapeHtml(label)}</span></div><div class="map-pin__stem"></div><div class="map-pin__point"></div></div>`;
}

function powerPlantLabel(point: PowerPlantPoint) {
  const firstName = point.firstPlantName || "발전소";
  if (point.plantCount <= 1) return firstName;
  return `${firstName} 외 ${(point.plantCount - 1).toLocaleString()}개`;
}

function formatKw(value: number | null | undefined) {
  if (!Number.isFinite(value ?? NaN)) return "-";
  return `${Number(value).toLocaleString()} kW`;
}

function formatDate(value: string | undefined) {
  const digits = String(value ?? "")
    .trim()
    .replace(/\.0+$/, "")
    .replace(/\D/g, "");
  if (digits.length !== 8) return value || "-";
  return `${digits.slice(0, 4)}년 ${digits.slice(4, 6)}월 ${digits.slice(6, 8)}일`;
}

function drawGeoJson(map: naver.maps.Map, geojson: FeatureCollection): Overlay {
  const polygons: naver.maps.Polygon[] = [];
  const markers: naver.maps.Marker[] = [];

  for (const feature of geojson.features as Feature<Polygon | MultiPolygon>[]) {
    const { geometry, properties } = feature;
    if (!geometry) continue;

    const ringGroups: number[][][][] = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

    for (const rings of ringGroups) {
      const [outer, ...holes] = rings;
      polygons.push(
        new naver.maps.Polygon({
          map,
          paths: [coordsToLatLng(outer), ...holes.map(coordsToLatLng)],
          fillColor: "#ef4444",
          fillOpacity: 0.25,
          strokeColor: "#ef4444",
          strokeWeight: 2,
          strokeOpacity: 0.8,
        }),
      );
      markers.push(
        new naver.maps.Marker({
          map,
          position: centroid(outer),
          title: properties?.name ?? undefined,
          zIndex: 100,
          icon: {
            content: `<div class="map-pin map-pin--substation"><div class="map-pin__label"><span class="map-pin__symbol">●</span><span class="map-pin__text">${escapeHtml(properties?.name)}</span></div><div class="map-pin__stem"></div><div class="map-pin__point"></div></div>`,
            anchor: new naver.maps.Point(0, 0),
          },
        }),
      );
    }
  }

  return { polygons, markers };
}

export default function NaverMap({
  center = { lat: 37.5665, lng: 126.978 },
  zoom = 13,
  className = "w-full h-full",
  pipOpen = false,
  darkMode = false,
  satelliteMode = false,
  cadastralMode = false,
  vworldMode = false,
  geojson = null,
  points = [],
  arrows = [],
  powerPlantPoints = [],
  searchQuery,
  onPipClose,
  onPipOpen,
}: NaverMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const panoRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<naver.maps.Map | null>(null);
  const panoInstanceRef = useRef<naver.maps.Panorama | null>(null);
  const panoMoveListenerRef = useRef<naver.maps.MapEventListener | null>(null);
  const markerRef = useRef<naver.maps.Marker | null>(null);
  const overlayRef = useRef<Overlay>({ polygons: [], markers: [] });
  const essMarkersRef = useRef<naver.maps.Marker[]>([]);
  const powerPlantMarkersRef = useRef<naver.maps.Marker[]>([]);
  const arrowsRef = useRef<naver.maps.Polyline[]>([]);
  const cadastralLayerRef = useRef<naver.maps.CadastralLayer | null>(null);
  const vworldLayerRef = useRef<VWorldOverlayInstance | null>(null);
  const searchMarkerRef = useRef<naver.maps.Marker | null>(null);
  const onPipOpenRef = useRef(onPipOpen);
  useEffect(() => {
    onPipOpenRef.current = onPipOpen;
  });

  const [hasPano, setHasPano] = useState(false);
  const [mapZoom, setMapZoom] = useState(zoom);
  const [mapReady, setMapReady] = useState(false);
  const [selectedPowerPlantPoint, setSelectedPowerPlantPoint] = useState<PowerPlantDetail | null>(null);
  const [loadingPowerPlantId, setLoadingPowerPlantId] = useState<string | null>(null);

  useEffect(() => {
    if (!searchQuery || !mapReady) return;
    const map = mapInstanceRef.current;
    if (!map) return;

    naver.maps.Service.geocode({ query: searchQuery }, (status, response) => {
      if (status !== naver.maps.Service.Status.OK) return;
      const item = response.v2?.addresses?.[0];
      if (!item) return;

      const lat = Number(item.y);
      const lng = Number(item.x);
      const coord = new naver.maps.LatLng(lat, lng);

      map.setCenter(coord);
      map.setZoom(15);

      if (!searchMarkerRef.current) {
        searchMarkerRef.current = new naver.maps.Marker({ position: coord, map });
      } else {
        searchMarkerRef.current.setPosition(coord);
        searchMarkerRef.current.setMap(map);
      }
    });
  }, [searchQuery, mapReady]);

  const powerPlantIndex = useMemo(() => {
    if (powerPlantPoints.length === 0) return null;

    const features: Feature<Point, PowerPlantFeatureProps>[] = powerPlantPoints.map((point) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [point.lng, point.lat],
      },
      properties: {
        id: point.id,
        label: powerPlantLabel(point),
        plantCount: point.plantCount,
        addressCount: point.addressCount,
        totalCapacityKw: point.totalCapacityKw,
      },
    }));

    const index = new Supercluster<PowerPlantFeatureProps, PowerPlantClusterProps>({
      radius: 112,
      maxZoom: 17,
      minPoints: 2,
      map: (props) => ({
        plantCount: props.plantCount,
        addressCount: props.addressCount,
        totalCapacityKw: props.totalCapacityKw,
      }),
      reduce: (acc, props) => {
        acc.plantCount += props.plantCount;
        acc.addressCount += props.addressCount;
        acc.totalCapacityKw += props.totalCapacityKw;
      },
    });

    index.load(features);
    return index;
  }, [powerPlantPoints]);

  useEffect(() => {
    function initMap() {
      if (!mapRef.current || mapInstanceRef.current) return;

      const map = new naver.maps.Map(mapRef.current, {
        center: new naver.maps.LatLng(center.lat, center.lng),
        zoom,
        zoomControl: false,
      });
      mapInstanceRef.current = map;
      setMapReady(true);
      naver.maps.Event.addListener(map, "zoom_changed", () => setMapZoom(map.getZoom()));

      const streetLayer = new naver.maps.StreetLayer();
      streetLayer.setMap(map);

      naver.maps.Event.addListener(map, "click", (e: naver.maps.PointerEvent) => {
        if (!panoRef.current) return;

        function placeMarker(coord: naver.maps.LatLng) {
          if (!markerRef.current) markerRef.current = new naver.maps.Marker({ position: coord, map: map ?? undefined });
          else markerRef.current.setPosition(coord);
        }

        if (!panoInstanceRef.current) {
          panoInstanceRef.current = new naver.maps.Panorama(panoRef.current, {
            position: e.coord as naver.maps.LatLng,
            pov: { pan: 0, tilt: 0, fov: 100 },
            zoomControl: true,
            zoomControlOptions: { position: naver.maps.Position.TOP_RIGHT },
          });
          panoMoveListenerRef.current = naver.maps.Event.addListener(panoInstanceRef.current, "position_changed", () => {
            const pos = panoInstanceRef.current?.getPosition();
            if (pos) placeMarker(pos);
          });
          setHasPano(true);
        } else {
          panoInstanceRef.current.setPosition(e.coord as naver.maps.LatLng);
        }

        placeMarker(e.coord as naver.maps.LatLng);
        onPipOpenRef.current?.();
      });
    }

    if (typeof naver !== "undefined" && naver.maps) {
      initMap();
    } else {
      const id = setInterval(() => {
        if (typeof naver !== "undefined" && naver.maps) {
          clearInterval(id);
          initMap();
        }
      }, 50);
      return () => clearInterval(id);
    }
  }, [center.lat, center.lng, zoom]);

  // 발전소 포인트 클러스터 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !powerPlantIndex) return;

    let drawTimer: ReturnType<typeof setTimeout> | null = null;

    function clearMarkers() {
      powerPlantMarkersRef.current.forEach((m) => {
        m.setMap(null);
      });
      powerPlantMarkersRef.current = [];
    }

    function draw() {
      const currentMap = mapInstanceRef.current;
      if (!currentMap || !powerPlantIndex) return;

      const bounds = currentMap.getBounds() as naver.maps.LatLngBounds;
      const sw = bounds.getSW();
      const ne = bounds.getNE();
      const zoomLevel = Math.round(currentMap.getZoom());
      const clusters = powerPlantIndex.getClusters([sw.lng(), sw.lat(), ne.lng(), ne.lat()], zoomLevel);

      clearMarkers();
      powerPlantMarkersRef.current = clusters.map((cluster) => {
        const [lng, lat] = cluster.geometry.coordinates;
        const props = cluster.properties;
        const isCluster = isPowerPlantCluster(props);
        const label = isCluster ? props.plantCount.toLocaleString() : props.label || `${props.plantCount.toLocaleString()}개 발전소`;

        const marker = new naver.maps.Marker({
          map: currentMap,
          position: new naver.maps.LatLng(lat, lng),
          title: isCluster ? `${props.plantCount.toLocaleString()}개 발전소` : label,
          zIndex: isCluster ? 10 : 15,
          icon: {
            content: powerPlantMarkerContent(label, isCluster ? "plant-cluster" : "plant"),
            anchor: new naver.maps.Point(0, 0),
          },
        });

        if (isCluster) {
          naver.maps.Event.addListener(marker, "click", () => {
            const expansionZoom = Math.min(powerPlantIndex.getClusterExpansionZoom(props.cluster_id), 18);
            currentMap.setCenter(new naver.maps.LatLng(lat, lng));
            currentMap.setZoom(expansionZoom);
          });
        } else {
          naver.maps.Event.addListener(marker, "click", () => {
            setLoadingPowerPlantId(props.id);
            fetch(`/api/power-plant-points/${encodeURIComponent(props.id)}`)
              .then((res) => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.json() as Promise<PowerPlantDetail>;
              })
              .then((detail) => {
                setSelectedPowerPlantPoint(detail);
              })
              .catch((err) => {
                console.error("[PowerPlantDetail]", err);
                setSelectedPowerPlantPoint(null);
              })
              .finally(() => {
                setLoadingPowerPlantId(null);
              });
          });
        }

        return marker;
      });
    }

    function requestDraw(delay = 0) {
      if (drawTimer) clearTimeout(drawTimer);
      drawTimer = setTimeout(draw, delay);
    }

    const listeners = [
      naver.maps.Event.addListener(map, "dragend", () => requestDraw()),
      naver.maps.Event.addListener(map, "zoom_changed", () => requestDraw(120)),
      naver.maps.Event.addListener(map, "size_changed", () => requestDraw()),
    ];

    requestDraw();

    return () => {
      if (drawTimer) clearTimeout(drawTimer);
      listeners.forEach((listener) => naver.maps.Event.removeListener(listener));
      clearMarkers();
    };
  }, [mapReady, powerPlantIndex]);

  // 위성 모드 전환
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    map.setMapTypeId(satelliteMode ? naver.maps.MapTypeId.HYBRID : naver.maps.MapTypeId.NORMAL);
  }, [satelliteMode]);

  // 지적편집도 레이어 전환 (Naver 기본)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (cadastralMode) {
      if (!cadastralLayerRef.current) cadastralLayerRef.current = new naver.maps.CadastralLayer();
      cadastralLayerRef.current.setMap(map);
    } else {
      cadastralLayerRef.current?.setMap(null);
    }
  }, [cadastralMode]);

  // VWorld 연속지적도 레이어 전환 (줌 15 이상)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (vworldMode) {
      if (!vworldLayerRef.current) vworldLayerRef.current = createVWorldCadastralOverlay();
      vworldLayerRef.current.setMap(map);
    } else {
      vworldLayerRef.current?.setMap(null);
    }
  }, [vworldMode]);

  // GeoJSON 폴리곤 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // 기존 오버레이 제거
    overlayRef.current.polygons.forEach((p) => {
      p.setMap(null);
    });
    overlayRef.current.markers.forEach((m) => {
      m.setMap(null);
    });
    overlayRef.current = { polygons: [], markers: [] };

    if (!geojson) return;

    overlayRef.current = drawGeoJson(map, geojson);
  }, [geojson]);

  // ESS 화살표 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    arrowsRef.current.forEach((l) => {
      l.setMap(null);
    });
    arrowsRef.current = arrows.map(
      (a) =>
        new naver.maps.Polyline({
          map,
          path: [new naver.maps.LatLng(a.from.lat, a.from.lon), new naver.maps.LatLng(a.to.lat, a.to.lon)],
          strokeColor: "#3b82f6",
          strokeOpacity: 0.5,
          strokeWeight: 9,
          endIcon: naver.maps.PointingIcon.BLOCK_ARROW,
          endIconSize: 20,
        }),
    );
  }, [arrows]);

  // ESS 포인트 마커 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    essMarkersRef.current.forEach((m) => {
      m.setMap(null);
    });
    essMarkersRef.current = points.map(
      (p) =>
        new naver.maps.Marker({
          map,
          position: new naver.maps.LatLng(p.lat, p.lon),
          zIndex: 110,
          icon: {
            content: `<div class="map-pin map-pin--line"><div class="map-pin__label"><span class="map-pin__symbol">•</span><span class="map-pin__text">${escapeHtml(p.label)}</span></div><div class="map-pin__stem"></div><div class="map-pin__point"></div></div>`,
            anchor: new naver.maps.Point(0, 0),
          },
        }),
    );
  }, [points, darkMode]);

  function closePip() {
    markerRef.current?.setMap(null);
    markerRef.current = null;
    if (panoMoveListenerRef.current) {
      naver.maps.Event.removeListener(panoMoveListenerRef.current);
      panoMoveListenerRef.current = null;
    }
    panoInstanceRef.current = null;
    setHasPano(false);
    onPipClose?.();
  }

  return (
    <div className={`relative ${className}`}>
      <div className="absolute h-full w-full flex flex-col justify-center items-center">
        <div className="text-xl">지도를 불러오는 중입니다...</div>
        <div className="text-md">최대 몇초간 로딩이 소요될 수 있습니다.</div>
      </div>
      <div
        ref={mapRef}
        className={`w-full h-full${darkMode ? " dark-map" : ""}`}
        style={darkMode ? { filter: "invert(90%) hue-rotate(180deg)" } : undefined}
      />
      {vworldMode && mapZoom < CADASTRAL_MIN_ZOOM && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-full bg-black/70 text-white text-sm whitespace-nowrap pointer-events-none">
          현재 줌레벨에서는 지적도 조회를 지원하지 않습니다
        </div>
      )}
      {(selectedPowerPlantPoint || loadingPowerPlantId) && (
        <div className="absolute top-3 right-3 z-30 w-[min(760px,calc(100%-24px))] max-h-[58vh] rounded-md border border-black/10 bg-white/95 shadow-lg backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3 border-b border-black/10 px-4 pt-2 pb-1.5">
            <div className="min-w-0 pt-0.5">
              {selectedPowerPlantPoint ? (
                <div className="flex items-baseline gap-2 truncate tracking-tight">
                  <span className="shrink-0 font-bold text-gray-900">
                    {selectedPowerPlantPoint.plantCount.toLocaleString()}개 발전소 · 총 {formatKw(selectedPowerPlantPoint.totalCapacityKw)}
                  </span>
                  <span className="truncate text-gray-500">{selectedPowerPlantPoint.addresses.join(", ")}</span>
                </div>
              ) : (
                <div className="text-sm font-bold text-gray-900">발전소 정보를 불러오는 중...</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedPowerPlantPoint(null);
                setLoadingPowerPlantId(null);
              }}
              className="shrink-0 rounded px-2 py-1 text-sm font-bold text-gray-500 hover:bg-gray-100 hover:text-gray-900"
            >
              ✕
            </button>
          </div>
          {selectedPowerPlantPoint ? (
            <div className="max-h-[calc(58vh-86px)] overflow-auto">
              <table className="min-w-[1120px] text-left text-[0.85rem]">
                <thead className="sticky top-0 bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">기초</th>
                    <th className="min-w-[110px] px-3 py-2 font-semibold">기존인허가번호</th>
                    <th className="px-3 py-2 font-semibold">인허가일자</th>
                    <th className="px-3 py-2 font-semibold">법인(상호)명</th>
                    <th className="min-w-[110px] px-3 py-2 font-semibold">설비용량(KW)</th>
                    <th className="min-w-[100px] px-3 py-2 font-semibold">공사신고일</th>
                    <th className="min-w-[100px] px-3 py-2 font-semibold">사업개시일</th>
                    <th className="px-3 py-2 font-semibold">사업준비기간</th>
                    <th className="px-3 py-2 font-semibold">주소</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {selectedPowerPlantPoint.plants.map((plant, idx) => (
                    <tr key={`${plant.permitNo ?? plant.name ?? "plant"}-${idx}`} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">{plant.region || "-"}</td>
                      <td className="min-w-[110px] whitespace-nowrap px-3 py-2 text-gray-700">{plant.permitNo || "-"}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">{formatDate(plant.permitDate)}</td>
                      <td className="min-w-[180px] px-3 py-2 font-medium text-gray-900">{plant.name || "-"}</td>
                      <td className="min-w-[110px] whitespace-nowrap px-3 py-2 text-gray-700">{plant.capacityKw ?? "-"}</td>
                      <td className="min-w-[100px] whitespace-nowrap px-3 py-2 text-gray-700">
                        {formatDate(plant.constructionReportDate)}
                      </td>
                      <td className="min-w-[100px] whitespace-nowrap px-3 py-2 text-gray-700">{formatDate(plant.businessStartDate)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                        {formatDate(plant.preparationFrom)} ~ {formatDate(plant.preparationTo)}
                      </td>
                      <td className="min-w-[300px] px-3 py-2 text-gray-600">{plant.originalAddress || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-4 py-6 text-sm text-gray-500">상세 데이터를 조회하고 있습니다.</div>
          )}
        </div>
      )}
      {/* 거리뷰 PiP 패널 */}
      <div
        className={`w-160 h-150 absolute bottom-3 right-3 z-20 rounded-xl overflow-hidden shadow-xl bg-white border ${pipOpen ? "" : "invisible pointer-events-none"}`}
      >
        <div className="absolute inset-0 h-5 w-full flex justify-between">
          <div className="pt-0.5 pl-3">거리뷰</div>
          <button type="button" onClick={closePip} className="px-2 py-2 font-bold leading-3 rounded-md cursor-pointer hover:bg-[#eee]">
            ✕
          </button>
        </div>
        <div className="h-full w-full">
          <div ref={panoRef} className="absolute inset-0 mt-7 m-1.5 h-[calc(100%-32px)] w-[calc(100%-10px)] rounded-lg border" />
          {!hasPano && <div className="h-full w-full flex justify-center items-center -mt-2">지도에서 위치를 클릭하세요</div>}
        </div>
      </div>
    </div>
  );
}
