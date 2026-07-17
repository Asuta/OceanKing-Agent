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

function WorkspaceProbe() {
  const workspace = useWorkspace(snapshot, 99);
  const roomPreviews = Object.values(workspace.roomPreviews)
    .map((preview) => `${preview.roomId}:${preview.messageKey}:${preview.content}`)
    .sort()
    .join("|");
  return <>
    <output aria-label="Agent 历史检查点">{workspace.agentHistoryCheckpoints.turn_live ?? 0}</output>
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
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => FakeEventSource.latest?.emit("turn.preview", { id: 302, type: "turn.preview", entityId: "turn_stream", payload: { kind: "history_checkpoint" } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
