import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Agent, CronJob, SchedulerPacket, ToolExecutionResult, TurnEffect } from "@/lib/domain/types";
import { readNoReplyToolSchema, sendMessageToolSchema } from "@/lib/domain/schemas";
import { WorkspaceRepository } from "@/lib/server/repository";
import { createId, nowIso } from "@/lib/utils/id";

export type ToolContext = {
  agent: Agent;
  roomId: string;
  agentParticipantId: string;
  packet: SchedulerPacket;
  repository: WorkspaceRepository;
  signal: AbortSignal;
};

export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodType;
  parameters: Record<string, unknown>;
  execute: (context: ToolContext, args: unknown, toolCallId: string) => Promise<ToolExecutionResult>;
};

const noEffects = (text: string, structured: unknown = {}): ToolExecutionResult => ({ text, structured, effects: [] });

const createRoomToolSchema = z.object({
  title: z.string().trim().min(1).max(120),
  agentIds: z.array(z.string().min(1)).max(64).default([]),
});

const inviteAgentToolSchema = z.object({ roomId: z.string().min(1), agentId: z.string().min(1) });

function connectedRooms(context: ToolContext) {
  return context.repository.getSnapshot().rooms.filter((room) => room.participants.some((participant) => participant.agentId === context.agent.id && participant.enabled));
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
    name: "send_message_to_room", description: "向一个已连接房间提交正式、公开的 Agent 消息。普通 assistant 文本不会公开。", schema: sendMessageToolSchema,
    parameters: { type: "object", additionalProperties: false, required: ["roomId", "content", "kind"], properties: { roomId: { type: "string" }, content: { type: "string" }, kind: { type: "string", enum: ["answer", "progress", "warning", "error", "clarification"] }, messageKey: { type: "string" } } },
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
        text: `已准备创建房间 ${effect.roomId}；当前 Agent 将自动成为 owner 并连接${invitedAgentIds.length ? `，同时邀请 ${invitedAgentIds.join("、")}` : ""}。本轮结束后统一提交。`,
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
    name: "web_fetch", description: "抓取公开 HTTP/HTTPS 页面文本，拒绝本机与内网地址。", schema: z.object({ url: z.string().url() }),
    parameters: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri" } } },
    execute: async (context, raw) => { const { url: rawUrl } = z.object({ url: z.string().url() }).parse(raw); const url = await assertPublicUrl(rawUrl); const response = await fetch(url, { signal: context.signal, redirect: "follow", headers: { "user-agent": "OceanKing/1.0" } }); const text = (await response.text()).slice(0, 200_000); return noEffects(text, { url: response.url, status: response.status, contentType: response.headers.get("content-type") }); },
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
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false } }));
}

export function toolDefinitionsForResponses() {
  return tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }));
}
