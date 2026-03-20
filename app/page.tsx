"use client";

import type { Feature, FeatureCollection, MultiPolygon } from "geojson";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { EssArrow, EssPoint } from "@/components/NaverMap";
import NaverMap from "@/components/NaverMap";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import rawFeatures from "@/constants/byeon-jeon.json";
import rawEssZone from "@/constants/ess_zone.json";

const FEATURES = rawFeatures as Feature<MultiPolygon>[];

interface EssLocation {
  label: string;
  addr: string;
  lat: number;
  lon: number;
}
type EssZoneData = Record<string, Record<string, Record<string, EssLocation[]>>>;
const ESS_ZONE = rawEssZone as EssZoneData;

const FEATURE_ESS_KEY = FEATURES.map((f) => {
  const name = f.properties?.name ?? "";
  return Object.keys(ESS_ZONE).find((k) => name.startsWith(k)) ?? null;
});

const MATCHED_ESS_KEYS = new Set(FEATURE_ESS_KEY.filter((k): k is string => k !== null));
const ORPHAN_ESS_KEYS = Object.keys(ESS_ZONE).filter((k) => !MATCHED_ESS_KEYS.has(k));

const FEATURE_CENTROIDS = FEATURES.map((f) => {
  const outer = f.geometry.coordinates[0][0] as number[][];
  const lngSum = outer.reduce((s, [lng]) => s + lng, 0);
  const latSum = outer.reduce((s, [, lat]) => s + lat, 0);
  return { lat: latSum / outer.length, lon: lngSum / outer.length };
});

export default function Home() {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [roadviewOpen, setRoadviewOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [satelliteMode, setSatelliteMode] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [essChecked, setEssChecked] = useState<Set<string>>(new Set());

  function essItemKeys(essKey: string): string[] {
    const places = ESS_ZONE[essKey];
    return Object.entries(places).flatMap(([placeName, ranks]) =>
      Object.entries(ranks).flatMap(([rank, locs]) =>
        locs.map((_, idx) => `${essKey}/${placeName}/${rank}/${idx}`)
      )
    );
  }

  function toggle(index: number) {
    const featureId = `feature-${index}`;
    const next = !checked[index];
    setChecked((prev) => ({ ...prev, [index]: next }));
    const essKey = FEATURE_ESS_KEY[index];
    if (essKey) {
      setExpanded((prev) => {
        const s = new Set(prev);
        if (next) s.add(featureId); else s.delete(featureId);
        return s;
      });
      setEssChecked((prev) => {
        const s = new Set(prev);
        for (const key of essItemKeys(essKey)) {
          if (next) s.add(key); else s.delete(key);
        }
        return s;
      });
    }
  }

  const allChecked = FEATURES.every((_, i) => !!checked[i]);
  function toggleAll() {
    if (allChecked) {
      setChecked({});
      setExpanded(new Set());
      setEssChecked(new Set());
    } else {
      setChecked(Object.fromEntries(FEATURES.map((_, i) => [i, true])));
      setExpanded(new Set(FEATURES.flatMap((_, i) => FEATURE_ESS_KEY[i] ? [`feature-${i}`] : [])));
      setEssChecked(new Set(FEATURES.flatMap((_, i) => FEATURE_ESS_KEY[i] ? essItemKeys(FEATURE_ESS_KEY[i]) : [])));
    }
  }

  function toggleExpand(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleEss(key: string) {
    setEssChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const geojson = useMemo<FeatureCollection>(
    () => ({ type: "FeatureCollection", features: FEATURES.filter((_, i) => checked[i]) }),
    [checked],
  );

  const essPoints = useMemo<EssPoint[]>(() => {
    const points: EssPoint[] = [];
    essChecked.forEach((key) => {
      const [ssKey, placeName, rank, idxStr] = key.split("/");
      const loc = ESS_ZONE[ssKey]?.[placeName]?.[rank]?.[Number(idxStr)];
      if (loc) points.push({ label: loc.label, lat: loc.lat, lon: loc.lon });
    });
    return points;
  }, [essChecked]);

  const essArrows = useMemo<EssArrow[]>(() => {
    const arrows: EssArrow[] = [];
    essChecked.forEach((key) => {
      const [ssKey, placeName, rank, idxStr] = key.split("/");
      const loc = ESS_ZONE[ssKey]?.[placeName]?.[rank]?.[Number(idxStr)];
      const featureIdx = FEATURE_ESS_KEY.indexOf(ssKey);
      if (loc && featureIdx !== -1) {
        const from = FEATURE_CENTROIDS[featureIdx];
        arrows.push({ from, to: { lat: loc.lat, lon: loc.lon } });
      }
    });
    return arrows;
  }, [essChecked]);

  function renderEssHierarchy(essKey: string) {
    const places = ESS_ZONE[essKey];
    return (
      <div className="ml-4 border-l border-border/50 pl-1 pb-1">
        {Object.entries(places).map(([placeName, ranks]) => (
          <div key={placeName} className="mb-2">
            <div className="px-1.75 pt-0.5 my-px text-[0.85rem] font-semibold text-muted-foreground/90 bg-muted-foreground/10 inline-block rounded-sm">{placeName}</div>
            {Object.entries(ranks).map(([rank, locations]) => (
              <div key={rank} className="pl-1">
                {Object.keys(ranks).length > 1 && (
                  <div className="px-2 py-0.5 text-[0.85rem] font-medium text-muted-foreground/70">{rank}순위</div>
                )}
                {locations.map((loc, idx) => {
                  const itemKey = `${essKey}/${placeName}/${rank}/${idx}`;
                  return (
                    <div key={itemKey} className="flex items-center gap-1.5 px-2 py-0.75">
                      <Checkbox id={itemKey} checked={essChecked.has(itemKey)} onCheckedChange={() => toggleEss(itemKey)} />
                      <label htmlFor={itemKey} className="text-[0.85rem] cursor-pointer select-none leading-tight">
                        {loc.label}
                        {loc.addr && (
                          <span className="block text-[0.82rem] text-muted-foreground/70 font-normal">{loc.addr}</span>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <SidebarProvider>
      <Sidebar className="h-full flex flex-col">
        <SidebarHeader className="flex flex-row items-center justify-between pl-5 pr-3">
          <span className="mt-1 text-2xl tracking-tighter font-bold">Wire Finder Map</span>
          <SidebarTrigger />
        </SidebarHeader>
        <SidebarContent className="flex-1 flex flex-col min-h-0">
          <SidebarGroup className="flex-1 flex flex-col min-h-0">
            <SidebarGroupLabel className="shrink-0 flex items-center gap-2 pr-2 pb-1 border-b border-[#00000016]">
              <Checkbox id="toggle-all" checked={allChecked} onCheckedChange={toggleAll} />
              <label htmlFor="toggle-all" className="cursor-pointer select-none text-[1.1rem] tracking-tighter font-medium">
                전체 변전소 목록 ({FEATURES.length})
              </label>
            </SidebarGroupLabel>
            <ScrollArea className="flex-1 min-h-0 -mr-1.5">
              <SidebarGroupContent>
                <SidebarMenu className="pt-0.5">
                  {FEATURES.map((feature, i) => {
                    const name = feature.properties?.name ?? `항목 ${i + 1}`;
                    const featureId = `feature-${i}`;
                    const essKey = FEATURE_ESS_KEY[i];
                    const isExpanded = !!essKey && expanded.has(featureId);
                    return (
                      <SidebarMenuItem key={featureId}>
                        <div className="flex items-center gap-1.5 px-2 py-1.25">
                          <Checkbox id={featureId} checked={!!checked[i]} onCheckedChange={() => toggle(i)} />
                          <label htmlFor={featureId} className="text-[0.96rem] tracking-tight cursor-pointer select-none">
                            {name}
                          </label>
                        </div>
                        {isExpanded && essKey && renderEssHierarchy(essKey)}
                      </SidebarMenuItem>
                    );
                  })}
                  {ORPHAN_ESS_KEYS.map((essKey) => {
                    const orphanId = `orphan-${essKey}`;
                    const isExpanded = expanded.has(orphanId);
                    return (
                      <SidebarMenuItem key={orphanId}>
                        <div className="flex items-center gap-1.5 px-2 py-1">
                          <button type="button" onClick={() => toggleExpand(orphanId)} className="p-0.5 rounded hover:bg-muted shrink-0">
                            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                          </button>
                          <div className="w-4 shrink-0" />
                          <span className="text-sm text-muted-foreground">{essKey}변전소</span>
                        </div>
                        {isExpanded && renderEssHierarchy(essKey)}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </ScrollArea>
          </SidebarGroup>
          <SidebarGroup className="shrink-0">
            <SidebarGroupContent>
              <div className="grid grid-cols-2 gap-2 px-2 pb-2">
                <button
                  type="button"
                  onClick={() => setDarkMode((prev) => !prev)}
                  className={`rounded px-3 py-2 text-sm font-medium border transition-colors ${
                    darkMode ? "bg-gray-900 text-white border-gray-700" : "bg-white text-[#333] hover:bg-gray-100"
                  }`}
                >
                  {darkMode ? "다크 모드" : "라이트 모드"}
                </button>
                <button
                  type="button"
                  onClick={() => setSatelliteMode((prev) => !prev)}
                  className={`rounded px-3 py-2 text-sm font-medium border transition-colors ${
                    satelliteMode ? "bg-green-700 text-white border-green-700" : "bg-white text-[#333] hover:bg-gray-100"
                  }`}
                >
                  위성 모드
                </button>
                <button
                  type="button"
                  onClick={() => setRoadviewOpen((prev) => !prev)}
                  className={`rounded px-3 py-2 text-sm font-medium border transition-colors col-span-2 ${
                    roadviewOpen ? "bg-blue-600 text-white border-blue-600" : "bg-white text-[#333] hover:bg-gray-100"
                  }`}
                >
                  거리뷰 팝업
                </button>
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <main className="absolute inset-0">
        <SidebarTrigger className="absolute top-2 left-2 z-9 bg-white shadow-md border border-black/10 rounded-md" />
        <NaverMap
          className="w-full h-full"
          center={{ lat: 35.55, lng: 127.1 }}
          zoom={8}
          pipOpen={roadviewOpen}
          darkMode={darkMode}
          satelliteMode={satelliteMode}
          geojson={geojson}
          points={essPoints}
          arrows={essArrows}
          onPipClose={() => setRoadviewOpen(false)}
          onPipOpen={() => setRoadviewOpen(true)}
        />
      </main>
    </SidebarProvider>
  );
}
