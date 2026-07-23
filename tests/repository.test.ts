import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSessionMessage, ToolExecution, TurnEffect } from "@/lib/domain/types";
import { createDatabase } from "@/lib/server/db/client";
import { VersionConflictError, WorkspaceRepository } from "@/lib/server/repository";
import { commandBase, packetFor, sendUser, withRepository } from "./helpers";

describe("OceanKing 领域仓库", () => {
  it("种子状态包含房间、Agent 与独立 scheduler", async () => withRepository((repository) => {
    const snapshot = repository.getSnapshot();
    expect(snapshot.agents.map((agent) => agent.id)).toEqual(["navigator", "builder"]);
    expect(new Set(snapshot.agents.map((agent) => agent.summary))).toHaveProperty("size", 1);
    expect(new Set(snapshot.agents.map((agent) => agent.instruction))).toHaveProperty("size", 1);
    expect(snapshot.agents[0]?.instruction).toContain("平级协作 Agent");
    expect(snapshot.rooms[0]?.scheduler.status).toBe("idle");
    expect(snapshot.rooms[0]?.messages[0]?.source).toBe("system");
  }));

  it("房间按最近置顶顺序排列，取消置顶不改变活动时间，归档会清除置顶", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "第一房间" });
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "第二房间" });
    const initial = repository.getSnapshot();
    const first = initial.rooms.find((room) => room.title === "第一房间")!;
    const second = initial.rooms.find((room) => room.title === "第二房间")!;

    repository.executeCommand({ ...commandBase(repository), type: "set_room_pinned", roomId: first.id, pinned: true });
    repository.executeCommand({ ...commandBase(repository), type: "set_room_pinned", roomId: second.id, pinned: true });
    let rooms = repository.getSnapshot().rooms;
    expect(rooms.filter((room) => !room.archivedAt).slice(0, 2).map((room) => room.id)).toEqual([second.id, first.id]);
    expect(rooms.find((room) => room.id === first.id)?.updatedAt).toBe(first.updatedAt);

    repository.executeCommand({ ...commandBase(repository), type: "set_room_pinned", roomId: second.id, pinned: false });
    rooms = repository.getSnapshot().rooms;
    expect(rooms.find((room) => room.id === second.id)?.pinnedAt).toBeNull();
    expect(rooms.find((room) => room.id === second.id)?.updatedAt).toBe(second.updatedAt);
    expect(rooms.find((room) => !room.archivedAt)?.id).toBe(first.id);

    repository.executeCommand({ ...commandBase(repository), type: "archive_room", roomId: first.id, archived: true });
    expect(repository.getRoom(first.id)).toMatchObject({ archivedAt: expect.any(String), pinnedAt: null });
    expect(() => repository.executeCommand({ ...commandBase(repository), type: "set_room_pinned", roomId: first.id, pinned: true })).toThrow("已归档房间不能置顶");
  }));

  it("首次发送时懒创建唯一 Agent 单聊，并在后续消息中复用", async () => withRepository((repository) => {
    expect(repository.getSnapshot().rooms.every((room) => room.kind === "shared")).toBe(true);

    const first = repository.executeCommand({ ...commandBase(repository), type: "send_direct_message", agentId: "navigator", content: "第一条单聊", attachmentIds: [] });
    const directRoom = first.snapshot.rooms.find((room) => room.kind === "direct" && room.directAgentId === "navigator")!;

    expect(first.triggerRoomId).toBe(directRoom.id);
    expect(directRoom.title).toBe("领航员 · 单聊");
    expect(directRoom.participants).toHaveLength(2);
    expect(directRoom.participants.map((participant) => [participant.kind, participant.agentId])).toEqual([["human", null], ["agent", "navigator"]]);
    expect(directRoom.messages.map((message) => message.content)).toEqual(["第一条单聊"]);
    expect(directRoom.scheduler.nextAgentParticipantId).toBe(directRoom.participants[1]?.id);

    const second = repository.executeCommand({ ...commandBase(repository), type: "send_direct_message", agentId: "navigator", content: "第二条单聊", attachmentIds: [] });
    const directRooms = second.snapshot.rooms.filter((room) => room.kind === "direct" && room.directAgentId === "navigator");
    expect(directRooms).toHaveLength(1);
    expect(directRooms[0]?.id).toBe(directRoom.id);
    expect(directRooms[0]?.messages.map((message) => message.content)).toEqual(["第一条单聊", "第二条单聊"]);

    const currentAgent = second.snapshot.agents.find((agent) => agent.id === "navigator")!;
    repository.executeCommand({ ...commandBase(repository), type: "update_agent", agentId: "navigator", label: "新领航员", summary: currentAgent.summary, instruction: currentAgent.instruction });
    const renamedDirectRoom = repository.getSnapshot().rooms.find((room) => room.id === directRoom.id)!;
    expect(renamedDirectRoom.title).toBe("新领航员 · 单聊");
    expect(renamedDirectRoom.participants.find((participant) => participant.agentId === "navigator")?.displayName).toBe("新领航员");
  }));

  it("Agent 单聊成员固定，不能通过普通房间命令改名、归档或增删成员", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "send_direct_message", agentId: "navigator", content: "建立单聊", attachmentIds: [] });
    const directRoom = repository.getSnapshot().rooms.find((room) => room.kind === "direct")!;
    const agentParticipant = directRoom.participants.find((participant) => participant.kind === "agent")!;

    expect(() => repository.executeCommand({ ...commandBase(repository), type: "rename_room", roomId: directRoom.id, title: "不能改名" })).toThrow("Agent 单聊不能修改成员、名称或归档状态");
    expect(() => repository.executeCommand({ ...commandBase(repository), type: "archive_room", roomId: directRoom.id, archived: true })).toThrow("Agent 单聊不能修改成员、名称或归档状态");
    expect(() => repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: directRoom.id, agentId: "builder" })).toThrow("Agent 单聊不能修改成员、名称或归档状态");
    expect(() => repository.executeCommand({ ...commandBase(repository), type: "remove_participant", roomId: directRoom.id, participantId: agentParticipant.id })).toThrow("Agent 单聊不能修改成员、名称或归档状态");
    expect(() => repository.executeCommand({ ...commandBase(repository), type: "toggle_participant", roomId: directRoom.id, participantId: agentParticipant.id, enabled: false })).toThrow("Agent 单聊不能修改成员、名称或归档状态");
  }));

  it("旧 rooms 表会在启动时补齐单聊字段与唯一索引", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-direct-room-migration-"));
    const legacy = new Database(path.join(dir, "oceanking.db"));
    legacy.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_participant_id TEXT, next_seq INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    legacy.close();

    const handle = createDatabase(dir);
    try {
      const columns = (handle.raw.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map((column) => column.name);
      const indexes = (handle.raw.prepare("PRAGMA index_list(rooms)").all() as Array<{ name: string }>).map((index) => index.name);
      expect(columns).toEqual(expect.arrayContaining(["kind", "direct_agent_id"]));
      expect(indexes).toContain("rooms_direct_agent_unique");
    } finally {
      handle.raw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("旧默认身份升级为平级描述，同时保留用户自定义身份", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-agent-migration-"));
    const handle = createDatabase(dir);
    try {
      const repository = new WorkspaceRepository(handle);
      const peerDefaults = repository.getSnapshot().agents[0]!;
      repository.raw.prepare("UPDATE agents SET summary=?,instruction=? WHERE id='navigator'").run(
        "梳理目标、协调房间并公开可靠结论",
        "你是 OceanKing 领航员。先调查和协调，再通过房间工具明确公开经过整理的结论。普通 assistant 文本对人类不可见。",
      );
      repository.raw.prepare("UPDATE agents SET summary=?,instruction=? WHERE id='builder'").run("我的自定义简介", "我的自定义指令");

      const migrated = new WorkspaceRepository(handle).getSnapshot().agents;

      expect(migrated.find((agent) => agent.id === "navigator")).toMatchObject({
        summary: peerDefaults.summary,
        instruction: peerDefaults.instruction,
      });
      expect(migrated.find((agent) => agent.id === "builder")).toMatchObject({
        summary: "我的自定义简介",
        instruction: "我的自定义指令",
      });
    } finally {
      handle.raw.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("重置工作台会清空全部历史和新建 Agent，只保留初始 Agent、房间与模型思考配置", async () => withRepository(async (repository) => {
    const initialSettings = repository.getSnapshot().settings;
    repository.executeCommand({
      ...commandBase(repository), type: "update_settings", model: initialSettings.model, availableModels: initialSettings.availableModels,
      apiFormat: initialSettings.apiFormat, thinkingMode: "enabled", reasoningEffort: "max", contextTokenThreshold: initialSettings.contextTokenThreshold,
      maxToolSteps: initialSettings.maxToolSteps, maxRoomRounds: initialSettings.maxRoomRounds, projectContextRoots: initialSettings.projectContextRoots,
    });
    repository.executeCommand({ ...commandBase(repository), type: "create_agent", label: "审计 Agent", summary: "确认保留注册表", instruction: "执行审计" });
    const customAgentId = repository.getSnapshot().agents.find((agent) => agent.label === "审计 Agent")!.id;
    const customAgentWorkspace = path.join(repository.dataDir, "workspaces", "agents", customAgentId);
    await fs.mkdir(customAgentWorkspace, { recursive: true });
    await fs.writeFile(path.join(customAgentWorkspace, "private-note.txt"), "待删除的 Agent 私有文件");
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "待删除房间", agentId: "navigator" });
    repository.executeCommand({ ...commandBase(repository), type: "send_direct_message", agentId: "navigator", content: "需要清空的单聊历史", attachmentIds: [] });
    expect(repository.getSnapshot().rooms.some((room) => room.kind === "direct")).toBe(true);
    const extraRoom = repository.getSnapshot().rooms.find((room) => room.title === "待删除房间")!;
    const oldMessageCommandId = crypto.randomUUID();
    repository.executeCommand({ commandId: oldMessageCommandId, expectedVersion: repository.getVersion().version, type: "send_message", roomId: "room_harbor", content: "需要被清空的历史", attachmentIds: [] });
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_before_reset", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_before_reset", assistantContent: "旧回复", sessionMessages: [{ role: "user", content: "旧输入" }, { role: "assistant", content: "旧回复" }], tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
    repository.raw.prepare("UPDATE agent_sessions SET history_json=?").run(JSON.stringify([{ role: "user", content: "所有 Agent 的旧会话" }]));
    repository.executeCommand({ ...commandBase(repository), type: "create_cron", roomId: extraRoom.id, agentId: "navigator", name: "待删除 Cron", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "旧任务" });
    repository.appendCronMessage(repository.getSnapshot().cronJobs[0]!.id);
    const attachmentPath = path.join(repository.dataDir, "uploads", "reset-history.txt");
    await fs.writeFile(attachmentPath, "旧附件");
    repository.registerAttachment({ id: "attachment_before_reset", fileName: "reset-history.txt", mimeType: "text/plain", byteSize: 9, storagePath: path.join("uploads", "reset-history.txt") });
    const settingsJsonBefore = (repository.raw.prepare("SELECT settings_json FROM workspace_meta WHERE id=1").get() as { settings_json: string }).settings_json;
    const dedupCountBefore = (repository.raw.prepare("SELECT COUNT(*) count FROM command_dedup").get() as { count: number }).count;
    const resetCommandId = crypto.randomUUID();

    const result = repository.executeCommand({ commandId: resetCommandId, expectedVersion: repository.getVersion().version, type: "reset_workspace" });

    expect(result.snapshot.rooms).toHaveLength(1);
    expect(result.snapshot.rooms[0]).toMatchObject({ id: "room_harbor", title: "港湾协作室", kind: "shared", directAgentId: null, archivedAt: null });
    expect(result.snapshot.rooms[0]?.messages).toEqual([expect.objectContaining({ id: "msg_welcome", seq: 1, source: "system" })]);
    expect(result.snapshot.rooms[0]?.turns).toEqual([]);
    expect(result.snapshot.rooms[0]?.participants.map((participant) => participant.id)).toEqual(["human_local", "participant_navigator_harbor"]);
    expect(result.snapshot.cronJobs).toEqual([]); expect(result.snapshot.cronRuns).toEqual([]);
    expect(result.snapshot.agents.map((agent) => agent.id)).toEqual(["navigator", "builder"]);
    expect(result.snapshot.agents.some((agent) => agent.id === customAgentId)).toBe(false);
    expect(result.snapshot.settings).toMatchObject({ thinkingMode: "enabled", reasoningEffort: "max", model: initialSettings.model });
    expect((repository.raw.prepare("SELECT settings_json FROM workspace_meta WHERE id=1").get() as { settings_json: string }).settings_json).toBe(settingsJsonBefore);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM agent_sessions WHERE history_json<>'[]' OR active_turn_id IS NOT NULL").get() as { count: number }).count).toBe(0);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM agent_sessions").get() as { count: number }).count).toBe(2);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM attachments").get() as { count: number }).count).toBe(0);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM command_dedup").get() as { count: number }).count).toBe(dedupCountBefore + 1);
    expect(repository.hasProcessedCommand(resetCommandId)).toBe(true);
    expect(repository.hasProcessedCommand(oldMessageCommandId)).toBe(true);
    expect(repository.getRoomIds()).toEqual(["room_harbor"]);
    expect(repository.getAgentConversation("navigator")?.turns).toEqual([]);
    expect(repository.getAgentConversation(customAgentId)).toBeNull();
    await expect(fs.stat(attachmentPath)).rejects.toThrow();
    await expect(fs.stat(customAgentWorkspace)).rejects.toThrow();

    const replayedMessage = repository.executeCommand({ commandId: oldMessageCommandId, expectedVersion: -1, type: "send_message", roomId: "room_harbor", content: "旧命令不应复活", attachmentIds: [] });
    expect(replayedMessage.snapshot.rooms[0]?.messages).toHaveLength(1);

    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "重置后的新房间" });
    const versionBeforeReplay = repository.getVersion();
    const replay = repository.executeCommand({ commandId: resetCommandId, expectedVersion: -1, type: "reset_workspace" });
    expect(replay.snapshot.rooms.some((room) => room.title === "重置后的新房间")).toBe(true);
    expect(repository.getVersion()).toEqual(versionBeforeReplay);
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

  it("完整调度包保留在 Turn 审计中，会话历史只保存精简增量", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "请检查本轮输入");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_compact_packet", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_compact_packet", assistantContent: "已检查", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    const sessionInput = repository.getAgentSession("navigator")[0];
    expect(sessionInput).toMatchObject({ role: "user" });
    expect(sessionInput?.content).toContain("[内部房间调度增量]");
    expect(sessionInput?.content).toContain("请检查本轮输入");
    expect(sessionInput?.content).not.toContain("connectedRooms");
    expect(sessionInput?.content).not.toContain("availableAgents");

    const turn = repository.getAgentConversation("navigator")!.turns.find((entry) => entry.id === "turn_compact_packet")!;
    expect(turn.userEnvelope.connectedRooms).toEqual(packet.connectedRooms);
    expect(turn.userEnvelope.availableAgents).toEqual(packet.availableAgents);
    expect(turn.messages[0]).toEqual(sessionInput);
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
    const effect: TurnEffect = { type: "send_message", roomId: "room_harbor", messageId: "msg_emit_one", messageKey: "call-stable", content: "正式结论", kind: "handoff" };
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
    repository.finishTurn({ turnId: "turn_cross", assistantContent: "internal", tools: [], timeline: [], effects: [{ type: "send_message", roomId: roomB.id, messageId: "msg_to_b", messageKey: "to-b", content: "只在 B 出现", kind: "handoff" }], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    expect(repository.getRoom(roomB.id)!.messages.some((message) => message.id === "msg_to_b")).toBe(true);
    expect(repository.getRoom("room_harbor")!.messages.some((message) => message.id === "msg_to_b")).toBe(false);
  }));

  it("跨房间 Agent 新消息返回目标房间且幂等重放不会重复触发", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "创建讨论房间");
    const createPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_create_trigger_room", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: createPacket });
    repository.finishTurn({
      turnId: "turn_create_trigger_room", assistantContent: "internal", tools: [], timeline: [],
      effects: [{ type: "create_room", roomId: "room_agent_started", title: "AI 发起的讨论", invitedAgentIds: ["builder"] }],
      modelMeta: {}, cutoffSeq: createPacket.cutoffSeq, nextParticipantId: null,
    });

    sendUser(repository, "room_harbor", "向新房间发起讨论");
    const emitPacket = packetFor(repository);
    const effect: TurnEffect = { type: "send_message", roomId: "room_agent_started", messageId: "msg_agent_started", messageKey: "agent-started", content: "由 AI 发起的第一句话", kind: "handoff" };
    repository.beginTurn({ turnId: "turn_emit_trigger_room", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: emitPacket });
    const first = repository.finishTurn({ turnId: "turn_emit_trigger_room", assistantContent: "internal", tools: [], timeline: [], effects: [effect], modelMeta: {}, cutoffSeq: emitPacket.cutoffSeq, nextParticipantId: null });
    expect(first.triggerRoomIds).toEqual(["room_agent_started"]);
    expect(first.messageRoomIds).toEqual(["room_agent_started"]);

    sendUser(repository, "room_harbor", "重放同一工具调用");
    const replayPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_replay_trigger_room", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: replayPacket });
    const replay = repository.finishTurn({ turnId: "turn_replay_trigger_room", assistantContent: "internal", tools: [], timeline: [], effects: [effect], modelMeta: {}, cutoffSeq: replayPacket.cutoffSeq, nextParticipantId: null });
    expect(replay.triggerRoomIds).toEqual([]);
    expect(replay.messageRoomIds).toEqual([]);
    expect(repository.getRoom("room_agent_started")!.messages.filter((message) => message.messageKey === "agent-started")).toHaveLength(1);
  }));

  it("notify 只记录过程，不完成当前交付也不触发其他 Agent", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "执行一个分阶段任务");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_notify_process", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    const applied = repository.finishTurn({
      turnId: "turn_notify_process", assistantContent: "继续工作", tools: [], timeline: [],
      effects: [{ type: "send_message", roomId: "room_harbor", messageId: "msg_notify_process", messageKey: "notify-process", content: "第一阶段已经开始", kind: "notify" }],
      modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null,
    });

    expect(applied.triggerRoomIds).toEqual([]);
    expect(applied.messageRoomIds).toEqual([]);
    expect(applied.unresolvedRoomIds).toEqual(["room_harbor"]);
    expect(applied.continuationRoomIds).toEqual(["room_harbor"]);
    expect(repository.getRoom("room_harbor")!.turns.at(-1)?.status).toBe("continued");
  }));

  it("无需回复通过 receipt 表达而不创建空气泡", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "已阅即可，无需回复"); const packet = packetFor(repository); const before = repository.getRoom("room_harbor")!.messages.length;
    repository.beginTurn({ turnId: "turn_receipt", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_receipt", assistantContent: "已判断无需回复", tools: [], timeline: [], effects: [{ type: "read_no_reply", roomId: "room_harbor", messageId: packet.targetMessageId, receiptId: "receipt_one" }], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    const room = repository.getRoom("room_harbor")!;
    expect(room.messages).toHaveLength(before);
    expect(room.messages.at(-1)?.receipts[0]?.agentParticipantId).toBe("participant_navigator_harbor");
  }));

  it("跨房间 read_no_reply 使用目标房间内的 Agent 成员身份", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "跨房间回执", agentId: "navigator" });
    const receiptRoom = repository.getSnapshot().rooms.find((room) => room.title === "跨房间回执")!;
    const receiptParticipant = receiptRoom.participants.find((participant) => participant.agentId === "navigator")!;
    const receiptMessage = sendUser(repository, receiptRoom.id, "这条消息已阅即可").snapshot.rooms.find((room) => room.id === receiptRoom.id)!.messages.at(-1)!;
    sendUser(repository, "room_harbor", "同时处理当前房间任务");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_cross_room_receipt", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });

    repository.finishTurn({
      turnId: "turn_cross_room_receipt", assistantContent: "已分别处理", tools: [], timeline: [], effects: [
        { type: "send_message", roomId: "room_harbor", messageId: "msg_cross_receipt_done", messageKey: "cross-receipt-done", content: "当前房间已处理", kind: "handoff" },
        { type: "read_no_reply", roomId: receiptRoom.id, messageId: receiptMessage.id, receiptId: "receipt_cross_room" },
      ], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor",
    });

    const receipt = repository.raw.prepare("SELECT agent_participant_id FROM message_receipts WHERE id='receipt_cross_room'").get() as { agent_participant_id: string };
    expect(receipt.agent_participant_id).toBe(receiptParticipant.id);
    expect(receipt.agent_participant_id).not.toBe("participant_navigator_harbor");
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

  it("新房间消息打断旧任务时保存续接快照且不清除新 turn", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "先完成旧房间的长期任务");
    const oldPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_interrupted_old", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: oldPacket });
    const tools: ToolExecution[] = Array.from({ length: 12 }, (_, index) => ({
      id: `tool_before_interrupt_${index}`, turnId: "turn_interrupted_old", name: index === 0 ? "shell_command" : `tool_${index}`,
      input: index === 0 ? { command: "inspect" } : { index }, outputText: index === 0 ? "检查已完成" : `output_${index}`,
      structuredResult: { ok: true }, status: "completed", durationMs: 12, error: null, createdAt: new Date(Date.now() + index).toISOString(),
    }));
    repository.checkpointTurn({
      turnId: "turn_interrupted_old", assistantContent: "已经完成第一阶段分析", systemPrompt: "system",
      conversationMessages: [{ role: "user", content: "旧任务" }, { role: "assistant", content: "已经完成第一阶段分析" }],
      tools, timeline: [],
    });

    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "紧急房间", agentId: "navigator" });
    const nextRoom = repository.getSnapshot().rooms.find((room) => room.title === "紧急房间")!;
    sendUser(repository, nextRoom.id, "这是需要立刻处理的新消息");
    const nextPacket = packetFor(repository, nextRoom.id);
    const nextParticipant = nextRoom.participants.find((participant) => participant.agentId === "navigator")!;
    repository.beginTurn({ turnId: "turn_interrupted_new", roomId: nextRoom.id, agentId: "navigator", agentParticipantId: nextParticipant.id, packet: nextPacket });

    repository.continueInterruptedTurn("turn_interrupted_old", "新房间任务接管", nextRoom.id, { format: "responses" });

    const oldTurn = repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === "turn_interrupted_old");
    expect(oldTurn).toMatchObject({ status: "continued", error: null, modelMeta: { format: "responses" } });
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBeLessThan(oldPacket.cutoffSeq);
    const activeSession = repository.raw.prepare("SELECT active_turn_id FROM agent_sessions WHERE agent_id='navigator'").get() as { active_turn_id: string | null };
    expect(activeSession.active_turn_id).toBe("turn_interrupted_new");
    const snapshot = repository.getAgentSession("navigator").at(-1);
    expect(snapshot?.role).toBe("assistant");
    expect(snapshot?.content).toContain("[被新消息打断的未完成任务快照]");
    expect(snapshot?.content).toContain("先完成旧房间的长期任务");
    expect(snapshot?.content).toContain("已经完成第一阶段分析");
    expect(snapshot?.content).toContain("shell_command");
    expect(snapshot?.content).toContain("检查已完成");
    expect(snapshot?.content).toContain("tool_11");
    expect(snapshot?.content).toContain("output_11");
    expect(snapshot?.content).toContain("这只是信息更新，不是自动允许放弃当前未完成任务");
    expect(snapshot?.content).toContain("处理新任务时也要继续处理好原任务");
    expect(snapshot?.content).toContain("把被打断的房间义务视为活跃义务");
    expect(snapshot?.content).toContain("结束当前轮之前");
    expect(snapshot?.content).toContain("不要盲目重复执行");

    const applied = repository.finishTurn({
      turnId: "turn_interrupted_new", assistantContent: "已完成接管", tools: [], timeline: [], effects: [
        { type: "send_message", roomId: nextRoom.id, messageId: "msg_new_room_done", messageKey: "new-room-done", content: "新房间任务结果", kind: "handoff" },
        { type: "send_message", roomId: "room_harbor", messageId: "msg_old_room_done", messageKey: "old-room-done", content: "旧房间任务结果", kind: "handoff" },
      ], modelMeta: {},
      cutoffSeq: nextPacket.cutoffSeq, nextParticipantId: nextParticipant.id,
    });
    expect(applied.continuationRoomIds).toEqual(["room_harbor"]);
    expect(applied.unresolvedRoomIds).toEqual([]);
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBe(oldPacket.cutoffSeq);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("跨房间 handoff 会自动等待回复，并跨多轮保留来源任务直到最终汇报", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "去新房间协作，完成后回来汇报");
    const sourcePacket = packetFor(repository);
    const targetRoomId = "room_automatic_awaiting";
    repository.beginTurn({ turnId: "turn_automatic_source", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: sourcePacket });
    const started = repository.finishTurn({
      turnId: "turn_automatic_source", assistantContent: "已启动跨房间协作", tools: [], timeline: [], effects: [
        { type: "create_room", roomId: targetRoomId, title: "自动续办房间", invitedAgentIds: ["builder"] },
        { type: "send_message", roomId: targetRoomId, messageId: "msg_automatic_one", messageKey: "automatic-one", content: "1", kind: "handoff" },
      ], awaitingRoomId: targetRoomId, modelMeta: {}, cutoffSeq: sourcePacket.cutoffSeq, nextParticipantId: "participant_navigator_harbor",
    });

    expect(started.continuationRoomIds).toEqual([targetRoomId]);
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === "turn_automatic_source")?.status).toBe("continued");
    expect(repository.raw.prepare("SELECT target_room_id,target_turn_id,delivery_only,awaiting_reply,awaiting_message_id FROM turn_handoffs WHERE source_turn_id='turn_automatic_source'").get()).toEqual({
      target_room_id: targetRoomId, target_turn_id: null, delivery_only: 0, awaiting_reply: 1, awaiting_message_id: "msg_automatic_one",
    });

    sendUser(repository, targetRoomId, "另一个 Agent 回复了 2");
    const targetRoom = repository.getRoom(targetRoomId)!;
    const navigator = targetRoom.participants.find((participant) => participant.agentId === "navigator")!;
    const middlePacket = packetFor(repository, targetRoomId);
    repository.beginTurn({ turnId: "turn_automatic_middle", roomId: targetRoomId, agentId: "navigator", agentParticipantId: navigator.id, packet: middlePacket });
    expect(repository.getTurnDeliveryObligations("turn_automatic_middle")).toEqual([{ roomId: targetRoomId, messageId: middlePacket.targetMessageId }]);
    expect(repository.getTurnAwaitingTasks("turn_automatic_middle")).toEqual([{ roomId: "room_harbor", messageId: sourcePacket.targetMessageId }]);
    const middle = repository.finishTurn({
      turnId: "turn_automatic_middle", assistantContent: "继续数数", tools: [], timeline: [],
      effects: [{ type: "send_message", roomId: targetRoomId, messageId: "msg_automatic_three", messageKey: "automatic-three", content: "3", kind: "handoff" }],
      awaitingRoomId: targetRoomId, modelMeta: {}, cutoffSeq: middlePacket.cutoffSeq, nextParticipantId: navigator.id,
    });
    expect(middle.unresolvedRoomIds).toEqual(["room_harbor"]);
    expect(repository.getRoom(targetRoomId)!.messages.at(-1)).toMatchObject({ content: "3", kind: "handoff" });
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(1);
    expect(repository.raw.prepare("SELECT target_room_id,target_turn_id,awaiting_reply,awaiting_message_id FROM turn_handoffs WHERE source_turn_id='turn_automatic_source'").get()).toEqual({
      target_room_id: targetRoomId, target_turn_id: null, awaiting_reply: 1, awaiting_message_id: "msg_automatic_three",
    });

    sendUser(repository, targetRoomId, "游戏已经数到 10");
    const finalPacket = packetFor(repository, targetRoomId);
    repository.beginTurn({ turnId: "turn_automatic_final", roomId: targetRoomId, agentId: "navigator", agentParticipantId: navigator.id, packet: finalPacket });
    expect(repository.getTurnAwaitingTasks("turn_automatic_final")).toHaveLength(1);
    const completed = repository.finishTurn({
      turnId: "turn_automatic_final", assistantContent: "完成并汇报", tools: [], timeline: [], effects: [
        { type: "send_message", roomId: targetRoomId, messageId: "msg_automatic_done", messageKey: "automatic-done", content: "游戏结束", kind: "handoff" },
        { type: "send_message", roomId: "room_harbor", messageId: "msg_automatic_report", messageKey: "automatic-report", content: "数数游戏已经完成到 10", kind: "handoff" },
      ], modelMeta: {}, cutoffSeq: finalPacket.cutoffSeq, nextParticipantId: navigator.id,
    });
    expect(completed.unresolvedRoomIds).toEqual([]);
    expect(repository.getRoom("room_harbor")!.messages.at(-1)?.content).toBe("数数游戏已经完成到 10");
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("read_no_reply 会终止当前 handoff 链且不把任务退回来源房间", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "去新房间发起一轮交接");
    const sourcePacket = packetFor(repository);
    const targetRoomId = "room_read_no_reply_handoff";
    repository.beginTurn({ turnId: "turn_read_no_reply_source", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: sourcePacket });
    repository.finishTurn({
      turnId: "turn_read_no_reply_source", assistantContent: "发起交接", tools: [], timeline: [], effects: [
        { type: "create_room", roomId: targetRoomId, title: "已读不回交接房间", invitedAgentIds: ["builder"] },
        { type: "send_message", roomId: targetRoomId, messageId: "msg_read_no_reply_handoff", messageKey: "read-no-reply-handoff", content: "任务已经结束，无需再回复", kind: "handoff" },
      ], awaitingRoomId: targetRoomId, modelMeta: {}, cutoffSeq: sourcePacket.cutoffSeq, nextParticipantId: null,
    });

    const targetPacket = packetFor(repository, targetRoomId);
    const builder = repository.getRoom(targetRoomId)!.participants.find((participant) => participant.agentId === "builder")!;
    repository.beginTurn({ turnId: "turn_read_no_reply_target", roomId: targetRoomId, agentId: "builder", agentParticipantId: builder.id, packet: targetPacket });
    const applied = repository.finishTurn({
      turnId: "turn_read_no_reply_target", assistantContent: "无需回复", tools: [], timeline: [], effects: [
        { type: "read_no_reply", roomId: targetRoomId, messageId: targetPacket.targetMessageId, receiptId: "receipt_read_no_reply_handoff" },
      ], modelMeta: {}, cutoffSeq: targetPacket.cutoffSeq, nextParticipantId: null,
    });

    expect(applied.continuationRoomIds).toEqual([]);
    expect(applied.unresolvedRoomIds).toEqual([]);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("接管 turn 只回复新房间时保留旧房间义务并退回原房间续跑", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "旧房间必须收到自己的结果");
    const oldPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_delivery_gate_old", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: oldPacket });
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "交付门禁房间", agentId: "navigator" });
    const nextRoom = repository.getSnapshot().rooms.find((room) => room.title === "交付门禁房间")!;
    sendUser(repository, nextRoom.id, "新房间也要自己的结果");
    const nextPacket = packetFor(repository, nextRoom.id);
    const nextParticipant = nextRoom.participants.find((participant) => participant.agentId === "navigator")!;
    repository.beginTurn({ turnId: "turn_delivery_gate_new", roomId: nextRoom.id, agentId: "navigator", agentParticipantId: nextParticipant.id, packet: nextPacket });
    repository.continueInterruptedTurn("turn_delivery_gate_old", "跨房间接管", nextRoom.id);

    const first = repository.finishTurn({
      turnId: "turn_delivery_gate_new", assistantContent: "只回答了新房间", tools: [], timeline: [],
      effects: [{ type: "send_message", roomId: nextRoom.id, messageId: "msg_only_new", messageKey: "only-new", content: "新房间结果", kind: "handoff" }],
      modelMeta: {}, cutoffSeq: nextPacket.cutoffSeq, nextParticipantId: nextParticipant.id,
    });

    expect(first.unresolvedRoomIds).toEqual(["room_harbor"]);
    expect(repository.getRoom(nextRoom.id)!.scheduler.cursorByParticipantId[nextParticipant.id]).toBe(nextPacket.cutoffSeq);
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBe(oldPacket.cutoffSeq);
    expect(repository.raw.prepare("SELECT target_room_id,target_turn_id,delivery_only FROM turn_handoffs WHERE source_turn_id='turn_delivery_gate_old'").get()).toEqual({ target_room_id: "room_harbor", target_turn_id: null, delivery_only: 1 });

    const deliveryPacket = { ...oldPacket, type: "delivery_packet" as const, messages: [], sender: { id: "scheduler:delivery", name: "结果投递恢复器" } };
    repository.beginTurn({ turnId: "turn_delivery_gate_retry", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: deliveryPacket });
    expect(repository.getTurnDeliveryObligations("turn_delivery_gate_retry")).toEqual([{ roomId: "room_harbor", messageId: oldPacket.targetMessageId }]);
    const retry = repository.finishTurn({
      turnId: "turn_delivery_gate_retry", assistantContent: "补交旧房间", tools: [], timeline: [],
      effects: [{ type: "send_message", roomId: "room_harbor", messageId: "msg_old_retry", messageKey: "old-retry", content: "旧房间最终结果", kind: "handoff" }],
      modelMeta: {}, cutoffSeq: oldPacket.cutoffSeq, nextParticipantId: "participant_navigator_harbor",
    });
    expect(retry.unresolvedRoomIds).toEqual([]);
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBe(oldPacket.cutoffSeq);
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("仅投递重试被跨房间打断时只迁移原义务而不复制任务", async () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "任务已经执行但尚未公开结果");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_delivery_source", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.finishTurn({ turnId: "turn_delivery_source", assistantContent: "已有私有结果", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    const deliveryPacket = { ...packet, type: "delivery_packet" as const, messages: [], sender: { id: "scheduler:delivery", name: "结果投递恢复器" } };
    repository.beginTurn({ turnId: "turn_delivery_interrupted", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: deliveryPacket });
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "投递接管房间", agentId: "navigator" });
    const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "投递接管房间")!;

    repository.continueInterruptedTurn("turn_delivery_interrupted", "投递轮被新房间消息打断", takeoverRoom.id);

    expect(repository.raw.prepare("SELECT source_turn_id,target_room_id,delivery_only FROM turn_handoffs").all()).toEqual([
      { source_turn_id: "turn_delivery_source", target_room_id: takeoverRoom.id, delivery_only: 1 },
    ]);
    expect(repository.getPendingDeliveryObligations(takeoverRoom.id, "navigator")).toEqual([
      { sourceTurnId: "turn_delivery_source", messageId: packet.targetMessageId },
    ]);
  }));

  it("进程恢复会重新调度尚未被目标 turn 认领的接管任务", async () => withRepository((repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "待恢复接管房间", agentId: "navigator" });
    const targetRoom = repository.getSnapshot().rooms.find((room) => room.title === "待恢复接管房间")!;
    sendUser(repository, "room_harbor", "崩溃后仍需继续");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_handoff_before_crash", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.continueInterruptedTurn("turn_handoff_before_crash", "转交后进程退出", targetRoom.id);
    repository.setScheduler("room_harbor", { status: "idle", active: null });

    expect(repository.recoverInterruptedRuns()).toContain(targetRoom.id);
    expect((repository.raw.prepare("SELECT target_turn_id FROM turn_handoffs WHERE source_turn_id='turn_handoff_before_crash'").get() as { target_turn_id: string | null }).target_turn_id).toBeNull();
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBeLessThan(packet.cutoffSeq);
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
    repository.finishTurn({ turnId: "turn_cursor", assistantContent: "done", tools: [], timeline: [], effects: [{ type: "send_message", roomId: "room_harbor", messageId: "msg_cursor_done", messageKey: "cursor-done", content: "游标处理完成", kind: "handoff" }], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
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

  it("旧即时提交数据库启动时会补齐 Turn 使用关系和待投递房间", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-effect-outbox-migration-"));
    try {
      const firstHandle = createDatabase(dir);
      const first = new WorkspaceRepository(firstHandle);
      first.executeCommand({ ...commandBase(first), type: "create_room", title: "迁移待唤醒房间", agentId: "navigator" });
      const targetRoom = first.getSnapshot().rooms.find((room) => room.title === "迁移待唤醒房间")!;
      sendUser(first, "room_harbor", "迁移即时提交记录");
      const packet = packetFor(first);
      first.beginTurn({ turnId: "turn_effect_migration", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
      first.commitTurnEffect({
        invocationKey: "task:effect-migration:invite",
        turnId: "turn_effect_migration",
        agentId: "navigator",
        participantId: "participant_navigator_harbor",
        toolName: "invite_agent",
        effect: { type: "invite_agent", roomId: targetRoom.id, agentId: "builder", participantId: "participant_effect_migration" },
      });
      firstHandle.raw.exec("DROP TABLE turn_effect_dispatches; DROP TABLE turn_effect_uses;");
      firstHandle.raw.close();

      const secondHandle = createDatabase(dir);
      expect(secondHandle.raw.prepare("SELECT turn_id,invocation_key FROM turn_effect_uses").all()).toEqual([
        { turn_id: "turn_effect_migration", invocation_key: "task:effect-migration:invite" },
      ]);
      expect(secondHandle.raw.prepare("SELECT room_id,message_room,dispatched_at FROM turn_effect_dispatches").all()).toEqual([
        { room_id: targetRoom.id, message_room: 0, dispatched_at: null },
      ]);
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

  it("旧数据库启动时自动补齐房间置顶字段", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-room-pin-migration-"));
    try {
      const legacy = new Database(path.join(dir, "oceanking.db"));
      legacy.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_participant_id TEXT, next_seq INTEGER NOT NULL DEFAULT 1, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
      legacy.close();
      const handle = createDatabase(dir);
      const columns = (handle.raw.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).toContain("pinned_at");
      handle.raw.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it("旧数据库启动时把显式续办字段迁移为内部自动等待状态", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-migrate-awaiting-handoff-"));
    try {
      const legacy = new Database(path.join(dir, "oceanking.db"));
      legacy.exec(`CREATE TABLE turn_handoffs (
        source_turn_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_room_id TEXT NOT NULL,
        source_participant_id TEXT NOT NULL,
        cutoff_seq INTEGER NOT NULL,
        target_room_id TEXT NOT NULL,
        target_turn_id TEXT,
        delivery_only INTEGER NOT NULL DEFAULT 0,
        deferred INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`);
      legacy.prepare("INSERT INTO turn_handoffs VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run("turn_legacy", "navigator", "room_source", "participant_source", 3, "room_target", "turn_target", 0, 1, "2026-01-01T00:00:00.000Z");
      legacy.close();

      const handle = createDatabase(dir);
      const columns = (handle.raw.prepare("PRAGMA table_info(turn_handoffs)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns).not.toContain("deferred");
      expect(columns).toContain("awaiting_reply");
      expect(columns).toContain("awaiting_message_id");
      expect(handle.raw.prepare("SELECT target_room_id,target_turn_id,delivery_only,awaiting_reply,awaiting_message_id FROM turn_handoffs WHERE source_turn_id='turn_legacy'").get()).toEqual({
        target_room_id: "room_target",
        target_turn_id: "turn_target",
        delivery_only: 0,
        awaiting_reply: 1,
        awaiting_message_id: null,
      });
      handle.raw.close();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
