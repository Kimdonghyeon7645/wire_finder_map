"use client";

import { useState } from "react";
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

const ITEMS = Array.from({ length: 40 }, (_, i) => ({
  id: `item-${i + 1}`,
  label: `항목 ${i + 1}`,
}));

export default function Home() {
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(ITEMS.map((item) => [item.id, false])));
  const [roadviewOpen, setRoadviewOpen] = useState(false);

  function toggle(id: string) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <SidebarProvider>
      <Sidebar className="h-full flex flex-col">
        <SidebarHeader>
          <span className="px-2 py-1 text-2xl tracking-tighter font-bold">Wire Finder Map</span>
        </SidebarHeader>
        <SidebarContent className="flex-1 flex flex-col min-h-0">
          <SidebarGroup className="shrink-0">
            <SidebarGroupLabel>거리뷰</SidebarGroupLabel>
            <SidebarGroupContent>
              <div className="px-2 pb-2">
                <button
                  type="button"
                  onClick={() => setRoadviewOpen((prev) => !prev)}
                  className={`w-full rounded px-3 py-2 text-sm font-medium border transition-colors ${
                    roadviewOpen ? "bg-blue-600 text-white border-blue-600" : "bg-white text-[#333] hover:bg-gray-100"
                  }`}
                >
                  거리뷰 토글
                </button>
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="flex-1 flex flex-col min-h-0">
            <SidebarGroupLabel className="shrink-0">체크리스트</SidebarGroupLabel>
            <ScrollArea className="flex-1 min-h-0 -mr-1.5">
              <SidebarGroupContent>
                <SidebarMenu>
                  {ITEMS.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <div className="flex items-center gap-2 px-2 py-1">
                        <Checkbox id={item.id} checked={checked[item.id]} onCheckedChange={() => toggle(item.id)} />
                        <label htmlFor={item.id} className="text-sm cursor-pointer select-none">
                          {item.label}
                        </label>
                      </div>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </ScrollArea>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <main className="relative flex-1 min-w-0 h-screen">
        <SidebarTrigger className="absolute top-2 left-2 z-10 bg-white p-4 border-black/10 shadow-xl" />
        <NaverMap className="w-full h-full" roadviewOpen={roadviewOpen} onRoadviewClose={() => setRoadviewOpen(false)} />
      </main>
    </SidebarProvider>
  );
}
