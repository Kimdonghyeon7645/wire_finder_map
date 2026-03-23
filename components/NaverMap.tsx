"use client";

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { useEffect, useRef, useState } from "react";

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
        const rings: number[][][][] = type === "Polygon"
          ? [coordinates as number[][][]]
          : (coordinates as number[][][][]);

        const props = feature.properties ?? {};
        const sido = String(props.sido_nm ?? "");
        const sgg = String(props.sgg_nm ?? "");
        const emd = String(props.emd_nm ?? "");
        const ri = String(props.ri_nm ?? "");
        const jibunRaw = String(props.jibun ?? "");
        const jibun = jibunRaw.replace(/[가-힣]+$/, "");
        const jimok = String(props.jimok ?? "");
        const key = sido && sgg && emd && jibun
          ? `${sido}_${sgg}_${emd}_${ri}_${jibun}`
          : "";

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
          chunks.map((c) =>
            fetch(`/api/parcel?keys=${encodeURIComponent(c.join(","))}`, { signal }).then((r) => r.json()),
          ),
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

type Overlay = { polygons: naver.maps.Polygon[]; markers: naver.maps.Marker[] };

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
          icon: {
            content: `<div class="substation-marker"><div class="substation-marker__label">${properties?.name ?? ""}</div><div class="substation-marker__tail"></div></div>`,
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
  const arrowsRef = useRef<naver.maps.Polyline[]>([]);
  const cadastralLayerRef = useRef<naver.maps.CadastralLayer | null>(null);
  const vworldLayerRef = useRef<VWorldOverlayInstance | null>(null);
  const onPipOpenRef = useRef(onPipOpen);
  useEffect(() => {
    onPipOpenRef.current = onPipOpen;
  });

  const [hasPano, setHasPano] = useState(false);
  const [mapZoom, setMapZoom] = useState(zoom);

  useEffect(() => {
    function initMap() {
      if (!mapRef.current || mapInstanceRef.current) return;

      const map = new naver.maps.Map(mapRef.current, {
        center: new naver.maps.LatLng(center.lat, center.lng),
        zoom,
        zoomControl: true,
        zoomControlOptions: {
          position: naver.maps.Position.TOP_RIGHT,
          style: naver.maps.ZoomControlStyle.SMALL,
        },
      });
      mapInstanceRef.current = map;
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

    arrowsRef.current.forEach((l) => { l.setMap(null); });
    arrowsRef.current = arrows.map((a) =>
      new naver.maps.Polyline({
        map,
        path: [
          new naver.maps.LatLng(a.from.lat, a.from.lon),
          new naver.maps.LatLng(a.to.lat, a.to.lon),
        ],
        strokeColor: "#3b82f6",
        strokeOpacity: 0.5,
        strokeWeight: 9,
        endIcon: naver.maps.PointingIcon.BLOCK_ARROW,
        endIconSize: 20,
      })
    );
  }, [arrows]);

  // ESS 포인트 마커 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    essMarkersRef.current.forEach((m) => { m.setMap(null); });
    const filter = darkMode ? "filter:invert(90%) hue-rotate(180deg);" : "";
    essMarkersRef.current = points.map((p) =>
      new naver.maps.Marker({
        map,
        position: new naver.maps.LatLng(p.lat, p.lon),
        icon: {
          content: `<div style="transform:translate(-50%,-100%);display:inline-flex;flex-direction:column;align-items:center;pointer-events:none;${filter}"><div style="background:#3b82f6;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:500;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.3);letter-spacing:-0.6px;">${p.label}</div><div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid #3b82f6"></div></div>`,
          anchor: new naver.maps.Point(0, 0),
        },
      })
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
      <div ref={mapRef} className={`w-full h-full${darkMode ? " dark-map" : ""}`} style={darkMode ? { filter: "invert(90%) hue-rotate(180deg)" } : undefined} />
      {vworldMode && mapZoom < CADASTRAL_MIN_ZOOM && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-full bg-black/70 text-white text-sm whitespace-nowrap pointer-events-none">
          현재 줌레벨에서는 지적도 조회를 지원하지 않습니다
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
