"use client";

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { useEffect, useRef, useState } from "react";

interface NaverMapProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  className?: string;
  pipOpen?: boolean;
  darkMode?: boolean;
  geojson?: FeatureCollection | null;
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

    const ringGroups: number[][][][] =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.coordinates;

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
        })
      );
      markers.push(
        new naver.maps.Marker({
          map,
          position: centroid(outer),
          title: properties?.name ?? undefined,
          icon: {
            content: `<div style="transform:translate(-50%,-100%);display:inline-flex;flex-direction:column;align-items:center;pointer-events:none"><div style="background:#ef4444;color:#fff;padding:3px 8px;border-radius:5px;font-size:11px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);font-weight:500">${properties?.name ?? ""}</div><div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:7px solid #ef4444"></div></div>`,
            anchor: new naver.maps.Point(0, 0),
          },
        })
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
  geojson = null,
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

  // GeoJSON 폴리곤 렌더링
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // 기존 오버레이 제거
    overlayRef.current.polygons.forEach((p) => { p.setMap(null); });
    overlayRef.current.markers.forEach((m) => { m.setMap(null); });
    overlayRef.current = { polygons: [], markers: [] };

    if (!geojson) return;

    overlayRef.current = drawGeoJson(map, geojson);
  }, [geojson]);

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
        className="w-full h-full"
        style={darkMode ? { filter: "invert(90%) hue-rotate(180deg)" } : undefined}
      />
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
