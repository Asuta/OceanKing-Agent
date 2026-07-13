import { Cron } from "croner";
import { trackCronRun } from "@/lib/server/cron-run-tracker";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { getRepository, WorkspaceRepository } from "@/lib/server/repository";
import { getRoomScheduler } from "@/lib/server/scheduler";

class CronDispatcher {
  private jobs = new Map<string, Cron>();
  constructor(private repository: WorkspaceRepository = getRepository()) {}

  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  refresh(): void {
    this.stopAll();
    for (const definition of this.repository.getSnapshot().cronJobs) {
      if (!definition.enabled) continue;
      try {
        const job = new Cron(definition.schedule, { timezone: definition.timezone, protect: true }, () => { void this.runNow(definition.id); });
        this.jobs.set(definition.id, job);
      } catch (error) {
        publishWorkspaceEvent("cron.changed", definition.id, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async runNow(jobId: string): Promise<void> {
    const { roomId, runId } = this.repository.appendCronMessage(jobId); publishWorkspaceEvent("cron.changed", jobId, { runId, status: "running" });
    try { trackCronRun(roomId, runId); getRoomScheduler().enqueue(roomId); }
    catch (error) { this.repository.completeCronRun(runId, error instanceof Error ? error.message : String(error)); }
  }
}

const globalCron = globalThis as typeof globalThis & { __oceanKingCron?: CronDispatcher };
export function getCronDispatcher(): CronDispatcher { globalCron.__oceanKingCron ??= new CronDispatcher(); return globalCron.__oceanKingCron; }
