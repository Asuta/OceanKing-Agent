import { getRepository } from "@/lib/server/repository";

const state = globalThis as typeof globalThis & { __oceanKingCronRunsByRoom?: Map<string, string[]> };
const runsByRoom = state.__oceanKingCronRunsByRoom ??= new Map<string, string[]>();

export function trackCronRun(roomId: string, runId: string): void {
  runsByRoom.set(roomId, [...(runsByRoom.get(roomId) ?? []), runId]);
}

export function completeCronRunsForRoom(roomId: string, error?: string): void {
  const runIds = runsByRoom.get(roomId) ?? [];
  runsByRoom.delete(roomId);
  for (const runId of runIds) getRepository().completeCronRun(runId, error);
}
