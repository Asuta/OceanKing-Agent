import { describe, expect, it } from "vitest";
import { runAgentModel } from "@/lib/server/model-runtime";
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
      repository.finishTurn({ turnId: "turn_builder_emit", assistantContent: "internal", tools: [], timeline: [], effects: [{ type: "send_message", roomId: "room_harbor", messageId: "agent_message", messageKey: "agent-message", content: "另一个 Agent 的正式结果", kind: "answer" }], modelMeta: {}, cutoffSeq: userPacket.cutoffSeq, nextParticipantId: null });
      const packet = packetFor(repository); const agent = repository.getAgent("navigator")!;
      const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_no_echo", signal: new AbortController().signal });
      expect(result.effects[0]?.type).toBe("read_no_reply");
      expect(result.effects.some((effect) => effect.type === "send_message")).toBe(false);
    } finally { if (original) process.env.OPENAI_API_KEY = original; }
  }));

  it("工具注册表包含房间、工作区、基础与 Cron 能力", () => {
    const names = new Set(listToolDefinitions().map((tool) => tool.name));
    for (const name of ["send_message_to_room", "read_no_reply", "read_room_history", "workspace_read", "workspace_write", "shell", "web_fetch", "create_cron_job"]) expect(names.has(name)).toBe(true);
  });

  it("shell 收到 abort 时终止活动进程树", async () => withRepository(async (repository) => {
    if (process.platform !== "win32") return;
    sendUser(repository, "room_harbor", "测试停止"); const packet = packetFor(repository); const agent = repository.getAgent("navigator")!; const controller = new AbortController();
    const promise = getToolDefinition("shell")!.execute({ agent, roomId: "room_harbor", agentParticipantId: "participant_navigator_harbor", packet, repository, signal: controller.signal }, { command: "Start-Sleep -Seconds 10" }, "tool_abort");
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  }));
});
