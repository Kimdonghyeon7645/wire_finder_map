import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const GEOCODE_URL = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query")?.trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  const clientId = process.env.GEOCODING_CLIENT_ID;
  const clientSecret = process.env.GEOCODING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "geocoding credentials missing" }, { status: 500 });
  }

  const url = new URL(GEOCODE_URL);
  url.searchParams.set("query", query);

  const res = await fetch(url, {
    headers: {
      "X-NCP-APIGW-API-KEY-ID": clientId,
      "X-NCP-APIGW-API-KEY": clientSecret,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return NextResponse.json({ error: "geocoding failed" }, { status: res.status });
  }

  const data = await res.json();
  const first = data?.addresses?.[0];
  if (!first?.x || !first?.y) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json({
    query,
    address: first.roadAddress || first.jibunAddress || query,
    lat: Number(first.y),
    lng: Number(first.x),
  });
}
