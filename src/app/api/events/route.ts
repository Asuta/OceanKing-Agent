import { eventsAfter, subscribeWorkspaceEvents } from "@/lib/server/events";
import { ensureRuntimeStarted } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  ensureRuntimeStarted();
  const url = new URL(request.url);
  const after = Number(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: { id: number; type: string; [key: string]: unknown }) => controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      for (const event of eventsAfter(after)) send(event);
      unsubscribe = subscribeWorkspaceEvents(send);
      timer = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 15_000);
    },
    cancel() { unsubscribe(); if (timer) clearInterval(timer); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
}
