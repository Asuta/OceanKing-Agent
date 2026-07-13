import { NextResponse } from "next/server";
import { ensureRuntimeStarted } from "@/lib/server/runtime";
import { getRepository } from "@/lib/server/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ agentId: string }> }) {
  ensureRuntimeStarted();
  const { agentId } = await context.params;
  const history = getRepository().getAgentConversation(agentId);
  if (!history) return NextResponse.json({ error: "Agent 不存在" }, { status: 404 });
  return NextResponse.json(history, { headers: { "cache-control": "no-store" } });
}
