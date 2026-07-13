import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
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

  it("按 Agent 汇总跨房间底层输入、推理、回复与工具命令", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "分析港湾任务");
    const firstPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_agent_history_room", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: firstPacket });
    repository.finishTurn({
      turnId: "turn_agent_history_room",
      assistantContent: "已分析港湾任务",
      systemPrompt: "你是测试领航员",
      sessionMessages: [
        { role: "user", content: "完整输入" },
        { role: "assistant", content: null, reasoning_content: "先核对上下文", tool_calls: [{ id: "call_history", type: "function", function: { name: "read_room_history", arguments: "{\"roomId\":\"room_harbor\"}" } }] },
        { role: "tool", tool_call_id: "call_history", content: "历史读取完成" },
        { role: "assistant", content: "已分析港湾任务" },
      ],
      tools: [{ id: "tool_history", turnId: "turn_agent_history_room", name: "read_room_history", input: { roomId: "room_harbor" }, outputText: "历史读取完成", structuredResult: { count: 1 }, status: "completed", durationMs: 8, error: null, createdAt: new Date().toISOString() }],
      timeline: [], effects: [], modelMeta: { format: "chat_completions" }, cutoffSeq: firstPacket.cutoffSeq, nextParticipantId: null,
    });

    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "跨房间任务", agentId: "navigator" });
    const secondRoom = repository.getSnapshot().rooms.find((room) => room.title === "跨房间任务")!;
    repository.executeCommand({ ...commandBase(repository), type: "create_cron", roomId: secondRoom.id, agentId: "navigator", name: "历史审计 Cron", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "执行跨房间检查" });
    repository.appendCronMessage(repository.getSnapshot().cronJobs[0]!.id);
    const secondPacket = { ...packetFor(repository, secondRoom.id), type: "cron_packet" as const };
    const participant = secondRoom.participants.find((entry) => entry.agentId === "navigator")!;
    repository.beginTurn({ turnId: "turn_agent_history_cron", roomId: secondRoom.id, agentId: "navigator", agentParticipantId: participant.id, packet: secondPacket });
    repository.finishTurn({ turnId: "turn_agent_history_cron", assistantContent: "Cron 已处理", systemPrompt: "Cron system", sessionMessages: [{ role: "user", content: "Cron 输入" }, { role: "assistant", content: "Cron 已处理" }], tools: [], timeline: [], effects: [], modelMeta: { format: "responses" }, cutoffSeq: secondPacket.cutoffSeq, nextParticipantId: null });

    const history = repository.getAgentConversation("navigator")!;
    expect(history.agent).toMatchObject({ id: "navigator", label: "领航员" });
    expect(history.turns.map((turn) => turn.roomTitle)).toEqual(expect.arrayContaining(["港湾协作室", "跨房间任务"]));
    expect(history.turns.find((turn) => turn.id === "turn_agent_history_cron")?.userEnvelope.type).toBe("cron_packet");
    const roomTurn = history.turns.find((turn) => turn.id === "turn_agent_history_room")!;
    expect(roomTurn.systemPrompt).toBe("你是测试领航员");
    expect(roomTurn.messages[1]).toMatchObject({ role: "assistant", reasoning_content: "先核对上下文" });
    expect(roomTurn.tools[0]).toMatchObject({ name: "read_room_history", outputText: "历史读取完成" });
    expect(repository.getAgentConversation("missing-agent")).toBeNull();
  }));

  it("失败或停止前的回复与工具记录通过检查点保留，且检查点不推进工作区版本", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "执行后故意失败"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_failed_checkpoint", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    const versionBeforeCheckpoint = repository.getVersion();
    const messages: AgentSessionMessage[] = [
      { role: "user", content: "底层输入" },
      { role: "assistant", content: "先执行命令", tool_calls: [{ id: "call_before_failure", type: "function", function: { name: "read_room_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_before_failure", content: "已读取一条记录" },
    ];
    repository.checkpointTurn({
      turnId: "turn_failed_checkpoint",
      assistantContent: "先执行命令",
      systemPrompt: "测试 System",
      conversationMessages: messages,
      tools: [{ id: "call_before_failure", turnId: "turn_failed_checkpoint", name: "read_room_history", input: {}, outputText: "已读取一条记录", structuredResult: { count: 1 }, status: "completed", durationMs: 3, error: null, createdAt: new Date().toISOString() }],
      timeline: [{ id: "timeline_before_failure", turnId: "turn_failed_checkpoint", ordinal: 1, type: "tool_finished", payload: { id: "call_before_failure" }, createdAt: new Date().toISOString() }],
    });
    expect(repository.getVersion()).toEqual(versionBeforeCheckpoint);

    repository.failTurn("turn_failed_checkpoint", "用户已停止", true);
    const turn = repository.getAgentConversation("navigator")!.turns.find((entry) => entry.id === "turn_failed_checkpoint")!;
    expect(turn).toMatchObject({ status: "stopped", assistantContent: "先执行命令", systemPrompt: "测试 System" });
    expect(turn.messages).toEqual(messages);
    expect(turn.tools[0]).toMatchObject({ id: "call_before_failure", outputText: "已读取一条记录" });
    expect(turn.timeline[0]).toMatchObject({ id: "timeline_before_failure", type: "tool_finished" });
  }));

  it("上下文压缩只裁剪后续会话上下文，不裁剪 Turn 审计记录", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "压缩审计测试"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_compaction_audit", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    const compactedMessages: AgentSessionMessage[] = [{ role: "user", content: "压缩后的继续上下文" }, { role: "assistant", content: "最终回复" }];
    const auditMessages: AgentSessionMessage[] = [
      { role: "user", content: "原始模型输入" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_before_compaction", type: "function", function: { name: "read_room_history", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_before_compaction", content: "压缩前的工具结果" },
      ...compactedMessages,
    ];
    repository.finishTurn({
      turnId: "turn_compaction_audit", assistantContent: "最终回复", sessionMessages: compactedMessages, auditMessages,
      tools: [], timeline: [], effects: [], modelMeta: {}, contextCompaction: { summary: "压缩后的继续上下文", estimatedTokens: 100, compactedTokens: 10, threshold: 50, sourceEntries: 3 },
      cutoffSeq: packet.cutoffSeq, nextParticipantId: null,
    });

    expect(repository.getAgentSession("navigator")).toEqual(compactedMessages);
    expect(repository.getAgentConversation("navigator")!.turns.find((turn) => turn.id === "turn_compaction_audit")?.messages).toEqual(auditMessages);
  }));

  it("Agent 会话完整持久化，不再按固定条数截断", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "长期任务"); const packet = packetFor(repository);
    for (let index = 0; index < 25; index += 1) {
      const turnId = `turn_history_${index}`;
      repository.beginTurn({ turnId, roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
      repository.finishTurn({ turnId, assistantContent: `第 ${index} 轮结果`, tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    }
    expect(repository.getAgentSession("navigator")).toHaveLength(50);
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

  it("房间改名通过权威仓库持久化且保留房间内容", async () => withRepository((repository) => {
    const before = repository.getRoom("room_harbor")!;
    repository.executeCommand({ ...commandBase(repository), type: "rename_room", roomId: before.id, title: "产品讨论室" });
    const renamed = repository.getRoom(before.id)!;
    expect(renamed.title).toBe("产品讨论室");
    expect(renamed.messages.map((message) => message.id)).toEqual(before.messages.map((message) => message.id));
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
      apiFormat: "chat_completions", thinkingMode: "enabled", reasoningEffort: "max", contextTokenThreshold: 64_000, maxToolSteps: 12, maxRoomRounds: 32, projectContextRoots: [],
    });
    const snapshot = repository.getSnapshot();
    expect(snapshot.settings.model).toBe("deepseek-v4-flash");
    expect(snapshot.settings.availableModels).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    expect(snapshot.settings.contextTokenThreshold).toBe(64_000);
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

  it("会话历史完整保留 assistant 与 tool 消息", async () => withRepository((repository) => {
    const history: AgentSessionMessage[] = Array.from({ length: 20 }, (_, index) => {
      const callId = `call_${index}`;
      return [
        { role: "user" as const, content: `user_${index}` },
        { role: "assistant" as const, content: null, reasoning_content: `reasoning_${index}`, tool_calls: [{ id: callId, type: "function" as const, function: { name: "read_room_history", arguments: "{}" } }] },
        { role: "tool" as const, tool_call_id: callId, content: `output_${index}` },
      ];
    }).flat();
    repository.raw.prepare("UPDATE agent_sessions SET history_json=? WHERE agent_id='navigator'").run(JSON.stringify(history));
    sendUser(repository, "room_harbor", "追加一轮会话"); const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_trim_session", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_trim_session", assistantContent: "done", sessionMessages: [{ role: "user", content: "current_user" }, { role: "assistant", content: "done" }], tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    const session = repository.getAgentSession("navigator");
    expect(session.filter((message) => message.role === "user")).toHaveLength(21);
    expect(session[0]).toEqual({ role: "user", content: "user_0" });
    for (let index = 0; index < session.length; index += 1) {
      const message = session[index];
      if (message?.role !== "tool") continue;
      const assistant = session[index - 1];
      expect(assistant?.role).toBe("assistant");
      if (assistant?.role === "assistant") expect(assistant.tool_calls?.[0]?.id).toBe(message.tool_call_id);
    }
  }));

  it("超大会话工具结果仍完整保留", async () => withRepository((repository) => {
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
    const session = repository.getAgentSession("navigator");
    expect(session).toHaveLength(3);
    expect(session[2]).toMatchObject({ role: "tool", tool_call_id: "call_oversized" });
    expect(session[2]?.content).toHaveLength(600 * 1024);
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

  it("旧数据库启动时自动补齐 Turn 对话审计字段", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-agent-history-migration-"));
    try {
      const legacy = new Database(path.join(dir, "oceanking.db"));
      legacy.exec("CREATE TABLE agent_turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_participant_id TEXT NOT NULL, user_envelope_json TEXT NOT NULL, anchor_message_id TEXT, assistant_content TEXT NOT NULL, emitted_message_ids_json TEXT NOT NULL, status TEXT NOT NULL, model_meta_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.close();
      const handle = createDatabase(dir);
      const columns = (handle.raw.prepare("PRAGMA table_info(agent_turns)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["system_prompt", "conversation_json"]));
      handle.raw.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
