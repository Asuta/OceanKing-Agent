import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { WorkspaceCommand } from "@/lib/domain/schemas";
import type {
  Agent, AgentConversationHistory, AgentSessionMessage, AgentTurn, Attachment, ContextCompaction, CronJob, CronRun, ModelAndRuntimeSettings, Participant, ReadNoReplyReceipt,
  Room, RoomMessage, SchedulerPacket, SchedulerState, TimelineEvent, ToolExecution, TurnEffect, WorkspaceSnapshot,
} from "@/lib/domain/types";
import { getDatabase, type DatabaseHandle } from "@/lib/server/db/client";
import { compactedSessionContent } from "@/lib/server/context-compaction";
import { createId, nowIso } from "@/lib/utils/id";
import { normalizeOpenAiBaseUrl, normalizeRuntimeSettings } from "@/lib/server/provider-config";

type Row = Record<string, unknown>;

export class VersionConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super(`工作区版本冲突：当前版本为 ${currentVersion}`);
  }
}

export class DomainError extends Error {}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function bool(value: unknown): boolean { return value === 1 || value === true; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function nullableStr(value: unknown): string | null { return typeof value === "string" ? value : null; }
function num(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0); }

function normalizeSessionMessage(value: unknown): AgentSessionMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.role === "user" && typeof message.content === "string") return { role: "user", content: message.content };
  if (message.role === "tool" && typeof message.tool_call_id === "string" && typeof message.content === "string") {
    return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
  }
  if (message.role !== "assistant") return null;
  const normalized: Extract<AgentSessionMessage, { role: "assistant" }> = {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : null,
  };
  if (typeof message.reasoning_content === "string") normalized.reasoning_content = message.reasoning_content;
  if (Array.isArray(message.tool_calls)) {
    const toolCalls = message.tool_calls.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const call = value as Record<string, unknown>;
      const fn = call.function as Record<string, unknown> | undefined;
      if (typeof call.id !== "string" || typeof fn?.name !== "string" || typeof fn.arguments !== "string") return [];
      return [{ id: call.id, type: "function" as const, function: { name: fn.name, arguments: fn.arguments } }];
    });
    if (toolCalls.length) normalized.tool_calls = toolCalls;
  }
  return normalized;
}

export type CommandResult = { snapshot: WorkspaceSnapshot; triggerRoomId?: string; stopRoomId?: string; runCronJobId?: string; refreshCron?: boolean };

export class WorkspaceRepository {
  readonly raw: Database.Database;
  readonly dataDir: string;

  constructor(handle: DatabaseHandle = getDatabase()) {
    this.raw = handle.raw;
    this.dataDir = handle.dataDir;
    this.ensureSeed();
  }

  private defaultSettings(): ModelAndRuntimeSettings {
    const row = this.raw.prepare("SELECT settings_json FROM workspace_meta WHERE id=1").get() as Row;
    return normalizeRuntimeSettings(parseJson<Partial<ModelAndRuntimeSettings>>(row.settings_json, {}));
  }

  private ensureSeed(): void {
    const count = num((this.raw.prepare("SELECT COUNT(*) count FROM agents").get() as Row).count);
    if (count > 0) return;
    const tx = this.raw.transaction(() => {
      const at = nowIso();
      const settings = JSON.stringify(this.defaultSettings());
      const insertAgent = this.raw.prepare("INSERT INTO agents(id,label,summary,instruction,skills_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)");
      insertAgent.run("navigator", "领航员", "梳理目标、协调房间并公开可靠结论", "你是 OceanKing 领航员。先调查和协调，再通过房间工具明确公开经过整理的结论。普通 assistant 文本对人类不可见。", "[]", settings, at, at);
      insertAgent.run("builder", "执行者", "执行具体任务并汇报可验证结果", "你是 OceanKing 执行者。聚焦实际执行、工具使用和验证，只通过 send_message_to_room 公开需要人类看到的内容。", "[]", settings, at, at);
      this.raw.prepare("INSERT INTO agent_sessions(agent_id,history_json,active_turn_id,updated_at) VALUES(?,?,NULL,?)").run("navigator", "[]", at);
      this.raw.prepare("INSERT INTO agent_sessions(agent_id,history_json,active_turn_id,updated_at) VALUES(?,?,NULL,?)").run("builder", "[]", at);

      this.insertInitialRoom(at);
      this.bump();
    });
    tx();
  }

  private insertInitialRoom(at: string): void {
    const roomId = "room_harbor";
    const humanId = "human_local";
    const agentParticipantId = "participant_navigator_harbor";
    const navigator = this.raw.prepare("SELECT label FROM agents WHERE id='navigator'").get() as Row | undefined;
    if (!navigator) throw new DomainError("初始领航员不存在，无法重置工作台");
    this.raw.prepare("INSERT INTO rooms(id,title,owner_participant_id,next_seq,archived_at,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)").run(roomId, "港湾协作室", humanId, 2, at, at);
    this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)").run(humanId, roomId, "human", null, "你", 1, 0, at);
    this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?)").run(agentParticipantId, roomId, "agent", "navigator", str(navigator.label), 1, 1, at);
    this.raw.prepare("INSERT INTO scheduler_states(room_id,status,next_agent_participant_id,active_participant_id,round_count,cursor_json,receipt_revision_json,rerun_requested) VALUES(?,?,?,?,?,?,?,0)").run(roomId, "idle", agentParticipantId, null, 0, JSON.stringify({ [agentParticipantId]: 1 }), "{}");
    this.raw.prepare("INSERT INTO room_messages(id,room_id,seq,sender_id,sender_name,sender_role,source,kind,status,content,final,message_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("msg_welcome", roomId, 1, "system", "OceanKing", "system", "system", "system", "completed", "房间是公开协作事实；Agent 的思考与工具过程只会出现在右侧 Console。", 1, null, at);
  }

  private resetWorkspaceState(at: string): string[] {
    const attachmentPaths = (this.raw.prepare("SELECT storage_path FROM attachments").all() as Row[]).map((row) => str(row.storage_path));
    this.raw.prepare("DELETE FROM attachments").run();
    this.raw.prepare("DELETE FROM rooms").run();
    this.raw.prepare("UPDATE agent_sessions SET history_json='[]',active_turn_id=NULL,updated_at=?").run(at);
    this.raw.prepare("INSERT OR IGNORE INTO agent_sessions(agent_id,history_json,active_turn_id,updated_at) SELECT id,'[]',NULL,? FROM agents").run(at);
    this.insertInitialRoom(at);
    return attachmentPaths;
  }

  private removeResetAttachments(storagePaths: string[]): void {
    const uploadsRoot = path.resolve(this.dataDir, "uploads");
    for (const storagePath of storagePaths) {
      const target = path.resolve(this.dataDir, storagePath);
      if (!target.startsWith(`${uploadsRoot}${path.sep}`)) continue;
      try { fs.rmSync(target, { force: true }); } catch { /* 数据已清空；磁盘清理失败不回滚已提交的重置。 */ }
    }
  }

  private bump(): { version: number; revision: number } {
    this.raw.prepare("UPDATE workspace_meta SET version=version+1, revision=revision+1 WHERE id=1").run();
    const row = this.raw.prepare("SELECT version,revision FROM workspace_meta WHERE id=1").get() as Row;
    return { version: num(row.version), revision: num(row.revision) };
  }

  getVersion(): { version: number; revision: number } {
    const row = this.raw.prepare("SELECT version,revision FROM workspace_meta WHERE id=1").get() as Row;
    return { version: num(row.version), revision: num(row.revision) };
  }

  hasProcessedCommand(commandId: string): boolean {
    return Boolean(this.raw.prepare("SELECT 1 FROM command_dedup WHERE command_id=?").get(commandId));
  }

  getRoomIds(): string[] {
    return (this.raw.prepare("SELECT id FROM rooms ORDER BY created_at").all() as Row[]).map((row) => str(row.id));
  }

  getSnapshot(): WorkspaceSnapshot {
    const meta = this.raw.prepare("SELECT * FROM workspace_meta WHERE id=1").get() as Row;
    const settings = normalizeRuntimeSettings(parseJson<Partial<ModelAndRuntimeSettings>>(meta.settings_json, {}));
    const agentRows = this.raw.prepare("SELECT * FROM agents ORDER BY created_at").all() as Row[];
    const roomRows = this.raw.prepare("SELECT * FROM rooms ORDER BY archived_at IS NOT NULL, updated_at DESC").all() as Row[];
    const participantRows = this.raw.prepare("SELECT * FROM participants ORDER BY room_id,sort_order").all() as Row[];
    const messageRows = this.raw.prepare("SELECT * FROM room_messages ORDER BY room_id,seq").all() as Row[];
    const attachmentRows = this.raw.prepare("SELECT * FROM attachments ORDER BY created_at").all() as Row[];
    const receiptRows = this.raw.prepare("SELECT * FROM message_receipts ORDER BY created_at").all() as Row[];
    const turnRows = this.raw.prepare("SELECT * FROM agent_turns ORDER BY created_at").all() as Row[];
    const toolRows = this.raw.prepare("SELECT * FROM tool_executions ORDER BY created_at").all() as Row[];
    const timelineRows = this.raw.prepare("SELECT * FROM timeline_events ORDER BY turn_id,ordinal").all() as Row[];
    const schedulerRows = this.raw.prepare("SELECT * FROM scheduler_states").all() as Row[];

    const agents: Agent[] = agentRows.map((row) => ({
      id: str(row.id), label: str(row.label), summary: str(row.summary), instruction: str(row.instruction),
      skills: parseJson<string[]>(row.skills_json, []), settings,
      createdAt: str(row.created_at), updatedAt: str(row.updated_at),
    }));
    const participants: Participant[] = participantRows.map((row) => ({
      id: str(row.id), roomId: str(row.room_id), kind: str(row.kind) as Participant["kind"], agentId: nullableStr(row.agent_id), displayName: str(row.display_name),
      enabled: bool(row.enabled), sortOrder: num(row.sort_order), createdAt: str(row.created_at),
    }));
    const allAttachments: Attachment[] = attachmentRows.map((row) => ({
      id: str(row.id), roomId: nullableStr(row.room_id), messageId: nullableStr(row.message_id), fileName: str(row.file_name), mimeType: str(row.mime_type),
      byteSize: num(row.byte_size), storagePath: str(row.storage_path), createdAt: str(row.created_at),
    }));
    const allReceipts: ReadNoReplyReceipt[] = receiptRows.map((row) => ({ id: str(row.id), messageId: str(row.message_id), agentParticipantId: str(row.agent_participant_id), createdAt: str(row.created_at) }));
    const messages: RoomMessage[] = messageRows.map((row) => ({
      id: str(row.id), roomId: str(row.room_id), seq: num(row.seq), sender: { id: str(row.sender_id), name: str(row.sender_name), role: str(row.sender_role) as RoomMessage["sender"]["role"] },
      source: str(row.source) as RoomMessage["source"], kind: str(row.kind) as RoomMessage["kind"], status: str(row.status) as RoomMessage["status"], content: str(row.content),
      attachments: allAttachments.filter((a) => a.messageId === str(row.id)), receipts: allReceipts.filter((r) => r.messageId === str(row.id)), final: bool(row.final), messageKey: nullableStr(row.message_key), createdAt: str(row.created_at),
    }));
    const tools: ToolExecution[] = toolRows.map((row) => ({
      id: str(row.id), turnId: str(row.turn_id), name: str(row.name), input: parseJson(row.input_json, {}), outputText: str(row.output_text), structuredResult: parseJson(row.structured_result_json, {}),
      status: str(row.status) as ToolExecution["status"], durationMs: num(row.duration_ms), error: nullableStr(row.error), createdAt: str(row.created_at),
    }));
    const timeline: TimelineEvent[] = timelineRows.map((row) => ({ id: str(row.id), turnId: str(row.turn_id), ordinal: num(row.ordinal), type: str(row.type) as TimelineEvent["type"], payload: parseJson(row.payload_json, {}), createdAt: str(row.created_at) }));
    const turns: AgentTurn[] = turnRows.map((row) => ({
      id: str(row.id), roomId: str(row.room_id), agentId: str(row.agent_id), agentParticipantId: str(row.agent_participant_id), userEnvelope: parseJson<SchedulerPacket>(row.user_envelope_json, {} as SchedulerPacket),
      anchorMessageId: nullableStr(row.anchor_message_id), assistantContent: str(row.assistant_content), tools: tools.filter((tool) => tool.turnId === str(row.id)), emittedMessageIds: parseJson<string[]>(row.emitted_message_ids_json, []),
      timeline: timeline.filter((event) => event.turnId === str(row.id)), status: str(row.status) as AgentTurn["status"], modelMeta: row.model_meta_json ? parseJson<Record<string, unknown>>(row.model_meta_json, {}) : null,
      error: nullableStr(row.error), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
    }));
    const schedulers = new Map(schedulerRows.map((row) => [str(row.room_id), {
      roomId: str(row.room_id), status: str(row.status) as SchedulerState["status"], nextAgentParticipantId: nullableStr(row.next_agent_participant_id), activeParticipantId: nullableStr(row.active_participant_id),
      roundCount: num(row.round_count), cursorByParticipantId: parseJson<Record<string, number>>(row.cursor_json, {}), receiptRevisionByParticipantId: parseJson<Record<string, number>>(row.receipt_revision_json, {}), rerunRequested: bool(row.rerun_requested),
    } satisfies SchedulerState]));
    const rooms: Room[] = roomRows.map((row) => {
      const roomId = str(row.id);
      return {
        id: roomId, title: str(row.title), ownerParticipantId: nullableStr(row.owner_participant_id), participants: participants.filter((p) => p.roomId === roomId), messages: messages.filter((m) => m.roomId === roomId),
        turns: turns.filter((turn) => turn.roomId === roomId), scheduler: schedulers.get(roomId) ?? { roomId, status: "idle", nextAgentParticipantId: null, activeParticipantId: null, roundCount: 0, cursorByParticipantId: {}, receiptRevisionByParticipantId: {}, rerunRequested: false },
        archivedAt: nullableStr(row.archived_at), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
      };
    });
    const cronJobs = (this.raw.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() as Row[]).map((row): CronJob => ({
      id: str(row.id), agentId: str(row.agent_id), roomId: str(row.room_id), name: str(row.name), schedule: str(row.schedule), timezone: str(row.timezone), prompt: str(row.prompt), enabled: bool(row.enabled), lastRunAt: nullableStr(row.last_run_at), nextRunAt: nullableStr(row.next_run_at), createdAt: str(row.created_at), updatedAt: str(row.updated_at),
    }));
    const cronRuns = (this.raw.prepare("SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT 200").all() as Row[]).map((row): CronRun => ({
      id: str(row.id), jobId: str(row.job_id), status: str(row.status) as CronRun["status"], messageId: nullableStr(row.message_id), error: nullableStr(row.error), startedAt: str(row.started_at), finishedAt: nullableStr(row.finished_at),
    }));
    return {
      version: num(meta.version), revision: num(meta.revision), agents, rooms, cronJobs, cronRuns,
      settings: { ...settings, baseUrl: normalizeOpenAiBaseUrl(), apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY), usingMockModel: !process.env.OPENAI_API_KEY },
    };
  }

  getAgentConversation(agentId: string): AgentConversationHistory | null {
    const snapshot = this.getSnapshot();
    const agent = snapshot.agents.find((entry) => entry.id === agentId);
    if (!agent) return null;
    const detailRows = this.raw.prepare("SELECT id,system_prompt,conversation_json FROM agent_turns WHERE agent_id=?").all(agentId) as Row[];
    const details = new Map(detailRows.map((row) => [str(row.id), {
      systemPrompt: str(row.system_prompt),
      messages: parseJson<unknown[]>(row.conversation_json, []).map(normalizeSessionMessage).filter((message): message is AgentSessionMessage => message !== null),
    }]));
    const turns = snapshot.rooms.flatMap((room) => room.turns
      .filter((turn) => turn.agentId === agentId)
      .map((turn) => {
        const detail = details.get(turn.id);
        const messages = detail?.messages.length
          ? detail.messages
          : turn.assistantContent
            ? [{ role: "assistant" as const, content: turn.assistantContent }]
            : [];
        return { ...turn, roomTitle: room.title, systemPrompt: detail?.systemPrompt ?? "", messages };
      }))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { agent: { id: agent.id, label: agent.label, summary: agent.summary }, turns };
  }

  executeCommand(command: WorkspaceCommand): CommandResult {
    const result: Omit<CommandResult, "snapshot"> = {};
    let resetAttachmentPaths: string[] = [];
    const tx = this.raw.transaction(() => {
      const deduped = this.raw.prepare("SELECT 1 found FROM command_dedup WHERE command_id=?").get(command.commandId) as Row | undefined;
      if (deduped) return;
      const current = this.getVersion().version;
      if (current !== command.expectedVersion) throw new VersionConflictError(current);
      const at = nowIso();
      switch (command.type) {
        case "create_room": {
          const roomId = createId("room");
          const humanId = createId("human");
          this.raw.prepare("INSERT INTO rooms(id,title,owner_participant_id,next_seq,archived_at,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)").run(roomId, command.title, humanId, 1, at, at);
          this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,1,0,?)").run(humanId, roomId, "human", null, "你", at);
          let nextParticipant: string | null = null;
          if (command.agentId) nextParticipant = this.insertAgentParticipant(roomId, command.agentId, at).participantId;
          this.raw.prepare("INSERT INTO scheduler_states(room_id,status,next_agent_participant_id,active_participant_id,round_count,cursor_json,receipt_revision_json,rerun_requested) VALUES(?,?,?,?,0,?,?,0)").run(roomId, "idle", nextParticipant, null, "{}", "{}");
          break;
        }
        case "rename_room": this.requireRoom(command.roomId); this.raw.prepare("UPDATE rooms SET title=?,updated_at=? WHERE id=?").run(command.title, at, command.roomId); break;
        case "archive_room": this.requireRoom(command.roomId); this.raw.prepare("UPDATE rooms SET archived_at=?,updated_at=? WHERE id=?").run(command.archived ? at : null, at, command.roomId); break;
        case "send_message": {
          this.requireRoom(command.roomId);
          if (!command.content.trim() && command.attachmentIds.length === 0) throw new DomainError("消息或附件不能为空");
          const messageId = createId("msg");
          const seq = this.takeNextSeq(command.roomId, at);
          this.raw.prepare("INSERT INTO room_messages(id,room_id,seq,sender_id,sender_name,sender_role,source,kind,status,content,final,message_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(messageId, command.roomId, seq, "human_local", "你", "participant", "user", "user_input", "completed", command.content.trim(), 1, null, at);
          for (const attachmentId of command.attachmentIds) this.raw.prepare("UPDATE attachments SET room_id=?,message_id=? WHERE id=? AND message_id IS NULL").run(command.roomId, messageId, attachmentId);
          result.triggerRoomId = command.roomId;
          break;
        }
        case "add_agent": this.requireRoom(command.roomId); this.insertAgentParticipant(command.roomId, command.agentId, at); result.triggerRoomId = command.roomId; break;
        case "remove_participant": this.requireRoom(command.roomId); this.raw.prepare("DELETE FROM participants WHERE id=? AND room_id=?").run(command.participantId, command.roomId); break;
        case "toggle_participant": this.raw.prepare("UPDATE participants SET enabled=? WHERE id=? AND room_id=? AND kind='agent'").run(command.enabled ? 1 : 0, command.participantId, command.roomId); result.triggerRoomId = command.roomId; break;
        case "stop_room": this.stopRoomState(command.roomId, at); result.stopRoomId = command.roomId; break;
        case "create_agent": {
          const id = createId("agent"); const settings = JSON.stringify(this.defaultSettings());
          this.raw.prepare("INSERT INTO agents(id,label,summary,instruction,skills_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, command.label, command.summary, command.instruction, "[]", settings, at, at);
          this.raw.prepare("INSERT INTO agent_sessions(agent_id,history_json,active_turn_id,updated_at) VALUES(?,?,NULL,?)").run(id, "[]", at); break;
        }
        case "update_agent": this.raw.prepare("UPDATE agents SET label=?,summary=?,instruction=?,updated_at=? WHERE id=?").run(command.label, command.summary, command.instruction, at, command.agentId); break;
        case "create_cron": {
          const id = createId("cron");
          this.raw.prepare("INSERT INTO cron_jobs(id,agent_id,room_id,name,schedule,timezone,prompt,enabled,last_run_at,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,NULL,NULL,?,?)")
            .run(id, command.agentId, command.roomId, command.name, command.schedule, command.timezone, command.prompt, at, at); result.refreshCron = true; break;
        }
        case "update_cron": {
          const row = this.raw.prepare("SELECT * FROM cron_jobs WHERE id=?").get(command.jobId) as Row | undefined; if (!row) throw new DomainError("定时任务不存在");
          this.raw.prepare("UPDATE cron_jobs SET name=?,schedule=?,timezone=?,prompt=?,enabled=?,updated_at=? WHERE id=?").run(command.name ?? row.name, command.schedule ?? row.schedule, command.timezone ?? row.timezone, command.prompt ?? row.prompt, command.enabled === undefined ? row.enabled : command.enabled ? 1 : 0, at, command.jobId);
          result.refreshCron = true; break;
        }
        case "delete_cron": this.raw.prepare("DELETE FROM cron_jobs WHERE id=?").run(command.jobId); result.refreshCron = true; break;
        case "run_cron": result.runCronJobId = command.jobId; break;
        case "reset_workspace": resetAttachmentPaths = this.resetWorkspaceState(at); result.refreshCron = true; break;
        case "update_settings": {
          const currentSettings = this.defaultSettings();
          if (!command.availableModels.includes(command.model)) throw new DomainError("默认模型必须来自全局可选模型列表");
          const updated = { ...currentSettings, model: command.model, availableModels: [...new Set(command.availableModels)], apiFormat: command.apiFormat, thinkingMode: command.thinkingMode ?? currentSettings.thinkingMode, reasoningEffort: command.reasoningEffort ?? currentSettings.reasoningEffort, contextTokenThreshold: command.contextTokenThreshold, maxToolSteps: command.maxToolSteps, maxRoomRounds: command.maxRoomRounds, projectContextRoots: command.projectContextRoots };
          const encoded = JSON.stringify(updated);
          this.raw.prepare("UPDATE workspace_meta SET settings_json=? WHERE id=1").run(encoded);
          this.raw.prepare("UPDATE agents SET settings_json=?,updated_at=?").run(encoded, at); break;
        }
      }
      this.raw.prepare("INSERT INTO command_dedup(command_id,created_at) VALUES(?,?)").run(command.commandId, at);
      this.bump();
    });
    tx();
    if (resetAttachmentPaths.length) this.removeResetAttachments(resetAttachmentPaths);
    return { ...result, snapshot: this.getSnapshot() };
  }

  private requireRoom(roomId: string): Row {
    const row = this.raw.prepare("SELECT * FROM rooms WHERE id=?").get(roomId) as Row | undefined;
    if (!row) throw new DomainError("房间不存在"); return row;
  }

  private insertAgentParticipant(roomId: string, agentId: string, at: string, participantId = createId("participant")): { participantId: string; inserted: boolean } {
    const agent = this.raw.prepare("SELECT label FROM agents WHERE id=?").get(agentId) as Row | undefined;
    if (!agent) throw new DomainError("Agent 不存在");
    const existing = this.raw.prepare("SELECT id FROM participants WHERE room_id=? AND agent_id=?").get(roomId, agentId) as Row | undefined;
    if (existing) return { participantId: str(existing.id), inserted: false };
    const order = num((this.raw.prepare("SELECT COALESCE(MAX(sort_order),0)+1 next_order FROM participants WHERE room_id=?").get(roomId) as Row).next_order);
    this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,1,?,?)").run(participantId, roomId, "agent", agentId, str(agent.label), order, at);
    const scheduler = this.raw.prepare("SELECT next_agent_participant_id FROM scheduler_states WHERE room_id=?").get(roomId) as Row | undefined;
    if (scheduler && !scheduler.next_agent_participant_id) this.raw.prepare("UPDATE scheduler_states SET next_agent_participant_id=? WHERE room_id=?").run(participantId, roomId);
    return { participantId, inserted: true };
  }

  private takeNextSeq(roomId: string, at: string): number {
    const row = this.requireRoom(roomId); const seq = num(row.next_seq);
    this.raw.prepare("UPDATE rooms SET next_seq=?,updated_at=? WHERE id=?").run(seq + 1, at, roomId); return seq;
  }

  registerAttachment(file: { id: string; fileName: string; mimeType: string; byteSize: number; storagePath: string }): Attachment {
    const at = nowIso();
    this.raw.prepare("INSERT INTO attachments(id,room_id,message_id,file_name,mime_type,byte_size,storage_path,created_at) VALUES(?,NULL,NULL,?,?,?,?,?)")
      .run(file.id, file.fileName, file.mimeType, file.byteSize, file.storagePath, at);
    this.bump();
    return { ...file, roomId: null, messageId: null, createdAt: at };
  }

  getAttachmentPath(id: string): string | null {
    const row = this.raw.prepare("SELECT storage_path FROM attachments WHERE id=?").get(id) as Row | undefined;
    return row ? path.join(this.dataDir, str(row.storage_path)) : null;
  }

  setScheduler(roomId: string, patch: Partial<{ status: string; next: string | null; active: string | null; roundCount: number; cursors: Record<string, number>; rerun: boolean }>): void {
    const row = this.raw.prepare("SELECT * FROM scheduler_states WHERE room_id=?").get(roomId) as Row;
    const cursors = patch.cursors ?? parseJson<Record<string, number>>(row.cursor_json, {});
    this.raw.prepare("UPDATE scheduler_states SET status=?,next_agent_participant_id=?,active_participant_id=?,round_count=?,cursor_json=?,rerun_requested=? WHERE room_id=?")
      .run(patch.status ?? row.status, patch.next === undefined ? row.next_agent_participant_id : patch.next, patch.active === undefined ? row.active_participant_id : patch.active, patch.roundCount ?? row.round_count, JSON.stringify(cursors), patch.rerun === undefined ? row.rerun_requested : patch.rerun ? 1 : 0, roomId);
    this.bump();
  }

  beginTurn(args: { turnId: string; roomId: string; agentId: string; agentParticipantId: string; packet: SchedulerPacket }): void {
    const at = nowIso();
    const tx = this.raw.transaction(() => {
      this.raw.prepare("INSERT INTO agent_turns(id,room_id,agent_id,agent_participant_id,user_envelope_json,anchor_message_id,assistant_content,emitted_message_ids_json,status,model_meta_json,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[]','running',NULL,NULL,?,?)")
        .run(args.turnId, args.roomId, args.agentId, args.agentParticipantId, JSON.stringify(args.packet), args.packet.targetMessageId, "", at, at);
      this.raw.prepare("UPDATE agent_sessions SET active_turn_id=?,updated_at=? WHERE agent_id=?").run(args.turnId, at, args.agentId);
      this.raw.prepare("UPDATE scheduler_states SET active_participant_id=?,status='running' WHERE room_id=?").run(args.agentParticipantId, args.roomId);
      this.bump();
    }); tx();
  }

  checkpointTurn(args: { turnId: string; assistantContent: string; systemPrompt: string; conversationMessages: AgentSessionMessage[]; tools: ToolExecution[]; timeline: TimelineEvent[] }): void {
    const tx = this.raw.transaction(() => {
      const turn = this.raw.prepare("SELECT 1 found FROM agent_turns WHERE id=?").get(args.turnId) as Row | undefined;
      if (!turn) return;
      this.persistTurnTrace(args.turnId, args.tools, args.timeline);
      this.raw.prepare("UPDATE agent_turns SET assistant_content=?,system_prompt=?,conversation_json=? WHERE id=?")
        .run(args.assistantContent, args.systemPrompt, JSON.stringify(args.conversationMessages), args.turnId);
    });
    tx();
  }

  finishTurn(args: { turnId: string; assistantContent: string; systemPrompt?: string; sessionMessages?: AgentSessionMessage[]; auditMessages?: AgentSessionMessage[]; tools: ToolExecution[]; timeline: TimelineEvent[]; effects: TurnEffect[]; modelMeta: Record<string, unknown>; contextCompaction?: ContextCompaction; cutoffSeq: number; nextParticipantId: string | null; status?: "completed" | "continued" }): { emittedMessageIds: string[]; triggerRoomIds: string[]; superseded: boolean } {
    const emittedMessageIds: string[] = [];
    const triggerRoomIds = new Set<string>();
    let superseded = false;
    const tx = this.raw.transaction(() => {
      const turn = this.raw.prepare("SELECT * FROM agent_turns WHERE id=?").get(args.turnId) as Row;
      if (!turn) throw new DomainError("Agent turn 不存在");
      const roomId = str(turn.room_id); const agentId = str(turn.agent_id); const participantId = str(turn.agent_participant_id); const at = nowIso();
      this.persistTurnTrace(args.turnId, args.tools, args.timeline);
      for (const effect of args.effects) this.applyEffect(effect, agentId, participantId, emittedMessageIds, triggerRoomIds, at);
      const newer = this.raw.prepare("SELECT 1 found FROM room_messages WHERE room_id=? AND seq>? AND sender_id<>? LIMIT 1").get(roomId, args.cutoffSeq, participantId) as Row | undefined;
      superseded = Boolean(newer);
      const status = superseded ? "continued" : (args.status ?? "completed");
      const packet = parseJson<SchedulerPacket>(turn.user_envelope_json, {} as SchedulerPacket);
      const completedMessages = args.sessionMessages ?? (args.contextCompaction
        ? [{ role: "user" as const, content: compactedSessionContent(args.contextCompaction.summary) }, { role: "assistant" as const, content: args.assistantContent }]
        : [{ role: "user" as const, content: JSON.stringify(packet) }, { role: "assistant" as const, content: args.assistantContent }]);
      this.raw.prepare("UPDATE agent_turns SET assistant_content=?,system_prompt=?,conversation_json=?,emitted_message_ids_json=?,status=?,model_meta_json=?,error=NULL,updated_at=? WHERE id=?")
        .run(args.assistantContent, args.systemPrompt ?? "", JSON.stringify(args.auditMessages ?? completedMessages), JSON.stringify(emittedMessageIds), status, JSON.stringify(args.modelMeta), at, args.turnId);
      const session = this.raw.prepare("SELECT history_json FROM agent_sessions WHERE agent_id=?").get(agentId) as Row;
      const history = parseJson<unknown[]>(session.history_json, []).map(normalizeSessionMessage).filter((message): message is AgentSessionMessage => message !== null);
      const nextHistory = args.contextCompaction ? completedMessages : [...history, ...completedMessages];
      this.raw.prepare("UPDATE agent_sessions SET history_json=?,active_turn_id=NULL,updated_at=? WHERE agent_id=?").run(JSON.stringify(nextHistory), at, agentId);
      const scheduler = this.raw.prepare("SELECT cursor_json,round_count FROM scheduler_states WHERE room_id=?").get(roomId) as Row;
      const cursors = parseJson<Record<string, number>>(scheduler.cursor_json, {}); cursors[participantId] = args.cutoffSeq;
      this.raw.prepare("UPDATE scheduler_states SET cursor_json=?,next_agent_participant_id=?,active_participant_id=NULL,round_count=?,rerun_requested=? WHERE room_id=?")
        .run(JSON.stringify(cursors), args.nextParticipantId, num(scheduler.round_count) + 1, superseded ? 1 : 0, roomId);
      this.bump();
    }); tx();
    return { emittedMessageIds, triggerRoomIds: [...triggerRoomIds], superseded };
  }

  private persistTurnTrace(turnId: string, tools: ToolExecution[], timeline: TimelineEvent[]): void {
    for (const tool of tools) this.raw.prepare("INSERT OR REPLACE INTO tool_executions(id,turn_id,name,input_json,output_text,structured_result_json,status,duration_ms,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(tool.id, turnId, tool.name, JSON.stringify(tool.input), tool.outputText, JSON.stringify(tool.structuredResult), tool.status, tool.durationMs, tool.error, tool.createdAt);
    for (const event of timeline) this.raw.prepare("INSERT OR REPLACE INTO timeline_events(id,turn_id,ordinal,type,payload_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(event.id, turnId, event.ordinal, event.type, JSON.stringify(event.payload), event.createdAt);
  }

  private applyEffect(effect: TurnEffect, agentId: string, participantId: string, emitted: string[], triggerRooms: Set<string>, at: string): void {
    if (effect.type === "send_message") {
      const membership = this.raw.prepare("SELECT id,display_name FROM participants WHERE room_id=? AND agent_id=? AND enabled=1").get(effect.roomId, agentId) as Row | undefined;
      if (!membership) throw new DomainError("Agent 不能向未连接房间发言");
      const existing = this.raw.prepare("SELECT id FROM room_messages WHERE room_id=? AND message_key=?").get(effect.roomId, effect.messageKey) as Row | undefined;
      if (existing) { emitted.push(str(existing.id)); return; }
      const seq = this.takeNextSeq(effect.roomId, at);
      this.raw.prepare("INSERT INTO room_messages(id,room_id,seq,sender_id,sender_name,sender_role,source,kind,status,content,final,message_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(effect.messageId, effect.roomId, seq, str(membership.id), str(membership.display_name), "participant", "agent_emit", effect.kind, "completed", effect.content, 1, effect.messageKey, at);
      emitted.push(effect.messageId); triggerRooms.add(effect.roomId); return;
    }
    if (effect.type === "read_no_reply") {
      const message = this.raw.prepare("SELECT id FROM room_messages WHERE id=? AND room_id=?").get(effect.messageId, effect.roomId) as Row | undefined;
      if (!message) throw new DomainError("receipt 目标消息不存在");
      this.raw.prepare("INSERT OR IGNORE INTO message_receipts(id,message_id,agent_participant_id,created_at) VALUES(?,?,?,?)").run(effect.receiptId, effect.messageId, participantId, at); return;
    }
    if (effect.type === "create_room") {
      const ownerId = createId("participant");
      const label = str((this.raw.prepare("SELECT label FROM agents WHERE id=?").get(agentId) as Row).label);
      this.raw.prepare("INSERT INTO rooms(id,title,owner_participant_id,next_seq,archived_at,created_at,updated_at) VALUES(?,?,?,?,NULL,?,?)").run(effect.roomId, effect.title, ownerId, 1, at, at);
      this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,1,0,?)").run(ownerId, effect.roomId, "agent", agentId, label, at);
      this.raw.prepare("INSERT INTO participants(id,room_id,kind,agent_id,display_name,enabled,sort_order,created_at) VALUES(?,?,?,?,?,1,1,?)").run(createId("human"), effect.roomId, "human", null, "你", at);
      this.raw.prepare("INSERT INTO scheduler_states(room_id,status,next_agent_participant_id,active_participant_id,round_count,cursor_json,receipt_revision_json,rerun_requested) VALUES(?,'idle',?,NULL,0,'{}','{}',0)").run(effect.roomId, ownerId);
      for (const invitedAgentId of [...new Set(effect.invitedAgentIds)]) {
        if (invitedAgentId !== agentId) this.insertAgentParticipant(effect.roomId, invitedAgentId, at);
      }
      return;
    }
    if (effect.type === "invite_agent") {
      this.assertAgentOwner(effect.roomId, agentId);
      const invitation = this.insertAgentParticipant(effect.roomId, effect.agentId, at, effect.participantId);
      if (invitation.inserted) triggerRooms.add(effect.roomId);
      return;
    }
    if (effect.type === "remove_participant") {
      this.assertAgentOwner(effect.roomId, agentId);
      this.raw.prepare("DELETE FROM participants WHERE room_id=? AND id=? AND id<>(SELECT owner_participant_id FROM rooms WHERE id=?)")
        .run(effect.roomId, effect.participantId, effect.roomId);
      return;
    }
    if (effect.type === "leave_room") { this.raw.prepare("DELETE FROM participants WHERE room_id=? AND id=?").run(effect.roomId, participantId); return; }
    if (effect.type === "create_cron") {
      const job = effect.job; this.raw.prepare("INSERT OR IGNORE INTO cron_jobs(id,agent_id,room_id,name,schedule,timezone,prompt,enabled,last_run_at,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(job.id, agentId, job.roomId, job.name, job.schedule, job.timezone, job.prompt, job.enabled ? 1 : 0, job.lastRunAt, job.nextRunAt, at, at); return;
    }
    if (effect.type === "update_cron") {
      const row = this.raw.prepare("SELECT * FROM cron_jobs WHERE id=? AND agent_id=?").get(effect.jobId, agentId) as Row | undefined; if (!row) throw new DomainError("只能管理所属 Agent 的 Cron");
      const p = effect.patch; this.raw.prepare("UPDATE cron_jobs SET name=?,schedule=?,timezone=?,prompt=?,enabled=?,updated_at=? WHERE id=?").run(p.name ?? row.name, p.schedule ?? row.schedule, p.timezone ?? row.timezone, p.prompt ?? row.prompt, p.enabled === undefined ? row.enabled : p.enabled ? 1 : 0, at, effect.jobId); return;
    }
    if (effect.type === "delete_cron") { this.raw.prepare("DELETE FROM cron_jobs WHERE id=? AND agent_id=?").run(effect.jobId, agentId); }
  }

  private assertAgentOwner(roomId: string, agentId: string): void {
    const room = this.requireRoom(roomId);
    const owner = this.raw.prepare("SELECT agent_id FROM participants WHERE id=? AND room_id=?").get(room.owner_participant_id, roomId) as Row | undefined;
    if (!owner || owner.agent_id !== agentId) throw new DomainError("只有房间 owner Agent 能管理成员");
  }

  failTurn(turnId: string, error: string, stopped = false, modelMeta?: Record<string, unknown>): void {
    const at = nowIso();
    const tx = this.raw.transaction(() => {
      const row = this.raw.prepare("SELECT agent_id,room_id FROM agent_turns WHERE id=?").get(turnId) as Row | undefined;
      if (!row) return;
      this.raw.prepare("UPDATE agent_turns SET status=?,error=?,model_meta_json=COALESCE(?,model_meta_json),updated_at=? WHERE id=?")
        .run(stopped ? "stopped" : "error", error, modelMeta ? JSON.stringify(modelMeta) : null, at, turnId);
      this.raw.prepare("UPDATE agent_sessions SET active_turn_id=NULL,updated_at=? WHERE agent_id=?").run(at, row.agent_id);
      this.raw.prepare("UPDATE scheduler_states SET active_participant_id=NULL WHERE room_id=?").run(row.room_id);
      this.bump();
    }); tx();
  }

  stopRoomState(roomId: string, at = nowIso()): void {
    this.requireRoom(roomId);
    this.raw.prepare("UPDATE agent_turns SET status='stopped',error='用户已停止房间',updated_at=? WHERE room_id=? AND status='running'").run(at, roomId);
    this.raw.prepare("UPDATE scheduler_states SET status='idle',active_participant_id=NULL,rerun_requested=0 WHERE room_id=?").run(roomId);
    this.raw.prepare("UPDATE agent_sessions SET active_turn_id=NULL,updated_at=? WHERE active_turn_id IN (SELECT id FROM agent_turns WHERE room_id=?)").run(at, roomId);
  }

  recoverInterruptedRuns(): string[] {
    const rows = this.raw.prepare("SELECT room_id FROM scheduler_states WHERE status='running' OR active_participant_id IS NOT NULL").all() as Row[];
    const tx = this.raw.transaction(() => {
      const at = nowIso();
      this.raw.prepare("UPDATE agent_turns SET status='error',error='进程重启：运行已恢复为明确错误状态',updated_at=? WHERE status='running'").run(at);
      this.raw.prepare("UPDATE scheduler_states SET status='idle',active_participant_id=NULL,rerun_requested=1 WHERE status='running' OR active_participant_id IS NOT NULL").run();
      this.raw.prepare("UPDATE agent_sessions SET active_turn_id=NULL,updated_at=? WHERE active_turn_id IS NOT NULL").run(at);
      if (rows.length) this.bump();
    }); tx(); return rows.map((row) => str(row.room_id));
  }

  getAgentSession(agentId: string): AgentSessionMessage[] {
    const row = this.raw.prepare("SELECT history_json FROM agent_sessions WHERE agent_id=?").get(agentId) as Row | undefined;
    return row ? parseJson<unknown[]>(row.history_json, []).map(normalizeSessionMessage).filter((message): message is AgentSessionMessage => message !== null) : [];
  }

  hasAgent(agentId: string): boolean { return Boolean(this.raw.prepare("SELECT 1 FROM agents WHERE id=?").get(agentId)); }
  getAgent(agentId: string): Agent | null { return this.getSnapshot().agents.find((agent) => agent.id === agentId) ?? null; }
  getRoom(roomId: string): Room | null { return this.getSnapshot().rooms.find((room) => room.id === roomId) ?? null; }

  appendCronMessage(jobId: string): { roomId: string; messageId: string; runId: string } {
    let result = { roomId: "", messageId: "", runId: "" };
    const tx = this.raw.transaction(() => {
      const job = this.raw.prepare("SELECT * FROM cron_jobs WHERE id=?").get(jobId) as Row | undefined; if (!job) throw new DomainError("Cron 不存在");
      const at = nowIso(); const roomId = str(job.room_id); const messageId = createId("msg"); const runId = createId("cronrun"); const seq = this.takeNextSeq(roomId, at);
      this.raw.prepare("INSERT INTO room_messages(id,room_id,seq,sender_id,sender_name,sender_role,source,kind,status,content,final,message_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(messageId, roomId, seq, `cron:${jobId}`, `Cron · ${str(job.name)}`, "participant", "system", "user_input", "completed", str(job.prompt), 1, `cron:${runId}`, at);
      this.raw.prepare("INSERT INTO cron_runs(id,job_id,status,message_id,error,started_at,finished_at) VALUES(?,?,'running',?,NULL,?,NULL)").run(runId, jobId, messageId, at);
      this.raw.prepare("UPDATE cron_jobs SET last_run_at=?,updated_at=? WHERE id=?").run(at, at, jobId); this.bump(); result = { roomId, messageId, runId };
    }); tx(); return result;
  }

  completeCronRun(runId: string, error?: string): void {
    this.raw.prepare("UPDATE cron_runs SET status=?,error=?,finished_at=? WHERE id=?").run(error ? "error" : "completed", error ?? null, nowIso(), runId); this.bump();
  }
}

const globalRepo = globalThis as typeof globalThis & { __oceanKingRepo?: WorkspaceRepository };
export function getRepository(): WorkspaceRepository { globalRepo.__oceanKingRepo ??= new WorkspaceRepository(); return globalRepo.__oceanKingRepo; }
export function resetRepositoryForTests(): void { delete globalRepo.__oceanKingRepo; }
