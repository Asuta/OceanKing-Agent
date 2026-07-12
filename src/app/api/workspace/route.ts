import { NextResponse } from "next/server";
import { ensureRuntimeStarted } from "@/lib/server/runtime";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  ensureRuntimeStarted();
  return NextResponse.json(getRepository().getSnapshot(), { headers: { "cache-control": "no-store" } });
}
