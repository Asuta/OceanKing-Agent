import { describe, expect, it, vi } from "vitest";
import { AgentExecutor, AgentRunSupersededError } from "@/lib/server/agent-executor";

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("AgentExecutor 自动抢占", () => {
  it("同一 Agent 的新用户任务会中止正在运行的旧房间任务", async () => {
    const executor = new AgentExecutor();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = executor.run("navigator", "room_a", async (signal) => {
      markStarted();
      return waitForAbort(signal);
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await started;

    const second = executor.run("navigator", "room_b", async () => "new-result", { supersedeActive: true });

    const interruption = await firstOutcome;
    expect(interruption).toBeInstanceOf(AgentRunSupersededError);
    expect(interruption).toMatchObject({ previousRoomId: "room_a", nextRoomId: "room_b" });
    await expect(second).resolves.toBe("new-result");
  });

  it("最新用户任务也会淘汰尚在排队的更旧任务", async () => {
    const executor = new AgentExecutor();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const active = executor.run("navigator", "room_a", async (signal) => {
      markStarted();
      return waitForAbort(signal);
    });
    const activeOutcome = active.catch((error: unknown) => error);
    await started;

    const queuedTask = vi.fn(async () => "stale-result");
    const queued = executor.run("navigator", "room_b", queuedTask, { supersedeActive: true });
    const queuedOutcome = queued.catch((error: unknown) => error);
    const newestTask = vi.fn(async () => "latest-result");
    const newest = executor.run("navigator", "room_c", newestTask, { supersedeActive: true });

    await activeOutcome;
    const queuedInterruption = await queuedOutcome;
    expect(queuedInterruption).toBeInstanceOf(AgentRunSupersededError);
    expect(queuedInterruption).toMatchObject({ previousRoomId: "room_b", nextRoomId: "room_c" });
    expect(queuedTask).not.toHaveBeenCalled();
    await expect(newest).resolves.toBe("latest-result");
    expect(newestTask).toHaveBeenCalledOnce();
  });

  it("房间已经有排队任务时，新消息仍会立即抢占该 Agent 在其他房间的活动任务", async () => {
    const executor = new AgentExecutor();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const active = executor.run("navigator", "room_b", async (signal) => {
      markStarted();
      return waitForAbort(signal);
    });
    const activeOutcome = active.catch((error: unknown) => error);
    await started;
    const queuedTask = vi.fn(async () => "stale-room-a");
    const queued = executor.run("navigator", "room_a", queuedTask);
    const queuedOutcome = queued.catch((error: unknown) => error);

    executor.interruptAgentsForNewMessage("room_a", ["navigator"]);

    expect(await activeOutcome).toMatchObject({ previousRoomId: "room_b", nextRoomId: "room_a" });
    expect(await queuedOutcome).toMatchObject({ previousRoomId: "room_a", nextRoomId: "room_a" });
    expect(queuedTask).not.toHaveBeenCalled();
    await expect(executor.run("navigator", "room_a", async () => "fresh-room-a")).resolves.toBe("fresh-room-a");
  });
});
