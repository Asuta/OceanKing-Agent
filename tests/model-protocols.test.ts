import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPartialJsonStringField, runAgentModel } from "@/lib/server/model-runtime";
import { packetFor, sendUser, withRepository } from "./helpers";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";
import { subscribeWorkspaceEvents } from "@/lib/server/events";

function sse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("OpenAI 兼容协议", () => {
  it("从未完成 JSON 中安全提取已到达的字符串内容", () => {
    expect(extractPartialJsonStringField('{"content":"第一行\\n第二', "content")).toBe("第一行\n第二");
    expect(extractPartialJsonStringField('{"content":"等待\\u4e', "content")).toBe("等待");
    expect(extractPartialJsonStringField('{"roomId":', "roomId")).toBeNull();
  });

  it("接受完整 chat/completions 地址并归一化为兼容 API 根地址", () => {
    expect(normalizeOpenAiBaseUrl("https://api.deepseek.com/v1/chat/completions")).toBe("https://api.deepseek.com/v1");
  });
  it("解析 Responses SSE 的私有文本与 usage", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "只进入 Console" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 4, output_tokens: 3 } } },
      "[DONE]",
    ])));
    sendUser(repository, "room_harbor", "协议测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("只进入 Console"); expect(result.modelMeta.format).toBe("responses"); expect(result.effects).toEqual([]);
  }));

  it("auto 仅在首个 Responses 请求不兼容时回退 Chat Completions", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
      return sse([{ choices: [{ delta: { content: "兼容回退成功" } }] }, "[DONE]"]);
    });
    vi.stubGlobal("fetch", fetchMock);
    sendUser(repository, "room_harbor", "兼容测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "auto" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_fallback", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("兼容回退成功"); expect(result.modelMeta.format).toBe("chat_completions"); expect(fetchMock).toHaveBeenCalledTimes(2);
  }));

  it("Chat Completions 流式 function call 只产生结构化房间 effect", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; content?: string } | undefined;
      if (event.entityId === "turn_chat_tool" && payload?.kind === "room_message_preview" && payload.content) previewContents.push(payload.content);
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_emit", function: { name: "send_message_to_room", arguments: '{"roomId":"room_harbor","content":"正式' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "工具" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '消息","kind":"answer"}' } }] } }] },
        "[DONE]",
      ]);
      return sse([{ choices: [{ delta: { content: "工具之后的私有总结" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_tool", signal: new AbortController().signal }); unsubscribe();
    expect(result.assistantContent).toBe("工具之后的私有总结"); expect(result.effects).toHaveLength(1); expect(result.effects[0]).toMatchObject({ type: "send_message", content: "正式工具消息" }); expect(result.tools[0]?.status).toBe("completed");
    expect(previewContents).toEqual(["正式", "正式工具", "正式工具消息"]);
  }));

  it("DeepSeek 思考模式在工具子轮和后续用户轮次完整回传 reasoning_content", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { reasoning_content: "需要先公开工具" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_reasoning", function: { name: "send_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", content: "推理工具消息", kind: "answer" }) } }] } }] },
        "[DONE]",
      ]);
      if (call === 2) return sse([
        { choices: [{ delta: { reasoning_content: "工具已经执行，可以结束" } }] },
        { choices: [{ delta: { content: "第一轮私有总结" } }] },
        "[DONE]",
      ]);
      return sse([{ choices: [{ delta: { content: "第二轮私有总结" } }] }, "[DONE]"]);
    }));

    sendUser(repository, "room_harbor", "第一轮推理工具测试");
    const firstPacket = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "enabled" as const, reasoningEffort: "max" as const, maxToolSteps: 1 } };
    repository.beginTurn({ turnId: "turn_reasoning_1", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet: firstPacket });
    const firstResult = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet: firstPacket, turnId: "turn_reasoning_1", signal: new AbortController().signal });
    repository.finishTurn({ turnId: "turn_reasoning_1", assistantContent: firstResult.assistantContent, sessionMessages: firstResult.sessionMessages, tools: firstResult.tools, timeline: firstResult.timeline, effects: firstResult.effects, modelMeta: firstResult.modelMeta, cutoffSeq: firstPacket.cutoffSeq, nextParticipantId: null });

    expect(bodies[0]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
    expect((bodies[1]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort()).toEqual(["read_no_reply", "send_message_to_room"]);
    const firstContinuation = bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(firstContinuation.at(-2)).toMatchObject({ role: "assistant", reasoning_content: "需要先公开工具", tool_calls: [{ id: "call_reasoning" }] });
    expect(firstContinuation.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_reasoning" });

    sendUser(repository, "room_harbor", "第二轮继续追问");
    const secondPacket = packetFor(repository);
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet: secondPacket, turnId: "turn_reasoning_2", signal: new AbortController().signal });
    const secondTurnMessages = bodies[2]?.messages as Array<Record<string, unknown>>;
    expect(secondTurnMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", reasoning_content: "需要先公开工具", tool_calls: [expect.objectContaining({ id: "call_reasoning" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_reasoning" }),
    ]));
    expect(firstResult.modelMeta).toMatchObject({ toolSteps: 1, reasoningCharacters: 18 });
  }));

  it("DeepSeek 跟随服务商默认思考模式时仍应用 reasoning_effort", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([{ choices: [{ delta: { content: "默认思考强度生效" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "默认思考强度"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "provider_default" as const, reasoningEffort: "max" as const } };
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_default_reasoning", signal: new AbortController().signal });
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "max" });
    expect(requestBodies[0]?.thinking).toBeUndefined();
  }));

  it("普通工具步骤耗尽后仍允许终结工具公开结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_terminal", function: { name: "send_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", content: "达到上限后的正式结果", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "私有收尾" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "工具上限测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const, maxToolSteps: 1 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_terminal_tool", signal: new AbortController().signal });
    expect(result.tools.map((tool) => tool.name)).toEqual(["read_room_history", "send_message_to_room"]);
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "达到上限后的正式结果" })]);
    expect((bodies[1]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort()).toEqual(["read_no_reply", "send_message_to_room"]);
    expect(bodies[2]?.tools).toBeUndefined();
  }));

  it("Responses function arguments 发布跨片段房间预览", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; content?: string } | undefined;
      if (event.entityId === "turn_responses_tool" && payload?.kind === "room_message_preview" && payload.content && previewContents.at(-1) !== payload.content) previewContents.push(payload.content);
    });
    let call = 0; const fullArguments = JSON.stringify({ roomId: "room_harbor", content: "Responses 流式消息", kind: "answer" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { type: "response.output_item.added", item: { id: "item_1", call_id: "call_responses", type: "function_call", name: "send_message_to_room", arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '{"roomId":"room_harbor","content":"Responses ' },
        { type: "response.function_call_arguments.delta", item_id: "item_1", delta: '流式消息","kind":"answer"}' },
        { type: "response.output_item.done", item: { id: "item_1", call_id: "call_responses", type: "function_call", name: "send_message_to_room", arguments: fullArguments } },
        { type: "response.completed", response: { id: "resp_tools" } }, "[DONE]",
      ]);
      return sse([{ type: "response.output_text.delta", delta: "私有总结" }, { type: "response.completed", response: { id: "resp_done" } }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "Responses 工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses_tool", signal: new AbortController().signal }); unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", content: "Responses 流式消息" });
    expect(previewContents).toEqual(["Responses ", "Responses 流式消息"]);
  }));
});
