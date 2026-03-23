"use client";

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { useEffect, useRef, useState } from "react";

const VWORLD_API_KEY = process.env.NEXT_PUBLIC_VWORLD_API_KEY ?? "";
const CADASTRAL_MIN_ZOOM = 15;

interface VWorldOverlayInstance {
  setMap(map: naver.maps.Map | null): void;
}

function createVWorldCadastralOverlay(): VWorldOverlayInstance {
  function lngLatToMercator(lat: number, lng: number): [number, number] {
    const x = (lng * 20037508.34) / 180;
    let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
    y = (y * 20037508.34) / 180;
    return [x, y];
  }

  // naver.maps.OverlayView has no exported constructor type — cast required
  const Base = naver.maps.OverlayView as new () => naver.maps.OverlayView;

  class VWorldOverlay extends Base {
    private _div: HTMLDivElement | null = null;
    private _img: HTMLImageElement | null = null;
    private _listeners: naver.maps.MapEventListener[] = [];
    private _drawTimer: ReturnType<typeof setTimeout> | null = null;
    private _wheelHandler: ((e: Event) => void) | null = null;

    private _fade() {
      if (this._img) this._img.style.opacity = "0.2";
    }

    private _requestDraw(delay = 0) {
      if (this._drawTimer) clearTimeout(this._drawTimer);
      this._drawTimer = setTimeout(() => this.draw(), delay);
    }

    onAdd() {
      const div = document.createElement("div");
      div.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;";
      const img = document.createElement("img");
      img.style.cssText = "width:100%;height:100%;opacity:0.85;transition:opacity 0.2s;";
      img.alt = "";
      // API 응답 완료 시 opacity 복원
      img.onload = () => { img.style.opacity = "0.85"; };
      div.appendChild(img);
      this._div = div;
      this._img = img;

      const map = this.getMap() as naver.maps.Map;
      const mapEl = map.getElement();
      mapEl.appendChild(div);

      // 스크롤 줌: 휠 이벤트로 fade, 멈추면 300ms 후 draw
      this._wheelHandler = () => { this._fade(); this._requestDraw(300); };
      mapEl.addEventListener("wheel", this._wheelHandler, { passive: true });

      this._listeners = [
        // 드래그: 움직이는 동안 fade만, 끝나면 draw
        naver.maps.Event.addListener(map, "dragstart", () => this._fade()),
        naver.maps.Event.addListener(map, "dragend", () => this._requestDraw()),
        // 창 리사이즈 등
        naver.maps.Event.addListener(map, "size_changed", () => this._requestDraw()),
      ];
      this.draw();
    }

    draw() {
      if (this._drawTimer) { clearTimeout(this._drawTimer); this._drawTimer = null; }
      const map = this.getMap() as naver.maps.Map;
      const img = this._img;
      if (!map || !img) return;

      if (map.getZoom() < CADASTRAL_MIN_ZOOM) {
        img.style.display = "none";
        return;
      }
      img.style.display = "";

      const bounds = map.getBounds() as naver.maps.LatLngBounds;
      const sw = bounds.getSW();
      const ne = bounds.getNE();
      const [swX, swY] = lngLatToMercator(sw.lat(), sw.lng());
      const [neX, neY] = lngLatToMercator(ne.lat(), ne.lng());

      const el = map.getElement();
      const w = el.offsetWidth;
      const h = el.offsetHeight;

      img.src = `https://api.vworld.kr/req/wms?service=WMS&request=GetMap&version=1.3.0&layers=lt_c_landinfobasemap&styles=&crs=EPSG:3857&bbox=${swX},${swY},${neX},${neY}&width=${w}&height=${h}&format=image/png&transparent=true&apikey=${VWORLD_API_KEY}`;
    }

    onRemove() {
      if (this._drawTimer) clearTimeout(this._drawTimer);
      if (this._wheelHandler) {
        const map = this.getMap() as naver.maps.Map | null;
        map?.getElement().removeEventListener("wheel", this._wheelHandler);
        this._wheelHandler = null;
      }
      for (const l of this._listeners) naver.maps.Event.removeListener(l);
      this._listeners = [];
      this._div?.remove();
      this._div = null;
      this._img = null;
    }
  }

  return new VWorldOverlay();
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
