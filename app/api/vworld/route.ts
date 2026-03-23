import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const API_KEY = process.env.VWORLD_API_KEY ?? "";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const bbox = searchParams.get("bbox");
  const page = searchParams.get("page") ?? "1";
  const size = searchParams.get("size") ?? "1000";

  if (!bbox) return NextResponse.json({ error: "bbox required" }, { status: 400 });

  const url = new URL("https://api.vworld.kr/req/data");
  url.searchParams.set("service", "data");
  url.searchParams.set("request", "GetFeature");
  url.searchParams.set("data", "LT_C_LANDINFOBASEMAP");
  url.searchParams.set("key", API_KEY);
  url.searchParams.set("domain", req.nextUrl.origin);
  url.searchParams.set("geometry", "true");
  url.searchParams.set("attribute", "true");
  url.searchParams.set("page", page);
  url.searchParams.set("size", size);
  url.searchParams.set("crs", "EPSG:4326");
  url.searchParams.set("geomfilter", `BOX(${bbox})`);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "upstream error" }, { status: 502 });
  }
}
