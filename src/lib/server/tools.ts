import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { publicAgentMessageKinds, type Agent, type CronJob, type Room, type SchedulerPacket, type ToolExecutionResult, type TurnEffect } from "@/lib/domain/types";
import { beginMessageToolSchema, readNoReplyToolSchema, sendMessageToolSchema } from "@/lib/domain/schemas";
import { WorkspaceRepository } from "@/lib/server/repository";
import { extractWebContent, isSupportedWebContentType, limitWebContentTokens, readLimitedResponseText } from "@/lib/server/web-content";
import { formatWebSearchResponse, runWebSearch, webSearchSchema } from "@/lib/server/web-search";
import { createId, nowIso } from "@/lib/utils/id";

export type ToolContext = {
  agent: Agent;
  roomId: string;
  agentParticipantId: string;
  packet: SchedulerPacket;
  repository: WorkspaceRepository;
  signal: AbortSignal;
  turnId?: string;
  pendingEffects?: readonly TurnEffect[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodType;
  parameters: Record<string, unknown>;
  modelVisible?: boolean;
  execute: (context: ToolContext, args: unknown, toolCallId: string, invocationKey?: string) => Promise<ToolExecutionResult>;
};

const noEffects = (text: string, structured: unknown = {}): ToolExecutionResult => ({ text, structured, effects: [] });

const createRoomToolSchema = z.object({
  title: z.string().trim().min(1).max(120),
  agentIds: z.array(z.string().min(1)).max(64).default([]),
});

const inviteAgentToolSchema = z.object({ roomId: z.string().min(1), agentId: z.string().min(1) });

function pendingCreatedRooms(context: ToolContext): Room[] {
  const snapshot = context.repository.getSnapshot();
  const createdAt = context.agent.updatedAt;
  return (context.pendingEffects ?? []).flatMap((effect) => {
    if (effect.type !== "create_room") return [];
    const ownerId = `pending_owner_${effect.roomId}`;
    const invited = effect.invitedAgentIds.flatMap((agentId, index) => {
      const agent = snapshot.agents.find((entry) => entry.id === agentId);
      return agent ? [{ id: `pending_agent_${effect.roomId}_${agentId}`, roomId: effect.roomId, kind: "agent" as const, agentId, displayName: agent.label, enabled: true, sortOrder: index + 2, createdAt }] : [];
    });
    return [{
      id: effect.roomId,
      title: effect.title,
      ownerParticipantId: ownerId,
      participants: [
        { id: ownerId, roomId: effect.roomId, kind: "agent" as const, agentId: context.agent.id, displayName: context.agent.label, enabled: true, sortOrder: 0, createdAt },
        { id: `pending_human_${effect.roomId}`, roomId: effect.roomId, kind: "human" as const, agentId: null, displayName: "你", enabled: true, sortOrder: 1, createdAt },
        ...invited,
      ],
      messages: [],
      turns: [],
      scheduler: { roomId: effect.roomId, status: "idle" as const, nextAgentParticipantId: ownerId, activeParticipantId: null, roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    }];
  });
}

function connectedRooms(context: ToolContext): Room[] {
  const persisted = context.repository.getSnapshot().rooms.filter((room) => room.participants.some((participant) => participant.agentId === context.agent.id && participant.enabled));
  const persistedIds = new Set(persisted.map((room) => room.id));
  return [...persisted, ...pendingCreatedRooms(context).filter((room) => !persistedIds.has(room.id))];
}

function requireConnectedRoom(context: ToolContext, roomId: string) {
  const room = connectedRooms(context).find((entry) => entry.id === roomId);
  if (!room) throw new Error("Agent 只能访问自己已连接的房间");
  return room;
}

function requireOwnedRoom(context: ToolContext, roomId: string) {
  const room = requireConnectedRoom(context, roomId);
  const membership = room.participants.find((participant) => participant.agentId === context.agent.id && participant.enabled);
  if (!membership || room.ownerParticipantId !== membership.id) throw new Error("只有 owner Agent 能管理成员");
  return room;
}

function resolveWorkspacePath(context: ToolContext, scope: "private" | "shared", relativePath: string): string {
  const root = scope === "private"
    ? path.join(/* turbopackIgnore: true */ context.repository.dataDir, "workspaces", "agents", context.agent.id)
    : path.join(/* turbopackIgnore: true */ context.repository.dataDir, "workspaces", "shared");
  const resolved = path.resolve(path.join(/* turbopackIgnore: true */ root, relativePath || "."));
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (resolved !== path.resolve(root) && !`${resolved}${path.sep}`.startsWith(normalizedRoot)) throw new Error("工作区路径越界");
  return resolved;
}

const privateRanges = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^fc/i, /^fd/i, /^fe80:/i,
];

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new Error("只允许 HTTP/HTTPS");
  if (["localhost", "0.0.0.0"].includes(url.hostname)) throw new Error("禁止访问本机地址");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.some((entry) => privateRanges.some((pattern) => pattern.test(entry.address)))) throw new Error("禁止访问内网地址");
  return url;
}

async function runShell(command: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: process.cwd(), windowsHide: true, env: process.env,
    });
    let stdout = ""; let stderr = ""; const cap = 64 * 1024;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-cap);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      reject(new Error("shell 超过 120 秒，已终止进程树"));
    }, 120_000);
    const abort = () => {
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      reject(new DOMException("shell 已被停止", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve({ stdout, stderr, exitCode: code }); });
  });
}

const tools: ToolDefinition[] = [
  {
    name: "begin_message_to_room",
    description: "打开一个房间的公开消息通道。调用成功后，后续 assistant 正文会实时显示并正式提交到该房间；一次只打开一个房间。kind=notify 是过程消息，提交后当前 Agent 继续执行且不会触发其他 Agent；kind=handoff 是结束消息，提交后当前 Turn 结束并触发房间中的下一个 Agent。",
    schema: beginMessageToolSchema,
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "kind"], properties: { roomId: { type: "string" }, kind: { type: "string", enum: [...publicAgentMessageKinds], description: "notify 继续当前 Turn；handoff 结束当前 Turn并把控制权交给下一个 Agent" } } },
    execute: async (context, raw, callId, invocationKey) => {
      const args = beginMessageToolSchema.parse(raw); requireConnectedRoom(context, args.roomId);
      const route = { type: "begin_room_message" as const, roomId: args.roomId, kind: args.kind, messageKey: invocationKey ?? callId };
      return {
        text: [
          "[系统公开输出阶段]",
          `目标房间：${args.roomId}`,
          `消息类型：${args.kind}`,
          "后续 assistant 回复的全部 content 会被实时公开到目标房间。",
          "可以按需继续调用结构化工具；content 只输出给房间成员阅读的正文，不要输出构思、前言、路由信息或 JSON。最终正文不能为空。",
        ].join("\n"),
        structured: route,
        effects: [],
      };
    },
  },
  {
    name: "send_message_to_room", description: "旧版兼容工具：把完整正文作为工具参数一次性提交。新任务应使用 begin_message_to_room，以获得可靠的普通文本流式输出。", schema: sendMessageToolSchema,
    modelVisible: false,
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "content", "kind"], properties: { roomId: { type: "string" }, content: { type: "string" }, kind: { type: "string", enum: [...publicAgentMessageKinds] }, messageKey: { type: "string" } } },
    execute: async (context, raw, callId) => {
      const args = sendMessageToolSchema.parse(raw); requireConnectedRoom(context, args.roomId);
      const effect: TurnEffect = { type: "send_message", roomId: args.roomId, messageId: createId("msg"), messageKey: args.messageKey ?? callId, content: args.content, kind: args.kind };
      return { text: `正式消息已准备提交到房间 ${args.roomId}`, structured: effect, effects: [effect] };
    },
  },
  {
    name: "read_no_reply", description: "明确标记某条参与者消息已读但无需回复，不产生空消息气泡。", schema: readNoReplyToolSchema,
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "messageId"], properties: { roomId: { type: "string" }, messageId: { type: "string" } } },
    execute: async (context, raw) => {
      const args = readNoReplyToolSchema.parse(raw); const room = requireConnectedRoom(context, args.roomId);
      if (!room.messages.some((message) => message.id === args.messageId)) throw new Error("消息不存在");
      const effect: TurnEffect = { type: "read_no_reply", roomId: args.roomId, messageId: args.messageId, receiptId: createId("receipt") };
      return { text: "已准备写入 read_no_reply receipt", structured: effect, effects: [effect] };
    },
  },
  {
    name: "list_connected_rooms", description: "列出当前 Agent 已连接的房间。", schema: z.object({}), parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async (context) => { const result = connectedRooms(context).map((room) => ({ id: room.id, title: room.title, members: room.participants.length, messages: room.messages.length })); return noEffects(JSON.stringify(result), result); },
  },
  {
    name: "list_available_agents", description: "按需列出可邀请或协作的 Agent 信息卡。", schema: z.object({}), parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async (context) => {
      const result = context.repository.getSnapshot().agents.map(({ id, label, summary }) => ({ id, label, summary, current: id === context.agent.id }));
      return noEffects(JSON.stringify(result), result);
    },
  },
  {
    name: "read_room_history", description: "按需读取一个已连接房间的近期公开消息。", schema: z.object({ roomId: z.string(), limit: z.number().int().min(1).max(100).default(30) }),
    parameters: { type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } },
    execute: async (context, raw) => { const args = z.object({ roomId: z.string(), limit: z.number().int().min(1).max(100).default(30) }).parse(raw); const room = requireConnectedRoom(context, args.roomId); const result = room.messages.slice(-args.limit).map(({ id, seq, sender, content, createdAt }) => ({ id, seq, sender, content, createdAt })); return noEffects(JSON.stringify(result), result); },
  },
  {
    name: "create_room", description: "创建新房间。当前 Agent 会自动成为 owner 并连接；可通过 agentIds 在同一原子操作中邀请任意多个可用 Agent，无需再调用 invite_agent。", schema: createRoomToolSchema,
    parameters: { type: "object", additionalProperties: false, required: ["title", "agentIds"], properties: { title: { type: "string" }, agentIds: { type: "array", items: { type: "string" }, maxItems: 64, description: "要同时加入房间的 Agent ID；不必包含当前 Agent" } } },
    execute: async (context, raw) => {
      const args = createRoomToolSchema.parse(raw);
      const invitedAgentIds = [...new Set(args.agentIds)].filter((agentId) => agentId !== context.agent.id);
      for (const agentId of invitedAgentIds) if (!context.repository.hasAgent(agentId)) throw new Error(`Agent 不存在：${agentId}`);
      const effect: TurnEffect = { type: "create_room", roomId: createId("room"), title: args.title, invitedAgentIds };
      return {
        text: `房间 ${effect.roomId} 已加入本轮事务；当前 Agent 将自动成为 owner 并连接${invitedAgentIds.length ? `，同时邀请 ${invitedAgentIds.join("、")}` : ""}。现在可以立即用该 roomId 发送消息；本轮成功后统一提交，失败时不会留下半成品。`,
        structured: effect,
        effects: [effect],
      };
    },
  },
  {
    name: "invite_agent", description: "向当前 Agent 拥有的已连接房间邀请任意可用 Agent。新建房间时优先直接使用 create_room.agentIds。", schema: inviteAgentToolSchema,
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "agentId"], properties: { roomId: { type: "string" }, agentId: { type: "string" } } },
    execute: async (context, raw) => { const args = inviteAgentToolSchema.parse(raw); requireOwnedRoom(context, args.roomId); if (!context.repository.hasAgent(args.agentId)) throw new Error("Agent 不存在"); const effect: TurnEffect = { type: "invite_agent", roomId: args.roomId, agentId: args.agentId, participantId: createId("participant") }; return { text: "邀请动作已准备提交", structured: effect, effects: [effect] }; },
  },
  {
    name: "remove_room_participant", description: "房间 owner 移除一个成员。", schema: z.object({ roomId: z.string(), participantId: z.string() }),
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "participantId"], properties: { roomId: { type: "string" }, participantId: { type: "string" } } },
    execute: async (context, raw) => { const args = z.object({ roomId: z.string(), participantId: z.string() }).parse(raw); requireOwnedRoom(context, args.roomId); const effect: TurnEffect = { type: "remove_participant", ...args }; return { text: "移除动作已准备提交", structured: effect, effects: [effect] }; },
  },
  {
    name: "leave_room", description: "当前 Agent 离开指定房间。", schema: z.object({ roomId: z.string() }),
    parameters: { type: "object", additionalProperties: false, required: ["roomId"], properties: { roomId: { type: "string" } } },
    execute: async (context, raw) => { const args = z.object({ roomId: z.string() }).parse(raw); requireConnectedRoom(context, args.roomId); const participant = context.repository.getRoom(args.roomId)?.participants.find((p) => p.agentId === context.agent.id); if (!participant) throw new Error("成员不存在"); const effect: TurnEffect = { type: "leave_room", roomId: args.roomId, participantId: participant.id }; return { text: "离开动作已准备提交", structured: effect, effects: [effect] }; },
  },
  ...(["list", "read", "write"] as const).map((action): ToolDefinition => ({
    name: `workspace_${action}`, description: `${action === "list" ? "列出" : action === "read" ? "读取" : "写入"} Agent 私有或共享工作区文件。`,
    schema: action === "write" ? z.object({ scope: z.enum(["private", "shared"]), path: z.string(), content: z.string().max(2_000_000) }) : z.object({ scope: z.enum(["private", "shared"]), path: z.string().default(".") }),
    parameters: { type: "object", additionalProperties: false, required: action === "write" ? ["scope", "path", "content"] : ["scope", "path"], properties: { scope: { type: "string", enum: ["private", "shared"] }, path: { type: "string" }, ...(action === "write" ? { content: { type: "string" } } : {}) } },
    execute: async (context, raw) => {
      const args = (action === "write" ? z.object({ scope: z.enum(["private", "shared"]), path: z.string(), content: z.string().max(2_000_000) }) : z.object({ scope: z.enum(["private", "shared"]), path: z.string().default(".") })).parse(raw);
      const target = resolveWorkspacePath(context, args.scope, args.path); await fs.mkdir(action === "write" ? path.dirname(target) : target, { recursive: true });
      if (action === "write" && "content" in args) { await fs.writeFile(target, String(args.content), "utf8"); return noEffects(`已写入 ${args.scope}:${args.path}`, { path: args.path }); }
      if (action === "read") { const text = (await fs.readFile(target, "utf8")).slice(0, 200_000); return noEffects(text, { path: args.path, bytes: Buffer.byteLength(text) }); }
      const entries = await fs.readdir(target, { withFileTypes: true }); const result = entries.slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })); return noEffects(JSON.stringify(result), result);
    },
  })),
  {
    name: "shell", description: "在本机 PowerShell 中执行命令。继承 OceanKing 进程权限，可访问整个磁盘且不进行高危审批。", schema: z.object({ command: z.string().min(1).max(100_000) }),
    parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" } } },
    execute: async (context, raw) => { const { command } = z.object({ command: z.string().min(1).max(100_000) }).parse(raw); const result = await runShell(command, context.signal); const text = [result.stdout, result.stderr].filter(Boolean).join("\n"); return noEffects(text || `进程退出码 ${result.exitCode}`, result); },
  },
  {
    name: "web_search", description: "零配置查找公开网页或新闻，返回标题、URL、来源、发布时间和摘要；如配置 Brave Search 会自动使用更可靠的正式 API。联网检索必须优先使用此工具发现来源，再用 web_fetch 阅读具体页面；不要用 shell 抓取搜索引擎结果页。", schema: webSearchSchema,
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", description: "搜索词，最多 400 字符或 50 个单词" }, type: { type: "string", enum: ["web", "news"], description: "普通网页使用 web；时事和最新新闻使用 news" }, freshness: { type: "string", enum: ["any", "day", "week", "month", "year"], description: "结果时间范围" }, count: { type: "integer", minimum: 1, maximum: 10, description: "返回结果数，默认 8" }, country: { type: "string", description: "可选的两位国家代码或 ALL；中文查询默认 CN" }, searchLanguage: { type: "string", description: "可选的搜索语言代码；中文查询默认 zh-hans" } } },
    execute: async (context, raw) => { const args = webSearchSchema.parse(raw); const result = await runWebSearch(args, context.signal); return noEffects(formatWebSearchResponse(result), result); },
  },
  {
    name: "web_fetch", description: "抓取公开 HTTP/HTTPS 页面文本；HTML 会提取正文并限制返回长度，拒绝本机、内网与二进制内容。", schema: z.object({ url: z.string().url() }),
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri" } } },
    execute: async (context, raw) => {
      const { url: rawUrl } = z.object({ url: z.string().url() }).parse(raw);
      const url = await assertPublicUrl(rawUrl);
      const response = await fetch(url, { signal: context.signal, redirect: "follow", headers: { "user-agent": "OceanKing/1.0" } });
      const contentType = response.headers.get("content-type");
      if (!isSupportedWebContentType(contentType)) throw new Error(`不支持的网页内容类型：${contentType}`);
      const body = await readLimitedResponseText(response);
      const extracted = extractWebContent(body.text, contentType, response.url || url.href);
      const limited = limitWebContentTokens(extracted.text);
      return noEffects(limited.text, {
        url: response.url || url.href,
        status: response.status,
        contentType,
        bytes: body.bytes,
        title: extracted.title,
        extraction: extracted.extraction,
        tokens: limited.tokenCount,
        originalTokens: limited.originalTokenCount,
        truncated: limited.truncated,
      });
    },
  },
  {
    name: "read_project_context", description: "读取设置中显式登记项目根目录内的文本文件。", schema: z.object({ root: z.string(), path: z.string() }),
    parameters: { type: "object", additionalProperties: false, required: ["root", "path"], properties: { root: { type: "string" }, path: { type: "string" } } },
    execute: async (context, raw) => { const args = z.object({ root: z.string(), path: z.string() }).parse(raw); if (!context.agent.settings.projectContextRoots.includes(args.root)) throw new Error("项目根目录未登记"); const root = path.resolve(path.join(/* turbopackIgnore: true */ args.root, ".")); const target = path.resolve(path.join(/* turbopackIgnore: true */ root, args.path)); if (target !== root && !`${target}${path.sep}`.startsWith(`${root}${path.sep}`)) throw new Error("项目上下文路径越界"); const text = (await fs.readFile(target, "utf8")).slice(0, 200_000); return noEffects(text, { root, path: args.path }); },
  },
  {
    name: "list_cron_jobs", description: "列出当前 Agent 所属定时任务。", schema: z.object({}), parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async (context) => { const jobs = context.repository.getSnapshot().cronJobs.filter((job) => job.agentId === context.agent.id); return noEffects(JSON.stringify(jobs), jobs); },
  },
  {
    name: "create_cron_job", description: "为当前 Agent 创建面向已连接房间的定时任务。", schema: z.object({ roomId: z.string(), name: z.string().min(1), schedule: z.string().min(1), timezone: z.string().default("Asia/Shanghai"), prompt: z.string().min(1) }),
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "name", "schedule", "timezone", "prompt"], properties: { roomId: { type: "string" }, name: { type: "string" }, schedule: { type: "string" }, timezone: { type: "string" }, prompt: { type: "string" } } },
    execute: async (context, raw) => { const args = z.object({ roomId: z.string(), name: z.string().min(1), schedule: z.string().min(1), timezone: z.string().default("Asia/Shanghai"), prompt: z.string().min(1) }).parse(raw); requireConnectedRoom(context, args.roomId); const at = nowIso(); const job: CronJob = { id: createId("cron"), agentId: context.agent.id, roomId: args.roomId, name: args.name, schedule: args.schedule, timezone: args.timezone, prompt: args.prompt, enabled: true, lastRunAt: null, nextRunAt: null, createdAt: at, updatedAt: at }; const effect: TurnEffect = { type: "create_cron", job }; return { text: `Cron 已准备创建：${job.id}`, structured: job, effects: [effect] }; },
  },
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

export function listToolDefinitions(): ToolDefinition[] { return tools; }
export function getToolDefinition(name: string): ToolDefinition | undefined { return toolMap.get(name); }

export function toolDefinitionsForChat() {
  return tools.filter((tool) => tool.modelVisible !== false).map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false } }));
}

export function toolDefinitionsForResponses() {
  return tools.filter((tool) => tool.modelVisible !== false).map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
}
