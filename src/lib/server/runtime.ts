import { getCronDispatcher } from "@/lib/server/cron-dispatcher";
import { getRepository } from "@/lib/server/repository";
import { getRoomScheduler } from "@/lib/server/scheduler";

const runtimeState = globalThis as typeof globalThis & { __oceanKingRuntimeStarted?: boolean };

export function ensureRuntimeStarted(): void {
  if (runtimeState.__oceanKingRuntimeStarted) return;
  runtimeState.__oceanKingRuntimeStarted = true;
  const repository = getRepository();
  const interruptedRooms = repository.recoverInterruptedRuns();
  getCronDispatcher().refresh();
  for (const roomId of interruptedRooms) {
    getRoomScheduler().enqueue(roomId);
    repository.markRoomEffectDispatchesDispatched(roomId);
  }
}
