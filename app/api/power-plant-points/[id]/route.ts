import { NextResponse } from "next/server";
import details from "@/constants/power-plant-point-details.json";

type RouteParams = {
  params: Promise<{ id: string }>;
};

const DETAIL_BY_ID = details as Record<string, unknown>;

export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  const detail = DETAIL_BY_ID[id];

  if (!detail) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(detail);
}
