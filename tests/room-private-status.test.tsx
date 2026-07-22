// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentTurn, Room, RoomMessagePreview } from "@/lib/domain/types";
import type { ReasoningPreview } from "@/components/workspace/live-assistant-preview";
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
    kind: "shared",
    directAgentId: null,
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
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

const sendCommand = vi.fn(async () => true);

function panel(room: Room, assistantPreviews: Record<string, string>, previews: RoomMessagePreview[] = [], reasoningPreviews: Record<string, ReasoningPreview> = {}) {
  return <RoomPanel room={room} agents={agents} previews={previews} assistantPreviews={assistantPreviews} reasoningPreviews={reasoningPreviews} busy={false} sendCommand={sendCommand} onToggleConsole={() => undefined} consoleOpen />;
}

describe("房间私有 Assistant 临时状态", () => {
  it("合并检查点与实时增量，并让卡片内部跟随最新内容", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "已经分析")]);
    const { rerender } = render(panel(room, { turn_a: "已经分析，正在查询资料" }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).toContain("已经分析，正在查询资料");
    expect(status.textContent?.match(/已经分析/g)).toHaveLength(1);
    expect(status.textContent).toContain("临时状态");

    const output = status.querySelector(".private-status-output") as HTMLDivElement;
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 420 });
    output.scrollTop = 0;
    rerender(panel(room, { turn_a: "已经分析，正在查询资料，并整理结果" }));
    expect(output.scrollTop).toBe(420);
    expect(status.textContent).toContain("并整理结果");
  });

  it("思考与临时正文只显示当前最新活动且没有步骤展开入口", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const thinking: ReasoningPreview = { steps: [
      { step: 0, content: "已经完成的旧思考", status: "completed" },
      { step: 1, content: "正在分析最新上下文", status: "streaming" },
    ], phase: "thinking" };
    const { rerender } = render(panel(room, {}, [], { turn_a: thinking }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).toContain("正在分析最新上下文");
    expect(status.textContent).not.toContain("已经完成的旧思考");
    expect(screen.queryByRole("button", { name: /思考步骤/ })).toBeNull();

    const answering: ReasoningPreview = { steps: thinking.steps.map((step) => ({ ...step, status: "answer_started" as const })), phase: "answering" };
    rerender(panel(room, { turn_a: "开始生成正文" }, [], { turn_a: answering }));
    expect(status.textContent).toContain("开始生成正文");
    expect(status.textContent).not.toContain("正在分析最新上下文");
    expect(screen.getByText("组织中")).toBeTruthy();
  });

  it("多次工具续轮只展示最新思考步骤的内容", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const reasoning: ReasoningPreview = { steps: [
      { step: 0, content: "第一次思考", status: "completed" },
      { step: 1, content: "工具返回后的第二次思考", status: "streaming" },
    ], phase: "thinking" };
    render(panel(room, {}, [], { turn_a: reasoning }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).not.toContain("第一次思考");
    expect(status.textContent).toContain("工具返回后的第二次思考");
  });

  it("长活动文本只保留最新尾部片段", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const longReasoning = `最早内容${"旧内容".repeat(100)}最新结论正在生成`;
    render(panel(room, {}, [], { turn_a: { steps: [{ step: 0, content: longReasoning, status: "streaming" }], phase: "thinking" } }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).not.toContain("最早内容");
    expect(status.textContent).toContain("最新结论正在生成");
  });

  it("工具处理阶段隐藏旧文本并显示单行状态", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "上一阶段正文")]);
    render(panel(room, { turn_a: "上一阶段正文" }, [], { turn_a: { steps: [{ step: 0, content: "上一阶段思考", status: "completed" }], phase: "working" } }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).toContain("正在处理工具结果…");
    expect(status.textContent).not.toContain("上一阶段正文");
    expect(status.querySelector(".private-status-output")?.classList.contains("single-line")).toBe(true);
  });

  it("分别归属并展示多个房间的运行状态", () => {
    const roomA = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const roomB = createRoom("room_b", [createTurn("turn_b", "room_b", "builder", "")]);
    const assistantPreviews = { turn_a: "只属于房间 A", turn_b: "只属于房间 B" };
    const reasoningPreviews: Record<string, ReasoningPreview> = {
      turn_a: { steps: [{ step: 0, content: "房间 A 的思考", status: "streaming" }], phase: "thinking" },
      turn_b: { steps: [{ step: 0, content: "房间 B 的思考", status: "streaming" }], phase: "thinking" },
    };
    const { rerender } = render(panel(roomA, assistantPreviews, [], reasoningPreviews));

    expect(screen.getByLabelText("领航员 私有执行状态").textContent).toContain("房间 A 的思考");
    expect(screen.getByLabelText("领航员 私有执行状态").textContent).not.toContain("只属于房间 A");
    expect(screen.queryByText("只属于房间 B")).toBeNull();
    expect(screen.getByText(/房间 A 的思考/)).toBeTruthy();
    expect(screen.queryByText(/房间 B 的思考/)).toBeNull();

    rerender(panel(roomB, assistantPreviews, [], reasoningPreviews));
    expect(screen.getByLabelText("执行者 私有执行状态").textContent).toContain("房间 B 的思考");
    expect(screen.getByLabelText("执行者 私有执行状态").textContent).not.toContain("只属于房间 B");
    expect(screen.queryByText("只属于房间 A")).toBeNull();
    expect(screen.getByText(/房间 B 的思考/)).toBeTruthy();
    expect(screen.queryByText(/房间 A 的思考/)).toBeNull();
  });

  it("正式公开流开始后将同一 Turn 的临时卡片缩成一行", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "私有准备内容")]);
    const publicPreview: RoomMessagePreview = { turnId: "turn_a", roomId: "room_a", agentId: "navigator", messageKey: "public_a", content: "正式公开内容", kind: "notify" };
    const answering: ReasoningPreview = { steps: [{ step: 0, content: "公开正文前的思考", status: "answer_started" }], phase: "answering" };
    const { rerender } = render(panel(room, { turn_a: "私有准备内容仍在生成" }, [publicPreview], { turn_a: answering }));

    const privateStatus = screen.getByLabelText("领航员 私有执行状态");
    expect(privateStatus.textContent).toContain("正在生成公开回复…");
    expect(privateStatus.textContent).not.toContain("私有准备内容仍在生成");
    expect(privateStatus.querySelector(".private-status-output")?.classList.contains("single-line")).toBe(true);
    expect(screen.getByLabelText("Agent 正在生成公开回复").textContent).toContain("正式公开内容");
    expect(screen.getByLabelText("Agent 正在生成公开回复").textContent).toContain("过程");
    expect(screen.queryByText(/公开正文前的思考/)).toBeNull();

    rerender(panel(room, { turn_a: "私有准备内容仍在生成" }, [{ ...publicPreview, kind: "handoff" }], { turn_a: answering }));
    expect(screen.getByLabelText("Agent 正在生成公开回复").textContent).toContain("结束");

    const resumed: ReasoningPreview = { steps: [
      { ...answering.steps[0]!, status: "completed" },
      { step: 1, content: "进度消息后的新思考", status: "streaming" },
    ], phase: "thinking" };
    rerender(panel(room, { turn_a: "私有准备内容仍在生成" }, [publicPreview], { turn_a: resumed }));
    expect(privateStatus.textContent).toContain("进度消息后的新思考");
    expect(privateStatus.querySelector(".private-status-output")?.classList.contains("single-line")).toBe(false);
  });

  it("Turn 仍在运行时不因已经提交过公开消息而隐藏临时状态", () => {
    const turn = createTurn("turn_a", "room_a", "navigator", "私有准备内容");
    turn.emittedMessageIds = ["message_public"];
    render(panel(createRoom("room_a", [turn]), { turn_a: "提交后继续生成的私有内容" }, [], { turn_a: { steps: [{ step: 1, content: "提交后的后续思考", status: "streaming" }], phase: "thinking" } }));

    const status = screen.getByLabelText("领航员 私有执行状态");
    expect(status.textContent).toContain("提交后的后续思考");
    expect(status.textContent).not.toContain("提交后继续生成的私有内容");
  });

  it("向其他房间发送公开消息时仍保留源房间的思考状态", () => {
    const room = createRoom("room_a", [createTurn("turn_a", "room_a", "navigator", "")]);
    const crossRoomPreview: RoomMessagePreview = { turnId: "turn_a", roomId: "room_b", agentId: "navigator", messageKey: "public_b", content: "发往房间 B 的进度", kind: "notify" };
    render(panel(room, {}, [crossRoomPreview], { turn_a: { steps: [{ step: 1, content: "源房间继续思考", status: "streaming" }], phase: "thinking" } }));

    expect(screen.getByLabelText("领航员 私有执行状态")).toBeTruthy();
    expect(screen.getByText(/源房间继续思考/)).toBeTruthy();
    expect(screen.queryByLabelText("Agent 正在生成公开回复")).toBeNull();
  });

  it("Turn 结束后不再显示临时内容", () => {
    const completed = createTurn("turn_done", "room_a", "navigator", "已经完成", "completed");
    render(panel(createRoom("room_a", [completed]), { turn_done: "已经完成但不应保留" }, [], { turn_done: { steps: [{ step: 0, content: "完成后不保留的思考", status: "completed" }], phase: "working" } }));

    expect(screen.queryByLabelText("领航员 私有执行状态")).toBeNull();
    expect(screen.queryByText("已经完成但不应保留")).toBeNull();
    expect(screen.queryByText(/完成后不保留的思考/)).toBeNull();
  });

  it("尚无正文时仍显示等待状态", () => {
    render(panel(createRoom("room_a", [createTurn("turn_waiting", "room_a", "navigator", "")]), {}));

    expect(within(screen.getByLabelText("领航员 私有执行状态")).getByText("正在等待 Assistant 输出…")).toBeTruthy();
  });
});
