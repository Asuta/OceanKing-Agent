import { describe, expect, it } from "vitest";
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

  it("Agent 创建的新 Agent 可在同一 Turn 加入非 owner 的已连接房间", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    const created = await getToolDefinition("create_agent")!.execute(context, {
      label: "资料研究员",
      summary: "负责检索和整理资料",
      instruction: "独立检索资料并给出来源。",
    }, "tool_create_agent");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_agent") throw new Error("create_agent 未返回预期 effect");
    expect(repository.hasAgent(createEffect.agentId)).toBe(false);

    const pendingContext = { ...context, pendingEffects: created.effects };
    const listed = await getToolDefinition("list_available_agents")!.execute(pendingContext, {}, "tool_list_pending_agent");
    expect(listed.structured).toContainEqual(expect.objectContaining({ id: createEffect.agentId, label: "资料研究员", pending: true }));
    const invited = await getToolDefinition("invite_agent")!.execute(pendingContext, { roomId: "room_harbor", agentId: createEffect.agentId }, "tool_invite_created_agent");

    repository.beginTurn({ turnId: "turn_create_and_invite_agent", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet });
    repository.finishTurn({ turnId: "turn_create_and_invite_agent", assistantContent: "internal", tools: [], timeline: [], effects: [...created.effects, ...invited.effects], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    expect(repository.getAgent(createEffect.agentId)).toMatchObject({
      label: "资料研究员",
      summary: "负责检索和整理资料",
      instruction: "独立检索资料并给出来源。",
      settings: agent.settings,
    });
    expect(repository.getAgentSession(createEffect.agentId)).toEqual([]);
    expect(repository.getRoom("room_harbor")!.participants.some((participant) => participant.agentId === createEffect.agentId)).toBe(true);
  }));

  it("Agent 创建的新 Agent 可在同一 Turn 用于创建协作房间", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    const created = await getToolDefinition("create_agent")!.execute(context, {
      label: "方案评审员",
      summary: "负责独立评审方案",
      instruction: "检查方案风险并给出结论。",
    }, "tool_create_agent_for_room");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_agent") throw new Error("create_agent 未返回预期 effect");
    const roomResult = await getToolDefinition("create_room")!.execute(
      { ...context, pendingEffects: created.effects },
      { title: "方案评审室", agentIds: [createEffect.agentId] },
      "tool_create_room_with_pending_agent",
    );
    const roomEffect = roomResult.effects[0];
    if (!roomEffect || roomEffect.type !== "create_room") throw new Error("create_room 未返回预期 effect");

    repository.beginTurn({ turnId: "turn_create_agent_room", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet });
    repository.finishTurn({ turnId: "turn_create_agent_room", assistantContent: "internal", tools: [], timeline: [], effects: [...created.effects, ...roomResult.effects], modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    expect(repository.getRoom(roomEffect.roomId)!.participants.filter((participant) => participant.agentId).map((participant) => participant.agentId)).toEqual(["navigator", createEffect.agentId]);
  }));

  it("每个 Turn 最多创建 16 个 Agent，仓库提交层也执行相同限制", async () => withRepository(async (repository) => {
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    const effects: TurnEffect[] = [];
    for (let index = 0; index < 16; index += 1) {
      const result = await getToolDefinition("create_agent")!.execute(
        { ...context, pendingEffects: effects },
        { label: `临时编组 ${index + 1}`, summary: "执行分配任务", instruction: "完成收到的任务。" },
        `tool_create_agent_${index}`,
      );
      effects.push(...result.effects);
    }
    await expect(getToolDefinition("create_agent")!.execute(
      { ...context, pendingEffects: effects },
      { label: "超额 Agent", summary: "不应创建", instruction: "不应执行。" },
      "tool_create_agent_over_limit",
    )).rejects.toThrow("每个 Turn 最多创建 16 个 Agent");

    repository.beginTurn({ turnId: "turn_create_agent_limit", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet });
    expect(() => repository.finishTurn({
      turnId: "turn_create_agent_limit",
      assistantContent: "internal",
      tools: [],
      timeline: [],
      effects: [...effects, { type: "create_agent", agentId: "agent_over_limit", label: "超额 Agent", summary: "不应创建", instruction: "不应执行。" }],
      modelMeta: {},
      cutoffSeq: packet.cutoffSeq,
      nextParticipantId: null,
    })).toThrow("每个 Turn 最多创建 16 个 Agent");
    expect(repository.getSnapshot().agents).toHaveLength(2);
  }));

  it("创建房间时当前 Agent 自动连接并原子邀请多个 Agent", async () => withRepository(async (repository) => {
    sendUser(repository, "room_harbor", "创建自由讨论房间并邀请执行者");
    const packet = packetFor(repository);
    const agent = repository.getAgent("navigator")!;
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    const result = await getToolDefinition("create_room")!.execute(context, { title: "自由讨论", agentIds: ["navigator", "builder", "builder"] }, "tool_create_room");
    const effect = result.effects[0];
    expect(effect).toMatchObject({ type: "create_room", title: "自由讨论", invitedAgentIds: ["builder"] });
    if (!effect || effect.type !== "create_room") throw new Error("create_room 未返回预期 effect");

    repository.beginTurn({ turnId: "turn_create_room", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet });
    repository.finishTurn({ turnId: "turn_create_room", assistantContent: "internal", tools: [], timeline: [], effects: result.effects, modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    const room = repository.getRoom(effect.roomId)!;
    expect(room.participants.filter((participant) => participant.agentId).map((participant) => participant.agentId)).toEqual(["navigator", "builder"]);
    expect(room.participants.find((participant) => participant.id === room.ownerParticipantId)?.agentId).toBe("navigator");
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
    const context = { agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: new AbortController().signal };
    const created = await getToolDefinition("create_room")!.execute(context, { title: "跨房间管理", agentIds: [] }, "tool_create_owned_room");
    const createEffect = created.effects[0];
    if (!createEffect || createEffect.type !== "create_room") throw new Error("create_room 未返回预期 effect");
    repository.beginTurn({ turnId: "turn_create_owned_room", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet });
    repository.finishTurn({ turnId: "turn_create_owned_room", assistantContent: "internal", tools: [], timeline: [], effects: created.effects, modelMeta: {}, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });

    const invited = await getToolDefinition("invite_agent")!.execute(context, { roomId: createEffect.roomId, agentId: "builder" }, "tool_invite_cross_room");
    sendUser(repository, "room_harbor", "继续邀请");
    const nextPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_invite_cross_room", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet: nextPacket });
    const applied = repository.finishTurn({ turnId: "turn_invite_cross_room", assistantContent: "internal", tools: [], timeline: [], effects: invited.effects, modelMeta: {}, cutoffSeq: nextPacket.cutoffSeq, nextParticipantId: null });
    expect(applied.triggerRoomIds).toEqual([createEffect.roomId]);
    expect(applied.messageRoomIds).toEqual([]);
    expect(repository.getRoom(createEffect.roomId)!.participants.some((participant) => participant.agentId === "builder")).toBe(true);

    const duplicate = await getToolDefinition("invite_agent")!.execute(context, { roomId: createEffect.roomId, agentId: "builder" }, "tool_invite_cross_room_duplicate");
    sendUser(repository, "room_harbor", "重复邀请");
    const duplicatePacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_invite_cross_room_duplicate", roomId: "room_harbor", agentId: agent.id, agentParticipantId: context.agentParticipantId, packet: duplicatePacket });
    const duplicateApplied = repository.finishTurn({ turnId: "turn_invite_cross_room_duplicate", assistantContent: "internal", tools: [], timeline: [], effects: duplicate.effects, modelMeta: {}, cutoffSeq: duplicatePacket.cutoffSeq, nextParticipantId: null });
    expect(duplicateApplied.triggerRoomIds).toEqual([]);
    expect(repository.getRoom(createEffect.roomId)!.participants.filter((participant) => participant.agentId === "builder")).toHaveLength(1);
  }));

  it("shell 收到 abort 时终止活动进程树", async () => withRepository(async (repository) => {
    if (process.platform !== "win32") return;
    sendUser(repository, "room_harbor", "测试停止"); const packet = packetFor(repository); const agent = repository.getAgent("navigator")!; const controller = new AbortController();
    const promise = getToolDefinition("shell")!.execute({ agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: controller.signal }, { command: "Start-Sleep -Seconds 10" }, "tool_abort");
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }));
});
