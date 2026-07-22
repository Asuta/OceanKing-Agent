// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomPanel } from "@/components/workspace/room-panel";
import type { Agent, Room, RoomMessage } from "@/lib/domain/types";

const createdAt = "2026-07-22T10:00:00.000Z";
const agents = [
  { id: "navigator", label: "领航员", summary: "负责协调" },
  { id: "builder", label: "执行者", summary: "负责执行" },
] as Agent[];
const sendCommand = vi.fn(async () => true);

function rectangle(top: number, height: number): DOMRect {
  return { x: 0, y: top, width: 600, height, top, right: 600, bottom: top + height, left: 0, toJSON: () => ({}) } as DOMRect;
}

function mockScrollGeometry(messageTops: Record<string, number>, scrollHeight = 1_000): { reads: () => number; reset: () => void } {
  let messageRectReads = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("message-scroll") ? scrollHeight : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() { return (this as HTMLElement).classList.contains("message-scroll") ? 300 : 0; },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("message-scroll")) return rectangle(0, 300);
    const messageId = this.dataset.messageId;
    const scroller = this.closest(".message-scroll") as HTMLDivElement | null;
    if (messageId) messageRectReads += 1;
    const top = messageId ? (messageTops[messageId] ?? 0) - (scroller?.scrollTop ?? 0) : 0;
    return rectangle(top, messageId ? 40 : 0);
  });
  return { reads: () => messageRectReads, reset: () => { messageRectReads = 0; } };
}

function message(id: string, roomId: string, seq: number): RoomMessage {
  return {
    id,
    roomId,
    seq,
    sender: { id: "human", name: "你", role: "participant" },
    source: "user",
    kind: "user_input",
    status: "completed",
    content: id,
    attachments: [],
    receipts: [],
    final: true,
    messageKey: null,
    createdAt,
  };
}

function room(id: string, messages: RoomMessage[], directAgentId: string | null = null): Room {
  const agentId = directAgentId ?? "navigator";
  return {
    id,
    title: directAgentId ? `${agents.find((agent) => agent.id === directAgentId)?.label} · 单聊` : id,
    kind: directAgentId ? "direct" : "shared",
    directAgentId,
    ownerParticipantId: `human_${id}`,
    participants: [
      { id: `human_${id}`, roomId: id, kind: "human", agentId: null, displayName: "你", enabled: true, sortOrder: 0, createdAt },
      { id: `agent_${id}`, roomId: id, kind: "agent", agentId, displayName: agents.find((agent) => agent.id === agentId)?.label ?? "Agent", enabled: true, sortOrder: 1, createdAt },
    ],
    messages,
    turns: [],
    scheduler: { roomId: id, status: "idle", nextAgentParticipantId: `agent_${id}`, activeParticipantId: null, roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
    archivedAt: null,
    pinnedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function panel(value: Room) {
  return <RoomPanel room={value} agents={agents} previews={[]} assistantPreviews={{}} reasoningPreviews={{}} busy={false} sendCommand={sendCommand} onToggleConsole={() => undefined} consoleOpen />;
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

describe("聊天阅读位置", () => {
  it("滚动热路径使用二分锚点查找并延迟会话存储写入", async () => {
    const messages = Array.from({ length: 128 }, (_, index) => message(`message_${index}`, "room_large", index + 1));
    const geometry = mockScrollGeometry(Object.fromEntries(messages.map((entry, index) => [entry.id, (index + 1) * 70])), 10_000);
    const storageWrite = vi.spyOn(Storage.prototype, "setItem");
    const mounted = render(panel(room("room_large", messages)));
    const scroller = mounted.container.querySelector(".message-scroll") as HTMLDivElement;

    await waitFor(() => expect(scroller.scrollTop).toBe(10_000));
    geometry.reset();
    storageWrite.mockClear();
    scroller.scrollTop = 8_500;
    fireEvent.scroll(scroller);

    expect(geometry.reads()).toBeLessThanOrEqual(9);
    expect(storageWrite).not.toHaveBeenCalled();
    mounted.unmount();
    expect(storageWrite).toHaveBeenCalledTimes(1);
  });

  it("首次进入定位最新，刷新后恢复历史锚点并提示离开期间的新消息", async () => {
    mockScrollGeometry({ message_a: 120, message_a_new: 800 });
    const initialRoom = room("room_a", [message("message_a", "room_a", 1)]);
    const mounted = render(panel(initialRoom));
    const scroller = mounted.container.querySelector(".message-scroll") as HTMLDivElement;

    await waitFor(() => expect(scroller.scrollTop).toBe(1_000));
    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "回到最新消息" })).toBeTruthy();

    mounted.unmount();
    const updatedRoom = room("room_a", [message("message_a", "room_a", 1), message("message_a_new", "room_a", 2)]);
    const reloaded = render(panel(updatedRoom));
    const restoredScroller = reloaded.container.querySelector(".message-scroll") as HTMLDivElement;

    await waitFor(() => expect(restoredScroller.scrollTop).toBe(100));
    const latestButton = screen.getByRole("button", { name: "1 条新消息，回到最新" });
    expect(latestButton.textContent).toContain("1 条新消息");
    fireEvent.click(latestButton);
    expect(restoredScroller.scrollTop).toBe(1_000);
    expect(screen.queryByRole("button", { name: /回到最新/ })).toBeNull();
  });

  it("不同 Agent 单聊分别恢复各自的阅读位置", async () => {
    mockScrollGeometry({ message_navigator: 100, message_builder: 300 });
    const navigatorRoom = room("direct_navigator", [message("message_navigator", "direct_navigator", 1)], "navigator");
    const builderRoom = room("direct_builder", [message("message_builder", "direct_builder", 1)], "builder");
    const mounted = render(panel(navigatorRoom));
    const scroller = mounted.container.querySelector(".message-scroll") as HTMLDivElement;

    await waitFor(() => expect(scroller.scrollTop).toBe(1_000));
    scroller.scrollTop = 80;
    fireEvent.scroll(scroller);

    mounted.rerender(panel(builderRoom));
    await waitFor(() => expect(scroller.scrollTop).toBe(1_000));
    scroller.scrollTop = 260;
    fireEvent.scroll(scroller);

    mounted.rerender(panel(navigatorRoom));
    await waitFor(() => expect(scroller.scrollTop).toBe(80));
    mounted.rerender(panel(builderRoom));
    await waitFor(() => expect(scroller.scrollTop).toBe(260));
  });
});
