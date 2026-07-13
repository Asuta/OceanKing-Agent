import { describe, expect, it } from "vitest";
import { ResetCoordinator } from "@/lib/server/reset-coordinator";

describe("工作台重置协调器", () => {
  it("相同 commandId 的并发请求只执行一次", async () => {
    const coordinator = new ResetCoordinator<string>();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const operation = async () => { executions += 1; await gate; return "reset"; };

    const first = coordinator.run("same-command", operation);
    const duplicate = coordinator.run("same-command", operation);
    release();

    await expect(Promise.all([first, duplicate])).resolves.toEqual(["reset", "reset"]);
    expect(executions).toBe(1);
  });

  it("不同重置命令严格串行执行", async () => {
    const coordinator = new ResetCoordinator<string>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = coordinator.run("first", async () => { order.push("first:start"); await firstGate; order.push("first:end"); return "first"; });
    const second = coordinator.run("second", async () => { order.push("second:start"); order.push("second:end"); return "second"; });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
