import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { extractPartialJsonStringField, ModelRunError, runAgentModel } from "@/lib/server/model-runtime";
import { packetFor, sendUser, withRepository } from "./helpers";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";
import { subscribeWorkspaceEvents } from "@/lib/server/events";

function sse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function expectProgressivePreview(contents: string[], completeContent: string): void {
  expect(contents.length).toBeGreaterThan(1);
  expect(contents[0]?.length).toBeLessThan(completeContent.length);
  expect(contents.at(-1)).toBe(completeContent);
  contents.forEach((content, index) => {
    expect(completeContent.startsWith(content)).toBe(true);
    if (index > 0) expect(content.length).toBeGreaterThan(contents[index - 1]!.length);
  });
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
  it("官方 OpenAI 使用原生 reasoning 参数且禁用时不覆盖模型默认值", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push(requestBody(init));
      return url.endsWith("/responses")
        ? sse([{ type: "response.output_text.delta", delta: "Responses" }, { type: "response.completed", response: { id: "resp_openai" } }, "[DONE]"])
        : sse([{ choices: [{ delta: { content: "Chat" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "官方协议测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const run = (apiFormat: "responses" | "chat_completions", thinkingMode: "enabled" | "disabled", turnId: string) => runAgentModel({ repository, agent: { ...base, settings: { ...base.settings, apiFormat, thinkingMode, reasoningEffort: "high" as const } }, agentParticipantId: "participant_navigator_harbor", packet, turnId, signal: new AbortController().signal });
    await run("responses", "enabled", "turn_openai_responses_on"); await run("chat_completions", "enabled", "turn_openai_chat_on");
    await run("responses", "disabled", "turn_openai_responses_off"); await run("chat_completions", "disabled", "turn_openai_chat_off");
    expect(requests).toHaveLength(4);
    expect(requests[0]?.reasoning).toEqual({ effort: "high" }); expect(requests[1]?.reasoning_effort).toBe("high");
    expect(requests[2]).not.toHaveProperty("reasoning"); expect(requests[3]).not.toHaveProperty("reasoning_effort");
    expect(requests.every((request) => !("thinking" in request))).toBe(true);
  }));
  it("解析 Responses SSE 的私有文本与 usage", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let sentBody: { input: Array<{ content: string }>; thinking?: { type: string } } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = requestBody(init) as typeof sentBody;
      return sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "只进入 Console" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 6 }, output_tokens: 3, total_tokens: 13 } } },
      "[DONE]",
    ]);
    }));
    sendUser(repository, "room_harbor", "Responses 历史"); const historicalPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_responses_history", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: historicalPacket });
    repository.finishTurn({ turnId: "turn_responses_history", assistantContent: "需要跨轮保留", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: historicalPacket.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    sendUser(repository, "room_harbor", "协议测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("只进入 Console"); expect(result.modelMeta.format).toBe("responses"); expect(result.effects).toEqual([]);
    expect(result.modelMeta.modelCalls).toEqual([expect.objectContaining({ index: 1, format: "responses", purpose: "generation", inputTokens: 10, cachedInputTokens: 6, cacheMissInputTokens: 4, outputTokens: 3, totalTokens: 13, cacheHitRate: 0.6 })]);
    expect(sentBody?.input.some((item) => item.content === "需要跨轮保留")).toBe(true);
    expect(sentBody?.thinking).toEqual({ type: "disabled" });
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
    expect(result.modelMeta.modelCalls).toEqual([
      expect.objectContaining({ index: 1, format: "responses", status: "error" }),
      expect.objectContaining({ index: 2, format: "chat_completions", status: "completed" }),
    ]);
  }));

  it("模型运行失败时仍把已经发生的调用统计保存到 Turn", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_invalid", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }] },
      { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 75 }, completion_tokens: 5, total_tokens: 105 } },
      "[DONE]",
    ])));
    sendUser(repository, "room_harbor", "失败调用统计"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, maxToolSteps: 0 } };
    repository.beginTurn({ turnId: "turn_failed_model_call", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });

    let failure: unknown;
    try {
      await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_failed_model_call", signal: new AbortController().signal });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelRunError);
    if (!(failure instanceof ModelRunError)) throw new Error("预期 ModelRunError");
    repository.failTurn("turn_failed_model_call", failure.message, false, failure.modelMeta);

    const turn = repository.getRoom("room_harbor")?.turns.find((candidate) => candidate.id === "turn_failed_model_call");
    expect(turn?.status).toBe("error");
    expect(turn?.modelMeta?.modelCalls).toEqual([
      expect.objectContaining({ index: 1, cachedInputTokens: 75, cacheHitRate: 0.75 }),
    ]);
  }));

  it("Chat Completions 会发送完整 Agent 会话，不再只取最后 12 条", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", "需要长期记住的任务"); const historicalPacket = packetFor(repository);
    for (let index = 0; index < 7; index += 1) {
      const turnId = `turn_complete_history_${index}`;
      repository.beginTurn({ turnId, roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: historicalPacket });
      repository.finishTurn({ turnId, assistantContent: `完整历史结果 ${index}`, tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: historicalPacket.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    }
    sendUser(repository, "room_harbor", "继续任务"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, contextTokenThreshold: 1_000_000 } };
    let sentMessages: Array<{ role: string; content: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentMessages = (JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }).messages;
      return sse([{ choices: [{ delta: { content: "已续接完整历史" } }] }, "[DONE]"]);
    }));
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_full_history", signal: new AbortController().signal });
    expect(sentMessages).toHaveLength(16);
    expect(sentMessages.some((message) => message.content === "完整历史结果 0")).toBe(true);
  }));

  it("上下文超过 Token 阈值时先整体压缩，再持久化压缩上下文并继续请求", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", `关键历史：${"必须保留的事实。".repeat(4_000)}`); const historicalPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_before_compaction", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: historicalPacket });
    repository.finishTurn({ turnId: "turn_before_compaction", assistantContent: "旧任务尚未完成", tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: historicalPacket.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    sendUser(repository, "room_harbor", "请继续完成旧任务"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, contextTokenThreshold: 8_000 } };
    repository.beginTurn({ turnId: "turn_compacted", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      requestBodies.push(body);
      if (requestBodies.length === 1) return sse([{ choices: [{ delta: { content: "用户要求继续旧任务；关键事实必须保留；当前尚未完成。" } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "基于压缩上下文继续执行" } }] }, "[DONE]"]);
    }));
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_compacted", signal: new AbortController().signal });
    repository.finishTurn({ turnId: "turn_compacted", assistantContent: result.assistantContent, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.messages[0]?.content).toContain("上下文压缩器");
    expect(requestBodies[1]?.messages).toHaveLength(2);
    expect(requestBodies[1]?.messages[1]?.content).toContain("用户要求继续旧任务");
    expect(result.contextCompaction).toMatchObject({ threshold: 8_000, sourceEntries: 3 });
    expect((result.modelMeta.modelCalls as Array<{ purpose: string }>).map((call) => call.purpose)).toEqual(["compaction", "generation"]);
    const session = repository.getAgentSession("navigator");
    expect(session).toHaveLength(2);
    expect(session[0]?.content).toContain("此前完整 Agent 会话的压缩上下文");
    expect(session[0]?.content).not.toContain("必须保留的事实。必须保留的事实。必须保留的事实。");
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
        { choices: [], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 5, total_tokens: 105 } },
        "[DONE]",
      ]);
      return sse([
        { choices: [{ delta: { content: "工具之后的私有总结" } }] },
        { choices: [], usage: { prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens: 8, total_tokens: 128 } },
        "[DONE]",
      ]);
    }));
    sendUser(repository, "room_harbor", "工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_tool", signal: new AbortController().signal }); unsubscribe();
    expect(result.assistantContent).toBe("工具之后的私有总结"); expect(result.effects).toHaveLength(1); expect(result.effects[0]).toMatchObject({ type: "send_message", content: "正式工具消息" }); expect(result.tools[0]?.status).toBe("completed");
    expect(result.modelMeta.modelCalls).toEqual([
      expect.objectContaining({ index: 1, cachedInputTokens: 80, cacheMissInputTokens: 20, cacheHitRate: 0.8 }),
      expect.objectContaining({ index: 2, cachedInputTokens: 90, cacheMissInputTokens: 30, cacheHitRate: 0.75 }),
    ]);
    expectProgressivePreview(previewContents, "正式工具消息");
  }));

  it("Chat Completions 单块 function call 也逐步发布房间预览", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; content?: string } | undefined;
      if (event.entityId === "turn_chat_single_chunk" && payload?.kind === "room_message_preview" && payload.content) previewContents.push(payload.content);
    });
    let call = 0; const completeContent = "供应商一次返回的完整公开消息";
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_single_chunk", function: { name: "send_message_to_room", arguments: JSON.stringify({ content: completeContent, kind: "answer", roomId: "room_harbor" }) } }] } }] },
        "[DONE]",
      ]);
      return sse([{ choices: [{ delta: { content: "私有总结" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "单块工具参数测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_single_chunk", signal: new AbortController().signal }); unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", content: completeContent });
    expectProgressivePreview(previewContents, completeContent);
  }));

  it("工具执行后模型续轮失败时仍可从 Turn 审计中还原命令与工具结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return sse([{
        choices: [{ delta: { content: "我先读取历史。", tool_calls: [{ index: 0, id: "call_before_provider_failure", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }],
      }, "[DONE]"]);
      return new Response("provider failed", { status: 500 });
    }));
    sendUser(repository, "room_harbor", "失败检查点测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    repository.beginTurn({ turnId: "turn_provider_failure", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });

    await expect(runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_provider_failure", signal: new AbortController().signal })).rejects.toThrow("模型接口错误 500");
    repository.failTurn("turn_provider_failure", "模型接口错误 500");

    const turn = repository.getAgentConversation("navigator")!.turns.find((entry) => entry.id === "turn_provider_failure")!;
    expect(turn.status).toBe("error");
    expect(turn.assistantContent).toBe("我先读取历史。");
    expect(turn.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "我先读取历史。", tool_calls: [expect.objectContaining({ id: "call_before_provider_failure" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_before_provider_failure" }),
    ]));
    expect(turn.tools[0]).toMatchObject({ id: "call_before_provider_failure", name: "read_room_history", status: "completed" });
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

  it("Chat 工具输出让上下文越过阈值时，会在下一次模型请求前整体压缩", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const fileName = "large-tool-context.txt";
    await fs.writeFile(path.join(repository.dataDir, fileName), Array.from({ length: 3_000 }, (_, index) => `工具关键事实 ${index}：仍需继续处理。`).join("\n"));
    const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      requestBodies.push(body);
      if (requestBodies.length === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_large_read", function: { name: "read_project_context", arguments: JSON.stringify({ root: repository.dataDir, path: fileName }) } }] } }] },
        "[DONE]",
      ]);
      if (requestBodies.length === 2) return sse([{ choices: [{ delta: { content: "工具返回了大量关键事实，任务仍需继续。" } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "已在压缩后继续处理" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "读取大文件并继续"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, contextTokenThreshold: 15_000, projectContextRoots: [repository.dataDir] } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_large_tool_context", signal: new AbortController().signal });
    expect(result.tools[0]?.outputText.length).toBeGreaterThan(50_000);
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]?.messages[0]?.content).toContain("上下文压缩器");
    expect(requestBodies[2]?.messages[1]?.content).toContain("工具返回了大量关键事实");
    expect(result.contextCompaction).toMatchObject({ threshold: 15_000 });
    expect(result.sessionMessages.some((message) => message.role === "tool" && message.tool_call_id === "call_large_read")).toBe(false);
    expect(result.auditMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call_large_read" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_large_read" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("此前完整 Agent 会话的压缩上下文") }),
    ]));
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
    expectProgressivePreview(previewContents, "Responses 流式消息");
  }));

  it("Responses 完成事件一次给出完整参数时也逐步发布房间预览", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; content?: string } | undefined;
      if (event.entityId === "turn_responses_single_chunk" && payload?.kind === "room_message_preview" && payload.content) previewContents.push(payload.content);
    });
    let call = 0; const completeContent = "Responses 一次返回的完整公开消息"; const fullArguments = JSON.stringify({ content: completeContent, kind: "answer", roomId: "room_harbor" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { type: "response.output_item.added", item: { id: "item_single", call_id: "call_responses_single", type: "function_call", name: "send_message_to_room", arguments: "" } },
        { type: "response.output_item.done", item: { id: "item_single", call_id: "call_responses_single", type: "function_call", name: "send_message_to_room", arguments: fullArguments } },
        { type: "response.completed", response: { id: "resp_single" } }, "[DONE]",
      ]);
      return sse([{ type: "response.output_text.delta", delta: "私有总结" }, { type: "response.completed", response: { id: "resp_single_done" } }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "Responses 单块工具参数测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses_single_chunk", signal: new AbortController().signal }); unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", content: completeContent });
    expectProgressivePreview(previewContents, completeContent);
  }));
});
