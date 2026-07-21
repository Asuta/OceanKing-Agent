import { isTerminalAgentMessageKind, publicAgentMessageKinds, type Agent, type AgentSessionMessage, type ContextCompaction, type ModelCallRecord, type SchedulerPacket, type TimelineEvent, type ToolExecution, type TurnEffect } from "@/lib/domain/types";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { getToolDefinition, listToolDefinitions, toolDefinitionsForChat, toolDefinitionsForResponses, type ToolContext } from "@/lib/server/tools";
import { WorkspaceRepository } from "@/lib/server/repository";
import { createId, nowIso } from "@/lib/utils/id";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";
import {
  compactedSessionContent, contextCompactionInstructions, countRenderedContextTokens,
} from "@/lib/server/context-compaction";
import { interruptedTurnSystemInstructions } from "@/lib/server/interruption-snapshot";
import { formatSchedulerPacketForModel } from "@/lib/server/scheduler-prompt";
import { maxRoomMessageContentCharacters, sendMessageToolSchema } from "@/lib/domain/schemas";

type ToolCall = { id: string; name: string; arguments: string };
type PublicMessageKind = (typeof publicAgentMessageKinds)[number];
type PublicMessageRoute = { roomId: string; messageKey: string; kind: PublicMessageKind };
type ToolCallOutput = { callId: string; name: string; text: string; error: boolean; structured: unknown };
const terminalToolNames = new Set(["begin_message_to_room", "read_no_reply"]);
const maxDeliveryRepairAttempts = 2;
const maxPublicMessageRepairAttempts = 2;
const maxInitialProgressRepairAttempts = 2;
const maxTerminalToolRepairAttempts = 2;
class ResponsesUnsupportedError extends Error {}
class ModelHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`模型接口错误 ${status}: ${body}`);
    this.name = "ModelHttpError";
  }
}
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
  awaitingRoomId: string | null;
  modelMeta: Record<string, unknown>;
  contextCompaction?: ContextCompaction;
};

export class ModelRunError extends Error {
  readonly originalError: unknown;
  readonly modelMeta: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(error: unknown, modelMeta: Record<string, unknown>) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ModelRunError";
    this.originalError = error;
    this.modelMeta = modelMeta;
    this.retryable = error instanceof ModelHttpError
      ? error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
      : error instanceof TypeError;
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

function sessionWithoutLegacyMessageCalls(messages: AgentSessionMessage[]): AgentSessionMessage[] {
  const removedCallIds = new Set<string>();
  const sanitized: AgentSessionMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const legacyPublicMessages: string[] = [];
      const retainedCalls = message.tool_calls.filter((call) => {
        if (call.function.name !== "send_message_to_room") return true;
        removedCallIds.add(call.id);
        try {
          const args = asRecord(JSON.parse(call.function.arguments));
          if (typeof args?.content === "string" && args.content) {
            const room = typeof args.roomId === "string" ? `到房间 ${args.roomId}` : "";
            legacyPublicMessages.push(`[历史公开回复${room}]\n${args.content}`);
          }
        } catch { /* Malformed legacy calls cannot contribute reliable history. */ }
        return false;
      });
      const mergedContent = [message.content, ...legacyPublicMessages].filter((content): content is string => Boolean(content)).join("\n\n") || null;
      if (!retainedCalls.length && !mergedContent && !message.reasoning_content) continue;
      const rest = { ...message, content: mergedContent };
      delete rest.tool_calls;
      sanitized.push(retainedCalls.length ? { ...rest, tool_calls: retainedCalls } : rest);
      continue;
    }
    if (message.role === "tool" && removedCallIds.has(message.tool_call_id)) continue;
    sanitized.push(message);
  }
  return sanitized;
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

function systemPrompt(args: RunArgs): string {
  return [
    "你运行在 OceanKing 多 Agent 工作台中。",
    "重要契约：普通 assistant 文本默认是私有执行记录，人类在房间里看不到。需要公开表达时，先调用 begin_message_to_room 打开目标房间；工具成功后的下一次 assistant 回复会作为该房间的公开正文实时发送。",
    "begin_message_to_room 之后可以按需继续调用工具；结构化工具调用本身不会成为公开正文。此阶段的 assistant content 会实时公开，只能写给房间成员阅读的正文，不得夹带私有构思、路由解释或 JSON。不要为了看起来有回复而伪造消息；无需回复时调用 read_no_reply。",
    "历史记录里可能出现旧工具 send_message_to_room；它已经停用，绝不能继续调用，也不要把公开正文放进任何工具参数。",
    "每个待处理房间都是独立交付义务；一次 begin_message_to_room 后的公开正文，或一次 read_no_reply，只处理它明确指定的那个房间。结束本轮前必须逐一处理下面列出的全部义务。",
    "kind=progress 只表示进度。kind=collaboration 表示需要其他 Agent 后续回复的协作请求，不会完成来源任务的最终汇报义务；但在系统标记的自动续办协作房间中，它会处理当前来信并继续等待下一条消息。任务完成时必须向来源房间发送 answer、warning、error 或 clarification。read_no_reply 必须精确指向所列 messageId。",
    "进度汇报规则：对需要调用工具或分阶段完成的任务，在开始实质工作前，必须向对应房间发送一条 kind=progress，简要说明准备怎样处理；短小且可直接回答的任务不必发送进度。",
    "执行过程中可以多次发送 kind=progress，但只在完成有意义的阶段、得到关键发现、遇到阻塞或执行计划发生变化时发送。进度应是面向房间成员的简洁阶段摘要，不是私有思维链，也不要逐次复述每个工具调用。",
    "不要发送定时心跳、等待状态、重复内容、没有新信息的进度、敏感信息或完整工具参数。最后仍须向每个相关房间发送 answer、warning、error 或 clarification 终结消息。",
    "房间不是默认隐私边界，但只能读取和发送到当前 Agent 已连接的房间。房间管理权限由工具执行层校验。",
    "创建房间时，create_room 会让你自动成为 owner 并连接；如需拉人，直接在同一次调用的 agentIds 中列出所有目标 Agent，不要要求人类手动操作。",
    "在新房间启动协作的第一条正式消息必须包含足够独立执行的任务目标、分工、终止条件和当前进度；其他 Agent 看不到来源房间，不要只发送孤立的数字或片段。",
    "向另一个包含 Agent 的房间发出需要后续回复的任务请求时，必须使用 kind=collaboration；运行时会自动提交消息、结束当前 Turn，并在目标房间出现新消息后恢复。无需回复的单向通知或最终结果不得使用 collaboration。不要调用 read_room_history 轮询，不要发送重复的等待进度，也不要用 read_no_reply 放弃仍需最终汇报的来源任务。",
    "恢复自动续办任务后：若目标尚未完成并且需要对方继续回复，向当前协作房间发送 kind=collaboration；运行时会同时处理当前来信并继续等待下一条消息。若目标已经完成，必须在同一 Turn 向系统列出的来源房间发送 answer、warning、error 或 clarification 最终结果。",
    "每轮输入只携带尚未处理的房间增量；需要房间清单或可用 Agent 清单时，分别调用 list_connected_rooms 或 list_available_agents。",
    ...interruptedTurnSystemInstructions,
    `当前 Agent：${args.agent.label}（${args.agent.id}）`,
    `Agent 指令：${args.agent.instruction}`,
  ].join("\n");
}

function turnUserContent(args: RunArgs): string {
  const obligations = args.repository.getTurnDeliveryObligations(args.turnId);
  const awaitingTasks = args.repository.getTurnAwaitingTasks(args.turnId);
  return [
    formatSchedulerPacketForModel(args.packet),
    "",
    "[系统本轮交付控制]",
    `当前房间：${args.packet.room.title}（${args.packet.room.id}）`,
    ...(args.packet.type === "delivery_packet"
      ? ["这是仅投递重试轮：原任务及其副作用已经执行过。本轮只能公开既有结果或标记无需回复，严禁重新执行原任务。"]
      : []),
    "本轮必须逐一处理以下房间义务：",
    ...(obligations.length
      ? obligations.map((obligation) => `- roomId=${obligation.roomId}, messageId=${obligation.messageId}`)
      : ["- 当前没有新增交付义务。"]),
    ...(awaitingTasks.length
      ? [
        "",
        "[系统跨房间自动续办]",
        "以下来源任务正在当前协作房间推进。目标未完成且需要对方继续回复时，向当前房间发送 kind=collaboration，系统会处理当前来信并自动等待下一条消息；目标完成时必须向来源房间发送 answer、warning、error 或 clarification 最终结果：",
        ...awaitingTasks.map((task) => `- sourceRoomId=${task.roomId}, sourceMessageId=${task.messageId}`),
      ]
      : []),
  ].join("\n");
}

function unresolvedDeliveryObligations(args: RunArgs, effects: TurnEffect[]): Array<{ roomId: string; messageId: string }> {
  return args.repository.getTurnDeliveryObligations(args.turnId).filter((obligation) => !effects.some((effect) => {
    if (effect.type === "send_message") {
      return effect.roomId === obligation.roomId
        && (isTerminalAgentMessageKind(effect.kind) || isCurrentRoomAwaitingContinuation(args, effects, effect));
    }
    return effect.type === "read_no_reply" && effect.roomId === obligation.roomId && effect.messageId === obligation.messageId;
  }));
}

function allDeliveryObligationsResolved(args: RunArgs, effects: TurnEffect[]): boolean {
  const obligations = args.repository.getTurnDeliveryObligations(args.turnId);
  return obligations.length > 0 && unresolvedDeliveryObligations(args, effects).length === 0;
}

function unresolvedAwaitingTasks(args: RunArgs, effects: TurnEffect[]): Array<{ roomId: string; messageId: string }> {
  return args.repository.getTurnAwaitingTasks(args.turnId).filter((task) => !effects.some((effect) => {
    if (effect.type === "send_message") return effect.roomId === task.roomId && isTerminalAgentMessageKind(effect.kind);
    return effect.type === "read_no_reply" && effect.roomId === task.roomId && effect.messageId === task.messageId;
  }));
}

function roomHasOtherAgent(args: RunArgs, effects: TurnEffect[], roomId: string): boolean {
  const effectiveParticipants = new Map<string, string>();
  for (const participant of args.repository.getRoom(roomId)?.participants ?? []) {
    if (participant.enabled && participant.agentId) effectiveParticipants.set(participant.id, participant.agentId);
  }
  for (const effect of effects) {
    if (!("roomId" in effect) || effect.roomId !== roomId) continue;
    if (effect.type === "create_room") {
      effectiveParticipants.clear();
      effectiveParticipants.set(`owner:${args.agent.id}`, args.agent.id);
      for (const agentId of effect.invitedAgentIds) effectiveParticipants.set(`invite:${agentId}`, agentId);
    } else if (effect.type === "invite_agent") {
      if (![...effectiveParticipants.values()].includes(effect.agentId)) effectiveParticipants.set(effect.participantId, effect.agentId);
    } else if (effect.type === "remove_participant" || effect.type === "leave_room") {
      effectiveParticipants.delete(effect.participantId);
    }
  }
  return [...effectiveParticipants.values()].some((agentId) => agentId !== args.agent.id);
}

function isCurrentRoomAwaitingContinuation(args: RunArgs, effects: TurnEffect[], effect: Extract<TurnEffect, { type: "send_message" }>): boolean {
  return args.packet.type !== "delivery_packet"
    && effect.kind === "collaboration"
    && effect.roomId === args.packet.room.id
    && unresolvedAwaitingTasks(args, effects).length > 0
    && roomHasOtherAgent(args, effects, effect.roomId);
}

function automaticAwaitingTarget(args: RunArgs, effects: TurnEffect[], effect: Extract<TurnEffect, { type: "send_message" }>): string | null {
  if (args.packet.type === "delivery_packet" || effect.kind !== "collaboration") return null;
  if (!roomHasOtherAgent(args, effects, effect.roomId)) return null;
  return effect.roomId !== args.packet.room.id || isCurrentRoomAwaitingContinuation(args, effects, effect)
    ? effect.roomId
    : null;
}

function awaitingTaskDecisionMessage(args: RunArgs, tasks: Array<{ roomId: string; messageId: string }>): AgentSessionMessage {
  return {
    role: "user",
    content: [
      "[系统跨房间自动续办判断]",
      `当前协作房间 ${args.packet.room.id} 的本轮消息已经处理，但以下来源任务还没有最终汇报：`,
      ...tasks.map((task) => `- sourceRoomId=${task.roomId}, sourceMessageId=${task.messageId}`),
      "如果完整目标已经达成，现在向来源房间发送 answer、warning、error 或 clarification 最终结果；如果仍需等待当前房间的未来消息，直接结束本轮，不要调用历史读取工具、不要发送等待状态，运行时会自动续办。",
    ].join("\n"),
  };
}

function deliveryRepairMessage(obligations: Array<{ roomId: string; messageId: string }>): AgentSessionMessage {
  return {
    role: "user",
    content: [
      "[系统交付校验未通过]",
      "下面这些房间仍没有终结动作。现在只处理交付：对每个房间分别调用 begin_message_to_room，然后在下一次 assistant 回复中只输出该房间的完整公开正文；或在确实无需回复时调用精确 messageId 的 read_no_reply。默认私有 assistant 文本、kind=progress 和 kind=collaboration 都不能完成来源房间义务。",
      ...obligations.map((obligation) => `- roomId=${obligation.roomId}, messageId=${obligation.messageId}`),
    ].join("\n"),
  };
}

function terminalToolRepairMessage(calls: ToolCall[]): AgentSessionMessage {
  const names = [...new Set(calls.map((call) => call.name))];
  return {
    role: "user",
    content: [
      "[系统收尾工具校验未通过]",
      `这些非终结工具没有执行：${names.join("、")}。`,
      "当前只允许 begin_message_to_room 或 read_no_reply。",
    ].join("\n"),
  };
}

function blockedTerminalToolOutputs(calls: ToolCall[]): ToolCallOutput[] {
  return calls.map((call) => ({
    callId: call.id,
    name: call.name,
    text: "[系统未执行工具] 当前已进入收尾阶段；请选择公开交付或无需回复。",
    error: true,
    structured: null,
  }));
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

function maxModelStepsForRun(args: RunArgs): number {
  const deliveryObligations = args.repository.getTurnDeliveryObligations(args.turnId).length;
  return Math.max(
    8,
    args.agent.settings.maxToolSteps * 2
      + deliveryObligations * 2
      + maxDeliveryRepairAttempts
      + maxPublicMessageRepairAttempts
      + maxInitialProgressRepairAttempts
      + maxTerminalToolRepairAttempts
      + 4,
  );
}

function terminalToolAllowed(name: string): boolean {
  return terminalToolNames.has(name);
}

function publicMessageRoute(value: unknown): PublicMessageRoute | null {
  const record = asRecord(value);
  if (record?.type !== "begin_room_message" || typeof record.roomId !== "string" || typeof record.messageKey !== "string") return null;
  const kind = publicAgentMessageKinds.find((entry) => entry === record.kind);
  return kind ? { roomId: record.roomId, messageKey: record.messageKey, kind } : null;
}

function routeFromToolOutputs(outputs: ToolCallOutput[]): PublicMessageRoute | null {
  const routes = outputs.filter((output) => output.name === "begin_message_to_room" && !output.error).map((output) => publicMessageRoute(output.structured)).filter((route): route is PublicMessageRoute => Boolean(route));
  if (routes.length > 1) throw new Error("一次模型回复只能打开一个房间的公开消息通道");
  return routes[0] ?? null;
}

function upgradeLegacyMessageCall(call: ToolCall): ToolCall {
  if (call.name !== "send_message_to_room") return call;
  let argumentsValue = call.arguments;
  try {
    const args = asRecord(JSON.parse(call.arguments));
    if (args) {
      argumentsValue = JSON.stringify({
        roomId: args.roomId,
        kind: args.kind,
      });
    }
  } catch { /* begin_message_to_room will return the canonical validation error. */ }
  return { ...call, name: "begin_message_to_room", arguments: argumentsValue };
}

function publicMessageRetry(route: PublicMessageRoute): AgentSessionMessage {
  return { role: "user", content: `[系统公开消息校验未通过]\n房间 ${route.roomId} 的公开正文为空。请继续处理，并在准备好后输出完整正文。` };
}

function publicMessageRouteSwitchRetry(current: PublicMessageRoute, attempted: PublicMessageRoute): AgentSessionMessage {
  return {
    role: "user",
    content: `[系统公开消息校验未通过]\n房间 ${current.roomId} 的公开正文仍为空，因此刚才请求打开的房间 ${attempted.roomId} 没有生效。当前仍是原通道；请先为原房间输出完整正文，提交后如有必要再重新打开新通道。`,
  };
}

function publicMessageRouteCancelledForAwaiting(committed: PublicMessageRoute, attempted: PublicMessageRoute): AgentSessionMessage {
  return {
    role: "user",
    content: `[系统跨房间自动等待]\n房间 ${committed.roomId} 的 collaboration 请求已经提交，当前 Turn 将在该房间等待后续回复。刚才请求打开的房间 ${attempted.roomId} 没有生效；任务恢复后如仍需发言，请重新调用 begin_message_to_room。`,
  };
}

function publicMessageControl(route: PublicMessageRoute): AgentSessionMessage {
  return {
    role: "user",
    content: [
      "[系统公开输出阶段]",
      `目标房间：${route.roomId}`,
      `消息类型：${route.kind}`,
      "后续 assistant 回复的全部 content 会被实时公开到目标房间。",
      "需要时可以继续调用工具；content 只写给房间成员阅读的正文，不要输出构思、前言、路由信息或 JSON。最终正文不能为空。",
    ].join("\n"),
  };
}

function progressContinuation(route: PublicMessageRoute): AgentSessionMessage {
  return {
    role: "user",
    content: [
      "[系统进度消息已提交]",
      `房间 ${route.roomId} 已收到这条阶段进度。继续执行当前任务。`,
      "之后完成有意义的阶段、得到关键发现、遇到阻塞或计划变化时，可以再次发送 kind=progress；不要发送定时心跳、重复状态或没有新信息的消息。",
      "最终完成时仍须使用 begin_message_to_room 提交 answer、warning、error 或 clarification 正式结果。",
    ].join("\n"),
  };
}

function consumesToolStep(calls: ToolCall[], openedRoute: PublicMessageRoute | null): boolean {
  return !(openedRoute?.kind === "progress" && calls.length === 1 && calls[0]?.name === "begin_message_to_room");
}

function needsInitialProgress(args: RunArgs, effects: TurnEffect[], calls: ToolCall[]): boolean {
  if (args.packet.type === "delivery_packet" || calls.every((call) => terminalToolNames.has(call.name))) return false;
  return !effects.some((effect) => effect.type === "send_message" && effect.roomId === args.packet.room.id && effect.kind === "progress");
}

function initialProgressRepairMessage(args: RunArgs, calls: ToolCall[]): AgentSessionMessage {
  const toolNames = [...new Set(calls.filter((call) => !terminalToolNames.has(call.name)).map((call) => call.name))];
  return {
    role: "user",
    content: [
      "[系统初始进度校验未通过]",
      `房间 ${args.packet.room.id} 的任务尚未收到开始进度，因此这些工作工具没有执行：${toolNames.join("、")}。`,
      `现在先调用 begin_message_to_room，roomId 必须是 ${args.packet.room.id}，kind 必须是 progress；在下一次 assistant 正文中简要说明处理计划。`,
      "进度提交后，再重新调用刚才需要的工作工具。不要把工具结果写进进度消息，因为工具尚未执行。",
    ].join("\n"),
  };
}

function blockedToolOutputs(calls: ToolCall[], roomId: string): ToolCallOutput[] {
  return calls.map((call) => ({
    callId: call.id,
    name: call.name,
    text: `[系统未执行工具] 房间 ${roomId} 尚未收到初始进度；请先发送 kind=progress，再重试此工具。`,
    error: true,
    structured: null,
  }));
}

function publicMessageEffect(route: PublicMessageRoute, content: string): Extract<TurnEffect, { type: "send_message" }> {
  const validated = sendMessageToolSchema.parse({ roomId: route.roomId, messageKey: route.messageKey, content, kind: route.kind });
  return { type: "send_message", roomId: validated.roomId, messageId: createId("msg"), messageKey: validated.messageKey ?? route.messageKey, content: validated.content, kind: validated.kind };
}

function commitPublicMessage(args: RunArgs, effects: TurnEffect[], route: PublicMessageRoute, content: string) {
  const unresolvedBefore = unresolvedDeliveryObligations(args, effects);
  const effect = publicMessageEffect(route, content);
  effects.push(effect);
  const unresolved = unresolvedDeliveryObligations(args, effects);
  return {
    effect,
    unresolved,
    awaitingTasks: unresolvedAwaitingTasks(args, effects),
    awaitingRoomId: automaticAwaitingTarget(args, effects, effect),
    resolvedObligation: unresolved.length < unresolvedBefore.length,
  };
}

function publishPublicMessageDelta(args: RunArgs, route: PublicMessageRoute, delta: string): void {
  if (!delta || args.signal.aborted) return;
  publishWorkspaceEvent("turn.preview", args.turnId, {
    kind: "room_message_preview",
    roomId: route.roomId,
    agentId: args.agent.id,
    messageKey: route.messageKey,
    delta,
    messageKind: route.kind,
  }, args.repository.getVersion().revision);
}

function replacePublicMessagePreview(args: RunArgs, route: PublicMessageRoute, content: string): void {
  if (args.signal.aborted) return;
  publishWorkspaceEvent("turn.preview", args.turnId, {
    kind: "room_message_preview",
    roomId: route.roomId,
    agentId: args.agent.id,
    messageKey: route.messageKey,
    content,
    messageKind: route.kind,
  }, args.repository.getVersion().revision);
}

function stripSerializedToolMarkup(content: string): { content: string; stripped: boolean } {
  const markers = ["<｜｜DSML｜｜tool_calls>", "<|DSML|tool_calls>"];
  const markerIndex = markers.reduce((earliest, marker) => {
    const index = content.indexOf(marker);
    return index < 0 ? earliest : Math.min(earliest, index);
  }, content.length);
  if (markerIndex === content.length) return { content, stripped: false };
  return { content: content.slice(0, markerIndex).trimEnd(), stripped: true };
}

async function executeToolCalls(args: RunArgs, calls: ToolCall[], tools: ToolExecution[], timeline: TimelineEvent[], effects: TurnEffect[], modelStep: number, onOutput?: (output: ToolCallOutput) => void, options?: { allowHiddenTools?: boolean }): Promise<ToolCallOutput[]> {
  const addTimeline = createTimelineFactory(args.turnId, timeline);
  const outputs: ToolCallOutput[] = [];
  for (const [callIndex, call] of calls.entries()) {
    if (args.signal.aborted) throw new DOMException("已停止", "AbortError");
    const started = Date.now(); addTimeline("tool_started", { id: call.id, name: call.name, arguments: call.arguments });
    let parsed: unknown = {};
    try { parsed = call.arguments ? JSON.parse(call.arguments) : {}; } catch { parsed = { _partialJson: call.arguments }; }
    const definition = getToolDefinition(call.name);
    let outputText = ""; let structured: unknown = {}; let error: string | null = null;
    try {
      if (!definition || (definition.modelVisible === false && !options?.allowHiddenTools)) throw new Error(`未知或已停用工具：${call.name}`);
      const context: ToolContext = { agent: args.agent, roomId: args.packet.room.id, agentParticipantId: args.agentParticipantId, packet: args.packet, repository: args.repository, signal: args.signal, turnId: args.turnId, pendingEffects: effects };
      const invocationKey = `${args.turnId}:model:${modelStep}:tool:${callIndex}`;
      const result = await definition.execute(context, parsed, call.id, invocationKey);
      outputText = result.text; structured = result.structured; effects.push(...result.effects);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught); outputText = `工具执行失败：${error}`; structured = { error };
    }
    const tool: ToolExecution = { id: call.id || createId("tool"), turnId: args.turnId, name: call.name, input: parsed, outputText, structuredResult: structured, status: error ? "error" : "completed", durationMs: Date.now() - started, error, createdAt: nowIso() };
    tools.push(tool); addTimeline("tool_finished", { id: tool.id, name: tool.name, status: tool.status, durationMs: tool.durationMs, error });
    const output = { callId: call.id, name: call.name, text: outputText, error: Boolean(error), structured };
    outputs.push(output); onOutput?.(output);
    publishWorkspaceEvent("turn.preview", args.turnId, { kind: "tool", tool }, args.repository.getVersion().revision);
  }
  return outputs;
}

async function parseSse(response: Response, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
  if (!response.ok) throw new ModelHttpError(response.status, (await response.text()).slice(0, 2_000));
  if (!response.body) throw new Error("模型接口未返回流");
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/); buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
      onEvent(event);
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

async function compactWithChatCompletions(
  args: RunArgs,
  messages: Array<Record<string, unknown>>,
  modelCalls: ModelCallRecord[],
  requestSystemPrompt: string,
  requestTools: Array<Record<string, unknown>>,
): Promise<string> {
  const { baseUrl, headers } = apiConfig();
  const body: Record<string, unknown> = {
    model: args.agent.settings.model,
    messages: [
      { role: "system", content: requestSystemPrompt },
      ...messages,
      { role: "system", content: contextCompactionInstructions },
      { role: "user", content: "现在压缩上面的完整会话，只输出可供 Agent 继续工作的压缩上下文。" },
    ],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (requestTools.length) { body.tools = requestTools; body.tool_choice = "auto"; }
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
  const allTools = format === "responses" ? toolDefinitionsForResponses() : toolDefinitionsForChat();
  const tools = args.packet.type === "delivery_packet"
    ? allTools.filter((tool) => terminalToolNames.has("function" in tool ? tool.function.name : tool.name))
    : allTools;
  const instructions = systemPrompt(args);
  const estimatedTokens = countRenderedContextTokens({ instructions, messages, tools });
  const threshold = args.agent.settings.contextTokenThreshold;
  if (estimatedTokens <= threshold) return { messages, estimatedTokens, compactedTokens: null, threshold };

  const summary = format === "responses"
    ? await compactWithResponses(args, messages, modelCalls)
    : await compactWithChatCompletions(args, messages.map((message) => ({ ...message })), modelCalls, instructions, tools);
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
  const turnSystemPrompt = systemPrompt(args);
  const session = sessionWithoutLegacyMessageCalls(args.repository.getAgentSession(args.agent.id));
  const userMessage: AgentSessionMessage = { role: "user", content: turnUserContent(args) };
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
  let deliveryOnly = args.packet.type === "delivery_packet"; let deliveryRepairAttempts = 0;
  let activePublicRoute: PublicMessageRoute | null = null; let activePublicContent = ""; let publicMessageRepairAttempts = 0;
  let initialProgressRepairAttempts = 0;
  let terminalToolRepairAttempts = 0;
  let awaitingRoomId: string | null = null;
  let awaitingDecisionRoomId: string | null = null;
  let activePublicTools: typeof chatToolDefinitions = [];
  const maxModelSteps = maxModelStepsForRun(args);
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  for (let modelStep = 0; modelStep < maxModelSteps; modelStep += 1) {
    const publicRouteForStep = activePublicRoute;
    const regularToolsAllowed = !awaitingDecisionRoomId && !deliveryOnly && toolSteps < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = Boolean(awaitingDecisionRoomId) || deliveryOnly || toolSteps >= args.agent.settings.maxToolSteps;
    const requestTools = publicRouteForStep
      ? activePublicTools
      : regularToolsAllowed
      ? chatToolDefinitions
      : terminalToolsOnly
        ? chatToolDefinitions.filter((tool) => terminalToolAllowed(tool.function.name))
        : [];
    const requestSystemPrompt = turnSystemPrompt;
    messages[0] = { role: "system", content: requestSystemPrompt };
    const requestTokens = countRenderedContextTokens({ instructions: "", messages, tools: requestTools });
    if (requestTokens > prepared.threshold) {
      const sourceEntries = messages.length - 1;
      const summary = await compactWithChatCompletions(args, messages.slice(1), modelCalls, requestSystemPrompt, requestTools);
      messages.splice(0, messages.length,
        { role: "system", content: requestSystemPrompt },
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
    applyChatThinkingSettings(body, args.agent, baseUrl);
    if (requestTools.length) {
      body.tools = requestTools;
      body.tool_choice = "auto";
    }
    const startedAt = nowIso(); const startedMs = Date.now(); let stepUsage: unknown = null;
    let content = ""; let reasoningContent = ""; let sawReasoningContent = false; const callMap = new Map<number, ToolCall>();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
      await parseSse(response, (event) => {
        if (event.usage) stepUsage = event.usage;
        const choices = Array.isArray(event.choices) ? event.choices as Array<Record<string, unknown>> : [];
        const delta = choices[0]?.delta as Record<string, unknown> | undefined;
        if (typeof delta?.reasoning_content === "string") {
          sawReasoningContent = true;
          reasoningContent += delta.reasoning_content;
          reasoningCharacters += delta.reasoning_content.length;
          if (delta.reasoning_content && args.agent.settings.thinkingMode !== "disabled") publishWorkspaceEvent("turn.preview", args.turnId, { kind: "reasoning_delta", step: modelStep, delta: delta.reasoning_content }, args.repository.getVersion().revision);
        }
        if (typeof delta?.content === "string") {
          if (publicRouteForStep && activePublicContent.length + content.length + delta.content.length > maxRoomMessageContentCharacters) {
            throw new Error(`公开正文超过 ${maxRoomMessageContentCharacters} 字符上限`);
          }
          content += delta.content;
          if (publicRouteForStep) {
            addTimeline("assistant_delta", { delta: delta.content, visibility: "public", roomId: publicRouteForStep.roomId });
            publishPublicMessageDelta(args, publicRouteForStep, delta.content);
          } else {
            assistantContent += delta.content;
            addTimeline("assistant_delta", { delta: delta.content });
            publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: delta.content }, args.repository.getVersion().revision);
          }
        }
        const chunks = Array.isArray(delta?.tool_calls) ? delta.tool_calls as Array<Record<string, unknown>> : [];
        for (const chunk of chunks) {
          const index = Number(chunk.index ?? 0); const current = callMap.get(index) ?? { id: "", name: "", arguments: "" }; const fn = chunk.function as Record<string, unknown> | undefined;
          const next = { id: current.id || String(chunk.id ?? ""), name: current.name + String(fn?.name ?? ""), arguments: current.arguments + String(fn?.arguments ?? "") };
          callMap.set(index, next);
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
    const calls = [...callMap.values()].map(upgradeLegacyMessageCall);
    if (publicRouteForStep) {
      const sanitized = stripSerializedToolMarkup(content);
      if (sanitized.stripped) {
        content = sanitized.content;
        replacePublicMessagePreview(args, publicRouteForStep, activePublicContent + content);
        addTimeline("assistant_delta", { content, visibility: "public", roomId: publicRouteForStep.roomId, sanitizedToolMarkup: true });
      }
    }
    const includeReasoning = sawReasoningContent || args.agent.settings.thinkingMode === "enabled" || (args.agent.settings.thinkingMode === "provider_default" && isDeepSeekBaseUrl(baseUrl));
    const assistantMessage: Extract<AgentSessionMessage, { role: "assistant" }> = {
      role: "assistant",
      content: content || null,
      ...(includeReasoning ? { reasoning_content: reasoningContent } : {}),
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    messages.push(assistantMessage); sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage);
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    if (publicRouteForStep && !calls.length) {
      if (args.signal.aborted) throw new DOMException("公开正文生成已停止", "AbortError");
      const publicContent = activePublicContent + content;
      if (!publicContent.trim()) {
        if (publicMessageRepairAttempts >= maxPublicMessageRepairAttempts) throw new Error(`房间 ${publicRouteForStep.roomId} 的公开正文连续为空`);
        publicMessageRepairAttempts += 1;
        const retryMessage = publicMessageRetry(publicRouteForStep);
        messages.push(retryMessage); sessionMessages.push(retryMessage); auditMessages.push(retryMessage);
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      const committed = commitPublicMessage(args, effects, publicRouteForStep, publicContent);
      const { effect, unresolved, awaitingTasks, awaitingRoomId: crossRoomAwaitingTarget, resolvedObligation } = committed;
      addTimeline("message_emitted", { roomId: effect.roomId, messageId: effect.messageId, messageKey: effect.messageKey, kind: effect.kind });
      activePublicRoute = null; activePublicContent = ""; activePublicTools = []; publicMessageRepairAttempts = 0;
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      if (crossRoomAwaitingTarget) {
        awaitingRoomId = crossRoomAwaitingTarget;
        break;
      }
      if (!unresolved.length && isTerminalAgentMessageKind(publicRouteForStep.kind)) {
        if (awaitingTasks.length) {
          awaitingDecisionRoomId = publicRouteForStep.roomId;
          const decisionMessage = awaitingTaskDecisionMessage(args, awaitingTasks);
          messages.push(decisionMessage); sessionMessages.push(decisionMessage); auditMessages.push(decisionMessage);
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          continue;
        }
        break;
      }
      const continuationMessage = publicRouteForStep.kind === "progress"
        ? progressContinuation(publicRouteForStep)
        : resolvedObligation
          ? deliveryRepairMessage(unresolved)
          : { role: "user" as const, content: `[系统公开消息已提交]\n房间 ${publicRouteForStep.roomId} 的消息已经提交。继续处理本轮任务；仍须逐一完成剩余房间义务。` };
      if (resolvedObligation && isTerminalAgentMessageKind(publicRouteForStep.kind)) deliveryOnly = true;
      messages.push(continuationMessage); sessionMessages.push(continuationMessage); auditMessages.push(continuationMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    if (!publicRouteForStep && calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    const invalidTerminalCalls = !publicRouteForStep && terminalToolsOnly ? calls.filter((call) => !terminalToolAllowed(call.name)) : [];
    if (invalidTerminalCalls.length) {
      if (terminalToolRepairAttempts >= maxTerminalToolRepairAttempts) throw new Error(`模型在收尾步骤持续请求非终结工具：${invalidTerminalCalls[0]?.name}`);
      terminalToolRepairAttempts += 1;
      for (const output of blockedTerminalToolOutputs(calls)) {
        const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
        messages.push(toolMessage); sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
      }
      const repairMessage = terminalToolRepairMessage(invalidTerminalCalls);
      messages.push(repairMessage); sessionMessages.push(repairMessage); auditMessages.push(repairMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    if (!calls.length) {
      if (awaitingDecisionRoomId) {
        awaitingRoomId = awaitingDecisionRoomId;
        break;
      }
      const unresolved = unresolvedDeliveryObligations(args, effects);
      if (unresolved.length && deliveryRepairAttempts < maxDeliveryRepairAttempts) {
        deliveryOnly = true; deliveryRepairAttempts += 1;
        const repairMessage = deliveryRepairMessage(unresolved);
        messages.push(repairMessage); sessionMessages.push(repairMessage); auditMessages.push(repairMessage);
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      break;
    }
    if (!publicRouteForStep && regularToolsAllowed && needsInitialProgress(args, effects, calls)) {
      if (initialProgressRepairAttempts >= maxInitialProgressRepairAttempts) throw new Error(`模型连续跳过房间 ${args.packet.room.id} 的初始进度汇报`);
      initialProgressRepairAttempts += 1;
      for (const output of blockedToolOutputs(calls, args.packet.room.id)) {
        const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
        messages.push(toolMessage); sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
      }
      const repairMessage = initialProgressRepairMessage(args, calls);
      messages.push(repairMessage); sessionMessages.push(repairMessage); auditMessages.push(repairMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    awaitingDecisionRoomId = null;
    const outputs = await executeToolCalls(args, calls, tools, timeline, effects, modelStep, (output) => {
      const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
      messages.push(toolMessage); sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    });
    const openedRoute = routeFromToolOutputs(outputs);
    if (regularToolsAllowed && consumesToolStep(calls, openedRoute)) toolSteps += 1;
    if (openedRoute) {
      if (publicRouteForStep) {
        const previousPublicContent = activePublicContent + content;
        if (!previousPublicContent.trim()) {
          if (publicMessageRepairAttempts >= maxPublicMessageRepairAttempts) throw new Error(`房间 ${publicRouteForStep.roomId} 的公开正文连续为空`);
          publicMessageRepairAttempts += 1;
          const retryMessage = publicMessageRouteSwitchRetry(publicRouteForStep, openedRoute);
          messages.push(retryMessage); sessionMessages.push(retryMessage); auditMessages.push(retryMessage);
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          continue;
        }
        const committed = commitPublicMessage(args, effects, publicRouteForStep, previousPublicContent);
        const { effect, awaitingRoomId: crossRoomAwaitingTarget, resolvedObligation } = committed;
        addTimeline("message_emitted", { roomId: effect.roomId, messageId: effect.messageId, messageKey: effect.messageKey, kind: effect.kind });
        activePublicRoute = null; activePublicContent = ""; activePublicTools = []; publicMessageRepairAttempts = 0;
        if (resolvedObligation && isTerminalAgentMessageKind(publicRouteForStep.kind)) deliveryOnly = true;
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        if (crossRoomAwaitingTarget) {
          const cancelledRouteMessage = publicMessageRouteCancelledForAwaiting(publicRouteForStep, openedRoute);
          messages.push(cancelledRouteMessage); sessionMessages.push(cancelledRouteMessage); auditMessages.push(cancelledRouteMessage);
          awaitingRoomId = crossRoomAwaitingTarget;
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          break;
        }
      }
      activePublicRoute = openedRoute; activePublicContent = ""; activePublicTools = requestTools; publicMessageRepairAttempts = 0;
      const controlMessage = publicMessageControl(openedRoute);
      messages.push(controlMessage); auditMessages.push(controlMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
    if (openedRoute) continue;
    if (publicRouteForStep) {
      activePublicContent += content;
      continue;
    }
    if (allDeliveryObligationsResolved(args, effects)) {
      const awaitingTasks = unresolvedAwaitingTasks(args, effects);
      if (awaitingTasks.length) {
        awaitingDecisionRoomId = args.packet.room.id;
        const decisionMessage = awaitingTaskDecisionMessage(args, awaitingTasks);
        messages.push(decisionMessage); sessionMessages.push(decisionMessage); auditMessages.push(decisionMessage);
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      if (!sawReasoningContent) break;
    }
    if (terminalToolsOnly) {
      const unresolved = unresolvedDeliveryObligations(args, effects);
      if (!unresolved.length) break;
      if (deliveryRepairAttempts >= maxDeliveryRepairAttempts) break;
      deliveryOnly = true; deliveryRepairAttempts += 1;
      const repairMessage = deliveryRepairMessage(unresolved);
      messages.push(repairMessage); sessionMessages.push(repairMessage); auditMessages.push(repairMessage);
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
  }
  if (activePublicRoute) throw new Error(`房间 ${activePublicRoute.roomId} 的公开消息通道已打开，但未生成正文`);
  addTimeline("turn_finished", { usage, awaitingRoomId });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, awaitingRoomId, contextCompaction: prepared.compaction, modelMeta: { format: "chat_completions", model: args.agent.settings.model, usage, modelCalls, toolSteps, reasoningCharacters, awaitingRoomId, context: contextMeta(prepared) } };
}

async function runResponses(args: RunArgs, modelCalls: ModelCallRecord[]): Promise<ModelTurnResult> {
  const { baseUrl, headers } = apiConfig();
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = [];
  const turnSystemPrompt = systemPrompt(args);
  const session = sessionWithoutLegacyMessageCalls(args.repository.getAgentSession(args.agent.id));
  const userMessage: AgentSessionMessage = { role: "user", content: turnUserContent(args) };
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
  let deliveryOnly = args.packet.type === "delivery_packet"; let deliveryRepairAttempts = 0;
  let toolSteps = 0; let activePublicRoute: PublicMessageRoute | null = null; let activePublicContent = ""; let publicMessageRepairAttempts = 0;
  let initialProgressRepairAttempts = 0;
  let terminalToolRepairAttempts = 0;
  let awaitingRoomId: string | null = null;
  let awaitingDecisionRoomId: string | null = null;
  let activePublicTools: typeof responseToolDefinitions = [];
  const maxModelSteps = maxModelStepsForRun(args);
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  for (let modelStep = 0; modelStep < maxModelSteps; modelStep += 1) {
    const publicRouteForStep = activePublicRoute;
    const regularToolsAllowed = !awaitingDecisionRoomId && !deliveryOnly && toolSteps < args.agent.settings.maxToolSteps;
    const terminalToolsOnly = Boolean(awaitingDecisionRoomId) || deliveryOnly || toolSteps >= args.agent.settings.maxToolSteps;
    const requestTools = publicRouteForStep
      ? activePublicTools
      : regularToolsAllowed
      ? responseToolDefinitions
      : terminalToolsOnly
        ? responseToolDefinitions.filter((tool) => terminalToolAllowed(tool.name))
        : [];
    const requestSystemPrompt = turnSystemPrompt;
    const requestTokens = countRenderedContextTokens({ instructions: requestSystemPrompt, messages: continuationMessages, tools: requestTools });
    if (requestTokens > prepared.threshold) {
      const sourceEntries = continuationMessages.length;
      const summary = await compactWithResponses(args, continuationMessages, modelCalls);
      continuationMessages = [{ role: "user", content: compactedSessionContent(summary) }];
      const compactedTokens = countRenderedContextTokens({ instructions: requestSystemPrompt, messages: continuationMessages, tools: requestTools });
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
    applyResponsesThinkingSettings(body, args.agent, baseUrl);
    if (requestTools.length) {
      body.tools = requestTools;
      body.tool_choice = "auto";
    }
    if (!previousResponseId) body.instructions = requestSystemPrompt;
    else body.previous_response_id = previousResponseId;
    const startedAt = nowIso(); const startedMs = Date.now(); let stepUsage: unknown = null;
    const callMap = new Map<string, ToolCall>(); let stepContent = "";
    try {
      const response = await fetch(`${baseUrl}/responses`, { method: "POST", headers, signal: args.signal, body: JSON.stringify(body) });
      if (!response.ok && modelStep === 0 && [400, 404, 405].includes(response.status)) {
        throw new ResponsesUnsupportedError(`Responses API 不可用 (${response.status}): ${(await response.text()).slice(0, 1_000)}`);
      }
      await parseSse(response, (event) => {
        const type = String(event.type ?? ""); const responseObject = event.response as Record<string, unknown> | undefined;
        if (typeof responseObject?.id === "string") previousResponseId = responseObject.id;
        if (responseObject?.usage) stepUsage = responseObject.usage;
        if (type === "response.output_text.delta" && typeof event.delta === "string") {
          if (publicRouteForStep && activePublicContent.length + stepContent.length + event.delta.length > maxRoomMessageContentCharacters) {
            throw new Error(`公开正文超过 ${maxRoomMessageContentCharacters} 字符上限`);
          }
          stepContent += event.delta;
          if (publicRouteForStep) {
            addTimeline("assistant_delta", { delta: event.delta, visibility: "public", roomId: publicRouteForStep.roomId });
            publishPublicMessageDelta(args, publicRouteForStep, event.delta);
          } else {
            assistantContent += event.delta;
            addTimeline("assistant_delta", { delta: event.delta });
            publishWorkspaceEvent("turn.preview", args.turnId, { kind: "assistant_delta", delta: event.delta }, args.repository.getVersion().revision);
          }
        }
        if (type === "response.output_item.added") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const key = String(item.id ?? item.call_id ?? createId("call")); const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
            callMap.set(key, call);
          }
        }
        if (type === "response.function_call_arguments.delta") {
          const key = String(event.item_id ?? event.call_id ?? ""); const current = callMap.get(key) ?? { id: String(event.call_id ?? key), name: String(event.name ?? ""), arguments: "" };
          const call = { ...current, arguments: current.arguments + String(event.delta ?? "") };
          callMap.set(key, call);
        }
        if (type === "response.output_item.done") {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call") {
            const call = { id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), arguments: String(item.arguments ?? "") };
            const key = String(item.id ?? item.call_id ?? "");
            callMap.set(key, call);
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
    const calls = [...callMap.values()].map(upgradeLegacyMessageCall);
    const assistantMessage: Extract<AgentSessionMessage, { role: "assistant" }> = {
      role: "assistant",
      content: stepContent || null,
      ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
    };
    sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage); continuationMessages.push(responseContextMessage(assistantMessage));
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    if (publicRouteForStep && !calls.length) {
      if (args.signal.aborted) throw new DOMException("公开正文生成已停止", "AbortError");
      const publicContent = activePublicContent + stepContent;
      if (!publicContent.trim()) {
        if (publicMessageRepairAttempts >= maxPublicMessageRepairAttempts) throw new Error(`房间 ${publicRouteForStep.roomId} 的公开正文连续为空`);
        publicMessageRepairAttempts += 1;
        const retryMessage = publicMessageRetry(publicRouteForStep);
        sessionMessages.push(retryMessage); auditMessages.push(retryMessage); continuationMessages.push(responseContextMessage(retryMessage));
        input = [responseContextMessage(retryMessage)];
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      const committed = commitPublicMessage(args, effects, publicRouteForStep, publicContent);
      const { effect, unresolved, awaitingTasks, awaitingRoomId: crossRoomAwaitingTarget, resolvedObligation } = committed;
      addTimeline("message_emitted", { roomId: effect.roomId, messageId: effect.messageId, messageKey: effect.messageKey, kind: effect.kind });
      activePublicRoute = null; activePublicContent = ""; activePublicTools = []; publicMessageRepairAttempts = 0;
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      if (crossRoomAwaitingTarget) {
        awaitingRoomId = crossRoomAwaitingTarget;
        break;
      }
      if (!unresolved.length && isTerminalAgentMessageKind(publicRouteForStep.kind)) {
        if (awaitingTasks.length) {
          awaitingDecisionRoomId = publicRouteForStep.roomId;
          const decisionMessage = awaitingTaskDecisionMessage(args, awaitingTasks);
          sessionMessages.push(decisionMessage); auditMessages.push(decisionMessage); continuationMessages.push(responseContextMessage(decisionMessage));
          input = [responseContextMessage(decisionMessage)];
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          continue;
        }
        break;
      }
      const continuationMessage = publicRouteForStep.kind === "progress"
        ? progressContinuation(publicRouteForStep)
        : resolvedObligation
          ? deliveryRepairMessage(unresolved)
          : { role: "user" as const, content: `[系统公开消息已提交]\n房间 ${publicRouteForStep.roomId} 的消息已经提交。继续处理本轮任务；仍须逐一完成剩余房间义务。` };
      if (resolvedObligation && isTerminalAgentMessageKind(publicRouteForStep.kind)) deliveryOnly = true;
      sessionMessages.push(continuationMessage); auditMessages.push(continuationMessage); continuationMessages.push(responseContextMessage(continuationMessage));
      input = [responseContextMessage(continuationMessage)];
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    if (!publicRouteForStep && calls.length && !regularToolsAllowed && !terminalToolsOnly) throw new Error(`模型在最大工具步骤 ${args.agent.settings.maxToolSteps} 用尽并完成收尾后仍请求调用工具`);
    const invalidTerminalCalls = !publicRouteForStep && terminalToolsOnly ? calls.filter((call) => !terminalToolAllowed(call.name)) : [];
    if (invalidTerminalCalls.length) {
      if (terminalToolRepairAttempts >= maxTerminalToolRepairAttempts) throw new Error(`模型在收尾步骤持续请求非终结工具：${invalidTerminalCalls[0]?.name}`);
      terminalToolRepairAttempts += 1;
      const blockedOutputs = blockedTerminalToolOutputs(calls);
      for (const output of blockedOutputs) {
        const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
        sessionMessages.push(toolMessage); auditMessages.push(toolMessage); continuationMessages.push(responseContextMessage(toolMessage));
      }
      const repairMessage = terminalToolRepairMessage(invalidTerminalCalls);
      sessionMessages.push(repairMessage); auditMessages.push(repairMessage); continuationMessages.push(responseContextMessage(repairMessage));
      input = [
        ...blockedOutputs.map((output) => ({ type: "function_call_output", call_id: output.callId, output: output.text })),
        responseContextMessage(repairMessage),
      ];
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    if (!calls.length) {
      if (awaitingDecisionRoomId) {
        awaitingRoomId = awaitingDecisionRoomId;
        break;
      }
      const unresolved = unresolvedDeliveryObligations(args, effects);
      if (unresolved.length && deliveryRepairAttempts < maxDeliveryRepairAttempts) {
        deliveryOnly = true; deliveryRepairAttempts += 1;
        const repairMessage = deliveryRepairMessage(unresolved);
        sessionMessages.push(repairMessage); auditMessages.push(repairMessage); continuationMessages.push(responseContextMessage(repairMessage));
        input = [responseContextMessage(repairMessage)];
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      break;
    }
    if (!publicRouteForStep && regularToolsAllowed && needsInitialProgress(args, effects, calls)) {
      if (initialProgressRepairAttempts >= maxInitialProgressRepairAttempts) throw new Error(`模型连续跳过房间 ${args.packet.room.id} 的初始进度汇报`);
      initialProgressRepairAttempts += 1;
      const blockedOutputs = blockedToolOutputs(calls, args.packet.room.id);
      for (const output of blockedOutputs) {
        const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
        sessionMessages.push(toolMessage); auditMessages.push(toolMessage); continuationMessages.push(responseContextMessage(toolMessage));
      }
      const repairMessage = initialProgressRepairMessage(args, calls);
      sessionMessages.push(repairMessage); auditMessages.push(repairMessage); continuationMessages.push(responseContextMessage(repairMessage));
      input = [
        ...blockedOutputs.map((output) => ({ type: "function_call_output", call_id: output.callId, output: output.text })),
        responseContextMessage(repairMessage),
      ];
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
      continue;
    }
    awaitingDecisionRoomId = null;
    const outputs = await executeToolCalls(args, calls, tools, timeline, effects, modelStep, (output) => {
      const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
      sessionMessages.push(toolMessage); auditMessages.push(toolMessage); continuationMessages.push(responseContextMessage(toolMessage));
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    });
    const outputItems = outputs.map((output) => ({ type: "function_call_output", call_id: output.callId, output: output.text }));
    input = outputItems;
    const openedRoute = routeFromToolOutputs(outputs);
    if (regularToolsAllowed && consumesToolStep(calls, openedRoute)) toolSteps += 1;
    if (openedRoute) {
      if (publicRouteForStep) {
        const previousPublicContent = activePublicContent + stepContent;
        if (!previousPublicContent.trim()) {
          if (publicMessageRepairAttempts >= maxPublicMessageRepairAttempts) throw new Error(`房间 ${publicRouteForStep.roomId} 的公开正文连续为空`);
          publicMessageRepairAttempts += 1;
          const retryMessage = publicMessageRouteSwitchRetry(publicRouteForStep, openedRoute);
          sessionMessages.push(retryMessage); auditMessages.push(retryMessage); continuationMessages.push(responseContextMessage(retryMessage));
          input = [...outputItems, responseContextMessage(retryMessage)];
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          continue;
        }
        const committed = commitPublicMessage(args, effects, publicRouteForStep, previousPublicContent);
        const { effect, awaitingRoomId: crossRoomAwaitingTarget, resolvedObligation } = committed;
        addTimeline("message_emitted", { roomId: effect.roomId, messageId: effect.messageId, messageKey: effect.messageKey, kind: effect.kind });
        activePublicRoute = null; activePublicContent = ""; activePublicTools = []; publicMessageRepairAttempts = 0;
        if (resolvedObligation && isTerminalAgentMessageKind(publicRouteForStep.kind)) deliveryOnly = true;
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        if (crossRoomAwaitingTarget) {
          const cancelledRouteMessage = publicMessageRouteCancelledForAwaiting(publicRouteForStep, openedRoute);
          sessionMessages.push(cancelledRouteMessage); auditMessages.push(cancelledRouteMessage); continuationMessages.push(responseContextMessage(cancelledRouteMessage));
          awaitingRoomId = crossRoomAwaitingTarget;
          checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
          break;
        }
      }
      activePublicRoute = openedRoute; activePublicContent = ""; activePublicTools = requestTools; publicMessageRepairAttempts = 0;
      const controlMessage = publicMessageControl(openedRoute);
      auditMessages.push(controlMessage); continuationMessages.push(responseContextMessage(controlMessage));
      input = [...outputItems, responseContextMessage(controlMessage)];
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
    if (openedRoute) continue;
    if (publicRouteForStep) {
      activePublicContent += stepContent;
      continue;
    }
    if (allDeliveryObligationsResolved(args, effects)) {
      const awaitingTasks = unresolvedAwaitingTasks(args, effects);
      if (awaitingTasks.length) {
        awaitingDecisionRoomId = args.packet.room.id;
        const decisionMessage = awaitingTaskDecisionMessage(args, awaitingTasks);
        sessionMessages.push(decisionMessage); auditMessages.push(decisionMessage); continuationMessages.push(responseContextMessage(decisionMessage));
        input = [responseContextMessage(decisionMessage)];
        checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
        continue;
      }
      break;
    }
    if (terminalToolsOnly) {
      const unresolved = unresolvedDeliveryObligations(args, effects);
      if (!unresolved.length) break;
      if (deliveryRepairAttempts >= maxDeliveryRepairAttempts) break;
      deliveryOnly = true; deliveryRepairAttempts += 1;
      const repairMessage = deliveryRepairMessage(unresolved);
      sessionMessages.push(repairMessage); auditMessages.push(repairMessage); continuationMessages.push(responseContextMessage(repairMessage));
      input = [responseContextMessage(repairMessage)];
      checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
    }
  }
  if (activePublicRoute) throw new Error(`房间 ${activePublicRoute.roomId} 的公开消息通道已打开，但未生成正文`);
  addTimeline("turn_finished", { usage, responseId: previousResponseId, awaitingRoomId });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, awaitingRoomId, contextCompaction: prepared.compaction, modelMeta: { format: "responses", model: args.agent.settings.model, responseId: previousResponseId, usage, modelCalls, toolSteps, awaitingRoomId, context: contextMeta(prepared) } };
}

async function runMock(args: RunArgs): Promise<ModelTurnResult> {
  const tools: ToolExecution[] = []; const timeline: TimelineEvent[] = []; const effects: TurnEffect[] = []; const addTimeline = createTimelineFactory(args.turnId, timeline);
  const turnSystemPrompt = systemPrompt(args);
  const sessionMessages: AgentSessionMessage[] = [{ role: "user", content: turnUserContent(args) }];
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
    return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, awaitingRoomId: null, modelMeta: { format: "mock", fixture: "private-only" } };
  }
  const wantsNoReply = args.packet.type !== "delivery_packet" && (!latestExternal || /无需回复|不需要回复|已阅即可/i.test(latest?.content ?? ""));
  const calls: ToolCall[] = args.packet.type === "delivery_packet"
    ? args.repository.getTurnDeliveryObligations(args.turnId).map((obligation) => ({
      id: createId("tool"),
      name: "send_message_to_room",
      arguments: JSON.stringify({ roomId: obligation.roomId, content: "此前任务已经处理完成，现补交结果。", kind: "answer" }),
    }))
    : [wantsNoReply
      ? { id: createId("tool"), name: "read_no_reply", arguments: JSON.stringify({ roomId: args.packet.room.id, messageId: latest?.id }) }
      : { id: createId("tool"), name: "send_message_to_room", arguments: JSON.stringify({ roomId: args.packet.room.id, content: `收到。我会处理「${(latest?.content ?? "附件任务").slice(0, 160)}」并把可验证结果留在这个房间。`, kind: "answer" }) }];
  const assistantMessage: AgentSessionMessage = { role: "assistant", content: assistantContent, tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) };
  sessionMessages.push(assistantMessage); auditMessages.push(assistantMessage);
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  await executeToolCalls(args, calls, tools, timeline, effects, 0, (output) => {
    const toolMessage: AgentSessionMessage = { role: "tool", tool_call_id: output.callId, content: output.text };
    sessionMessages.push(toolMessage); auditMessages.push(toolMessage);
    checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  }, { allowHiddenTools: true });
  addTimeline("turn_finished", { fixture: wantsNoReply ? "receipt" : "emit" });
  checkpointTurn(args, turnSystemPrompt, assistantContent, auditMessages, tools, timeline);
  return { assistantContent, systemPrompt: turnSystemPrompt, sessionMessages, auditMessages, tools, timeline, effects, awaitingRoomId: null, modelMeta: { format: "mock", fixture: wantsNoReply ? "receipt" : "emit", availableTools: listToolDefinitions().length } };
}

function checkpointTurn(args: RunArgs, system: string, assistantContent: string, auditMessages: AgentSessionMessage[], tools: ToolExecution[], timeline: TimelineEvent[]): void {
  const persisted = args.repository.checkpointTurn({
    turnId: args.turnId,
    assistantContent,
    systemPrompt: system,
    conversationMessages: auditMessages,
    tools,
    timeline,
  });
  if (persisted) publishWorkspaceEvent("turn.preview", args.turnId, { kind: "history_checkpoint" }, args.repository.getVersion().revision);
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
