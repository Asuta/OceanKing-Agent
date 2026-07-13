// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/workspace/settings-dialog";
import type { WorkspaceSnapshot } from "@/lib/domain/types";

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
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={sendCommand} onClose={vi.fn()} />);

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
    render(<SettingsDialog snapshot={snapshot} busy={false} sendCommand={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole("spinbutton", { name: "上下文压缩阈值（K Token）" }), { target: { value: "1" } });

    expect((screen.getByRole("button", { name: "保存全局模型设置" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
