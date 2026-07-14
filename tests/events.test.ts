import { describe, expect, it } from "vitest";
import { eventsAfterId, eventsAfterRevision, getWorkspaceEventCursor, publishWorkspaceEvent, resetWorkspaceEventHistory } from "@/lib/server/events";

describe("工作区 SSE 事件游标", () => {
  it("同一数据库 revision 的流式片段仍有独立递增 ID，并可从断点续传", () => {
    const revision = 42;
    const first = publishWorkspaceEvent("turn.preview", "turn_stream", { kind: "assistant_delta", delta: "第一段" }, revision);
    const second = publishWorkspaceEvent("turn.preview", "turn_stream", { kind: "assistant_delta", delta: "第二段" }, revision);

    expect(second.revision).toBe(first.revision);
    expect(second.id).toBeGreaterThan(first.id);
    expect(eventsAfterId(first.id)).toContainEqual(second);
    expect(eventsAfterRevision(first.revision)).not.toContainEqual(first);
  });

  it("首次连接使用事件游标补发快照之后产生的同 revision 事件", () => {
    const initialEventCursor = getWorkspaceEventCursor();
    const checkpoint = publishWorkspaceEvent("turn.preview", "turn_live", { kind: "history_checkpoint" }, 42);

    expect(checkpoint.id).toBeGreaterThan(initialEventCursor);
    expect(eventsAfterId(initialEventCursor)).toContainEqual(checkpoint);
  });

  it("工作台重置时清空旧的内存事件历史但保持事件 ID 单调递增", () => {
    const oldEvent = publishWorkspaceEvent("workspace.changed", "old_room", {}, 50);
    resetWorkspaceEventHistory();
    const resetEvent = publishWorkspaceEvent("workspace.changed", undefined, { commandType: "reset_workspace" }, 51);

    expect(resetEvent.id).toBeGreaterThan(oldEvent.id);
    expect(eventsAfterId(0)).toEqual([resetEvent]);
  });
});
