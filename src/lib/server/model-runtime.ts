import type { Agent, AgentSessionMessage, SchedulerPacket, TimelineEvent, ToolExecution, TurnEffect } from "@/lib/domain/types";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { getToolDefinition, listToolDefinitions, toolDefinitionsForChat, toolDefinitionsForResponses, type ToolContext } from "@/lib/server/tools";
import { WorkspaceRepository } from "@/lib/server/repository";
import { createId, nowIso } from "@/lib/utils/id";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";

type ToolCall = { id: string; name: string; arguments: string };
const terminalToolNames = new Set(["send_message_to_room", "read_no_reply"]);
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
  sessionMessages: AgentSessionMessage[];
  tools: ToolExecution[];
  timeline: TimelineEvent[];
  effects: TurnEffect[];
  modelMeta: Record<string, unknown>;
};

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

function publishRoomMessagePreview(args: RunArgs, call: ToolCall): void {
  if (call.name !== "send_message_to_room" || !call.id) return;
  const roomId = extractPartialJsonStringField(call.arguments, "roomId");
  const content = extractPartialJsonStringField(call.arguments, "content");
  if (!roomId || !content) return;
  const connected = args.repository.getSnapshot().rooms.some((room) => room.id === roomId && room.participants.some((participant) => participant.agentId === args.agent.id && participant.enabled));
  if (!connected) return;
  const rawKind = extractPartialJsonStringField(call.arguments, "kind");
  const kind = (["answer", "progress", "warning", "error", "clarification"] as const).find((entry) => entry === rawKind) ?? "answer";
  publishWorkspaceEvent("turn.preview", args.turnId, {
    kind: "room_message_preview", roomId, agentId: args.agent.id,
    messageKey: extractPartialJsonStringField(call.arguments, "messageKey") || call.id,
    content, messageKind: kind,
  });
}

async function executeToolCalls(args: RunArgs, calls: ToolCall[], tools: ToolExecution[], timeline: TimelineEvent[], effects: TurnEffect[]) {
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
    outputs.push({ callId: call.id, name: call.name, text: outputText, error: Boolean(error) });
    publishWorkspaceEvent("turn.preview", args.turnId, { kind: "tool", tool });
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
  if (agent.settings.thinkingMode === "provider_default") {
    if (isDeepSeekBaseUrl(baseUrl)) body.reasoning_effort = agent.settings.reasoningEffort;
    return;
  }
  body.thinking = { type: agent.settings.thinkingMode };
  if (agent.settings.thinkingMode === "enabled") body.reasoning_effort = agent.settings.reasoningEffort;
}

function isDeepSeekBaseUrl(baseUrl: string): boolean {
  try { const hostname = new URL(baseUrl).hostname.toLowerCase(); return hostname === "deepseek.com" || hostname.endsWith(".deepseek.com"); }
  catch { return false; }
}

async function runChatCompletions(args: RunArgs): Promise<ModelTurnResult> {
  const { baseUrl, headers } = apiConfig();
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = [];
  const addTimeline = createTimelineFactory(args.turnId, timeline); addTimeline("turn_started", { format: "chat_completions" });
  const session = args.repository.getAgentSession(args.agent.id);
  const userMessage: AgentSessionMessage = { role: "user", content: packetText(args.packet) };
  const sessionMessages: AgentSessionMessage[] = [userMessage];
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt(args.agent, args.packet) },
    ...session,
    userMessage,
  ];
  let assistantContent = ""; let usage: unknown = null; let toolSteps = 0; let reasoningCharacters = 0;
  for (let step = 0; step <= args.agent.settings.maxToolSteps + 1; step += 1) {
    const regularToolsAllowed = step < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = step === args.agent.settings.maxToolSteps;
    const body: Record<string, unknown> = { model: args.agent.settings.model, messages, stream: true, stream_options: { include_usage: true } };
    if (regularToolsAllowed) { body.tools = toolDefinitionsForChat(); body.tool_choice = "auto"; }
    else if (terminalToolsOnly) { body.tools = toolDefinitionsForChat().filter((tool) => terminalToolNames.has(tool.function.name)); body.tool_choice = "auto"; }
    applyChatThinkingSettings(body, args.agent, baseUrl);
    const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
    let content = ""; let reasoningContent = ""; let sawReasoningContent = false; const callMap = new Map<number, ToolCall>();
    await parseSse(response, (event) => {
      if (event.usage) usage = event.usage;
      const choices = Array.isArray(event.choices) ? event.choices as Array<Record<string, unknown>> : [];
      const delta = choices[0]?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.reasoning_content === "string") { sawReasoningContent = true; reasoningContent += delta.reasoning_content; reasoningCharacters += delta.reasoning_content.length; }
      if (typeof delta?.content === "string") { content += delta.content; assistantContent += delta.content; addTimeline("assistant_delta", { delta: delta.content }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: delta.content }); }
      const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
      for (const chunk of chunks) {
        const index = Number(chunk.index ?? 0); const current = callMap.get(index) ?? { id: "", name: "", arguments: "" }; const fn = chunk.function as Record<string, unknown> | undefined;
        const next = { id: current.id || String(chunk.id ?? ""), name: current.name + String(fn?.name ?? ""), arguments: current.arguments + String(fn?.arguments ?? "") };
        callMap.set(index, next); publishRoomMessagePreview(args, next);
      }
    });
    const calls = [...callMap.values()];
    if (calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    if (terminalToolsOnly && calls.some((call) => !terminalToolNames.has(call.name))) throw new Error(`模型在收尾步骤请求了非终结工具：${calls.find((call) => !terminalToolNames.has(call.name))?.name}`);
    const includeReasoning = sawReasoningContent || args.agent.settings.thinkingMode === "enabled" || (args.agent.settings.thinkingMode === "provider_default" && isDeepSeekBaseUrl(baseUrl));
    const assistantMessage: Extract<AgentSessionMessage, { role: "assistant" }> = {
      role: "assistant",
      content: content || null,
      ...(includeReasoning ? { reasoning_content: reasoningContent } : {}),
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    messages.push(assistantMessage); sessionMessages.push(assistantMessage);
    if (!calls.length) break;
    if (regularToolsAllowed) toolSteps += 1;
    const outputs = await executeToolCalls(args, calls, tools, timeline, effects);
    for (const output of outputs) {
      const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
      messages.push(toolMessage); sessionMessages.push(toolMessage);
    }
  }
  addTimeline("turn_finished", { usage });
  return { assistantContent, sessionMessages, tools, timeline, effects, modelMeta: { format: "chat_completions", model: args.agent.settings.model, usage, toolSteps, reasoningCharacters } };
}

async function runResponses(args: RunArgs): Promise<ModelTurnResult> {
  const { baseUrl, headers } = apiConfig();
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = [];
  const addTimeline = createTimelineFactory(args.turnId, timeline); addTimeline("turn_started", { format: "responses" });
  const userMessage: AgentSessionMessage = { role: "user", content: packetText(args.packet) };
  let assistantContent = ""; let previousResponseId: string | undefined; let input: unknown = userMessage.content; let usage: unknown = null;
  for (let step = 0; step <= args.agent.settings.maxToolSteps + 1; step += 1) {
    const regularToolsAllowed = step < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = step === args.agent.settings.maxToolSteps;
    const body: Record<string, unknown> = { model: args.agent.settings.model, input, stream: true };
    if (regularToolsAllowed) { body.tools = toolDefinitionsForResponses(); body.tool_choice = "auto"; }
    else if (terminalToolsOnly) { body.tools = toolDefinitionsForResponses().filter((tool) => terminalToolNames.has(tool.name)); body.tool_choice = "auto"; }
    if (!previousResponseId) body.instructions = systemPrompt(args.agent, args.packet); else body.previous_response_id = previousResponseId;
    const response = await fetch(`${baseUrl}/responses`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
    if (!response.ok && step === 0 && [400, 404, 405].includes(response.status)) {
      throw new ResponsesUnsupportedError(`Responses API 不可用 (${response.status}): ${(await response.text()).slice(0, 1_000)}`);
    }
    const callMap = new Map<string, ToolCall>();
    await parseSse(response, (event) => {
      const type = String(event.type ?? ""); const responseObject = event.response as Record<string, unknown> | undefined;
      if (typeof responseObject?.id === "string") previousResponseId = responseObject.id;
      if (responseObject?.usage) usage = responseObject.usage;
      if (type === "response.output_text.delta" && typeof event.delta === "string") { assistantContent += event.delta; addTimeline("assistant_delta", { delta: event.delta }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: event.delta }); }
      if (type === "response.output_item.added") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const key = String(item.id ?? item.call_id ?? createId("call")); const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
          callMap.set(key, call); publishRoomMessagePreview(args, call);
        }
      }
      if (type === "response.function_call_arguments.delta") {
        const key = String(event.item_id ?? event.call_id ?? ""); const current = callMap.get(key) ?? { id: String(event.call_id ?? key), name: String(event.name ?? ""), arguments: "" };
        const call = { ...current, arguments: current.arguments + String(event.delta ?? "") };
        callMap.set(key, call); publishRoomMessagePreview(args, call);
      }
      if (type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
          callMap.set(String(item.id ?? item.call_id ?? ""), call); publishRoomMessagePreview(args, call);
        }
      }
    });
    const calls = [...callMap.values()];
    if (calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    if (terminalToolsOnly && calls.some((call) => !terminalToolNames.has(call.name))) throw new Error(`模型在收尾步骤请求了非终结工具：${calls.find((call) => !terminalToolNames.has(call.name))?.name}`);
    if (!calls.length) break;
    const outputs = await executeToolCalls(args, calls, tools, timeline, effects);
    input = outputs.map((output) => ({ type: "function_call_output", call_id: output.callId, output: output.text }));
  }
  addTimeline("turn_finished", { usage, responseId: previousResponseId });
  return { assistantContent, sessionMessages: [userMessage, { role: "assistant", content: assistantContent }], tools, timeline, effects, modelMeta: { format: "responses", model: args.agent.settings.model, responseId: previousResponseId, usage } };
}

async function runMock(args: RunArgs): Promise<ModelTurnResult> {
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = []; const addTimeline = createTimelineFactory(args.turnId, timeline);
  addTimeline("turn_started", { format: "mock" });
  const latestExternal = args.packet.messages.toReversed().find((message) => message.source !== "agent_emit");
  const latest = latestExternal ?? args.packet.messages.at(-1);
  const assistantContent = `我已在私有执行区分析消息 #${latest?.seq ?? "?"}。`;
  addTimeline("assistant_delta", { delta: assistantContent }); publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: assistantContent });
  if (latest?.content.trim().startsWith("/private")) {
    addTimeline("turn_finished", { reason: "private-only fixture" });
    return { assistantContent, sessionMessages: [{ role: "user", content: packetText(args.packet) }, { role: "assistant", content: assistantContent }], tools, timeline, effects, modelMeta: { format: "mock", fixture: "private-only" } };
  }
  const wantsNoReply = !latestExternal || /无需回复|不需要回复|已阅即可/i.test(latest?.content ?? "");
  const call: ToolCall = wantsNoReply
    ? { id: createId("tool"), name: "read_no_reply", arguments: JSON.stringify({ roomId: args.packet.room.id, messageId: latest?.id }) }
    : { id: createId("tool"), name: "send_message_to_room", arguments: JSON.stringify({ roomId: args.packet.room.id, content: `收到。我会处理「${(latest?.content ?? "附件任务").slice(0, 160)}」并把可验证结果留在这个房间。`, kind: "answer" }) };
  await executeToolCalls(args, [call], tools, timeline, effects); addTimeline("turn_finished", { fixture: wantsNoReply ? "receipt" : "emit" });
  return { assistantContent, sessionMessages: [{ role: "user", content: packetText(args.packet) }, { role: "assistant", content: assistantContent }], tools, timeline, effects, modelMeta: { format: "mock", fixture: wantsNoReply ? "receipt" : "emit", availableTools: listToolDefinitions().length } };
}

export async function runAgentModel(args: RunArgs): Promise<ModelTurnResult> {
  if (!process.env.OPENAI_API_KEY) return runMock(args);
  const format = args.agent.settings.apiFormat;
  if (format === "chat_completions") return runChatCompletions(args);
  if (format === "responses") return runResponses(args);
  try { return await runResponses(args); } catch (error) {
    if (args.signal.aborted || !(error instanceof ResponsesUnsupportedError)) throw error;
    publishWorkspaceEvent("turn.preview", args.turnId, { kind: "compatibility_fallback", error: error instanceof Error ? error.message : String(error) });
    return runChatCompletions(args);
  }
}
