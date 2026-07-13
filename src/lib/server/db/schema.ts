import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaceMeta = sqliteTable("workspace_meta", {
  id: integer("id").primaryKey(), version: integer("version").notNull(), revision: integer("revision").notNull(),
  settingsJson: text("settings_json").notNull(),
});
export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(), label: text("label").notNull(), summary: text("summary").notNull(), instruction: text("instruction").notNull(),
  skillsJson: text("skills_json").notNull(), settingsJson: text("settings_json").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(), title: text("title").notNull(), ownerParticipantId: text("owner_participant_id"), nextSeq: integer("next_seq").notNull(),
  archivedAt: text("archived_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const participants = sqliteTable("participants", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull(), kind: text("kind").notNull(), agentId: text("agent_id"), displayName: text("display_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(), sortOrder: integer("sort_order").notNull(), createdAt: text("created_at").notNull(),
});
export const roomMessages = sqliteTable("room_messages", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull(), seq: integer("seq").notNull(), senderId: text("sender_id").notNull(), senderName: text("sender_name").notNull(),
  senderRole: text("sender_role").notNull(), source: text("source").notNull(), kind: text("kind").notNull(), status: text("status").notNull(), content: text("content").notNull(),
  final: integer("final", { mode: "boolean" }).notNull(), messageKey: text("message_key"), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("room_message_seq_unique").on(table.roomId, table.seq), uniqueIndex("room_message_key_unique").on(table.roomId, table.messageKey)]);
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(), roomId: text("room_id"), messageId: text("message_id"), fileName: text("file_name").notNull(), mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(), storagePath: text("storage_path").notNull(), createdAt: text("created_at").notNull(),
});
export const messageReceipts = sqliteTable("message_receipts", {
  id: text("id").primaryKey(), messageId: text("message_id").notNull(), agentParticipantId: text("agent_participant_id").notNull(), createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("receipt_unique").on(table.messageId, table.agentParticipantId)]);
export const agentTurns = sqliteTable("agent_turns", {
  id: text("id").primaryKey(), roomId: text("room_id").notNull(), agentId: text("agent_id").notNull(), agentParticipantId: text("agent_participant_id").notNull(),
  userEnvelopeJson: text("user_envelope_json").notNull(), anchorMessageId: text("anchor_message_id"), assistantContent: text("assistant_content").notNull(),
  systemPrompt: text("system_prompt").notNull().default(""), conversationJson: text("conversation_json").notNull().default("[]"),
  emittedMessageIdsJson: text("emitted_message_ids_json").notNull(), status: text("status").notNull(), modelMetaJson: text("model_meta_json"), error: text("error"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const toolExecutions = sqliteTable("tool_executions", {
  id: text("id").primaryKey(), turnId: text("turn_id").notNull(), name: text("name").notNull(), inputJson: text("input_json").notNull(), outputText: text("output_text").notNull(),
  structuredResultJson: text("structured_result_json").notNull(), status: text("status").notNull(), durationMs: integer("duration_ms").notNull(), error: text("error"), createdAt: text("created_at").notNull(),
});
export const timelineEvents = sqliteTable("timeline_events", {
  id: text("id").primaryKey(), turnId: text("turn_id").notNull(), ordinal: integer("ordinal").notNull(), type: text("type").notNull(), payloadJson: text("payload_json").notNull(), createdAt: text("created_at").notNull(),
});
export const schedulerStates = sqliteTable("scheduler_states", {
  roomId: text("room_id").primaryKey(), status: text("status").notNull(), nextAgentParticipantId: text("next_agent_participant_id"), activeParticipantId: text("active_participant_id"),
  roundCount: integer("round_count").notNull(), cursorJson: text("cursor_json").notNull(), receiptRevisionJson: text("receipt_revision_json").notNull(), rerunRequested: integer("rerun_requested", { mode: "boolean" }).notNull(),
});
export const agentSessions = sqliteTable("agent_sessions", {
  agentId: text("agent_id").primaryKey(), historyJson: text("history_json").notNull(), activeTurnId: text("active_turn_id"), updatedAt: text("updated_at").notNull(),
});
export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(), agentId: text("agent_id").notNull(), roomId: text("room_id").notNull(), name: text("name").notNull(), schedule: text("schedule").notNull(), timezone: text("timezone").notNull(),
  prompt: text("prompt").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull(), lastRunAt: text("last_run_at"), nextRunAt: text("next_run_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const cronRuns = sqliteTable("cron_runs", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull(), status: text("status").notNull(), messageId: text("message_id"), error: text("error"), startedAt: text("started_at").notNull(), finishedAt: text("finished_at"),
});
