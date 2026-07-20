// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "@/components/workspace/use-workspace";
import type { WorkspaceSnapshot } from "@/lib/domain/types";

const snapshot: WorkspaceSnapshot = {
  version: 1,
  revision: 7,
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

const runningSnapshot: WorkspaceSnapshot = {
  ...snapshot,
  rooms: [{
    id: "room_live",
    title: "实时房间",
    ownerParticipantId: null,
    participants: [],
    messages: [],
    turns: [{
      id: "turn_live",
      roomId: "room_live",
      agentId: "navigator",
      agentParticipantId: "participant_navigator",
      userEnvelope: {
        type: "scheduler_packet",
        room: { id: "room_live", title: "实时房间" },
        targetMessageId: "message_live",
        cutoffSeq: 1,
        sender: { id: "human", name: "你" },
        messages: [{ id: "message_live", seq: 1, content: "继续检查", source: "user", kind: "user_input", attachments: [] }],
        connectedRooms: [],
        availableAgents: [],
      },
      anchorMessageId: "message_live",
      assistantContent: "先检查配置",
      tools: [],
      emittedMessageIds: [],
      timeline: [],
      status: "running",
      modelMeta: null,
      error: null,
      createdAt: "2026-07-17T10:00:00.000Z",
      updatedAt: "2026-07-17T10:00:00.000Z",
    }],
    scheduler: { roomId: "room_live", status: "running", nextAgentParticipantId: null, activeParticipantId: "participant_navigator", roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
    archivedAt: null,
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:00:00.000Z",
  }],
};

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  readonly listeners = new Map<string, Set<EventListener>>();
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) { FakeEventSource.latest = this; }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener); this.listeners.set(type, listeners);
  }

  close() { /* test double */ }

  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function WorkspaceProbe({ initialSnapshot = snapshot }: { initialSnapshot?: WorkspaceSnapshot }) {
  const workspace = useWorkspace(initialSnapshot, 99);
  const roomPreviews = Object.values(workspace.roomPreviews)
    .map((preview) => `${preview.roomId}:${preview.messageKey}:${preview.content}`)
    .sort()
    .join("|");
  return <>
    <output aria-label="Agent 历史检查点">{workspace.agentHistoryCheckpoints.turn_live ?? 0}</output>
    <output aria-label="Assistant 实时预览">{workspace.previews.turn_live ?? ""}</output>
    <output aria-label="Assistant 思考预览">{JSON.stringify(workspace.reasoningPreviews.turn_live?.steps ?? [])}</output>
    <output aria-label="Assistant 实时阶段">{workspace.reasoningPreviews.turn_live?.phase ?? ""}</output>
    <output aria-label="房间消息预览">{roomPreviews}</output>
  </>;
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); FakeEventSource.latest = null; });

describe("工作区实时事件", () => {
  it("将运行中历史检查点事件转换为对应 Turn 的刷新版本", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } })));
    render(<WorkspaceProbe />);

    expect(FakeEventSource.latest?.url).toBe("/api/events?afterId=99");
    act(() => FakeEventSource.latest?.emit("turn.preview", {
      id: 101,
      type: "turn.preview",
      entityId: "turn_live",
      payload: { kind: "history_checkpoint" },
    }));

    expect(screen.getByLabelText("Agent 历史检查点").textContent).toBe("101");
  });

  it("从当前快照正文开始累积增量并保留合法重复文字", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(runningSnapshot), { status: 200, headers: { "content-type": "application/json" } })));
    render(<WorkspaceProbe initialSnapshot={runningSnapshot} />);

    act(() => {
      FakeEventSource.latest?.emit("turn.preview", {
        id: 151,
        type: "turn.preview",
        entityId: "turn_live",
        payload: { kind: "assistant_delta", delta: "配置仍然有效" },
      });
      FakeEventSource.latest?.emit("turn.preview", {
        id: 152,
        type: "turn.preview",
        entityId: "turn_live",
        payload: { kind: "assistant_delta", delta: "，继续执行" },
      });
    });

    expect(screen.getByLabelText("Assistant 实时预览").textContent).toBe("先检查配置配置仍然有效，继续执行");
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("answering");
  });

  it("按模型步骤累积思考增量，并在正文和检查点到达时更新阶段", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(runningSnapshot), { status: 200, headers: { "content-type": "application/json" } })));
    render(<WorkspaceProbe initialSnapshot={runningSnapshot} />);

    act(() => {
      FakeEventSource.latest?.emit("turn.preview", { id: 161, type: "turn.preview", entityId: "turn_live", payload: { kind: "reasoning_delta", step: 0, delta: "先分析" } });
      FakeEventSource.latest?.emit("turn.preview", { id: 162, type: "turn.preview", entityId: "turn_live", payload: { kind: "reasoning_delta", step: 0, delta: "上下文" } });
    });
    expect(JSON.parse(screen.getByLabelText("Assistant 思考预览").textContent ?? "[]")).toEqual([
      { step: 0, content: "先分析上下文", status: "streaming" },
    ]);
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("thinking");

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 163, type: "turn.preview", entityId: "turn_live", payload: { kind: "assistant_delta", delta: "正文" } }));
    expect(JSON.parse(screen.getByLabelText("Assistant 思考预览").textContent ?? "[]")[0]).toMatchObject({ status: "answer_started" });
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("answering");

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 164, type: "turn.preview", entityId: "turn_live", payload: { kind: "history_checkpoint" } }));
    expect(JSON.parse(screen.getByLabelText("Assistant 思考预览").textContent ?? "[]")[0]).toMatchObject({ status: "completed" });
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("working");

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 165, type: "turn.preview", entityId: "turn_live", payload: { kind: "reasoning_delta", step: 1, delta: "工具后的思考" } }));
    expect(JSON.parse(screen.getByLabelText("Assistant 思考预览").textContent ?? "[]")).toEqual([
      { step: 0, content: "先分析上下文", status: "completed" },
      { step: 1, content: "工具后的思考", status: "streaming" },
    ]);
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("thinking");

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 166, type: "turn.preview", entityId: "turn_live", payload: { kind: "room_message_preview", roomId: "room_live", agentId: "navigator", messageKey: "progress_live", delta: "公开进度", messageKind: "progress" } }));
    expect(JSON.parse(screen.getByLabelText("Assistant 思考预览").textContent ?? "[]")[1]).toMatchObject({ status: "answer_started" });
    expect(screen.getByLabelText("Assistant 实时阶段").textContent).toBe("answering");
  });

  it("同一 Turn 的多个 send_message 预览按 messageKey 独立保存", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } })));
    render(<WorkspaceProbe />);

    act(() => {
      FakeEventSource.latest?.emit("turn.preview", {
        id: 201, type: "turn.preview", entityId: "turn_multi",
        payload: { kind: "room_message_preview", roomId: "room_a", agentId: "navigator", messageKey: "call_a", delta: "房间 A ", messageKind: "answer" },
      });
      FakeEventSource.latest?.emit("turn.preview", {
        id: 202, type: "turn.preview", entityId: "turn_multi",
        payload: { kind: "room_message_preview", roomId: "room_b", agentId: "navigator", messageKey: "call_b", delta: "房间 B 初稿", messageKind: "answer" },
      });
      FakeEventSource.latest?.emit("turn.preview", {
        id: 203, type: "turn.preview", entityId: "turn_multi",
        payload: { kind: "room_message_preview", roomId: "room_a", agentId: "navigator", messageKey: "call_a", delta: "更新", messageKind: "answer" },
      });
    });

    expect(screen.getByLabelText("房间消息预览").textContent).toBe("room_a:call_a:房间 A 更新|room_b:call_b:房间 B 初稿");
  });

  it("预览帧只更新本地状态而不重新拉取整份工作区", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WorkspaceProbe />);

    act(() => FakeEventSource.latest?.emit("turn.preview", {
      id: 301, type: "turn.preview", entityId: "turn_stream",
      payload: { kind: "room_message_preview", roomId: "room_a", agentId: "navigator", messageKey: "call_stream", delta: "流式帧", messageKind: "answer" },
    }));
    act(() => FakeEventSource.latest?.emit("turn.preview", {
      id: 302, type: "turn.preview", entityId: "turn_stream",
      payload: { kind: "reasoning_delta", step: 0, delta: "思考帧" },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 303, type: "turn.preview", entityId: "turn_stream", payload: { kind: "history_checkpoint" } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
