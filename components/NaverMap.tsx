"use client";

import { useEffect, useRef, useState } from "react";

interface NaverMapProps {
  center?: { lat: number; lng: number };
  zoom?: number;
  className?: string;
}

export default function NaverMap({ center = { lat: 37.5665, lng: 126.978 }, zoom = 13, className = "w-full h-full" }: NaverMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const panoRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<naver.maps.Map | null>(null);
  const streetLayerRef = useRef<naver.maps.StreetLayer | null>(null);
  const panoInstanceRef = useRef<naver.maps.Panorama | null>(null);
  const clickListenerRef = useRef<naver.maps.MapEventListener | null>(null);

  const [roadviewOpen, setRoadviewOpen] = useState(false);
  const [hasPano, setHasPano] = useState(false);

  useEffect(() => {
    function initMap() {
      if (!mapRef.current || mapInstanceRef.current) return;

      mapInstanceRef.current = new naver.maps.Map(mapRef.current, {
        center: new naver.maps.LatLng(center.lat, center.lng),
        zoom,
        zoomControl: true,
        zoomControlOptions: {
          position: naver.maps.Position.TOP_RIGHT,
          style: naver.maps.ZoomControlStyle.SMALL,
        },
      });

      streetLayerRef.current = new naver.maps.StreetLayer();
    }

    if (typeof naver !== "undefined" && naver.maps) {
      initMap();
    } else {
      // afterInteractive 전략으로 스크립트가 아직 로드 안 됐을 경우 대기
      window.addEventListener("load", initMap, { once: true });
      return () => window.removeEventListener("load", initMap);
    }
  }, [center.lat, center.lng, zoom]);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const streetLayer = streetLayerRef.current;
    if (!map || !streetLayer) return;

    if (roadviewOpen) {
      streetLayer.setMap(map);

      clickListenerRef.current = naver.maps.Event.addListener(map, "click", (e: naver.maps.PointerEvent) => {
        if (!panoRef.current) return;

        if (!panoInstanceRef.current) {
          panoInstanceRef.current = new naver.maps.Panorama(panoRef.current, {
            position: e.coord as naver.maps.LatLng,
            pov: { pan: 0, tilt: 0, fov: 100 },
            zoomControl: true,
            zoomControlOptions: {
              position: naver.maps.Position.TOP_RIGHT,
            },
          });
          setHasPano(true);
        } else {
          panoInstanceRef.current.setPosition(e.coord as naver.maps.LatLng);
        }
      });
    } else {
      streetLayer.setMap(null);

      if (clickListenerRef.current) {
        naver.maps.Event.removeListener(clickListenerRef.current);
        clickListenerRef.current = null;
      }
    }
  }, [roadviewOpen]);

  function closeRoadview() {
    setRoadviewOpen(false);
    setHasPano(false);
    panoInstanceRef.current = null;
  }

  return (
    <div className={`relative ${className}`}>
      <div ref={mapRef} className="w-full h-full" />

      {/* 거리뷰 토글 버튼 */}
      <button
        type="button"
        onClick={() => setRoadviewOpen((prev) => !prev)}
        className={`absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded px-3 py-2 text-sm font-medium shadow-xl border transition-colors ${
          roadviewOpen ? "bg-blue-600 text-white" : "bg-white text-[#333] hover:bg-gray-100"
        }`}
      >
        거리뷰
      </button>

      {/* 거리뷰 PiP 패널 - DOM에 항상 유지하고 CSS로 show/hide (unmount 시 지도 재로드 방지) */}
      <div className={`w-160 h-120 absolute bottom-16 right-4 z-20 rounded-xl overflow-hidden shadow-xl bg-white border ${roadviewOpen ? "" : "hidden"}`}>
        <div className="absolute inset-0 h-5 w-full flex justify-between">
          <div className="pt-0.5 pl-3">거리뷰</div>
          <button type="button" onClick={closeRoadview} className="px-2 py-2 font-bold leading-3 rounded-md cursor-pointer hover:bg-[#eee]">
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
