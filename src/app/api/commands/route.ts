import { NextResponse } from "next/server";
import { Cron } from "croner";
import { workspaceCommandSchema } from "@/lib/domain/schemas";
import { getCronDispatcher } from "@/lib/server/cron-dispatcher";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { assertLocalRequest } from "@/lib/server/http";
import { DomainError, getRepository, VersionConflictError } from "@/lib/server/repository";
import { ensureRuntimeStarted } from "@/lib/server/runtime";
import { getRoomScheduler } from "@/lib/server/scheduler";

export const runtime = "nodejs";

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
    const result = getRepository().executeCommand(command);
    if (result.stopRoomId) getRoomScheduler().stop(result.stopRoomId);
    if (result.triggerRoomId) getRoomScheduler().enqueue(result.triggerRoomId);
    if (result.refreshCron) getCronDispatcher().refresh();
    if (result.runCronJobId) await getCronDispatcher().runNow(result.runCronJobId);
    publishWorkspaceEvent(command.type.includes("cron") ? "cron.changed" : "workspace.changed", "roomId" in command ? command.roomId : undefined, { commandId: command.commandId, commandType: command.type });
    return NextResponse.json({ ok: true, snapshot: getRepository().getSnapshot() });
  } catch (error) {
    if (error instanceof VersionConflictError) return NextResponse.json({ error: error.message, snapshot: getRepository().getSnapshot() }, { status: 409 });
    if (error instanceof DomainError) return NextResponse.json({ error: error.message }, { status: 400 });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
