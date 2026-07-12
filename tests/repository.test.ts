import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSessionMessage, TurnEffect } from "@/lib/domain/types";
import { createDatabase } from "@/lib/server/db/client";
import { VersionConflictError, WorkspaceRepository } from "@/lib/server/repository";
import { commandBase, packetFor, sendUser, withRepository } from "./helpers";

describe("OceanKing 领域仓库", () => {
  it("种子状态包含房间、Agent 与独立 scheduler", async () => withRepository((repository) => {
    const snapshot = repository.getSnapshot();
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["navigator", "builder"]);
    expect(snapshot.rooms[0]?.scheduler.status).toBe("idle");
    expect(snapshot.rooms[0]?.messages[0]?.source).toBe("system");
  }));

  it("普通 assistant 文本只保存到 Console，不产生公开房间消息", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "/private 只做内部分析"); const packet = packetFor(repository); const before = repository.getRoom("room_harbor")!.messages.length;
    repository.beginTurn({ turnId: "turn_private", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_private", assistantContent: "这段内容只能在 Console 中看到", tools: [], timeline: [], effects: [], modelMeta: { format: "mock" }, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    const room = repository.getRoom("room_harbor")!;
    expect(room.messages).toHaveLength(before);
    expect(room.turns.at(-1)?.assistantContent).toContain("Console");
    expect(room.turns.at(-1)?.emittedMessageIds).toEqual([]);
  }));

  it("相同 messageKey 重放只保留一条正式消息", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "请公开回复"); const packet = packetFor(repository);
    const effect: TurnEffect = { type: "send_message", roomId: "room_harbor", messageId: "msg_emit_one", messageKey: "call-stable", content: "正式结论", kind: "answer" };
    for (const turnId of ["turn_emit_1", "turn_emit_2"]) {
      repository.beginTurn({ turnId, roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
      repository.finishTurn({ turnId, assistantContent: "internal", tools: [], timeline: [], effects: [effect], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    }
    expect(repository.getRoom("room_harbor")!.messages.filter((message) => message.messageKey === "call-stable")).toHaveLength(1);
  }));

  it("同一 Agent 可向另一个已连接房间精确投递", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "房间 B", agentId: "navigator" });
    const roomB = repository.getSnapshot().rooms.find((room) => room.title === "房间 B")!;
    sendUser(repository, "room_harbor", "把结果发到 B"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_cross", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_cross", assistantContent: "internal", tools: [], timeline: [], effects: [{ type: "send_message", roomId: roomB.id, messageId: "msg_to_b", messageKey: "to-b", content: "只在 B 出现", kind: "answer" }], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    expect(repository.getRoom(roomB.id)!.messages.some((message) => message.id === "msg_to_b")).toBe(true);
    expect(repository.getRoom("room_harbor")!.messages.some((message) => message.id === "msg_to_b")).toBe(false);
  }));

  it("无需回复通过 receipt 表达而不创建空气泡", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "已阅即可，无需回复"); const packet = packetFor(repository); const before = repository.getRoom("room_harbor")!.messages.length;
    repository.beginTurn({ turnId: "turn_receipt", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_receipt", assistantContent: "已判断无需回复", tools: [], timeline: [], effects: [{ type: "read_no_reply", roomId: "room_harbor", messageId: packet.targetMessageId, receiptId: "receipt_one" }], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    const room = repository.getRoom("room_harbor")!;
    expect(room.messages).toHaveLength(before);
    expect(room.messages.at(-1)?.receipts[0]?.agentParticipantId).toBe("participant_navigator_harbor");
  }));

  it("turn 执行中出现新消息会标记 superseded 且不覆盖新状态", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "第一条"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_superseded", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    sendUser(repository, "room_harbor", "执行期间的新消息");
    const result = repository.finishTurn({ turnId: "turn_superseded", assistantContent: "旧快照结果", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    expect(result.superseded).toBe(true);
    expect(repository.getRoom("room_harbor")!.messages.at(-1)?.content).toBe("执行期间的新消息");
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === "turn_superseded")?.status).toBe("continued");
  }));

  it("过期版本写入被拒绝且既有消息不丢失", async () => withRepository((repository) => {
    const stale = repository.getVersion().version; sendUser(repository, "room_harbor", "服务端新消息");
    expect(() => repository.executeCommand({ commandId: crypto.randomUUID(), expectedVersion: stale, type: "rename_room", roomId: "room_harbor", title: "过期写入" })).toThrow(VersionConflictError);
    expect(repository.getRoom("room_harbor")!.messages.some((message) => message.content === "服务端新消息")).toBe(true);
  }));

  it("停止与进程恢复会把 running turn 收敛到明确状态", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "长任务"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_recovery", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    expect(repository.recoverInterruptedRuns()).toContain("room_harbor");
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === "turn_recovery")?.status).toBe("error");
    expect(repository.getRoom("room_harbor")!.scheduler.status).toBe("idle");
  }));

  it("Cron 输入复用房间消息 seq 与正式持久化链路", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_cron", roomId: "room_harbor", agentId: "navigator", name: "测试 Cron", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "检查未完成事项" });
    const job = repository.getSnapshot().cronJobs[0]!; const beforeSeq = repository.getRoom("room_harbor")!.messages.at(-1)!.seq;
    const run = repository.appendCronMessage(job.id); const message = repository.getRoom("room_harbor")!.messages.at(-1)!;
    expect(message.seq).toBe(beforeSeq + 1); expect(message.sender.id).toBe(`cron:${job.id}`); expect(message.source).toBe("system"); expect(run.messageId).toBe(message.id);
  }));

  it("每个 Agent 参与者拥有独立调度游标", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: "room_harbor", agentId: "builder" });
    sendUser(repository, "room_harbor", "游标测试"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_cursor", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_cursor", assistantContent: "done", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
    const room = repository.getRoom("room_harbor")!; const builder = room.participants.find((participant) => participant.agentId === "builder")!;
    expect(room.scheduler.cursorByParticipantId.participant_navigator_harbor).toBe(packet.cutoffSeq);
    expect(room.scheduler.cursorByParticipantId[builder.id] ?? 0).toBe(0);
  }));

  it("全局模型选择会被所有 Agent 与工作流共同读取", async () => withRepository((repository) => {
    repository.executeCommand({
      ...commandBase(repository), type: "update_settings", model: "deepseek-v4-flash", availableModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
      apiFormat: "chat_completions", thinkingMode: "enabled", reasoningEffort: "max", maxToolSteps: 12, maxRoomRounds: 32, projectContextRoots: [],
    });
    const snapshot = repository.getSnapshot();
    expect(snapshot.settings.model).toBe("deepseek-v4-flash");
    expect(snapshot.settings.availableModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(snapshot.agents.every((agent) => agent.settings.model === "deepseek-v4-flash")).toBe(true);
    expect(repository.getAgent("navigator")?.settings).toMatchObject({ model: "deepseek-v4-flash", apiFormat: "chat_completions", thinkingMode: "enabled", reasoningEffort: "max" });
  }));

  it("旧设置缺少思考字段时自动补齐兼容默认值", async () => withRepository((repository) => {
    const snapshotSettings = repository.getSnapshot().settings;
    const legacy: Partial<typeof snapshotSettings> = { ...snapshotSettings };
    delete legacy.thinkingMode; delete legacy.reasoningEffort;
    repository.raw.prepare("UPDATE workspace_meta SET settings_json=? WHERE id=1").run(JSON.stringify(legacy));
    expect(repository.getSnapshot().settings).toMatchObject({ thinkingMode: "provider_default", reasoningEffort: "high" });
  }));

  it("会话历史按完整用户工具链裁剪，不拆散 assistant 与 tool 消息", async () => withRepository((repository) => {
    const history: AgentSessionMessage[] = Array.from({ length: 20 }, (_, index) => {
      const callId = `call_${index}`;
      return [
        { role: "user" as const, content: `user_${index}` },
        { role: "assistant" as const, content: null, reasoning_content: `reasoning_${index}`, tool_calls: [{ id: callId, type: "function" as const, function: { name: "read_room_history", arguments: "{}" } }] },
        { role: "tool" as const, tool_call_id: callId, content: `output_${index}` },
      ];
    }).flat();
    repository.raw.prepare("UPDATE agent_sessions SET history_json=? WHERE agent_id='navigator'").run(JSON.stringify(history));
    sendUser(repository, "room_harbor", "触发历史裁剪"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_trim_session", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_trim_session", assistantContent: "done", sessionMessages: [{ role: "user", content: "current_user" }, { role: "assistant", content: "done" }], tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    const trimmed = repository.getAgentSession("navigator");
    expect(trimmed.filter((message) => message.role === "user")).toHaveLength(20);
    expect(trimmed[0]).toEqual({ role: "user", content: "user_1" });
    for (let index = 0; index < trimmed.length; index += 1) {
      const message = trimmed[index];
      if (message?.role !== "tool") continue;
      const assistant = trimmed[index - 1];
      expect(assistant?.role).toBe("assistant");
      if (assistant?.role === "assistant") expect(assistant.tool_calls?.[0]?.id).toBe(message.tool_call_id);
    }
  }));

  it("超出会话字节预算时丢弃整个工具 Turn", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "超大工具结果"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_oversized_session", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({
      turnId: "turn_oversized_session", assistantContent: "done",
      sessionMessages: [
        { role: "user", content: "oversized_user" },
        { role: "assistant", content: null, reasoning_content: "reasoning", tool_calls: [{ id: "call_oversized", type: "function", function: { name: "workspace_read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_oversized", content: "x".repeat(600 * 1024) },
      ],
      tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null,
    });
    expect(repository.getAgentSession("navigator")).toEqual([]);
  }));

  it("附件元数据绑定到正式消息并可在重载快照中恢复", async () => withRepository((repository) => {
    const attachment = repository.registerAttachment({ id: "attachment_test", fileName: "notes.md", mimeType: "text/markdown", byteSize: 12, storagePath: "uploads/attachment_test-notes.md" });
    repository.executeCommand({ ...commandBase(repository), type: "send_message", roomId: "room_harbor", content: "包含附件", attachmentIds: [attachment.id] });
    expect(repository.getRoom("room_harbor")!.messages.at(-1)?.attachments[0]?.fileName).toBe("notes.md");
  }));

  it("关闭并重新打开 SQLite 后房间、消息和 seq 均可恢复", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-restart-"));
    try {
      const firstHandle = createDatabase(dir); const first = new WorkspaceRepository(firstHandle); sendUser(first, "room_harbor", "重启后仍在"); firstHandle.raw.close();
      const secondHandle = createDatabase(dir); const second = new WorkspaceRepository(secondHandle);
      expect(second.getRoom("room_harbor")!.messages.at(-1)?.content).toBe("重启后仍在");
      expect(second.getRoom("room_harbor")!.messages.at(-1)?.seq).toBe(2);
      secondHandle.raw.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
