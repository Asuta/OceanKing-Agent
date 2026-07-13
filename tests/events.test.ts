import { describe, expect, it } from "vitest";
import { eventsAfterId, eventsAfterRevision, publishWorkspaceEvent } from "@/lib/server/events";

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
});
