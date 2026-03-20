"use client";

import type { Feature, FeatureCollection, MultiPolygon } from "geojson";
import { useMemo, useState } from "react";
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

const FEATURES = rawFeatures as Feature<MultiPolygon>[];

export default function Home() {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [roadviewOpen, setRoadviewOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  function toggle(index: number) {
    setChecked((prev) => ({ ...prev, [index]: !prev[index] }));
  }

  const allChecked = FEATURES.every((_, i) => !!checked[i]);

  function toggleAll() {
    if (allChecked) {
      setChecked({});
    } else {
      setChecked(Object.fromEntries(FEATURES.map((_, i) => [i, true])));
    }
  }

  const geojson = useMemo<FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: FEATURES.filter((_, i) => checked[i]),
    }),
    [checked],
  );

  return (
    <SidebarProvider>
      <Sidebar className="h-full flex flex-col">
        <SidebarHeader className="flex flex-row items-center justify-between pl-5 pr-3">
          <span className="mt-1 text-2xl tracking-tighter font-bold">Wire Finder Map</span>
          <SidebarTrigger />
        </SidebarHeader>
        <SidebarContent className="flex-1 flex flex-col min-h-0">
          <SidebarGroup className="flex-1 flex flex-col min-h-0">
            <SidebarGroupLabel className="shrink-0 flex items-center gap-2 pr-2">
              <Checkbox id="toggle-all" checked={allChecked} onCheckedChange={toggleAll} />
              <label htmlFor="toggle-all" className="cursor-pointer select-none text-[1.1rem] tracking-tighter font-medium">
                전체 변전소 목록 ({FEATURES.length})
              </label>
            </SidebarGroupLabel>
            <ScrollArea className="flex-1 min-h-0 -mr-1.5">
              <SidebarGroupContent>
                <SidebarMenu className="pl-2 pt-0.5">
                  {FEATURES.map((feature, i) => {
                    const name = feature.properties?.name ?? `항목 ${i + 1}`;
                    const id = `feature-${i}`;
                    return (
                      <SidebarMenuItem key={id}>
                        <div className="flex items-center gap-2 px-2 py-1">
                          <Checkbox id={id} checked={!!checked[i]} onCheckedChange={() => toggle(i)} />
                          <label htmlFor={id} className="text-sm cursor-pointer select-none">
                            {name}
                          </label>
                        </div>
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
                  onClick={() => setRoadviewOpen((prev) => !prev)}
                  className={`rounded px-3 py-2 text-sm font-medium border transition-colors ${
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
          pipOpen={roadviewOpen}
          darkMode={darkMode}
          geojson={geojson}
          onPipClose={() => setRoadviewOpen(false)}
          onPipOpen={() => setRoadviewOpen(true)}
        />
      </main>
    </SidebarProvider>
  );
}
