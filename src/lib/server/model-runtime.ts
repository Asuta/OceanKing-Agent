import type { Agent, AgentSessionMessage, ContextCompaction, ModelCallRecord, SchedulerPacket, TimelineEvent, ToolExecution, TurnEffect } from "@/lib/domain/types";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { getToolDefinition, listToolDefinitions, toolDefinitionsForChat, toolDefinitionsForResponses, type ToolContext } from "@/lib/server/tools";
import { WorkspaceRepository } from "@/lib/server/repository";
import { createId, nowIso } from "@/lib/utils/id";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";
import {
  compactedSessionContent, contextCompactionInstructions, countRenderedContextTokens,
} from "@/lib/server/context-compaction";

type ToolCall = { id: string; name: string; arguments: string };
type RoomMessagePreviewPayload = {
  roomId: string;
  agentId: string;
  messageKey: string;
  content: string;
  messageKind: "answer" | "progress" | "warning" | "error" | "clarification";
};
type RoomMessagePreviewState = {
  payload: RoomMessagePreviewPayload;
  publishedContent: string;
  worker: Promise<void> | null;
};
const terminalToolNames = new Set(["send_message_to_room", "read_no_reply"]);
const roomMessagePreviewFrameMs = 35;
const roomMessagePreviewMaxFrames = 16;
class ResponsesUnsupportedError extends Error {}
type RunArgs = {
  repository: WorkspaceRepository;
  agent: Agent;
  agentParticipantId: string;
  packet: SchedulerPacket;
  turnId: string;
  signal: AbortSignal;
};

export type ModelTurnResult = {
  assistantContent: string;
  systemPrompt: string;
  sessionMessages: AgentSessionMessage[];
  auditMessages: AgentSessionMessage[];
  tools: ToolExecution[];
  timeline: TimelineEvent[];
  effects: TurnEffect[];
  modelMeta: Record<string, unknown>;
  contextCompaction?: ContextCompaction;
};

export class ModelRunError extends Error {
  readonly originalError: unknown;
  readonly modelMeta: Record<string, unknown>;

  constructor(error: unknown, modelMeta: Record<string, unknown>) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ModelRunError";
    this.originalError = error;
    this.modelMeta = modelMeta;
  }
}

type PreparedContext = {
  messages: Array<Record<string, unknown>>;
  estimatedTokens: number;
  compactedTokens: number | null;
  threshold: number;
  compaction?: ContextCompaction;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function appendModelCall(modelCalls: ModelCallRecord[], args: {
  purpose: ModelCallRecord["purpose"];
  format: ModelCallRecord["format"];
  startedAt: string;
  startedMs: number;
  usage: unknown;
  error?: unknown;
}): void {
  const rawUsage = asRecord(args.usage);
  const inputDetails = asRecord(rawUsage?.input_tokens_details);
  const promptDetails = asRecord(rawUsage?.prompt_tokens_details);
  const cachedInputTokens = firstFiniteNumber(
    inputDetails?.cached_tokens,
    promptDetails?.cached_tokens,
    rawUsage?.prompt_cache_hit_tokens,
    rawUsage?.cache_read_input_tokens,
  );
  const reportedCacheMissTokens = firstFiniteNumber(rawUsage?.prompt_cache_miss_tokens);
  const cacheWriteInputTokens = firstFiniteNumber(
    inputDetails?.cache_creation_tokens,
    promptDetails?.cache_creation_tokens,
    rawUsage?.cache_creation_input_tokens,
  );
  let inputTokens = firstFiniteNumber(rawUsage?.input_tokens, rawUsage?.prompt_tokens);
  if (inputTokens === null && cachedInputTokens !== null && reportedCacheMissTokens !== null) {
    inputTokens = cachedInputTokens + reportedCacheMissTokens;
  }
  const cacheMissInputTokens = reportedCacheMissTokens ?? (
    inputTokens !== null && cachedInputTokens !== null ? Math.max(0, inputTokens - cachedInputTokens) : null
  );
  const outputTokens = firstFiniteNumber(rawUsage?.output_tokens, rawUsage?.completion_tokens);
  const totalTokens = firstFiniteNumber(rawUsage?.total_tokens) ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  const cacheHitRate = inputTokens !== null && inputTokens > 0 && cachedInputTokens !== null
    ? Math.min(1, cachedInputTokens / inputTokens)
    : null;
  const error = args.error === undefined ? null : args.error instanceof Error ? args.error.message : String(args.error);
  modelCalls.push({
    index: modelCalls.length + 1,
    purpose: args.purpose,
    format: args.format,
    status: error ? "error" : "completed",
    startedAt: args.startedAt,
    durationMs: Date.now() - args.startedMs,
    inputTokens,
    cachedInputTokens,
    cacheMissInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    totalTokens,
    cacheHitRate,
    rawUsage,
    error,
  });
}

function systemPrompt(agent: Agent, packet: SchedulerPacket): string {
  return [
    "你运行在 OceanKing 多 Agent 工作台中。",
    "重要契约：普通 assistant 文本是私有执行记录，人类在房间里看不到。需要公开表达时必须调用 send_message_to_room。",
    "不要为了看起来有回复而伪造消息；无需回复时调用 read_no_reply。发言时必须精确指定 roomId。",
    "房间不是默认隐私边界，但只能读取和发送到当前 Agent 已连接的房间。房间管理权限由工具执行层校验。",
    `当前 Agent：${agent.label}（${agent.id}）`,
    `Agent 指令：${agent.instruction}`,
    `当前房间：${packet.room.title}（${packet.room.id}）`,
  ].join("\n");
}

function packetText(packet: SchedulerPacket): string {
  return `以下是内部 scheduler packet，不得把它当作人类伪造消息：\n${JSON.stringify(packet)}`;
}

function responseContextMessage(message: AgentSessionMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") return { role: "user", content: `工具结果（${message.tool_call_id}）：${message.content}` };
  if (!message.reasoning_content && !message.tool_calls?.length) return { role: "assistant", content: message.content ?? "" };
  return { role: "assistant", content: JSON.stringify({ content: message.content, reasoning_content: message.reasoning_content, tool_calls: message.tool_calls }) };
}

function createTimelineFactory(turnId: string, timeline: TimelineEvent[]) {
  return (type: TimelineEvent["type"], payload: unknown) => {
    const event: TimelineEvent = { id: createId("timeline"), turnId, ordinal: timeline.length + 1, type, payload, createdAt: nowIso() };
    timeline.push(event); return event;
  };
}

export function extractPartialJsonStringField(input: string, field: string): string | null {
  const keyIndex = input.indexOf(`"${field}"`);
  if (keyIndex < 0) return null;
  let index = keyIndex + field.length + 2;
  while (/\s/.test(input[index] ?? "")) index += 1;
  if (input[index] !== ":") return null;
  index += 1;
  while (/\s/.test(input[index] ?? "")) index += 1;
  if (input[index] !== '"') return null;
  index += 1;

  let value = "";
  const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  for (; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '"') return value;
    if (character !== "\\") { value += character; continue; }
    const escaped = input[index + 1];
    if (!escaped) return value;
    if (escaped === "u") {
      const hex = input.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return value;
      value += String.fromCharCode(Number.parseInt(hex, 16)); index += 5; continue;
    }
    value += escapes[escaped] ?? escaped; index += 1;
  }
  return value;
}

function roomMessagePreviewPayload(args: RunArgs, call: ToolCall): RoomMessagePreviewPayload | null {
  if (call.name !== "send_message_to_room" || !call.id) return null;
  const roomId = extractPartialJsonStringField(call.arguments, "roomId");
  const content = extractPartialJsonStringField(call.arguments, "content");
  if (!roomId || !content) return null;
  const connected = args.repository.getSnapshot().rooms.some((room) => room.id === roomId && room.participants.some((participant) => participant.agentId === args.agent.id && participant.enabled));
  if (!connected) return null;
  const rawKind = extractPartialJsonStringField(call.arguments, "kind");
  const messageKind = (["answer", "progress", "warning", "error", "clarification"] as const).find((entry) => entry === rawKind) ?? "answer";
  return {
    roomId,
    agentId: args.agent.id,
    messageKey: extractPartialJsonStringField(call.arguments, "messageKey") || call.id,
    content,
    messageKind,
  };
}

function publishRoomMessagePreview(args: RunArgs, payload: RoomMessagePreviewPayload, content: string): void {
  publishWorkspaceEvent("turn.preview", args.turnId, {
    kind: "room_message_preview",
    ...payload,
    content,
  }, args.repository.getVersion().revision);
}

function waitForRoomMessagePreviewFrame(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, roomMessagePreviewFrameMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createRoomMessagePreviewStream(args: RunArgs) {
  const states = new Map<string, RoomMessagePreviewState>();

  const startWorker = (state: RoomMessagePreviewState): void => {
    if (state.worker) return;
    state.worker = (async () => {
      await Promise.resolve();
      try {
        while (!args.signal.aborted && state.publishedContent !== state.payload.content) {
          if (!state.payload.content.startsWith(state.publishedContent)) state.publishedContent = "";
          const targetCharacters = Array.from(state.payload.content);
          const publishedCharacters = Array.from(state.publishedContent).length;
          const step = Math.max(1, Math.ceil(targetCharacters.length / roomMessagePreviewMaxFrames));
          const nextLength = Math.min(targetCharacters.length, publishedCharacters + step);
          state.publishedContent = targetCharacters.slice(0, nextLength).join("");
          publishRoomMessagePreview(args, state.payload, state.publishedContent);
          if (state.publishedContent !== state.payload.content) await waitForRoomMessagePreviewFrame(args.signal);
        }
      } finally {
        state.worker = null;
        if (!args.signal.aborted && state.publishedContent !== state.payload.content) startWorker(state);
      }
    })();
  };

  const update = (call: ToolCall, streamKey = call.id): void => {
    const payload = roomMessagePreviewPayload(args, call);
    if (!payload) return;
    const current = states.get(streamKey);
    if (current) {
      current.payload = payload;
      startWorker(current);
      return;
    }
    const state: RoomMessagePreviewState = { payload, publishedContent: "", worker: null };
    states.set(streamKey, state);
    startWorker(state);
  };

  const flush = async (): Promise<void> => {
    while (true) {
      const workers = [...states.values()].map((state) => state.worker).filter((worker): worker is Promise<void> => Boolean(worker));
      if (!workers.length) return;
      await Promise.all(workers);
    }
  };

  return { update, flush };
}

async function executeToolCalls(args: RunArgs, calls: ToolCall[], tools: ToolExecution[], timeline: TimelineEvent[], effects: TurnEffect[], onOutput?: (output: { callId: string; name: string; text: string; error: boolean }) => void) {
  const addTimeline = createTimelineFactory(args.turnId, timeline);
  const outputs: Array<{ callId: string; name: string; text: string; error: boolean }> = [];
  for (const call of calls) {
    if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
    const started = Date.now(); addTimeline("tool_started", { id: call.id, name: call.name, arguments: call.arguments });
    let parsed: unknown = {};
    try { parsed = call.arguments ? JSON.parse(call.arguments) : {}; } catch { parsed = { _partialJson: call.arguments }; }
    const definition = getToolDefinition(call.name);
    let outputText = ""; let structured: unknown = {}; let error: string | null = null;
    try {
      if (!definition) throw new Error(`未知工具：${call.name}`);
      const context: ToolContext = { agent: args.agent, roomId: args.packet.room.id, agentParticipantId: args.agentParticipantId, packet: args.packet, repository: args.repository, signal: args.signal };
      const result = await definition.execute(context, parsed, call.id);
      outputText = result.text; structured = result.structured; effects.push(...result.effects);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught); outputText = `工具执行失败：${error}`; structured = { error };
    }
    const tool: ToolExecution = { id: call.id || createId("tool"), turnId: args.turnId, name: call.name, input: parsed, outputText, structuredResult: structured, status: error ? "error" : "completed", durationMs: Date.now() - started, error, createdAt: nowIso() };
    tools.push(tool); addTimeline("tool_finished", { id: tool.id, name: tool.name, status: tool.status, durationMs: tool.durationMs, error });
    const output = { callId: call.id, name: call.name, text: outputText, error: Boolean(error) };
    outputs.push(output); onOutput?.(output);
    publishWorkspaceEvent("turn.preview", args.turnId, { kind: "tool", tool }, args.repository.getVersion().revision);
  }
  return outputs;
}

async function parseSse(response: Response, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
  if (!response.ok) throw new Error(`模型接口错误 ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  if (!response.body) throw new Error("模型接口未返回流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/); buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { onEvent(JSON.parse(data) as Record<string, unknown>); } catch { /* malformed provider chunk is ignored */ }
    }
  }
}

function apiConfig() {
  const baseUrl = normalizeOpenAiBaseUrl();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("未配置 OPENAI_API_KEY");
  return { baseUrl, headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` } };
}

function applyChatThinkingSettings(body: Record<string, unknown>, agent: Agent, baseUrl: string): void {
  if (isOfficialOpenAiBaseUrl(baseUrl)) {
    if (agent.settings.thinkingMode === "enabled") body.reasoning_effort = agent.settings.reasoningEffort;
    return;
  }
  if (agent.settings.thinkingMode === "provider_default") {
    if (isDeepSeekBaseUrl(baseUrl)) body.reasoning_effort = agent.settings.reasoningEffort;
    return;
  }
  body.thinking = { type: agent.settings.thinkingMode };
  if (agent.settings.thinkingMode === "enabled") body.reasoning_effort = agent.settings.reasoningEffort;
}

function applyResponsesThinkingSettings(body: Record<string, unknown>, agent: Agent, baseUrl: string): void {
  if (isOfficialOpenAiBaseUrl(baseUrl)) {
    if (agent.settings.thinkingMode === "enabled") body.reasoning = { effort: agent.settings.reasoningEffort };
    return;
  }
  if (agent.settings.thinkingMode === "provider_default") return;
  body.thinking = { type: agent.settings.thinkingMode };
  if (agent.settings.thinkingMode === "enabled") body.reasoning_effort = agent.settings.reasoningEffort;
}

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"; }
  catch { return false; }
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try { const hostname = new URL(baseUrl).hostname.toLowerCase(); return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com"); }
  catch { return false; }
}

async function compactWithChatCompletions(args: RunArgs, messages: Array<Record<string, unknown>>, modelCalls: ModelCallRecord[]): Promise<string> {
  const { baseUrl, headers } = apiConfig();
  const body: Record<string, unknown> = {
    model: args.agent.settings.model,
    messages: [
      { role: "system", content: contextCompactionInstructions },
      ...messages,
      { role: "user", content: "现在压缩上面的完整会话，只输出可供 Agent 继续工作的压缩上下文。" },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  applyChatThinkingSettings(body, args.agent, baseUrl);
  const startedAt = nowIso(); const startedMs = Date.now(); let usage: unknown = null;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers, signal: args.signal,
      body: JSON.stringify(body),
    });
    let summary = "";
    await parseSse(response, (event) => {
      if (event.usage) usage = event.usage;
      const choices = Array.isArray(event.choices) ? event.choices as Array<Record<string, unknown>> : [];
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === "string") summary += delta.content;
    });
    if (!summary.trim()) throw new Error("上下文压缩失败：模型没有返回压缩内容");
    appendModelCall(modelCalls, { purpose: "compaction", format: "chat_completions", startedAt, startedMs, usage });
    return summary.trim();
  } catch (error) {
    appendModelCall(modelCalls, { purpose: "compaction", format: "chat_completions", startedAt, startedMs, usage, error });
    throw error;
  }
}

async function compactWithResponses(args: RunArgs, messages: Array<Record<string, unknown>>, modelCalls: ModelCallRecord[]): Promise<string> {
  const { baseUrl, headers } = apiConfig();
  const body: Record<string, unknown> = {
    model: args.agent.settings.model,
    instructions: contextCompactionInstructions,
    input: [...messages, { role: "user", content: "现在压缩上面的完整会话，只输出可供 Agent 继续工作的压缩上下文。" }],
    stream: true,
  };
  applyResponsesThinkingSettings(body, args.agent, baseUrl);
  const startedAt = nowIso(); const startedMs = Date.now(); let usage: unknown = null;
  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST", headers, signal: args.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok && [400, 404, 405].includes(response.status)) {
      throw new ResponsesUnsupportedError(`Responses API 不可用 (${response.status}): ${(await response.text()).slice(0, 1_000)}`);
    }
    let summary = "";
    await parseSse(response, (event) => {
      const responseObject = event.response as Record<string, unknown> | undefined;
      if (responseObject?.usage) usage = responseObject.usage;
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") summary += event.delta;
    });
    if (!summary.trim()) throw new Error("上下文压缩失败：模型没有返回压缩内容");
    appendModelCall(modelCalls, { purpose: "compaction", format: "responses", startedAt, startedMs, usage });
    return summary.trim();
  } catch (error) {
    appendModelCall(modelCalls, { purpose: "compaction", format: "responses", startedAt, startedMs, usage, error });
    throw error;
  }
}

async function prepareContext(args: RunArgs, format: "responses" | "chat_completions", messages: Array<Record<string, unknown>>, modelCalls: ModelCallRecord[]): Promise<PreparedContext> {
  const tools = format === "responses" ? toolDefinitionsForResponses() : toolDefinitionsForChat();
  const instructions = systemPrompt(args.agent, args.packet);
  const estimatedTokens = countRenderedContextTokens({ instructions, messages, tools });
  const threshold = args.agent.settings.contextTokenThreshold;
  if (estimatedTokens <= threshold) return { messages, estimatedTokens, compactedTokens: null, threshold };

  const summary = format === "responses"
    ? await compactWithResponses(args, messages, modelCalls)
    : await compactWithChatCompletions(args, messages.map((message) => ({ ...message })), modelCalls);
  const compactedMessages: Array<Record<string, unknown>> = [{ role: "user", content: compactedSessionContent(summary) }];
  const compactedTokens = countRenderedContextTokens({ instructions, messages: compactedMessages, tools });
  if (compactedTokens > threshold) {
    throw new Error(`上下文压缩后仍有 ${compactedTokens} tokens，超过阈值 ${threshold}`);
  }
  return {
    messages: compactedMessages,
    estimatedTokens,
    compactedTokens,
    threshold,
    compaction: { summary, estimatedTokens, compactedTokens, threshold, sourceEntries: messages.length },
  };
}

function contextMeta(prepared: PreparedContext): Record<string, unknown> {
  return {
    estimatedTokens: prepared.estimatedTokens,
    threshold: prepared.threshold,
    compacted: Boolean(prepared.compaction),
    compactedTokens: prepared.compactedTokens,
    sourceEntries: prepared.compaction?.sourceEntries,
  };
}

async function runChatCompletions(args: RunArgs, modelCalls: ModelCallRecord[]): Promise<ModelTurnResult> {
  const { baseUrl, headers } = apiConfig();
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = [];
  const turnSystemPrompt = systemPrompt(args.agent, args.packet);
  const session = args.repository.getAgentSession(args.agent.id);
  const userMessage: AgentSessionMessage = { role: "user", content: packetText(args.packet) };
  const prepared = await prepareContext(args, "chat_completions", [...session, userMessage].map((message) => ({ ...message })), modelCalls);
  const addTimeline = createTimelineFactory(args.turnId, timeline); addTimeline("turn_started", { format: "chat_completions", context: contextMeta(prepared) });
  let sessionMessages: AgentSessionMessage[] = prepared.compaction
    ? [{ role: "user", content: compactedSessionContent(prepared.compaction.summary) }]
    : [userMessage];
  const auditMessages = [...sessionMessages];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: turnSystemPrompt },
    ...prepared.messages,
  ];
  const chatToolDefinitions = toolDefinitionsForChat();
  let assistantContent = ""; let usage: unknown = null; let toolSteps = 0; let reasoningCharacters = 0;
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  for (let step = 0; step <= args.agent.settings.maxToolSteps + 1; step += 1) {
    const regularToolsAllowed = step < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = step === args.agent.settings.maxToolSteps;
    const requestTools = regularToolsAllowed
      ? chatToolDefinitions
      : terminalToolsOnly
        ? chatToolDefinitions.filter((tool) => terminalToolNames.has(tool.function.name))
        : [];
    const requestTokens = countRenderedContextTokens({ instructions: "", messages, tools: requestTools });
    if (requestTokens > prepared.threshold) {
      const sourceEntries = messages.length - 1;
      const summary = await compactWithChatCompletions(args, messages.slice(1), modelCalls);
      messages.splice(0, messages.length,
        { role: "system", content: turnSystemPrompt },
        { role: "user", content: compactedSessionContent(summary) },
      );
      const compactedMessage: AgentSessionMessage = { role: "user", content: compactedSessionContent(summary) };
      sessionMessages = [compactedMessage];
      auditMessages.push(compactedMessage);
      const compactedTokens = countRenderedContextTokens({ instructions: "", messages, tools: requestTools });
      if (compactedTokens > prepared.threshold) throw new Error(`上下文压缩后仍有 ${compactedTokens} tokens，超过阈值 ${prepared.threshold}`);
      prepared.estimatedTokens = requestTokens;
      prepared.compactedTokens = compactedTokens;
      prepared.compaction = { summary, estimatedTokens: requestTokens, compactedTokens, threshold: prepared.threshold, sourceEntries };
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
    const body: Record<string, unknown> = { model: args.agent.settings.model, messages, stream: true, stream_options: { include_usage: true } };
    if (requestTools.length) { body.tools = requestTools; body.tool_choice = "auto"; }
    applyChatThinkingSettings(body, args.agent, baseUrl);
    const startedAt = nowIso(); const startedMs = Date.now(); let stepUsage: unknown = null;
    const roomMessagePreviewStream = createRoomMessagePreviewStream(args);
    let content = ""; let reasoningContent = ""; let sawReasoningContent = false; const callMap = new Map<number, ToolCall>();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
      await parseSse(response, (event) => {
        if (event.usage) stepUsage = event.usage;
        const choices = Array.isArray(event.choices) ? event.choices as Array<Record<string, unknown>> : [];
        const delta = choices[0]?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.reasoning_content === "string") { sawReasoningContent = true; reasoningContent += delta.reasoning_content; reasoningCharacters += delta.reasoning_content.length; }
        if (typeof delta?.content === "string") { content += delta.content; assistantContent += delta.content; addTimeline("assistant_delta", { delta: delta.content }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: delta.content }, args.repository.getVersion().revision); }
        const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
        for (const chunk of chunks) {
          const index = Number(chunk.index ?? 0); const current = callMap.get(index) ?? { id: "", name: "", arguments: "" }; const fn = chunk.function as Record<string, unknown> | undefined;
          const next = { id: current.id || String(chunk.id ?? ""), name: current.name + String(fn?.name ?? ""), arguments: current.arguments + String(fn?.arguments ?? "") };
          callMap.set(index, next); roomMessagePreviewStream.update(next, String(index));
        }
      });
      usage = stepUsage;
      appendModelCall(modelCalls, { purpose: "generation", format: "chat_completions", startedAt, startedMs, usage: stepUsage });
    } catch (error) {
      appendModelCall(modelCalls, { purpose: "generation", format: "chat_completions", startedAt, startedMs, usage: stepUsage, error });
      const partialCalls = [...callMap.values()];
      if (content || reasoningContent || partialCalls.length) {
        auditMessages.push({
          role: "assistant",
          content: content || null,
          ...(sawReasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(partialCalls.length ? { tool_calls: partialCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
        });
      }
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      throw error;
    }
    const calls = [...callMap.values()];
    await roomMessagePreviewStream.flush();
    const includeReasoning = sawReasoningContent || args.agent.settings.thinkingMode === "enabled" || (args.agent.settings.thinkingMode === "provider_default" && isDeepSeekBaseUrl(baseUrl));
    const assistantMessage: Extract<AgentSessionMessage, { role: "assistant" }> = {
      role: "assistant",
      content: content || null,
      ...(includeReasoning ? { reasoning_content: reasoningContent } : {}),
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    messages.push(assistantMessage); sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage);
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    if (calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    if (terminalToolsOnly && calls.some((call) => !terminalToolNames.has(call.name))) throw new Error(`模型在收尾步骤请求了非终结工具：${calls.find((call) => !terminalToolNames.has(call.name))?.name}`);
    if (!calls.length) break;
    if (regularToolsAllowed) toolSteps += 1;
    await executeToolCalls(args, calls, tools, timeline, effects, (output) => {
      const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
      messages.push(toolMessage); sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    });
  }
  addTimeline("turn_finished", { usage });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, contextCompaction: prepared.compaction, modelMeta: { format: "chat_completions", model: args.agent.settings.model, usage, modelCalls, toolSteps, reasoningCharacters, context: contextMeta(prepared) } };
}

async function runResponses(args: RunArgs, modelCalls: ModelCallRecord[]): Promise<ModelTurnResult> {
  const { baseUrl, headers } = apiConfig();
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = [];
  const turnSystemPrompt = systemPrompt(args.agent, args.packet);
  const session = args.repository.getAgentSession(args.agent.id);
  const userMessage: AgentSessionMessage = { role: "user", content: packetText(args.packet) };
  const initialContext = [...session, userMessage].map(responseContextMessage);
  const prepared = await prepareContext(args, "responses", initialContext, modelCalls);
  const addTimeline = createTimelineFactory(args.turnId, timeline); addTimeline("turn_started", { format: "responses", context: contextMeta(prepared) });
  const responseToolDefinitions = toolDefinitionsForResponses();
  let assistantContent = ""; let previousResponseId: string | undefined; let input: unknown = prepared.messages; let usage: unknown = null;
  let continuationMessages = [...prepared.messages];
  let sessionMessages: AgentSessionMessage[] = prepared.compaction
    ? [{ role: "user", content: compactedSessionContent(prepared.compaction.summary) }]
    : [userMessage];
  const auditMessages = [...sessionMessages];
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  for (let step = 0; step <= args.agent.settings.maxToolSteps + 1; step += 1) {
    const regularToolsAllowed = step < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = step === args.agent.settings.maxToolSteps;
    const requestTools = regularToolsAllowed
      ? responseToolDefinitions
      : terminalToolsOnly
        ? responseToolDefinitions.filter((tool) => terminalToolNames.has(tool.name))
        : [];
    const requestTokens = countRenderedContextTokens({ instructions: turnSystemPrompt, messages: continuationMessages, tools: responseToolDefinitions });
    if (requestTokens > prepared.threshold) {
      const sourceEntries = continuationMessages.length;
      const summary = await compactWithResponses(args, continuationMessages, modelCalls);
      continuationMessages = [{ role: "user", content: compactedSessionContent(summary) }];
      const compactedTokens = countRenderedContextTokens({ instructions: turnSystemPrompt, messages: continuationMessages, tools: responseToolDefinitions });
      if (compactedTokens > prepared.threshold) throw new Error(`上下文压缩后仍有 ${compactedTokens} tokens，超过阈值 ${prepared.threshold}`);
      prepared.estimatedTokens = requestTokens;
      prepared.compactedTokens = compactedTokens;
      prepared.compaction = { summary, estimatedTokens: requestTokens, compactedTokens, threshold: prepared.threshold, sourceEntries };
      input = continuationMessages;
      previousResponseId = undefined;
      const compactedMessage: AgentSessionMessage = { role: "user", content: compactedSessionContent(summary) };
      sessionMessages = [compactedMessage];
      auditMessages.push(compactedMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
    const body: Record<string, unknown> = { model: args.agent.settings.model, input, stream: true };
    if (requestTools.length) { body.tools = requestTools; body.tool_choice = "auto"; }
    if (!previousResponseId) body.instructions = turnSystemPrompt; else body.previous_response_id = previousResponseId;
    applyResponsesThinkingSettings(body, args.agent, baseUrl);
    const startedAt = nowIso(); const startedMs = Date.now(); let stepUsage: unknown = null;
    const callMap = new Map<string, ToolCall>(); const roomMessagePreviewStream = createRoomMessagePreviewStream(args); let stepContent = "";
    try {
      const response = await fetch(`${baseUrl}/responses`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
      if (!response.ok && step === 0 && [400, 404, 405].includes(response.status)) {
        throw new ResponsesUnsupportedError(`Responses API 不可用 (${response.status}): ${(await response.text()).slice(0, 1_000)}`);
      }
      await parseSse(response, (event) => {
        const type = String(event.type ?? ""); const responseObject = event.response as Record<string, unknown> | undefined;
        if (typeof responseObject?.id === "string") previousResponseId = responseObject.id;
        if (responseObject?.usage) stepUsage = responseObject.usage;
        if (type === "response.output_text.delta" && typeof event.delta === "string") { stepContent += event.delta; assistantContent += event.delta; addTimeline("assistant_delta", { delta: event.delta }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: event.delta }, args.repository.getVersion().revision); }
        if (type === "response.output_item.added") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const key = String(item.id ?? item.call_id ?? createId("call")); const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
            callMap.set(key, call); roomMessagePreviewStream.update(call, key);
          }
        }
        if (type === "response.function_call_arguments.delta") {
          const key = String(event.item_id ?? event.call_id ?? ""); const current = callMap.get(key) ?? { id: String(event.call_id ?? key), name: String(event.name ?? ""), arguments: "" };
          const call = { ...current, arguments: current.arguments + String(event.delta ?? "") };
          callMap.set(key, call); roomMessagePreviewStream.update(call, key);
        }
        if (type === "response.output_item.done") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
            const key = String(item.id ?? item.call_id ?? "");
            callMap.set(key, call); roomMessagePreviewStream.update(call, key);
          }
        }
      });
      usage = stepUsage;
      appendModelCall(modelCalls, { purpose: "generation", format: "responses", startedAt, startedMs, usage: stepUsage });
    } catch (error) {
      appendModelCall(modelCalls, { purpose: "generation", format: "responses", startedAt, startedMs, usage: stepUsage, error });
      const partialCalls = [...callMap.values()];
      if (stepContent || partialCalls.length) {
        auditMessages.push({
          role: "assistant",
          content: stepContent || null,
          ...(partialCalls.length ? { tool_calls: partialCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
        });
      }
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      throw error;
    }
    const calls = [...callMap.values()];
    await roomMessagePreviewStream.flush();
    const assistantMessage: Extract<AgentSessionMessage, { role: "assistant" }> = {
      role: "assistant",
      content: stepContent || null,
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage); continuationMessages.push(responseContextMessage(assistantMessage));
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    if (calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    if (terminalToolsOnly && calls.some((call) => !terminalToolNames.has(call.name))) throw new Error(`模型在收尾步骤请求了非终结工具：${calls.find((call) => !terminalToolNames.has(call.name))?.name}`);
    if (!calls.length) break;
    const outputs = await executeToolCalls(args, calls, tools, timeline, effects, (output) => {
      const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
      sessionMessages.push(toolMessage); auditMessages.push(toolMessage); continuationMessages.push(responseContextMessage(toolMessage));
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    });
    input = outputs.map((output) => ({ type: "function_call_output", call_id: output.callId, output: output.text }));
  }
  addTimeline("turn_finished", { usage, responseId: previousResponseId });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, contextCompaction: prepared.compaction, modelMeta: { format: "responses", model: args.agent.settings.model, responseId: previousResponseId, usage, modelCalls, context: contextMeta(prepared) } };
}

async function runMock(args: RunArgs): Promise<ModelTurnResult> {
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = []; const addTimeline = createTimelineFactory(args.turnId, timeline);
  const turnSystemPrompt = systemPrompt(args.agent, args.packet);
  const sessionMessages: AgentSessionMessage[] = [{ role: "user", content: packetText(args.packet) }];
  const auditMessages = [...sessionMessages];
  addTimeline("turn_started", { format: "mock" });
  const latestExternal = args.packet.messages.toReversed().find((message) => message.source !== "agent_emit");
  const latest = latestExternal ?? args.packet.messages.at(-1);
  const assistantContent = `我已在私有执行区分析消息 #${latest?.seq ?? "?"}。`;
  checkpointTurn(args, turnSystemPrompt, "", auditMessages, tools, timeline);
  addTimeline("assistant_delta", { delta: assistantContent }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: assistantContent }, args.repository.getVersion().revision);
  if (latest?.content.trim().startsWith("/private")) {
    const assistantMessage: AgentSessionMessage = { role: "assistant", content: assistantContent };
    sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage);
    addTimeline("turn_finished", { reason: "private-only fixture" });
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, modelMeta: { format: "mock", fixture: "private-only" } };
  }
  const wantsNoReply = !latestExternal || /无需回复|不需要回复|已阅即可/i.test(latest?.content ?? "");
  const call: ToolCall = wantsNoReply
    ? { id: createId("tool"), name: "read_no_reply", arguments: JSON.stringify({ roomId: args.packet.room.id, messageId: latest?.id }) }
    : { id: createId("tool"), name: "send_message_to_room", arguments: JSON.stringify({ roomId: args.packet.room.id, content: `收到。我会处理「${(latest?.content ?? "附件任务").slice(0, 160)}」并把可验证结果留在这个房间。`, kind: "answer" }) };
  const assistantMessage: AgentSessionMessage = { role: "assistant", content: assistantContent, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] };
  sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage);
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  await executeToolCalls(args, [call], tools, timeline, effects, (output) => {
    const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
    sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  });
  addTimeline("turn_finished", { fixture: wantsNoReply ? "receipt" : "emit" });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, modelMeta: { format: "mock", fixture: wantsNoReply ? "receipt" : "emit", availableTools: listToolDefinitions().length } };
}

function checkpointTurn(args: RunArgs, system: string, assistantContent: string, auditMessages: AgentSessionMessage[], tools: ToolExecution[], timeline: TimelineEvent[]): void {
  args.repository.checkpointTurn({
    turnId: args.turnId,
    assistantContent,
    systemPrompt: system,
    conversationMessages: auditMessages,
    tools,
    timeline,
  });
}

export async function runAgentModel(args: RunArgs): Promise<ModelTurnResult> {
  if (!process.env.OPENAI_API_KEY) return runMock(args);
  const modelCalls: ModelCallRecord[] = [];
  const format = args.agent.settings.apiFormat;
  try {
    if (format === "chat_completions") return await runChatCompletions(args, modelCalls);
    if (format === "responses") return await runResponses(args, modelCalls);
    try { return await runResponses(args, modelCalls); } catch (error) {
      if (args.signal.aborted || !(error instanceof ResponsesUnsupportedError)) throw error;
      publishWorkspaceEvent("turn.preview", args.turnId, { kind: "compatibility_fallback", error: error instanceof Error ? error.message : String(error) }, args.repository.getVersion().revision);
      return await runChatCompletions(args, modelCalls);
    }
  } catch (error) {
    const lastCall = modelCalls.at(-1);
    throw new ModelRunError(error, {
      format: lastCall?.format ?? (format === "auto" ? "responses" : format),
      model: args.agent.settings.model,
      usage: lastCall?.rawUsage ?? null,
      modelCalls,
    });
  }
}
