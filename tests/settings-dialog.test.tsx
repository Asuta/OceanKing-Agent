// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/workspace/settings-dialog";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import { workspaceCommandSchema } from "@/lib/domain/schemas";

afterEach(cleanup);

const snapshot: WorkspaceSnapshot = {
  version: 1,
  revision: 1,
  agents: [],
  rooms: [],
  cronJobs: [],
  cronRuns: [],
  settings: {
    apiFormat: "chat_completions",
    thinkingMode: "disabled",
    reasoningEffort: "high",
    model: "test-model",
    availableModels: ["test-model"],
    contextTokenThreshold: 100_000,
    maxToolSteps: 12,
    maxRoomRounds: 32,
    projectContextRoots: [],
    baseUrl: "https://example.test/v1",
    apiKeyConfigured: false,
    usingMockModel: true,
  },
};

describe("工作台设置", () => {
  it("以 K Token 显示阈值并在保存时换算回整数 Token", async () => {
    const sendCommand = vi.fn().mockResolvedValue(true);
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={sendCommand} onReset={vi.fn()} onClose={vi.fn()} />);

    const threshold = screen.getByRole("spinbutton", { name: "上下文压缩阈值（K Token）" }) as HTMLInputElement;
    expect(threshold.value).toBe("100");
    fireEvent.change(threshold, { target: { value: "128.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局模型设置" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "update_settings",
      contextTokenThreshold: 128_500,
    })));
  });

  it("阈值超出原有 Token 合法范围时禁止保存", () => {
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={vi.fn()} onReset={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "上下文压缩阈值（K Token）" }), { target: { value: "1" } });

    expect((screen.getByRole("button", { name: "保存全局模型设置" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("最大工具步骤允许设置到 256 且拒绝更大的值", async () => {
    const sendCommand = vi.fn().mockResolvedValue(true);
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={sendCommand} onReset={vi.fn()} onClose={vi.fn()} />);

    const maxToolSteps = screen.getByRole("spinbutton", { name: "最大工具步骤" }) as HTMLInputElement;
    expect(maxToolSteps.max).toBe("256");
    fireEvent.change(maxToolSteps, { target: { value: "256" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局模型设置" }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ maxToolSteps: 256 })));

    const baseCommand = {
      commandId: crypto.randomUUID(), expectedVersion: 0, type: "update_settings" as const,
      model: "test-model", availableModels: ["test-model"], apiFormat: "chat_completions" as const,
      contextTokenThreshold: 100_000, maxRoomRounds: 32, projectContextRoots: [],
    };
    expect(workspaceCommandSchema.safeParse({ ...baseCommand, maxToolSteps: 256 }).success).toBe(true);
    expect(workspaceCommandSchema.safeParse({ ...baseCommand, maxToolSteps: 257 }).success).toBe(false);
  });

  it("重置工作台需要二次确认，成功后返回初始房间视图", async () => {
    const sendCommand = vi.fn().mockResolvedValue(true);
    const onReset = vi.fn(); const onClose = vi.fn();
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={sendCommand} onReset={onReset} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "数据重置" }));
    expect(screen.getByText("Agent 注册信息、全局模型、思考模式和思考强度保持不变。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重置工作台" }));
    expect(screen.getByRole("alert").textContent).toContain("不可撤销");
    expect(sendCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认重置全部历史" }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ type: "reset_workspace" }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
