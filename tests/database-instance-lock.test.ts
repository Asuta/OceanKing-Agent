import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDatabaseInstanceLock } from "@/lib/server/db/client";

const children: ChildProcess[] = [];
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-lock-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("SQLite 后端实例锁", () => {
  it("释放实例锁后允许重新占用同一数据目录", async () => {
    const directory = await temporaryDirectory();
    const release = acquireDatabaseInstanceLock(directory);
    await expect(fs.stat(path.join(directory, ".oceanking-instance.lock"))).resolves.toBeDefined();
    release();
    const releaseAgain = acquireDatabaseInstanceLock(directory);
    releaseAgain();
  });

  it("已有其他存活进程占用时拒绝启动第二个后端", async () => {
    const directory = await temporaryDirectory();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    if (!child.pid) throw new Error("测试子进程未启动");
    await fs.writeFile(path.join(directory, ".oceanking-instance.lock"), JSON.stringify({ pid: child.pid, token: "other", cwd: "other-worktree", startedAt: new Date().toISOString() }));
    expect(() => acquireDatabaseInstanceLock(directory)).toThrow(/另一个后端占用/);
  });

  it("自动清理已经退出进程留下的陈旧锁", async () => {
    const directory = await temporaryDirectory();
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    if (!pid) throw new Error("测试子进程未启动");
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
    await fs.writeFile(path.join(directory, ".oceanking-instance.lock"), JSON.stringify({ pid, token: "stale", cwd: "stale-worktree", startedAt: new Date().toISOString() }));
    const release = acquireDatabaseInstanceLock(directory);
    release();
  });
});
