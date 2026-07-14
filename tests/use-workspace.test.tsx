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
  return <output aria-label="Agent 历史检查点">{workspace.agentHistoryCheckpoints.turn_live ?? 0}</output>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); FakeEventSource.latest = null; });

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
});
