import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/parcel?keys=전라남도_신안군_지도읍_자동리_1692-1,전라남도_신안군_지도읍_자동리_1692-3,...
// keys: {sido}_{sgg}_{emd}_{ri}_{jibun} 형식, 콤마 구분 (N개 배치)
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("keys");
  if (!raw) return NextResponse.json({}, { status: 400 });

  const parsed = raw.split(",").map((k) => {
    const parts = k.trim().split("_");
    const [sido, sgg, emd, ri, jibun] = parts;
    return { sido, sgg, emd, ri, jibun };
  });

  // (sido, sgg, emd, ri) 단위로 그루핑 → 그룹당 쿼리 1회 (보통 1~2그룹)
  const groups = new Map<string, { sido: string; sgg: string; emd: string; ri: string; jibuns: string[] }>();
  for (const { sido, sgg, emd, ri, jibun } of parsed) {
    const gk = `${sido}_${sgg}_${emd}_${ri}`;
    if (!groups.has(gk)) groups.set(gk, { sido, sgg, emd, ri, jibuns: [] });
    groups.get(gk)?.jibuns.push(jibun);
  }

  const result: Record<string, unknown> = {};
  const db = getDb();
  const stmt = (jibuns: string[]) =>
    db.prepare(
      `SELECT ri, jibun, dl_nms
       FROM parcel
       WHERE sido=? AND sgg=? AND emd=? AND ri=? AND jibun IN (${jibuns.map(() => "?").join(",")})`,
    );

  for (const { sido, sgg, emd, ri, jibuns } of groups.values()) {
    const rows = stmt(jibuns).all(sido, sgg, emd, ri, ...jibuns) as
      { ri: string; jibun: string; [k: string]: unknown }[];
    for (const row of rows) {
      result[`${sido}_${sgg}_${emd}_${row.ri}_${row.jibun}`] = row;
    }
  }

  return NextResponse.json(result);
}
