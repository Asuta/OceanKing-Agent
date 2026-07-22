// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronDrawer } from "@/components/workspace/cron-drawer";
import { RoomPanel } from "@/components/workspace/room-panel";
import { RoomSidebar } from "@/components/workspace/room-sidebar";
import { directRoomPlaceholder } from "@/components/workspace/workspace-shell";
import type { Agent, Room, WorkspaceSnapshot } from "@/lib/domain/types";

afterEach(cleanup);

const createdAt = "2026-07-22T10:00:00.000Z";
const settings = {
  apiFormat: "chat_completions" as const,
  thinkingMode: "enabled" as const,
  reasoningEffort: "high" as const,
  model: "test-model",
  availableModels: ["test-model"],
  contextTokenThreshold: 100_000,
  maxToolSteps: 12,
  maxRoomRounds: 32,
  projectContextRoots: [],
};
const navigator: Agent = {
  id: "navigator",
  label: "领航员",
  summary: "协调任务",
  instruction: "先协调再执行",
  skills: [],
  settings,
  createdAt,
  updatedAt: createdAt,
};
const builder: Agent = { ...navigator, id: "builder", label: "执行者" };

function sharedRoom(): Room {
  return {
    id: "room_harbor",
    title: "港湾协作室",
    kind: "shared",
    directAgentId: null,
    ownerParticipantId: "human_local",
    participants: [{ id: "human_local", roomId: "room_harbor", kind: "human", agentId: null, displayName: "你", enabled: true, sortOrder: 0, createdAt }],
    messages: [],
    turns: [],
    scheduler: { roomId: "room_harbor", status: "idle", nextAgentParticipantId: null, activeParticipantId: null, roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
    archivedAt: null,
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("Agent 单聊界面", () => {
  it("单聊房间不进入房间列表，Agent 名称仍作为单聊入口", () => {
    const directRoom = { ...directRoomPlaceholder(navigator), id: "direct_navigator", title: "领航员 · 单聊", scheduler: { ...directRoomPlaceholder(navigator).scheduler, roomId: "direct_navigator" } };
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      revision: 1,
      agents: [navigator],
      rooms: [sharedRoom(), directRoom],
      cronJobs: [],
      cronRuns: [],
      settings: { ...settings, baseUrl: "https://example.test/v1", apiKeyConfigured: false, usingMockModel: true },
    };
    const onSelectAgent = vi.fn();

    render(<RoomSidebar snapshot={snapshot} activeRoomId="room_harbor" activeAgentId={null} onSelect={() => undefined} onSelectAgent={onSelectAgent} sendCommand={async () => true} busy={false} />);

    expect(screen.getByRole("navigation", { name: "房间列表" }).textContent).toContain("港湾协作室");
    expect(screen.getByRole("navigation", { name: "房间列表" }).textContent).not.toContain("领航员 · 单聊");
    fireEvent.click(screen.getByRole("button", { name: "与 领航员 单聊" }));
    expect(onSelectAgent).toHaveBeenCalledWith("navigator");
  });

  it("未落库的单聊页面使用专用发送命令，并隐藏普通房间管理操作", async () => {
    const sendCommand = vi.fn(async () => true);
    const room = directRoomPlaceholder(navigator);
    render(<RoomPanel room={room} directAgent={navigator} agents={[navigator]} previews={[]} assistantPreviews={{}} reasoningPreviews={{}} busy={false} sendCommand={sendCommand} onToggleConsole={() => undefined} consoleOpen />);

    expect(screen.getByText("你与该 Agent 的单聊 · 延续 Agent 的全局上下文")).toBeTruthy();
    expect(screen.queryByLabelText("邀请 Agent")).toBeNull();
    expect(screen.queryByLabelText("归档房间")).toBeNull();
    expect(screen.queryByLabelText("修改房间名称")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("给 领航员 发送消息…"), { target: { value: "开始单聊" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(sendCommand).toHaveBeenCalledWith({ type: "send_direct_message", agentId: "navigator", content: "开始单聊", attachmentIds: [] });
  });

  it("单聊定时任务只绑定当前单聊房间和目标 Agent", async () => {
    const sendCommand = vi.fn(async () => true);
    const room = { ...directRoomPlaceholder(navigator), id: "direct_navigator" };
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      revision: 1,
      agents: [navigator, builder],
      rooms: [sharedRoom(), room],
      cronJobs: [],
      cronRuns: [],
      settings: { ...settings, baseUrl: "https://example.test/v1", apiKeyConfigured: false, usingMockModel: true },
    };

    render(<CronDrawer snapshot={snapshot} roomId={room.id} allowedAgentIds={[navigator.id]} busy={false} sendCommand={sendCommand} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    const agentSelect = screen.getByLabelText("执行 Agent") as HTMLSelectElement;
    expect([...agentSelect.options].map((option) => option.value)).toEqual([navigator.id]);
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));

    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: "create_cron", roomId: room.id, agentId: navigator.id })));
  });

  it("单聊尚未落库时不会误用共享房间配置定时任务", () => {
    const snapshot: WorkspaceSnapshot = {
      version: 1,
      revision: 1,
      agents: [navigator],
      rooms: [sharedRoom()],
      cronJobs: [],
      cronRuns: [],
      settings: { ...settings, baseUrl: "https://example.test/v1", apiKeyConfigured: false, usingMockModel: true },
    };
    const reason = "请先发送第一条单聊消息，创建单聊房间后即可配置定时任务。";

    render(<CronDrawer snapshot={snapshot} roomId="" allowedAgentIds={[navigator.id]} unavailableReason={reason} busy={false} sendCommand={async () => true} onClose={() => undefined} />);

    expect(screen.getByText(reason)).toBeTruthy();
    expect((screen.getByRole("button", { name: "创建任务" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
