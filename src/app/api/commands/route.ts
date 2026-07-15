import { NextResponse } from "next/server";
import { Cron } from "croner";
import { workspaceCommandSchema, type WorkspaceCommand } from "@/lib/domain/schemas";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import { getCronDispatcher } from "@/lib/server/cron-dispatcher";
import { publishWorkspaceEvent, resetWorkspaceEventHistory } from "@/lib/server/events";
import { assertLocalRequest } from "@/lib/server/http";
import { DomainError, getRepository, VersionConflictError } from "@/lib/server/repository";
import { ResetCoordinator } from "@/lib/server/reset-coordinator";
import { ensureRuntimeStarted } from "@/lib/server/runtime";
import { getRoomScheduler } from "@/lib/server/scheduler";

export const runtime = "nodejs";

type ResetWorkspaceCommand = Extract<WorkspaceCommand, { type: "reset_workspace" }>;
const resetState = globalThis as typeof globalThis & { __oceanKingResetCoordinator?: ResetCoordinator<WorkspaceSnapshot> };
const resetCoordinator = resetState.__oceanKingResetCoordinator ??= new ResetCoordinator<WorkspaceSnapshot>();

function resetWorkspace(command: ResetWorkspaceCommand): Promise<WorkspaceSnapshot> {
  return resetCoordinator.run(command.commandId, async () => {
    const repository = getRepository();
    if (repository.hasProcessedCommand(command.commandId)) return repository.getSnapshot();

    const cron = getCronDispatcher();
    cron.stopAll();
    try {
      await getRoomScheduler().stopRoomsAndWait(repository.getRoomIds());
      const result = repository.executeCommand({ ...command, expectedVersion: repository.getVersion().version });
      resetWorkspaceEventHistory();
      publishWorkspaceEvent("workspace.changed", undefined, { commandId: command.commandId, commandType: command.type });
      return result.snapshot;
    } finally {
      cron.refresh();
    }
  });
}

export async function POST(request: Request) {
  const rejected = assertLocalRequest(request); if (rejected) return rejected;
  ensureRuntimeStarted();
  try {
    const command = workspaceCommandSchema.parse(await request.json());
    if (command.type === "create_cron" || (command.type === "update_cron" && (command.schedule || command.timezone))) {
      const current = command.type === "update_cron" ? getRepository().getSnapshot().cronJobs.find((job) => job.id === command.jobId) : null;
      const schedule = command.schedule ?? current?.schedule;
      const timezone = command.timezone ?? current?.timezone;
      if (!schedule || !timezone) throw new DomainError("Cron 配置不完整");
      const validationJob = new Cron(schedule, { timezone, paused: true });
      validationJob.stop();
    }
    if (command.type === "reset_workspace") {
      return NextResponse.json({ ok: true, snapshot: await resetWorkspace(command) });
    }
    const repository = getRepository();
    const result = repository.executeCommand(command);
    if (result.stopRoomId) getRoomScheduler().stop(result.stopRoomId);
    if (result.triggerRoomId) getRoomScheduler().enqueue(result.triggerRoomId, { interruptActive: command.type === "send_message" });
    if (result.refreshCron) getCronDispatcher().refresh();
    if (result.runCronJobId) await getCronDispatcher().runNow(result.runCronJobId);
    publishWorkspaceEvent(command.type.includes("cron") ? "cron.changed" : "workspace.changed", "roomId" in command ? command.roomId : undefined, { commandId: command.commandId, commandType: command.type });
    return NextResponse.json({ ok: true, snapshot: repository.getSnapshot() });
  } catch (error) {
    if (error instanceof VersionConflictError) return NextResponse.json({ error: error.message, snapshot: getRepository().getSnapshot() }, { status: 409 });
    if (error instanceof DomainError) return NextResponse.json({ error: error.message }, { status: 400 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
