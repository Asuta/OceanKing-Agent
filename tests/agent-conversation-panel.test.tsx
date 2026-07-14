// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationHistory, WorkspaceSnapshot } from "@/lib/domain/types";
import { AgentConversationPanel } from "@/components/workspace/agent-conversation-panel";
import { getAgentHistoryVersion } from "@/components/workspace/workspace-shell";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agent 全局底层对话面板", () => {
  it("按时间连续展示全部 Turn 的输入、推理、命令及实际工具结果", async () => {
    const createdAt = "2026-07-13T10:00:00.000Z";
    const history: AgentConversationHistory = {
      agent: { id: "navigator", label: "领航员", summary: "协调任务" },
      turns: [{
        id: "turn_one", roomId: "room_one", roomTitle: "测试房间", agentId: "navigator", agentParticipantId: "participant_one",
        userEnvelope: { type: "scheduler_packet", room: { id: "room_one", title: "测试房间" }, targetMessageId: "message_one", cutoffSeq: 1, sender: { id: "human", name: "你" }, messages: [{ id: "message_one", seq: 1, content: "请检查记录", source: "user", kind: "user_input", attachments: [] }], connectedRooms: [], availableAgents: [] },
        anchorMessageId: "message_one", assistantContent: "检查完成", systemPrompt: "先调查，再回答", emittedMessageIds: [], status: "completed", modelMeta: { format: "chat_completions" }, error: null, createdAt, updatedAt: createdAt, timeline: [],
        messages: [
          { role: "user", content: "底层输入正文" },
          { role: "assistant", content: null, reasoning_content: "先读取历史", tool_calls: [{ id: "call_one", type: "function", function: { name: "read_room_history", arguments: "{\"roomId\":\"room_one\"}" } }] },
          { role: "tool", tool_call_id: "call_one", content: "模型收到的工具返回" },
          { role: "assistant", content: "检查完成" },
        ],
        tools: [{ id: "tool_one", turnId: "turn_one", name: "read_room_history", input: { roomId: "room_one" }, outputText: "实际执行完成", structuredResult: {}, status: "completed", durationMs: 12, error: null, createdAt }],
      }, {
        id: "turn_older", roomId: "room_older", roomTitle: "更早的房间", agentId: "navigator", agentParticipantId: "participant_older",
        userEnvelope: { type: "scheduler_packet", room: { id: "room_older", title: "更早的房间" }, targetMessageId: "message_older", cutoffSeq: 1, sender: { id: "human", name: "你" }, messages: [{ id: "message_older", seq: 1, content: "更早的输入", source: "user", kind: "user_input", attachments: [] }], connectedRooms: [], availableAgents: [] },
        anchorMessageId: "message_older", assistantContent: "更早的回复", systemPrompt: "更早的 System", emittedMessageIds: [], status: "completed", modelMeta: { format: "responses" }, error: null,
        createdAt: "2026-07-13T09:00:00.000Z", updatedAt: "2026-07-13T09:00:00.000Z", timeline: [], tools: [], messages: [{ role: "user", content: "更早的模型输入" }, { role: "assistant", content: "更早的回复" }],
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(history), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { container, rerender } = render(<AgentConversationPanel agentId="navigator" historyVersion="navigator-v1" />);

    expect(await screen.findByText("请检查记录")).toBeTruthy();
    expect(screen.getByText("更早的输入")).toBeTruthy();
    expect(screen.getByText("先读取历史")).toBeTruthy();
    const toolReturn = screen.getByRole("group", { name: "工具返回 call_one" }) as HTMLDetailsElement;
    const toolReturnToggle = toolReturn.querySelector("summary");
    expect(toolReturn.open).toBe(false);
    expect(toolReturnToggle).toBeTruthy();
    fireEvent.click(toolReturnToggle!);
    expect(toolReturn.open).toBe(true);
    expect(screen.getByText("模型收到的工具返回")).toBeTruthy();
    fireEvent.click(toolReturnToggle!);
    expect(toolReturn.open).toBe(false);
    expect(screen.getByText("先调查，再回答")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "选择 Agent Turn" })).toBeNull();
    expect([...container.querySelectorAll("[data-turn-id]")].map((element) => element.getAttribute("data-turn-id"))).toEqual(["turn_older", "turn_one"]);
    fireEvent.click(screen.getByRole("button", { name: "查看工具执行 read_room_history tool_one" }));
    expect(screen.getByText("实际执行完成")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/navigator/conversation", expect.objectContaining({ cache: "no-store" }));

    rerender(<AgentConversationPanel agentId="navigator" historyVersion="navigator-v1" />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(<AgentConversationPanel agentId="navigator" historyVersion="navigator-v2" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("无关工作区变更不会改变选中 Agent 的历史版本", () => {
    const selectedTurn = { agentId: "navigator", updatedAt: "2026-07-13T10:00:00.000Z" };
    const otherTurn = { agentId: "builder", updatedAt: "2026-07-13T11:00:00.000Z" };
    const snapshot = {
      revision: 1,
      agents: [{ id: "navigator", updatedAt: "2026-07-13T09:00:00.000Z" }, { id: "builder", updatedAt: "2026-07-13T09:00:00.000Z" }],
      rooms: [{ id: "room_one", title: "房间一", turns: [selectedTurn] }],
    } as unknown as WorkspaceSnapshot;
    const initialVersion = getAgentHistoryVersion(snapshot, "navigator");
    const unrelatedChange = {
      ...snapshot,
      revision: 2,
      rooms: [...snapshot.rooms, { ...snapshot.rooms[0]!, id: "room_two", title: "其他 Agent 房间", turns: [otherTurn as typeof snapshot.rooms[number]["turns"][number]] }],
    };

    expect(getAgentHistoryVersion(unrelatedChange, "navigator")).toBe(initialVersion);
    expect(getAgentHistoryVersion({ ...snapshot, rooms: [{ ...snapshot.rooms[0]!, turns: [{ ...snapshot.rooms[0]!.turns[0]!, updatedAt: "2026-07-13T12:00:00.000Z" }] }] }, "navigator")).not.toBe(initialVersion);
  });
});
