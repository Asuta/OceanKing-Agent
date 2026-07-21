import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { maxRoomMessageContentCharacters } from "@/lib/domain/schemas";
import { countRenderedContextTokens } from "@/lib/server/context-compaction";
import { ModelRunError, runAgentModel } from "@/lib/server/model-runtime";
import { commandBase, packetFor, sendUser, withRepository } from "./helpers";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";
import { subscribeWorkspaceEvents } from "@/lib/server/events";

function sse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function gatedSse(
  first: Array<Record<string, unknown> | "[DONE]">,
  rest: Array<Record<string, unknown> | "[DONE]">,
  release: Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const encode = (events: Array<Record<string, unknown> | "[DONE]">) => encoder.encode(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encode(first));
      await release;
      controller.enqueue(encode(rest));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
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

function appendRoomPreview(contents: string[], event: { entityId?: string; payload?: unknown }, turnId: string): string | null {
  const payload = event.payload as { kind?: string; delta?: string; content?: string } | undefined;
  if (event.entityId !== turnId || payload?.kind !== "room_message_preview") return null;
  const content = payload.content ?? `${contents.at(-1) ?? ""}${payload.delta ?? ""}`;
  if (!content) return null;
  contents.push(content);
  return content;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("OpenAI 兼容协议", () => {
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
    const reasoningEvents: unknown[] = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string } | undefined;
      if (event.entityId === "turn_responses" && payload?.kind === "reasoning_delta") reasoningEvents.push(payload);
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = requestBody(init) as typeof sentBody;
      return sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.reasoning_summary_text.delta", delta: "Responses 推理摘要" },
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
    unsubscribe();
    expect(result.assistantContent).toBe("只进入 Console"); expect(result.modelMeta.format).toBe("responses"); expect(result.effects).toEqual([]);
    expect(reasoningEvents).toEqual([]);
    expect(result.modelMeta.modelCalls).toEqual([expect.objectContaining({ index: 1, format: "responses", purpose: "generation", inputTokens: 10, cachedInputTokens: 6, cacheMissInputTokens: 4, outputTokens: 3, totalTokens: 13, cacheHitRate: 0.6 })]);
    expect(sentBody?.input.some((item) => item.content === "需要跨轮保留")).toBe(true);
    expect(sentBody?.input.at(-1)?.content).toContain("[内部房间调度增量]");
    expect(sentBody?.input.at(-1)?.content).not.toContain("connectedRooms");
    expect(sentBody?.input.at(-1)?.content).not.toContain("availableAgents");
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
      expect.objectContaining({ index: 2, cachedInputTokens: 75, cacheHitRate: 0.75 }),
      expect.objectContaining({ index: 3, cachedInputTokens: 75, cacheHitRate: 0.75 }),
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
    expect(sentMessages.at(-1)?.content).toContain("[内部房间调度增量]");
    expect(sentMessages.at(-1)?.content).not.toContain("connectedRooms");
    expect(sentMessages.at(-1)?.content).not.toContain("availableAgents");
  }));

  it("跨用户轮次保持稳定前缀，把动态房间和消息信息放在历史末尾", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
    let currentMessageId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> });
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_read_${bodies.length}`, function: { name: "read_no_reply", arguments: JSON.stringify({ roomId: "room_harbor", messageId: currentMessageId }) } }] } }] }, "[DONE]"]);
    }));
    const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };

    sendUser(repository, "room_harbor", "第一轮缓存前缀"); const firstPacket = packetFor(repository); currentMessageId = firstPacket.targetMessageId;
    repository.beginTurn({ turnId: "turn_cache_prefix_1", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet: firstPacket });
    const first = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet: firstPacket, turnId: "turn_cache_prefix_1", signal: new AbortController().signal });
    repository.finishTurn({ turnId: "turn_cache_prefix_1", assistantContent: first.assistantContent, sessionMessages: first.sessionMessages, tools: first.tools, timeline: first.timeline, effects: first.effects, modelMeta: first.modelMeta, cutoffSeq: firstPacket.cutoffSeq, nextParticipantId: null });

    sendUser(repository, "room_harbor", "第二轮缓存前缀"); const secondPacket = packetFor(repository); currentMessageId = secondPacket.targetMessageId;
    repository.beginTurn({ turnId: "turn_cache_prefix_2", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet: secondPacket });
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet: secondPacket, turnId: "turn_cache_prefix_2", signal: new AbortController().signal });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.messages.slice(0, bodies[0]!.messages.length)).toEqual(bodies[0]?.messages);
    expect(bodies[0]?.messages[0]?.content).not.toContain(firstPacket.targetMessageId);
    expect(bodies[1]?.messages[0]?.content).not.toContain(secondPacket.targetMessageId);
    expect(bodies[0]?.messages.at(-1)?.content).toContain(firstPacket.targetMessageId);
    expect(bodies[1]?.messages.at(-1)?.content).toContain(secondPacket.targetMessageId);
  }));

  it("发送新协议请求前把旧公开消息工具转换为普通历史正文", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", "旧协议历史"); const oldPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_legacy_history", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: oldPacket });
    repository.finishTurn({
      turnId: "turn_legacy_history", assistantContent: "旧轮私有记录",
      sessionMessages: [
        { role: "assistant", content: "旧轮私有记录", tool_calls: [{ id: "legacy_call", type: "function", function: { name: "send_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", content: "不应再次进入模型上下文的旧正文", kind: "answer" }) } }] },
        { role: "tool", tool_call_id: "legacy_call", content: "旧工具已经提交" },
      ],
      tools: [], timeline: [], effects: [], modelMeta: {}, cutoffSeq: oldPacket.cutoffSeq, nextParticipantId: null,
    });
    sendUser(repository, "room_harbor", "使用新协议继续"); const packet = packetFor(repository); const requestBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(requestBody(init));
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read_new", function: { name: "read_no_reply", arguments: JSON.stringify({ roomId: "room_harbor", messageId: packet.targetMessageId }) } }] } }] }, "[DONE]"]);
    }));
    const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_clean_legacy_history", signal: new AbortController().signal });
    const renderedMessages = JSON.stringify((requestBodies[0]?.messages as unknown[]).slice(1));
    expect(renderedMessages).not.toContain("send_message_to_room");
    expect(renderedMessages).toContain("[历史公开回复到房间 room_harbor]");
    expect(renderedMessages).toContain("不应再次进入模型上下文的旧正文");
    expect(renderedMessages).toContain("旧轮私有记录");
  }));

  it("上下文超过 Token 阈值时先整体压缩，再持久化压缩上下文并继续请求", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", `关键历史：${"必须保留的事实。".repeat(4_000)}`); const historicalPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_before_compaction", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: historicalPacket });
    repository.finishTurn({
      turnId: "turn_before_compaction", assistantContent: "旧任务历史记录", tools: [], timeline: [],
      effects: [{ type: "read_no_reply", roomId: "room_harbor", messageId: historicalPacket.targetMessageId, receiptId: "receipt_before_compaction" }],
      modelMeta: {}, cutoffSeq: historicalPacket.cutoffSeq, nextParticipantId: null,
    });
    sendUser(repository, "room_harbor", "请继续完成旧任务"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, contextTokenThreshold: 8_000, maxToolSteps: 0 } };
    repository.beginTurn({ turnId: "turn_compacted", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet });
    const requestBodies: Array<{ messages: Array<{ role: string; content: string }>; tools?: unknown; tool_choice?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }>; tools?: unknown; tool_choice?: string };
      requestBodies.push(body);
      if (requestBodies.length === 1) return sse([{ choices: [{ delta: { content: "用户要求继续旧任务；关键事实必须保留；当前尚未完成。" } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_compacted_delivery", function: { name: "read_no_reply", arguments: JSON.stringify({ roomId: "room_harbor", messageId: packet.targetMessageId }) } }] } }] }, "[DONE]"]);
    }));
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_compacted", signal: new AbortController().signal });
    repository.finishTurn({ turnId: "turn_compacted", assistantContent: result.assistantContent, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: packet.cutoffSeq, nextParticipantId: "participant_navigator_harbor" });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.messages[0]?.content).toContain("OceanKing 多 Agent 工作台");
    expect(requestBodies[0]?.messages.at(-2)?.content).toContain("上下文压缩器");
    expect(requestBodies[0]?.tool_choice).toBe("auto");
    expect(requestBodies[1]?.messages).toHaveLength(2);
    expect(requestBodies[1]?.messages[1]?.content).toContain("用户要求继续旧任务");
    expect(result.contextCompaction).toMatchObject({ threshold: 8_000, sourceEntries: 3 });
    expect((result.modelMeta.modelCalls as Array<{ purpose: string }>).map((call) => call.purpose)).toEqual(["compaction", "generation"]);
    const session = repository.getAgentSession("navigator");
    expect(session).toHaveLength(2);
    expect(session[0]?.content).toContain("此前完整 Agent 会话的压缩上下文");
    expect(session[0]?.content).not.toContain("必须保留的事实。必须保留的事实。必须保留的事实。");
  }));

  it("把模型误发的旧 send_message 调用升级为新公开正文阶段", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => { appendRoomPreview(previewContents, event, "turn_chat_tool"); });
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
        { choices: [{ delta: { content: "升级后的" } }] },
        { choices: [{ delta: { content: "普通正文流" } }] },
        { choices: [], usage: { prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 90 }, completion_tokens: 8, total_tokens: 128 } },
        "[DONE]",
      ]);
    }));
    sendUser(repository, "room_harbor", "工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_tool", signal: new AbortController().signal }); unsubscribe();
    expect(result.assistantContent).toBe(""); expect(result.effects).toHaveLength(1); expect(result.effects[0]).toMatchObject({ type: "send_message", content: "升级后的普通正文流" }); expect(result.tools[0]).toMatchObject({ name: "begin_message_to_room", status: "completed" });
    expect(result.modelMeta.modelCalls).toEqual([
      expect.objectContaining({ index: 1, cachedInputTokens: 80, cacheMissInputTokens: 20, cacheHitRate: 0.8 }),
      expect.objectContaining({ index: 2, cachedInputTokens: 90, cacheMissInputTokens: 30, cacheHitRate: 0.75 }),
    ]);
    expect(previewContents).not.toContain("正式工具消息");
    expectProgressivePreview(previewContents, "升级后的普通正文流");
  }));

  it("单个 provider delta 立即按增量发布，不重发累计正文", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const partialContent = "这是一段用于锁定平滑字符步长的较长公开消息内容，仍在继续生成中。";
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => { releaseRest = resolve; });
    let resolvePartialPreview!: () => void;
    const partialPreview = new Promise<void>((resolve) => { resolvePartialPreview = resolve; });
    const previewContents: string[] = []; const previewPayloads: Array<{ delta?: string; content?: string }> = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; delta?: string; content?: string } | undefined;
      if (event.entityId === "turn_smooth_preview" && payload?.kind === "room_message_preview") previewPayloads.push(payload);
      const content = appendRoomPreview(previewContents, event, "turn_smooth_preview");
      if (content === partialContent) resolvePartialPreview();
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_smooth_preview", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] },
        "[DONE]",
      ]);
      return gatedSse(
        [{ choices: [{ delta: { content: partialContent } }] }],
        ["[DONE]"],
        restGate,
      );
    }));
    sendUser(repository, "room_harbor", "验证平滑预览步长"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    repository.beginTurn({ turnId: "turn_smooth_preview", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const run = runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_smooth_preview", signal: new AbortController().signal });
    let timeoutId!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error("长内容预览未按时发布完成")), 1_500); });

    try {
      await Promise.race([partialPreview, timeout]);
      expect(previewContents).toEqual([partialContent]);
      expect(previewPayloads).toEqual([{ kind: "room_message_preview", roomId: "room_harbor", agentId: "navigator", messageKey: "turn_smooth_preview:model:0:tool:0", delta: partialContent, messageKind: "answer" }]);
      expect(previewPayloads[0]?.content).toBeUndefined();
    } finally {
      clearTimeout(timeoutId);
      releaseRest();
    }
    const result = await run; unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", content: partialContent });
  }));

  it("begin_message_to_room 后通过普通 assistant delta 实时公开并在完成后提交", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => { releaseRest = resolve; });
    let resolveFirstPreview!: (content: string) => void;
    const firstPreview = new Promise<string>((resolve) => { resolveFirstPreview = resolve; });
    const previews: string[] = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const content = appendRoomPreview(previews, event, "turn_public_chat");
      if (content && previews.length === 1) resolveFirstPreview(content);
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_public", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer", messageKey: "public-chat-key" }) } }] } }] },
        "[DONE]",
      ]);
      return gatedSse(
        [{ choices: [{ delta: { content: "真正" } }] }],
        [{ choices: [{ delta: { content: "流式正文" } }] }, "[DONE]"],
        restGate,
      );
    }));
    sendUser(repository, "room_harbor", "使用两阶段公开协议"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    let settled = false;
    const run = runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_chat", signal: new AbortController().signal }).finally(() => { settled = true; });
    let timeoutId!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error("普通 assistant delta 没有进入房间预览")), 1_500); });
    try {
      const first = await Promise.race([firstPreview, timeout]);
      expect("真正".startsWith(first)).toBe(true);
      expect(settled).toBe(false);
    } finally {
      clearTimeout(timeoutId); releaseRest();
    }
    const result = await run; unsubscribe();
    const firstTools = requestBodies[0]?.tools as Array<{ function: { name: string } }>;
    expect(firstTools.map((tool) => tool.function.name)).toContain("begin_message_to_room");
    expect(firstTools.map((tool) => tool.function.name)).not.toContain("send_message_to_room");
    expect(requestBodies[1]?.tools).toEqual(requestBodies[0]?.tools);
    expect(requestBodies[1]?.tool_choice).toBe("none");
    const firstMessages = requestBodies[0]?.messages as Array<{ role: string; content?: string }>;
    const publicMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(publicMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
    expect(countRenderedContextTokens({ instructions: "", messages: publicMessages, tools: requestBodies[1]?.tools }))
      .toBeGreaterThan(countRenderedContextTokens({ instructions: "", messages: firstMessages, tools: requestBodies[0]?.tools }));
    expect(publicMessages[0]?.content).toBe(firstMessages[0]?.content);
    expect(publicMessages.at(-1)?.content).toContain("[系统公开输出阶段]");
    expect(result.assistantContent).toBe("");
    expect(result.tools.map((tool) => tool.name)).toEqual(["begin_message_to_room"]);
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", roomId: "room_harbor", messageKey: "turn_public_chat:model:0:tool:0", content: "真正流式正文", kind: "answer" })]);
    expectProgressivePreview(previews, "真正流式正文");
  }));

  it("公开正文为空时保持原路由并只重试正文生成", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const requestBodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_retry", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse(["[DONE]"]);
      return sse([{ choices: [{ delta: { content: "重试后正式正文" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "空正文重试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_retry", signal: new AbortController().signal });
    expect(requestBodies).toHaveLength(3);
    expect(requestBodies[1]?.tools).toEqual(requestBodies[0]?.tools);
    expect(requestBodies[2]?.tools).toEqual(requestBodies[0]?.tools);
    expect(requestBodies[1]?.tool_choice).toBe("none");
    expect(requestBodies[2]?.tool_choice).toBe("none");
    const thirdMessages = requestBodies[2]?.messages as Array<{ role: string; content?: string }>;
    expect(thirdMessages.at(-1)?.content).toContain("公开正文为空");
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "重试后正式正文", messageKey: "turn_public_retry:model:0:tool:0" })]);
  }));

  it("公开正文阶段显式禁用工具，并在服务商仍返回工具调用时重试正文", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const requestBodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_guard", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_forbidden", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "偏航修复后的公开正文" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "公开正文工具防线"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_tool_guard", signal: new AbortController().signal });
    expect(result.tools.map((tool) => tool.name)).toEqual(["begin_message_to_room"]);
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "偏航修复后的公开正文" })]);
    expect(requestBodies[1]?.tools).toEqual(requestBodies[0]?.tools);
    expect(requestBodies[1]?.tool_choice).toBe("none");
    expect(requestBodies[2]?.tool_choice).toBe("none");
  }));

  it("公开正文中的 DeepSeek DSML 工具标记不会进入房间消息", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const previews: string[] = [];
    const replacements: string[] = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      appendRoomPreview(previews, event, "turn_public_dsml");
      const payload = event.payload as { kind?: string; content?: string } | undefined;
      if (event.entityId === "turn_public_dsml" && payload?.kind === "room_message_preview" && payload.content !== undefined) replacements.push(payload.content);
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_dsml", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([
        { choices: [{ delta: { content: "正在创建房间…\n\n" } }] },
        { choices: [{ delta: { content: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="create_room">' } }] },
        "[DONE]",
      ]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_finish_dsml", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "房间创建流程已启动" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "验证 DSML 清理"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_dsml", signal: new AbortController().signal });
    unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", kind: "progress", content: "正在创建房间…" });
    expect(result.effects[0]).not.toEqual(expect.objectContaining({ content: expect.stringContaining("DSML") }));
    expect(replacements).toContain("正在创建房间…");
  }));

  it("公开正文超过统一字符上限时在发布预览和提交前失败", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previews: string[] = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => { appendRoomPreview(previews, event, "turn_public_too_long"); });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_too_long", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] },
        "[DONE]",
      ]);
      return sse([{ choices: [{ delta: { content: "超".repeat(maxRoomMessageContentCharacters + 1) } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "验证公开正文长度上限"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    await expect(runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_too_long", signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: "ModelRunError", message: expect.stringContaining("字符上限") });
    unsubscribe();
    expect(previews).toEqual([]);
  }));

  it("跨房间交付时逐个打开通道并把正文分别提交到各自房间", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", "旧房间任务"); const oldPacket = packetFor(repository);
    repository.beginTurn({ turnId: "turn_public_old", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: oldPacket });
    repository.checkpointTurn({ turnId: "turn_public_old", assistantContent: "旧任务处理中", systemPrompt: "system", conversationMessages: [{ role: "assistant", content: "旧任务处理中" }], tools: [], timeline: [] });
    repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "公开协议新房间", agentId: "navigator" });
    const nextRoom = repository.getSnapshot().rooms.find((room) => room.title === "公开协议新房间")!;
    const nextParticipant = nextRoom.participants.find((participant) => participant.agentId === "navigator")!;
    sendUser(repository, nextRoom.id, "新房间任务"); const nextPacket = packetFor(repository, nextRoom.id);
    repository.beginTurn({ turnId: "turn_public_multi", roomId: nextRoom.id, agentId: "navigator", agentParticipantId: nextParticipant.id, packet: nextPacket });
    repository.continueInterruptedTurn("turn_public_old", "新房间任务接管", nextRoom.id);
    expect(repository.getTurnDeliveryObligations("turn_public_multi").map((item) => item.roomId).sort()).toEqual(["room_harbor", nextRoom.id].sort());

    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_new", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: nextRoom.id, kind: "answer", messageKey: "new-room-key" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { content: "新房间独立结果" } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_old", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer", messageKey: "old-room-key" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "旧房间独立结果" } }] }, "[DONE]"]);
    }));
    const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: nextParticipant.id, packet: nextPacket, turnId: "turn_public_multi", signal: new AbortController().signal });
    expect(bodies).toHaveLength(4);
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[3]?.tools).toEqual(bodies[2]?.tools);
    expect(bodies[1]?.tool_choice).toBe("none");
    expect(bodies[3]?.tool_choice).toBe("none");
    const terminalTools = bodies[2]?.tools as Array<{ function: { name: string } }>;
    expect(terminalTools.map((tool) => tool.function.name).sort()).toEqual(["begin_message_to_room", "continue_task_in_room", "read_no_reply"]);
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "send_message", roomId: nextRoom.id, messageKey: "turn_public_multi:model:0:tool:0", content: "新房间独立结果" }),
      expect.objectContaining({ type: "send_message", roomId: "room_harbor", messageKey: "turn_public_multi:model:2:tool:0", content: "旧房间独立结果" }),
    ]);
  }));

  it("同一 Turn 创建房间后可立即发言，并在成功时原子提交房间和消息", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let call = 0; let createdRoomId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      const body = requestBody(init);
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_progress", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { content: "我先创建新房间并邀请执行者。" } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_create", function: { name: "create_room", arguments: JSON.stringify({ title: "数数游戏室", agentIds: ["builder"] }) } }] } }] }, "[DONE]"]);
      if (call === 4) {
        createdRoomId = JSON.stringify(body.messages).match(/room_[0-9a-f-]{36}/)?.[0] ?? "";
        expect(createdRoomId).not.toBe("");
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_new_room", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: createdRoomId, kind: "answer" }) } }] } }] }, "[DONE]"]);
      }
      if (call === 5) return sse([{ choices: [{ delta: { content: "1" } }] }, "[DONE]"]);
      if (call === 6) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_final", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "新房间已经创建并开始数数。" } }] }, "[DONE]"]);
    }));

    sendUser(repository, "room_harbor", "创建房间并开始数数"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    repository.beginTurn({ turnId: "turn_create_and_send", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_create_and_send", signal: new AbortController().signal });
    expect(result.tools.find((tool) => tool.id === "call_new_room")).toMatchObject({ status: "completed", error: null });

    const applied = repository.finishTurn({ turnId: "turn_create_and_send", assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
    const created = repository.getRoom(createdRoomId)!;
    expect(created.title).toBe("数数游戏室");
    expect(created.participants.filter((participant) => participant.kind === "agent").map((participant) => participant.agentId).sort()).toEqual(["builder", "navigator"]);
    expect(created.messages).toEqual([expect.objectContaining({ content: "1", sender: expect.objectContaining({ name: "领航员" }) })]);
    expect(applied.triggerRoomIds).toContain(createdRoomId);
  }));

  it("跨房间任务可结束当前 Turn 等待其他 Agent，且收尾偏航不会回滚新房间", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0; let createdRoomId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = requestBody(init); bodies.push(body); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deferred_progress", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { content: "我会创建协作房间并开始数数。" } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deferred_create", function: { name: "create_room", arguments: JSON.stringify({ title: "异步数数室", agentIds: ["builder"] }) } }] } }] }, "[DONE]"]);
      if (call === 4) {
        createdRoomId = JSON.stringify(body.messages).match(/room_[0-9a-f-]{36}/)?.[0] ?? "";
        return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deferred_open", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: createdRoomId, kind: "answer" }) } }] } }] }, "[DONE]"]);
      }
      if (call === 5) return sse([{ choices: [{ delta: { content: "1" } }] }, "[DONE]"]);
      if (call === 6) return sse([{ choices: [{ delta: { content: "等待另一个 Agent 的后续消息。" } }] }, "[DONE]"]);
      if (call === 7) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_blocked_poll", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: createdRoomId, limit: 10 }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_continue_async", function: { name: "continue_task_in_room", arguments: JSON.stringify({ roomId: createdRoomId }) } }] } }] }, "[DONE]"]);
    }));

    sendUser(repository, "room_harbor", "创建房间和另一个 Agent 数数，完成后再汇报"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "enabled" as const } };
    repository.beginTurn({ turnId: "turn_deferred_room", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_deferred_room", signal: new AbortController().signal });

    expect(createdRoomId).not.toBe("");
    expect(result.tools.some((tool) => tool.name === "read_room_history")).toBe(false);
    expect(result.effects).toContainEqual({ type: "continue_task_in_room", roomId: createdRoomId });
    expect((bodies[6]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort()).toEqual(["begin_message_to_room", "continue_task_in_room", "read_no_reply"]);
    const applied = repository.finishTurn({ turnId: "turn_deferred_room", assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
    expect(repository.getRoom(createdRoomId)?.messages.at(-1)?.content).toBe("1");
    expect(applied.continuationRoomIds).toContain(createdRoomId);
    expect(repository.raw.prepare("SELECT target_room_id,deferred FROM turn_handoffs WHERE source_turn_id='turn_deferred_room'").get()).toEqual({ target_room_id: createdRoomId, deferred: 1 });
  }));

  it("跨房间目标完成后会在同一 Turn 继续向来源房间提交最终汇报", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", "去协作房间完成任务后回来汇报");
    const sourcePacket = packetFor(repository); const targetRoomId = "room_protocol_deferred";
    repository.beginTurn({ turnId: "turn_protocol_deferred_source", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: sourcePacket });
    repository.finishTurn({
      turnId: "turn_protocol_deferred_source", assistantContent: "启动异步任务", tools: [], timeline: [], effects: [
        { type: "create_room", roomId: targetRoomId, title: "协议续办房间", invitedAgentIds: ["builder"] },
        { type: "send_message", roomId: targetRoomId, messageId: "msg_protocol_start", messageKey: "protocol-start", content: "开始协作", kind: "answer" },
        { type: "continue_task_in_room", roomId: targetRoomId },
      ], modelMeta: {}, cutoffSeq: sourcePacket.cutoffSeq, nextParticipantId: null,
    });
    sendUser(repository, targetRoomId, "协作目标已经完成");
    const targetRoom = repository.getRoom(targetRoomId)!; const navigator = targetRoom.participants.find((participant) => participant.agentId === "navigator")!;
    const targetPacket = packetFor(repository, targetRoomId); const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_target_done", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: targetRoomId, kind: "answer" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { content: "目标房间确认完成" } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_source_report", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "跨房间任务已经完成" } }] }, "[DONE]"]);
    }));
    const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    repository.beginTurn({ turnId: "turn_protocol_deferred_final", roomId: targetRoomId, agentId: agent.id, agentParticipantId: navigator.id, packet: targetPacket });
    const result = await runAgentModel({ repository, agent, agentParticipantId: navigator.id, packet: targetPacket, turnId: "turn_protocol_deferred_final", signal: new AbortController().signal });

    expect(JSON.stringify(bodies[2]?.messages)).toContain("[系统跨房间续办决策]");
    expect(result.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "send_message", roomId: targetRoomId, content: "目标房间确认完成" }),
      expect.objectContaining({ type: "send_message", roomId: "room_harbor", content: "跨房间任务已经完成" }),
    ]));
    repository.finishTurn({ turnId: "turn_protocol_deferred_final", assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: targetPacket.cutoffSeq, nextParticipantId: navigator.id });
    expect(repository.getRoom("room_harbor")!.messages.at(-1)?.content).toBe("跨房间任务已经完成");
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("跨房间目标消息即使无需回复，也会先完成来源房间汇报再结束", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    sendUser(repository, "room_harbor", "去协作房间完成任务后回来汇报");
    const sourcePacket = packetFor(repository); const targetRoomId = "room_deferred_no_reply";
    repository.beginTurn({ turnId: "turn_deferred_no_reply_source", roomId: "room_harbor", agentId: "navigator", agentParticipantId: "participant_navigator_harbor", packet: sourcePacket });
    repository.finishTurn({
      turnId: "turn_deferred_no_reply_source", assistantContent: "启动异步任务", tools: [], timeline: [], effects: [
        { type: "create_room", roomId: targetRoomId, title: "无需回复续办房间", invitedAgentIds: ["builder"] },
        { type: "send_message", roomId: targetRoomId, messageId: "msg_no_reply_start", messageKey: "no-reply-start", content: "开始协作", kind: "answer" },
        { type: "continue_task_in_room", roomId: targetRoomId },
      ], modelMeta: {}, cutoffSeq: sourcePacket.cutoffSeq, nextParticipantId: null,
    });
    sendUser(repository, targetRoomId, "结果已经完整给出，你无需在这里回复，只需回来源房间汇报");
    const targetRoom = repository.getRoom(targetRoomId)!; const navigator = targetRoom.participants.find((participant) => participant.agentId === "navigator")!;
    const targetPacket = packetFor(repository, targetRoomId); const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deferred_no_reply", function: { name: "read_no_reply", arguments: JSON.stringify({ roomId: targetRoomId, messageId: targetPacket.targetMessageId }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deferred_source_report", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "无需回复的协作结果已经完成" } }] }, "[DONE]"]);
    }));
    const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    repository.beginTurn({ turnId: "turn_deferred_no_reply_final", roomId: targetRoomId, agentId: agent.id, agentParticipantId: navigator.id, packet: targetPacket });
    const result = await runAgentModel({ repository, agent, agentParticipantId: navigator.id, packet: targetPacket, turnId: "turn_deferred_no_reply_final", signal: new AbortController().signal });

    expect(JSON.stringify(bodies[1]?.messages)).toContain("[系统跨房间续办决策]");
    expect(result.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "read_no_reply", roomId: targetRoomId, messageId: targetPacket.targetMessageId }),
      expect.objectContaining({ type: "send_message", roomId: "room_harbor", content: "无需回复的协作结果已经完成" }),
    ]));
    repository.finishTurn({ turnId: "turn_deferred_no_reply_final", assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: targetPacket.cutoffSeq, nextParticipantId: navigator.id });
    expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
  }));

  it("Chat 收尾修复会为混合工具批次中的每个调用返回结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [
        { index: 0, id: "call_mixed_allowed", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } },
        { index: 1, id: "call_mixed_blocked", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor" }) } },
      ] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_mixed_retry", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "混合收尾已经修复" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "验证混合收尾"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const, maxToolSteps: 0 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_mixed_terminal_chat", signal: new AbortController().signal });

    const repairMessages = bodies[1]?.messages as Array<{ role: string; tool_call_id?: string }>;
    expect(repairMessages.filter((message) => message.role === "tool").slice(-2).map((message) => message.tool_call_id).sort()).toEqual(["call_mixed_allowed", "call_mixed_blocked"]);
    expect(result.tools.map((tool) => tool.id)).toEqual(["call_mixed_retry"]);
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "混合收尾已经修复" })]);
  }));

  it("Responses 收尾修复会为混合工具批次中的每个调用返回结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    const functionItem = (id: string, name: string, args: Record<string, unknown>) => ({ id: `item_${id}`, call_id: id, type: "function_call", name, arguments: JSON.stringify(args) });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) {
        const allowed = functionItem("call_responses_mixed_allowed", "begin_message_to_room", { roomId: "room_harbor", kind: "answer" });
        const blocked = functionItem("call_responses_mixed_blocked", "read_room_history", { roomId: "room_harbor" });
        return sse([{ type: "response.output_item.added", item: allowed }, { type: "response.output_item.done", item: allowed }, { type: "response.output_item.added", item: blocked }, { type: "response.output_item.done", item: blocked }, { type: "response.completed", response: { id: "resp_mixed_terminal" } }, "[DONE]"]);
      }
      if (call === 2) {
        const retry = functionItem("call_responses_mixed_retry", "begin_message_to_room", { roomId: "room_harbor", kind: "answer" });
        return sse([{ type: "response.output_item.added", item: retry }, { type: "response.output_item.done", item: retry }, { type: "response.completed", response: { id: "resp_mixed_retry" } }, "[DONE]"]);
      }
      return sse([{ type: "response.output_text.delta", delta: "Responses 混合收尾已经修复" }, { type: "response.completed", response: { id: "resp_mixed_done" } }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "验证 Responses 混合收尾"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const, thinkingMode: "disabled" as const, maxToolSteps: 0 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_mixed_terminal_responses", signal: new AbortController().signal });

    const repairInput = bodies[1]?.input as Array<{ type?: string; call_id?: string }>;
    expect(repairInput.filter((item) => item.type === "function_call_output").map((item) => item.call_id).sort()).toEqual(["call_responses_mixed_allowed", "call_responses_mixed_blocked"]);
    expect(result.tools.map((tool) => tool.id)).toEqual(["call_responses_mixed_retry"]);
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "Responses 混合收尾已经修复" })]);
  }));

  it("公开正文流被打断时不会生成可提交的正式消息", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => { releaseRest = resolve; });
    let resolveFirstPreview!: () => void;
    const firstPreview = new Promise<void>((resolve) => { resolveFirstPreview = resolve; });
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const contents: string[] = [];
      if (appendRoomPreview(contents, event, "turn_public_abort")) resolveFirstPreview();
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_begin_abort", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return gatedSse([{ choices: [{ delta: { content: "只生成了一半" } }] }], ["[DONE]"], restGate);
    }));
    sendUser(repository, "room_harbor", "中断公开正文"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const messagesBefore = repository.getRoom("room_harbor")!.messages.length;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const controller = new AbortController();
    const run = runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_abort", signal: controller.signal });
    let timeoutId!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error("被打断前没有出现公开预览")), 1_500); });
    try { await Promise.race([firstPreview, timeout]); controller.abort(); }
    finally { clearTimeout(timeoutId); releaseRest(); }
    await expect(run).rejects.toMatchObject({ name: "ModelRunError" });
    unsubscribe();
    expect(repository.getRoom("room_harbor")!.messages).toHaveLength(messagesBefore);
  }));

  it.each(["chat_completions", "responses"] as const)("%s 的工具续轮只接收 web_fetch 清理后的正文", async (apiFormat) => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const pageUrl = "https://93.184.216.34/reports/tide";
    const html = `<!doctype html><html><head><title>潮汐报告</title></head><body>
      <nav>${"无效导航".repeat(200)}</nav><script>window.noise = "无效脚本";</script>
      <article><h1>潮汐报告</h1><p>${"有效正文：潮汐数据保持稳定。".repeat(30)}</p></article>
      <footer>${"无效页脚".repeat(200)}</footer></body></html>`;
    const modelBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === pageUrl) return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      modelBodies.push(requestBody(init));
      if (modelBodies.length === 1 && apiFormat === "chat_completions") return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_web_progress_chat", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] },
        "[DONE]",
      ]);
      if (modelBodies.length === 1) return sse([
        { type: "response.output_item.added", item: { id: "item_web_progress", call_id: "call_web_progress_responses", type: "function_call", name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } },
        { type: "response.output_item.done", item: { id: "item_web_progress", call_id: "call_web_progress_responses", type: "function_call", name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } },
        { type: "response.completed", response: { id: "resp_web_progress" } },
        "[DONE]",
      ]);
      if (modelBodies.length === 2) return apiFormat === "chat_completions"
        ? sse([{ choices: [{ delta: { content: "我先读取并清理网页正文。" } }] }, "[DONE]"])
        : sse([{ type: "response.output_text.delta", delta: "我先读取并清理网页正文。" }, { type: "response.completed", response: { id: "resp_web_progress_body" } }, "[DONE]"]);
      if (modelBodies.length === 3 && apiFormat === "chat_completions") return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_web_chat", function: { name: "web_fetch", arguments: JSON.stringify({ url: pageUrl }) } }] } }] },
        "[DONE]",
      ]);
      if (modelBodies.length === 3) return sse([
        { type: "response.output_item.added", item: { id: "item_web", call_id: "call_web_responses", type: "function_call", name: "web_fetch", arguments: "" } },
        { type: "response.output_item.done", item: { id: "item_web", call_id: "call_web_responses", type: "function_call", name: "web_fetch", arguments: JSON.stringify({ url: pageUrl }) } },
        { type: "response.completed", response: { id: "resp_web_tool" } },
        "[DONE]",
      ]);
      return apiFormat === "chat_completions"
        ? sse([{ choices: [{ delta: { content: "已读取精简正文" } }] }, "[DONE]"])
        : sse([{ type: "response.output_text.delta", delta: "已读取精简正文" }, { type: "response.completed", response: { id: "resp_web_done" } }, "[DONE]"]);
    }));

    sendUser(repository, "room_harbor", "读取网页正文");
    const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat, maxToolSteps: 1 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: `turn_web_${apiFormat}`, signal: new AbortController().signal });

    const webTool = result.tools.find((tool) => tool.name === "web_fetch");
    expect(webTool?.outputText).toContain("有效正文");
    expect(webTool?.outputText).not.toMatch(/无效导航|无效脚本|无效页脚/);
    expect(modelBodies).toHaveLength(4);
    const continuationText = apiFormat === "chat_completions"
      ? ((modelBodies[3]?.messages as Array<{ role?: string; content?: string }>).findLast((message) => message.role === "tool")?.content ?? "")
      : String((modelBodies[3]?.input as Array<{ type?: string; output?: string }>).find((item) => item.type === "function_call_output")?.output ?? "");
    expect(continuationText).toContain("有效正文");
    expect(continuationText).not.toMatch(/无效导航|无效脚本|无效页脚/);
  }));

  it("工具执行后模型续轮失败时仍可从 Turn 审计中还原命令与工具结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let requestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_failure_progress", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] }, "[DONE]"]);
      if (requestCount === 2) return sse([{ choices: [{ delta: { content: "我先读取历史，再继续检查。" } }] }, "[DONE]"]);
      if (requestCount === 3) return sse([{
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
    expect(turn.tools.find((tool) => tool.id === "call_before_provider_failure")).toMatchObject({ id: "call_before_provider_failure", name: "read_room_history", status: "completed" });
  }));

  it("DeepSeek 思考模式在工具子轮和后续用户轮次完整回传 reasoning_content", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const bodies: Array<Record<string, unknown>> = [];
    const reasoningEvents: Array<{ step: number; delta: string }> = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string; step?: number; delta?: string } | undefined;
      if (event.entityId === "turn_reasoning_1" && payload?.kind === "reasoning_delta" && typeof payload.step === "number" && payload.delta) reasoningEvents.push({ step: payload.step, delta: payload.delta });
    });
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
        { choices: [{ delta: { content: "推理工具消息" } }] },
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
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[1]?.tool_choice).toBe("none");
    const firstContinuation = bodies[1]?.messages as Array<Record<string, unknown>>;
    expect(firstContinuation.at(-3)).toMatchObject({ role: "assistant", reasoning_content: "需要先公开工具", tool_calls: [{ id: "call_reasoning" }] });
    expect(firstContinuation.at(-2)).toMatchObject({ role: "tool", tool_call_id: "call_reasoning" });
    expect(firstContinuation.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("[系统公开输出阶段]") });

    sendUser(repository, "room_harbor", "第二轮继续追问");
    const secondPacket = packetFor(repository);
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet: secondPacket, turnId: "turn_reasoning_2", signal: new AbortController().signal });
    unsubscribe();
    const secondTurnMessages = bodies[2]?.messages as Array<Record<string, unknown>>;
    expect(secondTurnMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", reasoning_content: "需要先公开工具", tool_calls: [expect.objectContaining({ id: "call_reasoning", function: expect.objectContaining({ name: "begin_message_to_room" }) })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_reasoning" }),
      expect.objectContaining({ role: "assistant", content: "推理工具消息" }),
    ]));
    expect(firstResult.modelMeta).toMatchObject({ toolSteps: 1, reasoningCharacters: 18 });
    expect(reasoningEvents).toEqual([
      { step: 0, delta: "需要先公开工具" },
      { step: 1, delta: "工具已经执行，可以结束" },
    ]);
  }));

  it("DeepSeek 思考模式进入终结交付时不发送不兼容的 required tool_choice", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { reasoning_content: "需要收尾" } }] }, { choices: [{ delta: { content: "尚未公开的私有正文" } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { reasoning_content: "现在提交正式结果" } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_deepseek_terminal", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { reasoning_content: "组织最终正文" } }] }, { choices: [{ delta: { content: "DeepSeek 思考模式正式结果" } }] }, "[DONE]"]);
    }));

    sendUser(repository, "room_harbor", "需要正式交付"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "enabled" as const } };
    repository.beginTurn({ turnId: "turn_deepseek_terminal", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_deepseek_terminal", signal: new AbortController().signal });

    expect((bodies[1]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort()).toEqual(["begin_message_to_room", "continue_task_in_room", "read_no_reply"]);
    expect(bodies[1]).toMatchObject({ thinking: { type: "enabled" }, tool_choice: "auto" });
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", content: "DeepSeek 思考模式正式结果" })]);
  }));

  it("DeepSeek 跟随服务商默认思考模式时仍应用 reasoning_effort", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const requestBodies: Array<Record<string, unknown>> = [];
    const reasoningEvents: unknown[] = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string } | undefined;
      if (event.entityId === "turn_default_reasoning" && payload?.kind === "reasoning_delta") reasoningEvents.push(payload);
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse([{ choices: [{ delta: { reasoning_content: "默认模式思考" } }] }, { choices: [{ delta: { content: "默认思考强度生效" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "默认思考强度"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "provider_default" as const, reasoningEffort: "max" as const } };
    await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_default_reasoning", signal: new AbortController().signal });
    unsubscribe();
    expect(requestBodies[0]).toMatchObject({ reasoning_effort: "max" });
    expect(requestBodies[0]?.thinking).toBeUndefined();
    expect(reasoningEvents).toEqual([expect.objectContaining({ kind: "reasoning_delta", step: 0, delta: "默认模式思考" })]);
  }));

  it("显式关闭思考时不发布服务商意外返回的推理预览", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";
    const reasoningEvents: unknown[] = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const payload = event.payload as { kind?: string } | undefined;
      if (event.entityId === "turn_disabled_reasoning" && payload?.kind === "reasoning_delta") reasoningEvents.push(payload);
    });
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { reasoning_content: "不应展示的思考" } }] },
      { choices: [{ delta: { content: "关闭思考后的正文" } }] },
      "[DONE]",
    ])));
    sendUser(repository, "room_harbor", "关闭思考预览"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_disabled_reasoning", signal: new AbortController().signal });
    unsubscribe();
    expect(result.assistantContent).toBe("关闭思考后的正文");
    expect(reasoningEvents).toEqual([]);
  }));

  it("普通工具步骤耗尽后仍允许终结工具公开结果", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_terminal_progress", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { content: "我先读取房间历史。" } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }] }, "[DONE]"]);
      if (call === 4) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_terminal", function: { name: "send_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", content: "达到上限后的正式结果", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "达到上限后的正式结果" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "工具上限测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const, maxToolSteps: 1 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_terminal_tool", signal: new AbortController().signal });
    expect(result.tools.map((tool) => tool.name)).toEqual(["begin_message_to_room", "read_room_history", "begin_message_to_room"]);
    expect(result.effects).toEqual(expect.arrayContaining([expect.objectContaining({ type: "send_message", kind: "progress" }), expect.objectContaining({ type: "send_message", content: "达到上限后的正式结果" })]));
    expect((bodies[3]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name).sort()).toEqual(["begin_message_to_room", "continue_task_in_room", "read_no_reply"]);
    expect(bodies[4]?.tools).toEqual(bodies[3]?.tools);
    expect(bodies[4]?.tool_choice).toBe("none");
  }));

  it("Chat 工具输出让上下文越过阈值时，会在下一次模型请求前整体压缩", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const fileName = "large-tool-context.txt";
    await fs.writeFile(path.join(repository.dataDir, fileName), Array.from({ length: 3_000 }, (_, index) => `工具关键事实 ${index}：仍需继续处理。`).join("\n"));
    const requestBodies: Array<{ messages: Array<{ role: string; content?: string }>; tools?: unknown; tool_choice?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }>; tools?: unknown; tool_choice?: string };
      requestBodies.push(body);
      if (requestBodies.length === 1) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_large_progress", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress" }) } }] } }] },
        "[DONE]",
      ]);
      if (requestBodies.length === 2) return sse([{ choices: [{ delta: { content: "我先读取大文件并整理关键事实。" } }] }, "[DONE]"]);
      if (requestBodies.length === 3) return sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_large_read", function: { name: "read_project_context", arguments: JSON.stringify({ root: repository.dataDir, path: fileName }) } }] } }] },
        "[DONE]",
      ]);
      if (requestBodies.length === 4) return sse([{ choices: [{ delta: { content: "工具返回了大量关键事实，任务仍需继续。" } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "已在压缩后继续处理" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "读取大文件并继续"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, contextTokenThreshold: 15_000, projectContextRoots: [repository.dataDir] } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_large_tool_context", signal: new AbortController().signal });
    expect(result.tools.find((tool) => tool.name === "read_project_context")?.outputText.length).toBeGreaterThan(50_000);
    expect(requestBodies).toHaveLength(5);
    expect(requestBodies[3]?.messages[0]?.content).toBe(requestBodies[2]?.messages[0]?.content);
    expect(requestBodies[3]?.messages.at(-2)?.content).toContain("上下文压缩器");
    expect(requestBodies[3]?.messages.slice(0, requestBodies[2]!.messages.length)).toEqual(requestBodies[2]?.messages);
    expect(requestBodies[3]?.tools).toEqual(requestBodies[2]?.tools);
    expect(requestBodies[3]?.tool_choice).toBe("auto");
    expect(requestBodies[4]?.messages[1]?.content).toContain("工具返回了大量关键事实");
    expect(result.contextCompaction).toMatchObject({ threshold: 15_000 });
    expect(result.sessionMessages.some((message) => message.role === "tool" && message.tool_call_id === "call_large_read")).toBe(false);
    expect(result.auditMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call_large_read" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_large_read" }),
      expect.objectContaining({ role: "user", content: expect.stringContaining("此前完整 Agent 会话的压缩上下文") }),
    ]));
  }));

  it("把 Responses 误发的旧 send_message 调用升级为新公开正文阶段", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const previewContents: string[] = []; const unsubscribe = subscribeWorkspaceEvents((event) => { appendRoomPreview(previewContents, event, "turn_responses_tool"); });
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
      return sse([{ type: "response.output_text.delta", delta: "Responses " }, { type: "response.output_text.delta", delta: "升级正文" }, { type: "response.completed", response: { id: "resp_done" } }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "Responses 工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses_tool", signal: new AbortController().signal }); unsubscribe();
    expect(result.effects[0]).toMatchObject({ type: "send_message", content: "Responses 升级正文" });
    expect(result.tools[0]).toMatchObject({ name: "begin_message_to_room", status: "completed" });
    expect(previewContents).not.toContain("Responses 流式消息");
    expectProgressivePreview(previewContents, "Responses 升级正文");
  }));

  it("Responses 在打开房间后把 output_text.delta 作为公开正文流", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => { releaseRest = resolve; });
    let resolveFirstPreview!: () => void;
    const firstPreview = new Promise<void>((resolve) => { resolveFirstPreview = resolve; });
    const previews: string[] = []; const bodies: Array<Record<string, unknown>> = [];
    const unsubscribe = subscribeWorkspaceEvents((event) => {
      const content = appendRoomPreview(previews, event, "turn_public_responses");
      if (content && previews.length === 1) resolveFirstPreview();
    });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) {
        const item = { id: "item_begin_public", call_id: "call_begin_responses", type: "function_call", name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer", messageKey: "public-responses-key" }) };
        return sse([{ type: "response.output_item.added", item }, { type: "response.output_item.done", item }, { type: "response.completed", response: { id: "resp_begin_public" } }, "[DONE]"]);
      }
      return gatedSse(
        [{ type: "response.output_text.delta", delta: "Responses " }],
        [{ type: "response.output_text.delta", delta: "公开正文" }, { type: "response.completed", response: { id: "resp_public_body" } }, "[DONE]"],
        restGate,
      );
    }));
    sendUser(repository, "room_harbor", "Responses 两阶段公开协议"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const, thinkingMode: "disabled" as const } };
    const run = runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_public_responses", signal: new AbortController().signal });
    let timeoutId!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error("Responses 公开正文没有提前显示")), 1_500); });
    try { await Promise.race([firstPreview, timeout]); }
    finally { clearTimeout(timeoutId); releaseRest(); }
    const result = await run; unsubscribe();
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[1]?.tool_choice).toBe("none");
    expect(bodies[1]?.instructions).toBeUndefined();
    expect(bodies[1]?.previous_response_id).toBe("resp_begin_public");
    expect(JSON.stringify(bodies[1]?.input)).toContain("[系统公开输出阶段]");
    expect(result.assistantContent).toBe("");
    expect(result.effects).toEqual([expect.objectContaining({ type: "send_message", messageKey: "turn_public_responses:model:0:tool:0", content: "Responses 公开正文" })]);
    expectProgressivePreview(previews, "Responses 公开正文");
  }));

  it("Chat 可在一个任务中多次汇报阶段进度且纯进度不消耗工作工具步数", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const bodies: Array<Record<string, unknown>> = []; let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(requestBody(init)); call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_progress_blocked", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }] }, "[DONE]"]);
      if (call === 2) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_reused", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress", messageKey: "reused-user-message-key" }) } }] } }] }, "[DONE]"]);
      if (call === 3) return sse([{ choices: [{ delta: { content: "我先检查房间历史，再核对关键结果。" } }] }, "[DONE]"]);
      if (call === 4) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_progress_work", function: { name: "read_room_history", arguments: JSON.stringify({ roomId: "room_harbor", limit: 1 }) } }] } }] }, "[DONE]"]);
      if (call === 5) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_reused", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "progress", messageKey: "reused-user-message-key" }) } }] } }] }, "[DONE]"]);
      if (call === 6) return sse([{ choices: [{ delta: { content: "历史已经核对完成，正在整理最终结论。" } }] }, "[DONE]"]);
      if (call === 7) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_reused", function: { name: "begin_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", kind: "answer", messageKey: "reused-user-message-key" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "检查完成，最终结果已经确认。" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "分阶段检查并持续汇报"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const, thinkingMode: "disabled" as const, maxToolSteps: 1 } };
    repository.beginTurn({ turnId: "turn_chat_progress", roomId: "room_harbor", agentId: agent.id, agentParticipantId: "participant_navigator_harbor", packet });
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_progress", signal: new AbortController().signal });

    expect(bodies).toHaveLength(8);
    expect(result.systemPrompt).toContain("在开始实质工作前，必须向对应房间发送一条 kind=progress");
    expect(result.systemPrompt).toContain("不要发送定时心跳");
    expect(result.modelMeta).toMatchObject({ toolSteps: 1 });
    expect(result.tools.map((tool) => tool.name)).toEqual(["begin_message_to_room", "read_room_history", "begin_message_to_room", "begin_message_to_room"]);
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "send_message", kind: "progress", messageKey: "turn_chat_progress:model:1:tool:0", content: "我先检查房间历史，再核对关键结果。" }),
      expect.objectContaining({ type: "send_message", kind: "progress", messageKey: "turn_chat_progress:model:4:tool:0", content: "历史已经核对完成，正在整理最终结论。" }),
      expect.objectContaining({ type: "send_message", kind: "answer", messageKey: "turn_chat_progress:model:6:tool:0", content: "检查完成，最终结果已经确认。" }),
    ]);
    const applied = repository.finishTurn({ turnId: "turn_chat_progress", assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq: packet.cutoffSeq, nextParticipantId: null });
    expect(new Set(applied.emittedMessageIds).size).toBe(3);
    expect(repository.getRoom("room_harbor")!.messages.slice(-3).map((message) => message.kind)).toEqual(["progress", "progress", "answer"]);
    expect(JSON.stringify(bodies[1]?.messages)).toContain("这些工作工具没有执行：read_room_history");
    const retryTools = bodies[3]?.tools as Array<{ function: { name: string } }>;
    expect(retryTools.map((tool) => tool.function.name)).toContain("read_room_history");
    expect(JSON.stringify(bodies[3]?.messages)).toContain("可以再次发送 kind=progress");
  }));

  it("Responses 的纯进度消息同样不占用工作工具步数", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const functionCall = (id: string, name: string, args: Record<string, unknown>, responseId: string) => {
      const item = { id: `item_${id}`, call_id: id, type: "function_call", name, arguments: JSON.stringify(args) };
      return sse([{ type: "response.output_item.added", item }, { type: "response.output_item.done", item }, { type: "response.completed", response: { id: responseId } }, "[DONE]"]);
    };
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return functionCall("call_responses_blocked", "read_room_history", { roomId: "room_harbor", limit: 1 }, "resp_blocked");
      if (call === 2) return functionCall("call_reused", "begin_message_to_room", { roomId: "room_harbor", kind: "progress", messageKey: "reused-responses-key" }, "resp_progress_route");
      if (call === 3) return sse([{ type: "response.output_text.delta", delta: "我先读取历史，再给出正式结论。" }, { type: "response.completed", response: { id: "resp_progress_body" } }, "[DONE]"]);
      if (call === 4) return functionCall("call_responses_work", "read_room_history", { roomId: "room_harbor", limit: 1 }, "resp_work");
      if (call === 5) return functionCall("call_reused", "begin_message_to_room", { roomId: "room_harbor", kind: "answer", messageKey: "reused-responses-key" }, "resp_answer_route");
      return sse([{ type: "response.output_text.delta", delta: "历史检查完成，这是最终结论。" }, { type: "response.completed", response: { id: "resp_answer_body" } }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "用 Responses 分阶段处理"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!;
    const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const, thinkingMode: "disabled" as const, maxToolSteps: 1 } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses_progress", signal: new AbortController().signal });

    expect(call).toBe(6);
    expect(result.modelMeta).toMatchObject({ toolSteps: 1 });
    expect(result.tools.map((tool) => tool.name)).toEqual(["begin_message_to_room", "read_room_history", "begin_message_to_room"]);
    expect(result.effects).toEqual([
      expect.objectContaining({ type: "send_message", kind: "progress", messageKey: "turn_responses_progress:model:1:tool:0", content: "我先读取历史，再给出正式结论。" }),
      expect.objectContaining({ type: "send_message", kind: "answer", messageKey: "turn_responses_progress:model:4:tool:0", content: "历史检查完成，这是最终结论。" }),
    ]);
  }));
});
