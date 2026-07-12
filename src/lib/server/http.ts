import { NextResponse } from "next/server";

export function assertLocalRequest(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  } catch { /* rejected below */ }
  return NextResponse.json({ error: "OceanKing 只接受本机同源请求" }, { status: 403 });
}
