import { describe, expect, it, vi } from "vitest";
import type { TurnEffect } from "@/lib/domain/types";
import { runAgentModel } from "@/lib/server/model-runtime";
import { eventsAfterId, resetWorkspaceEventHistory } from "@/lib/server/events";
import { getToolDefinition, listToolDefinitions } from "@/lib/server/tools";
import { commandBase, packetFor, sendUser, withRepository } from "./helpers";

describe("Agent runtime 与 canonical tools", () => {
  it("无 API Key 时假模型仍通过正式房间工具产生 effect", async () => withRepository(async (repository) => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      sendUser(repository, "room_harbor", "请处理这个任务"); const packet = packetFor(repository); const agent = repository.getAgent("navigator")!;
      const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_mock", signal: new AbortController().signal });
      expect(result.assistantContent).toContain("私有执行区"); expect(result.effects[0]?.type).toBe("send_message"); expect(result.tools[0]?.name).toBe("send_message_to_room");
    } finally { if (original) process.env.OPENAI_API_KEY = original; }
  }));

  it("持久化运行中检查点后发布 Agent 历史刷新事件", async () => withRepository(async (repository) => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      sendUser(repository, "room_harbor", "持续更新执行历史");
      const packet = packetFor(repository); const agent = repository.getAgent("navigator")!;
      repository.beginTurn({ turnId: "turn_history_live", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
      resetWorkspaceEventHistory();

      await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_history_live", signal: new AbortController().signal });

      expect(eventsAfterId(0)).toContainEqual(expect.objectContaining({
        type: "turn.preview",
        entityId: "turn_history_live",
        payload: { kind: "history_checkpoint" },
      }));
    } finally { if (original) process.env.OPENAI_API_KEY = original; }
  }));

  it("/private fixture 证明普通 assistant 不会自动生成 effect", async () => withRepository(async (repository) => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      sendUser(repository, "room_harbor", "/private 只思考"); const packet = packetFor(repository); const agent = repository.getAgent("navigator")!;
      const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_private_mock", signal: new AbortController().signal });
      expect(result.assistantContent.length).toBeGreaterThan(0); expect(result.effects).toEqual([]);
    } finally { if (original) process.env.OPENAI_API_KEY = original; }
  }));

  it("假模型面对纯 Agent 消息时写 receipt 而不是形成回声", async () => withRepository(async (repository) => {
    const original = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: "room_harbor", agentId: "builder" });
      sendUser(repository, "room_harbor", "原始用户任务"); const userPacket = packetFor(repository); const builderParticipant = repository.getRoom("room_harbor")!.participants.find((participant) => participant.agentId === "builder")!;
      repository.beginTurn({ turnId: "turn_builder_emit", roomId: "room_harbor", agentId: "builder", agentParticipantId: builderParticipant.id, packet: userPacket });
      repository.finishTurn({ turnId: "turn_builder_emit", assistantContent: "internal", tools: [], timeline: [], effects: [{ type: "send_message", roomId: "room_harbor", messageId: "agent_message", messageKey: "agent-message", content: "另一个 Agent 的正式结果", kind: "handoff" }], modelMeta: {}, cutoffSeq: userPacket.cutoffSeq, nextParticipantId: null });
      const packet = packetFor(repository); const agent = repository.getAgent("navigator")!;
      const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_no_echo", signal: new AbortController().signal });
      expect(result.effects[0]?.type).toBe("read_no_reply");
      expect(result.effects.some((effect) => effect.type === "send_message")).toBe(false);
    } finally { if (original) process.env.OPENAI_API_KEY = original; }
  }));

  it("工具注册表包含房间、工作区、基础与 Cron 能力", () => {
    const names = new Set(listToolDefinitions().map((tool) => tool.name));
    for (const name of ["begin_message_to_room", "send_message_to_room", "read_no_reply", "list_available_agents", "create_agent", "read_room_history", "workspace_read", "workspace_write", "shell", "web_search", "web_fetch", "create_cron_job"]) expect(names.has(name)).toBe(true);
    expect(names.has("continue_task_in_room")).toBe(false);
  });

  it("按需返回可协作 Agent 信息卡，不依赖 scheduler packet 携带清单", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const result = await getToolDefinition("list_available_agents")!.execute(
      { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal },
      {},
      "tool_list_agents",
    );

    expect(result.structured).toEqual([
      expect.objectContaining({ id: "navigator", label: "领航员", current: true }),
      expect.objectContaining({ id: "builder", label: "执行者", current: false }),
    ]);
  }));

  it("Agent 创建的新 Agent 会立即提交，并可在同一 Turn 加入非 owner 的已连接房间", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_create_and_invite_agent";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };
    const created = await getToolDefinition("create_agent")!.execute(context, {
      label: "资料研究员",
      summary: "负责检索和整理资料",
      instruction: "独立检索资料并给出来源。",
    }, "tool_create_agent");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_agent") throw new Error("create_agent 未返回预期 effect");
    expect(repository.hasAgent(createEffect.agentId)).toBe(true);

    const listed = await getToolDefinition("list_available_agents")!.execute(context, {}, "tool_list_created_agent");
    expect(listed.structured).toContainEqual(expect.objectContaining({ id: createEffect.agentId, label: "资料研究员" }));
    const invited = await getToolDefinition("invite_agent")!.execute(context, { roomId: "room_harbor", agentId: createEffect.agentId }, "tool_invite_created_agent");
    expect(repository.getRoom("room_harbor")!.participants.some((participant) => participant.agentId === createEffect.agentId)).toBe(true);

    repository.finishTurn({ turnId, assistantContent: "internal", tools: [], timeline: [], effects: [...created.effects, ...invited.effects], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    expect(repository.getAgent(createEffect.agentId)).toMatchObject({
      label: "资料研究员",
      summary: "负责检索和整理资料",
      instruction: "独立检索资料并给出来源。",
      settings: agent.settings,
    });
    expect(repository.getAgentSession(createEffect.agentId)).toEqual([]);
    expect(repository.getRoom("room_harbor")!.participants.some((participant) => participant.agentId === createEffect.agentId)).toBe(true);
  }));

  it("Agent 创建的新 Agent 可在同一 Turn 作为正式数据用于创建协作房间", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_create_agent_room";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };
    const created = await getToolDefinition("create_agent")!.execute(context, {
      label: "方案评审员",
      summary: "负责独立评审方案",
      instruction: "检查方案风险并给出结论。",
    }, "tool_create_agent_for_room");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_agent") throw new Error("create_agent 未返回预期 effect");
    const roomResult = await getToolDefinition("create_room")!.execute(
      context,
      { title: "方案评审室", agentIds: [createEffect.agentId] },
      "tool_create_room_with_pending_agent",
    );
    const roomEffect = roomResult.effects[0];
    if (!roomEffect || roomEffect.type !== "create_room") throw new Error("create_room 未返回预期 effect");

    expect(repository.getRoom(roomEffect.roomId)!.participants.filter((participant) => participant.agentId).map((participant) => participant.agentId)).toEqual(["navigator", createEffect.agentId]);
    repository.finishTurn({ turnId, assistantContent: "internal", tools: [], timeline: [], effects: [...created.effects, ...roomResult.effects], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
  }));

  it("即时提交层原子限制每个 Turn 最多创建 16 个 Agent", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_create_agent_limit";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };
    const effects: TurnEffect[] = [];
    for (let index = 0; index < 16; index += 1) {
      const result = await getToolDefinition("create_agent")!.execute(
        context,
        { label: `临时编组 ${index + 1}`, summary: "执行分配任务", instruction: "完成收到的任务。" },
        `tool_create_agent_${index}`,
      );
      effects.push(...result.effects);
    }
    await expect(getToolDefinition("create_agent")!.execute(
      context,
      { label: "超额 Agent", summary: "不应创建", instruction: "不应执行。" },
      "tool_create_agent_over_limit",
    )).rejects.toThrow("每个 Turn 最多创建 16 个 Agent");

    expect(repository.getSnapshot().agents).toHaveLength(18);
    expect(repository.hasAgent("agent_over_limit")).toBe(false);
    repository.finishTurn({ turnId, assistantContent: "internal", tools: [], timeline: [], effects, modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
  }));

  it("创建房间返回前当前 Agent 已连接且多个受邀 Agent 已原子加入", async () => withRepository(async (repository) => {
    sendUser(repository, "room_harbor", "创建自由讨论房间并邀请执行者");
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_create_room";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };
    const result = await getToolDefinition("create_room")!.execute(context, { title: "自由讨论", agentIds: ["navigator", "builder", "builder"] }, "tool_create_room");
    const effect = result.effects[0];
    expect(effect).toMatchObject({ type: "create_room", title: "自由讨论", invitedAgentIds: ["builder"] });
    if (!effect || effect.type !== "create_room") throw new Error("create_room 未返回预期 effect");

    const room = repository.getRoom(effect.roomId)!;
    expect(room.participants.filter((participant) => participant.agentId).map((participant) => participant.agentId)).toEqual(["navigator", "builder"]);
    expect(room.participants.find((participant) => participant.id === room.ownerParticipantId)?.agentId).toBe("navigator");
    repository.finishTurn({ turnId, assistantContent: "internal", tools: [], timeline: [], effects: result.effects, modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
  }));

  it("create_room 在工具返回前可见、重复调用幂等，且后续 Turn 失败不会回滚房间", async () => withRepository(async (repository) => {
    sendUser(repository, "room_harbor", "立即创建诊断房间");
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_immediate_room";
    const invocationKey = `${turnId}:model:0:tool:0`;
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };
    resetWorkspaceEventHistory();

    const first = await getToolDefinition("create_room")!.execute(context, { title: "即时可见诊断", agentIds: ["builder"] }, "call_immediate_room", invocationKey);
    const firstEffect = first.effects[0];
    if (!firstEffect || firstEffect.type !== "create_room") throw new Error("create_room 未返回预期 effect");
    expect(repository.getRoom(firstEffect.roomId)).toMatchObject({ title: "即时可见诊断" });
    expect(eventsAfterId(0)).toContainEqual(expect.objectContaining({
      type: "workspace.changed",
      entityId: firstEffect.roomId,
      payload: expect.objectContaining({ kind: "tool_command_committed", toolName: "create_room" }),
    }));

    const versionAfterFirst = repository.getVersion();
    const replay = await getToolDefinition("create_room")!.execute(context, { title: "即时可见诊断", agentIds: ["builder"] }, "call_immediate_room_retry", invocationKey);
    expect(replay.effects[0]).toEqual(firstEffect);
    expect(repository.getVersion()).toEqual(versionAfterFirst);
    expect(repository.getSnapshot().rooms.filter((room) => room.title === "即时可见诊断")).toHaveLength(1);
    await expect(getToolDefinition("create_room")!.execute(context, { title: "错误复用参数", agentIds: ["builder"] }, "call_immediate_room_conflict", invocationKey))
      .rejects.toThrow("同一工具调用幂等键不能用于不同参数");

    repository.failTurn(turnId, "模拟工具后的模型失败");
    expect(repository.getRoom(firstEffect.roomId)).toMatchObject({ title: "即时可见诊断" });
  }));

  it("非测试运行拒绝在 finishTurn 阶段补交未执行的工具命令", () => withRepository((repository) => {
    sendUser(repository, "room_harbor", "验证收尾边界");
    const packet = packetFor(repository);
    repository.beginTurn({ turnId: "turn_reject_deferred_effect", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => repository.finishTurn({
        turnId: "turn_reject_deferred_effect",
        assistantContent: "internal",
        tools: [],
        timeline: [],
        effects: [{ type: "create_room", roomId: "room_must_not_be_deferred", title: "不应延迟创建", invitedAgentIds: [] }],
        modelMeta: {},
        cutoffSeq: packet.cutoffSeq,
        nextParticipantId: null,
      })).toThrow("Turn 收尾不能提交尚未执行的工具命令");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(repository.getRoom("room_must_not_be_deferred")).toBeNull();
  }));

  it("创建房间会在产生 effect 前拒绝不存在的受邀 Agent", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    await expect(getToolDefinition("create_room")!.execute(context, { title: "无效邀请", agentIds: ["missing-agent"] }, "tool_invalid_invite"))
      .rejects.toThrow("Agent 不存在：missing-agent");
    expect(repository.getSnapshot().rooms.some((room) => room.title === "无效邀请")).toBe(false);
  }));

  it("已连接 Agent 可从其他房间上下文继续邀请成员", async () => withRepository(async (repository) => {
    sendUser(repository, "room_harbor", "先创建房间");
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const createTurnId = "turn_create_owned_room";
    repository.beginTurn({ turnId: createTurnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId: createTurnId };
    const created = await getToolDefinition("create_room")!.execute(context, { title: "跨房间管理", agentIds: [] }, "tool_create_owned_room");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_room") throw new Error("create_room 未返回预期 effect");
    repository.finishTurn({ turnId: createTurnId, assistantContent: "internal", tools: [], timeline: [], effects: created.effects, modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    sendUser(repository, "room_harbor", "继续邀请");
    const nextPacket = packetFor(repository);
    const inviteTurnId = "turn_invite_cross_room";
    repository.beginTurn({ turnId: inviteTurnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet: nextPacket });
    const invited = await getToolDefinition("invite_agent")!.execute({ ...context, packet: nextPacket, turnId: inviteTurnId }, { roomId: createEffect.roomId, agentId: "builder" }, "tool_invite_cross_room");
    const applied = repository.finishTurn({ turnId: inviteTurnId, assistantContent: "internal", tools: [], timeline: [], effects: invited.effects, modelMeta: {}, cutoffSeq: nextPacket.cutoffSeq, nextParticipantId: null });
    expect(applied.triggerRoomIds).toEqual([createEffect.roomId]);
    expect(applied.messageRoomIds).toEqual([]);
    expect(repository.getRoom(createEffect.roomId)!.participants.some((participant) => participant.agentId === "builder")).toBe(true);

    sendUser(repository, "room_harbor", "重复邀请");
    const duplicatePacket = packetFor(repository);
    const duplicateTurnId = "turn_invite_cross_room_duplicate";
    repository.beginTurn({ turnId: duplicateTurnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet: duplicatePacket });
    const duplicate = await getToolDefinition("invite_agent")!.execute({ ...context, packet: duplicatePacket, turnId: duplicateTurnId }, { roomId: createEffect.roomId, agentId: "builder" }, "tool_invite_cross_room_duplicate");
    const duplicateApplied = repository.finishTurn({ turnId: duplicateTurnId, assistantContent: "internal", tools: [], timeline: [], effects: duplicate.effects, modelMeta: {}, cutoffSeq: duplicatePacket.cutoffSeq, nextParticipantId: null });
    expect(duplicateApplied.triggerRoomIds).toEqual([]);
    expect(repository.getRoom(createEffect.roomId)!.participants.filter((participant) => participant.agentId === "builder")).toHaveLength(1);
  }));

  it("进程恢复会重新投递工具已提交但尚未交给调度器的房间唤醒", async () => withRepository(async (repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "待恢复邀请房间", agentId: "navigator" });
    const targetRoom = repository.getSnapshot().rooms.find((room) => room.title === "待恢复邀请房间")!;
    sendUser(repository, "room_harbor", "邀请 Builder 并模拟进程退出");
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const turnId = "turn_invite_before_restart";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal, turnId };

    await getToolDefinition("invite_agent")!.execute(context, { roomId: targetRoom.id, agentId: "builder" }, "invite_before_restart", "task:restart:invite");

    expect(repository.getRoom(targetRoom.id)!.participants.some((participant) => participant.agentId === "builder")).toBe(true);
    const recovered = repository.recoverInterruptedRuns();
    expect(recovered).toContain(targetRoom.id);
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === turnId)?.status).toBe("error");

    repository.markRoomEffectDispatchesDispatched(targetRoom.id);
    expect(repository.recoverInterruptedRuns()).not.toContain(targetRoom.id);
  }));

  it("跨房间 handoff 在消息提交时建立续办关系，提前已读也不会被 Turn 收尾重新挂起", async () => withRepository(async (repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "即时 handoff 目标", agentId: "navigator" });
    const targetRoom = repository.getSnapshot().rooms.find((room) => room.title === "即时 handoff 目标")!;
    repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: targetRoom.id, agentId: "builder" });
    sendUser(repository, "room_harbor", "把任务交到目标房间");
    const sourcePacket = packetFor(repository);
    const sourceTurnId = "turn_immediate_handoff_source";
    repository.beginTurn({ turnId: sourceTurnId, roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: sourcePacket });
    const handoff = repository.commitTurnEffect({
      invocationKey: "task:immediate-handoff:message",
      turnId: sourceTurnId,
      agentId: "navigator",
      participantId: "participant_navigator_harbor",
      toolName: "public_message",
      effect: { type: "send_message", roomId: targetRoom.id, messageId: "message_immediate_handoff", messageKey: "immediate-handoff", content: "请处理且无需回复。", kind: "handoff" },
      awaitingRoomId: targetRoom.id,
    });
    expect(repository.raw.prepare("SELECT target_room_id,awaiting_message_id FROM turn_handoffs WHERE source_turn_id=?").get(sourceTurnId)).toEqual({
      target_room_id: targetRoom.id,
      awaiting_message_id: "message_immediate_handoff",
    });

    const builder = repository.getRoom(targetRoom.id)!.participants.find((participant) => participant.agentId === "builder")!;
    const targetPacket = packetFor(repository, targetRoom.id);
    const targetTurnId = "turn_immediate_handoff_receipt";
    repository.beginTurn({ turnId: targetTurnId, roomId: targetRoom.id, agentId: "builder", agentParticipantId: builder.id, packet: targetPacket });
    const receipt = repository.commitTurnEffect({
      invocationKey: "task:immediate-handoff:receipt",
      turnId: targetTurnId,
      agentId: "builder",
      participantId: builder.id,
      toolName: "read_no_reply",
      effect: { type: "read_no_reply", roomId: targetRoom.id, messageId: "message_immediate_handoff", receiptId: "receipt_immediate_handoff" },
    });
    repository.finishTurn({ turnId: targetTurnId, assistantContent: "无需回复", tools: [], timeline: [], effects: [receipt.effect], modelMeta: {}, cutoffSeq: targetPacket.cutoffSeq, nextParticipantId: null });
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);

    repository.finishTurn({ turnId: sourceTurnId, assistantContent: "已完成交接", tools: [], timeline: [], effects: [handoff.effect], awaitingRoomId: targetRoom.id, modelMeta: {}, cutoffSeq: sourcePacket.cutoffSeq, nextParticipantId: null });
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === sourceTurnId)?.status).toBe("completed");
  }));

  it("跨房间 handoff 提交后进程退出会继续目标房间而不重放来源任务", async () => withRepository(async (repository) => {
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "崩溃恢复 handoff 目标", agentId: "navigator" });
    const targetRoom = repository.getSnapshot().rooms.find((room) => room.title === "崩溃恢复 handoff 目标")!;
    repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: targetRoom.id, agentId: "builder" });
    sendUser(repository, "room_harbor", "交接后模拟进程退出");
    const packet = packetFor(repository);
    const turnId = "turn_handoff_restart_source";
    repository.beginTurn({ turnId, roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    repository.commitTurnEffect({
      invocationKey: "task:handoff-restart:message",
      turnId,
      agentId: "navigator",
      participantId: "participant_navigator_harbor",
      toolName: "public_message",
      effect: { type: "send_message", roomId: targetRoom.id, messageId: "message_handoff_restart", messageKey: "handoff-restart", content: "请在目标房间继续处理。", kind: "handoff" },
      awaitingRoomId: targetRoom.id,
    });

    const recovered = repository.recoverInterruptedRuns();
    expect(recovered).toContain(targetRoom.id);
    expect(recovered).not.toContain("room_harbor");
    expect(repository.getRoom("room_harbor")!.turns.find((turn) => turn.id === turnId)?.status).toBe("continued");
    expect(repository.getRoom("room_harbor")!.scheduler.cursorByParticipantId.participant_navigator_harbor).toBe(packet.cutoffSeq);
    expect(repository.raw.prepare("SELECT target_room_id,awaiting_message_id FROM turn_handoffs WHERE source_turn_id=?").get(turnId)).toEqual({
      target_room_id: targetRoom.id,
      awaiting_message_id: "message_handoff_restart",
    });
  }));

  it("shell 收到 abort 时终止活动进程树", async () => withRepository(async (repository) => {
    if (process.platform !== "win32") return;
    sendUser(repository, "room_harbor", "测试停止"); const packet = packetFor(repository); const agent = repository.getAgent("navigator")!; const controller = new AbortController();
    const promise = getToolDefinition("shell")!.execute({ agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: controller.signal }, { command: "Start-Sleep -Seconds 10" }, "tool_abort");
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }));
});
