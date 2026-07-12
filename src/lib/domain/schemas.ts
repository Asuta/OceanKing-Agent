import { z } from "zod";

const base = {
  commandId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
};

export const workspaceCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("create_room"), title: z.string().trim().min(1).max(120), agentId: z.string().optional() }),
  z.object({ ...base, type: z.literal("rename_room"), roomId: z.string(), title: z.string().trim().min(1).max(120) }),
  z.object({ ...base, type: z.literal("archive_room"), roomId: z.string(), archived: z.boolean() }),
  z.object({ ...base, type: z.literal("send_message"), roomId: z.string(), content: z.string().max(100_000), attachmentIds: z.array(z.string()).max(12).default([]) }),
  z.object({ ...base, type: z.literal("add_agent"), roomId: z.string(), agentId: z.string() }),
  z.object({ ...base, type: z.literal("remove_participant"), roomId: z.string(), participantId: z.string() }),
  z.object({ ...base, type: z.literal("toggle_participant"), roomId: z.string(), participantId: z.string(), enabled: z.boolean() }),
  z.object({ ...base, type: z.literal("stop_room"), roomId: z.string() }),
  z.object({ ...base, type: z.literal("create_agent"), label: z.string().trim().min(1).max(80), summary: z.string().trim().max(300), instruction: z.string().trim().min(1).max(20_000) }),
  z.object({ ...base, type: z.literal("update_agent"), agentId: z.string(), label: z.string().trim().min(1).max(80), summary: z.string().trim().max(300), instruction: z.string().trim().min(1).max(20_000) }),
  z.object({ ...base, type: z.literal("create_cron"), roomId: z.string(), agentId: z.string(), name: z.string().trim().min(1).max(100), schedule: z.string().trim().min(1).max(100), timezone: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(20_000) }),
  z.object({ ...base, type: z.literal("update_cron"), jobId: z.string(), enabled: z.boolean().optional(), name: z.string().trim().min(1).max(100).optional(), schedule: z.string().trim().min(1).max(100).optional(), timezone: z.string().trim().min(1).max(80).optional(), prompt: z.string().trim().min(1).max(20_000).optional() }),
  z.object({ ...base, type: z.literal("delete_cron"), jobId: z.string() }),
  z.object({ ...base, type: z.literal("run_cron"), jobId: z.string() }),
  z.object({ ...base, type: z.literal("update_settings"), model: z.string().trim().min(1).max(200), availableModels: z.array(z.string().trim().min(1).max(200)).min(1).max(32), apiFormat: z.enum(["auto", "responses", "chat_completions"]), thinkingMode: z.enum(["provider_default", "enabled", "disabled"]).optional(), reasoningEffort: z.enum(["high", "max"]).optional(), contextTokenThreshold: z.number().int().min(1_024).max(1_000_000), maxToolSteps: z.number().int().min(1).max(64), maxRoomRounds: z.number().int().min(1).max(256), projectContextRoots: z.array(z.string()).max(32) }),
]);

export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never;
export type WorkspaceCommandDraft = DistributiveOmit<WorkspaceCommand, "commandId" | "expectedVersion">;

export const sendMessageToolSchema = z.object({
  roomId: z.string().min(1),
  content: z.string().min(1).max(100_000),
  kind: z.enum(["answer", "progress", "warning", "error", "clarification"]).default("answer"),
  messageKey: z.string().max(200).optional(),
});

export const readNoReplyToolSchema = z.object({ roomId: z.string(), messageId: z.string() });
