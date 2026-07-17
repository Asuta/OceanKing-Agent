// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentTurn, Room, RoomMessagePreview } from "@/lib/domain/types";
import { RoomPanel } from "@/components/workspace/room-panel";

afterEach(cleanup);

const createdAt = "2026-07-17T10:00:00.000Z";
const agents = [
  { id: "navigator", label: "领航员", summary: "负责协调" },
  { id: "builder", label: "执行者", summary: "负责执行" },
] as Agent[];

function createTurn(id: string, roomId: string, agentId: string, assistantContent: string, status: AgentTurn["status"] = "running"): AgentTurn {
  return {
    id,
    roomId,
    agentId,
    agentParticipantId: `participant_${agentId}_${roomId}`,
    userEnvelope: {
      type: "scheduler_packet",
      room: { id: roomId, title: roomId },
      targetMessageId: `message_${id}`,
      cutoffSeq: 1,
      sender: { id: "human", name: "你" },
      messages: [{ id: `message_${id}`, seq: 1, content: "执行任务", source: "user", kind: "user_input", attachments: [] }],
      connectedRooms: [],
      availableAgents: [],
    },
    anchorMessageId: `message_${id}`,
    assistantContent,
    tools: [],
    emittedMessageIds: [],
    timeline: [],
    status,
    modelMeta: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function createRoom(id: string, turns: AgentTurn[]): Room {
  return {
    id,
    title: id === "room_a" ? "房间 A" : "房间 B",
    ownerParticipantId: `participant_navigator_${id}`,
    participants: [
      { id: "human", roomId: id, kind: "human", agentId: null, displayName: "你", enabled: true, sortOrder: 0, createdAt },
      { id: `participant_navigator_${id}`, roomId: id, kind: "agent", agentId: "navigator", displayName: "领航员", enabled: true, sortOrder: 1, createdAt },
      { id: `participant_builder_${id}`, roomId: id, kind: "agent", agentId: "builder", displayName: "执行者", enabled: true, sortOrder: 2, createdAt },
    ],
    messages: [],
    turns,
    scheduler: { roomId: id, status: turns.some((turn) => turn.status === "running") ? "running" : "idle", nextAgentParticipantId: null, activeParticipantId: turns.find((turn) => turn.status === "running")?.agentParticipantId ?? null, roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

const sendCommand = vi.fn(async () => true);

function panel(room: Room, assistantPreviews: Record<string, string>, previews: RoomMessagePreview[] = []) {
  return <RoomPanel room={room} agents={agents} previews={previews} assistantPreviews={assistantPreviews} busy={false} sendCommand={sendCommand} onToggleConsole={() => undefined} consoleOpen />;
}

describe("房间私有 Assistant 临时状态", () => {
  it("合并检查点与实时增量，并让卡片内部跟随最新内容", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "已经分析")]);
    const { rerender } = render(panel(room, { turn_a: "已经分析，正在查询资料" }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).toContain("已经分析，正在查询资料");
    expect(status.textContent?.match(/已经分析/g)).toHaveLength(1);
    expect(status.textContent).toContain("不写入房间历史");

    const output = status.querySelector(".private-status-output") as HTMLDivElement;
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 420 });
    output.scrollTop = 0;
    rerender(panel(room, { turn_a: "已经分析，正在查询资料，并整理结果" }));
    expect(output.scrollTop).toBe(420);
    expect(status.textContent).toContain("并整理结果");
  });

  it("分别归属并展示多个房间的运行状态", () => {
    const roomA = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const roomB = createRoom("room_b", [createTurn("turn_b", "room_b", "builder", "")]);
    const assistantPreviews = { turn_a: "只属于房间 A", turn_b: "只属于房间 B" };
    const { rerender } = render(panel(roomA, assistantPreviews));

    expect(screen.getByLabelText("领航员 私有执行状态").textContent).toContain("只属于房间 A");
    expect(screen.queryByText("只属于房间 B")).toBeNull();

    rerender(panel(roomB, assistantPreviews));
    expect(screen.getByLabelText("执行者 私有执行状态").textContent).toContain("只属于房间 B");
    expect(screen.queryByText("只属于房间 A")).toBeNull();
  });

  it("正式公开流开始后隐藏同一 Turn 的私有卡片", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "私有准备内容")]);
    const publicPreview: RoomMessagePreview = { turnId: "turn_a", roomId: "room_b", agentId: "navigator", messageKey: "public_b", content: "正式公开内容", kind: "answer" };
    render(panel(room, { turn_a: "私有准备内容仍在生成" }, [publicPreview]));

    expect(screen.queryByLabelText("领航员 私有执行状态")).toBeNull();
    expect(screen.queryByText("私有准备内容仍在生成")).toBeNull();
  });

  it("公开消息提交并清理预览后仍保持隐藏", () => {
    const turn = createTurn("turn_a", "room_a", "navigator", "私有准备内容");
    turn.emittedMessageIds = ["message_public"];
    render(panel(createRoom("room_a", [turn]), { turn_a: "提交后继续生成的私有内容" }));

    expect(screen.queryByLabelText("领航员 私有执行状态")).toBeNull();
    expect(screen.queryByText("提交后继续生成的私有内容")).toBeNull();
  });

  it("Turn 结束后不再显示临时内容", () => {
    const completed = createTurn("turn_done", "room_a", "navigator", "已经完成", "completed");
    render(panel(createRoom("room_a", [completed]), { turn_done: "已经完成但不应保留" }));

    expect(screen.queryByLabelText("领航员 私有执行状态")).toBeNull();
    expect(screen.queryByText("已经完成但不应保留")).toBeNull();
  });

  it("尚无正文时仍显示等待状态", () => {
    render(panel(createRoom("room_a", [createTurn("turn_waiting", "room_a", "navigator", "")]), {}));

    expect(within(screen.getByLabelText("领航员 私有执行状态")).getByText("正在等待 Assistant 输出…")).toBeTruthy();
  });
});
