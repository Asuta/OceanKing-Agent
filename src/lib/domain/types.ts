export type Id = string;

export type ModelAndRuntimeSettings = {
  apiFormat: "auto" | "responses" | "chat_completions";
  model: string;
  availableModels: string[];
  maxToolSteps: number;
  maxRoomRounds: number;
  projectContextRoots: string[];
};

export type Agent = {
  id: Id;
  label: string;
  summary: string;
  instruction: string;
  skills: string[];
  settings: ModelAndRuntimeSettings;
  createdAt: string;
  updatedAt: string;
};

export type Participant = {
  id: Id;
  roomId: Id;
  kind: "human" | "agent";
  agentId: Id | null;
  displayName: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
};

export type Attachment = {
  id: Id;
  roomId: Id | null;
  messageId: Id | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  storagePath: string;
  createdAt: string;
};

export type ReadNoReplyReceipt = {
  id: Id;
  messageId: Id;
  agentParticipantId: Id;
  createdAt: string;
};

export type RoomMessage = {
  id: Id;
  roomId: Id;
  seq: number;
  sender: { id: Id; name: string; role: "participant" | "system" };
  source: "user" | "agent_emit" | "system";
  kind: "user_input" | "answer" | "progress" | "warning" | "error" | "clarification" | "system";
  status: "pending" | "streaming" | "completed" | "failed";
  content: string;
  attachments: Attachment[];
  receipts: ReadNoReplyReceipt[];
  final: boolean;
  messageKey: string | null;
  createdAt: string;
};

export type RoomMessagePreview = {
  turnId: Id;
  roomId: Id;
  agentId: Id;
  messageKey: string;
  content: string;
  kind: "answer" | "progress" | "warning" | "error" | "clarification";
};

export type ToolExecution = {
  id: Id;
  turnId: Id;
  name: string;
  input: unknown;
  outputText: string;
  structuredResult: unknown;
  status: "running" | "completed" | "error";
  durationMs: number;
  error: string | null;
  createdAt: string;
};

export type TimelineEvent = {
  id: Id;
  turnId: Id;
  ordinal: number;
  type: "turn_started" | "assistant_delta" | "tool_started" | "tool_finished" | "message_emitted" | "turn_finished" | "error";
  payload: unknown;
  createdAt: string;
};

export type AgentTurn = {
  id: Id;
  roomId: Id;
  agentId: Id;
  agentParticipantId: Id;
  userEnvelope: SchedulerPacket;
  anchorMessageId: Id | null;
  assistantContent: string;
  tools: ToolExecution[];
  emittedMessageIds: Id[];
  timeline: TimelineEvent[];
  status: "running" | "continued" | "completed" | "error" | "stopped";
  modelMeta: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SchedulerState = {
  roomId: Id;
  status: "idle" | "running";
  nextAgentParticipantId: Id | null;
  activeParticipantId: Id | null;
  roundCount: number;
  cursorByParticipantId: Record<Id, number>;
  receiptRevisionByParticipantId: Record<Id, number>;
  rerunRequested: boolean;
};

export type Room = {
  id: Id;
  title: string;
  ownerParticipantId: Id | null;
  participants: Participant[];
  messages: RoomMessage[];
  turns: AgentTurn[];
  scheduler: SchedulerState;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CronJob = {
  id: Id;
  agentId: Id;
  roomId: Id;
  name: string;
  schedule: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CronRun = {
  id: Id;
  jobId: Id;
  status: "running" | "completed" | "error" | "stopped";
  messageId: Id | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type WorkspaceSnapshot = {
  version: number;
  revision: number;
  agents: Agent[];
  rooms: Room[];
  cronJobs: CronJob[];
  cronRuns: CronRun[];
  settings: ModelAndRuntimeSettings & {
    baseUrl: string;
    apiKeyConfigured: boolean;
    usingMockModel: boolean;
  };
};

export type SchedulerPacket = {
  type: "scheduler_packet" | "cron_packet";
  room: { id: Id; title: string };
  targetMessageId: Id;
  cutoffSeq: number;
  sender: { id: Id; name: string };
  messages: Array<Pick<RoomMessage, "id" | "seq" | "content" | "source" | "kind"> & { attachments: Attachment[] }>;
  connectedRooms: Array<{ id: Id; title: string }>;
  availableAgents: Array<{ id: Id; label: string; summary: string }>;
};

export type TurnEffect =
  | { type: "send_message"; roomId: Id; messageId: Id; messageKey: string; content: string; kind: RoomMessage["kind"] }
  | { type: "read_no_reply"; roomId: Id; messageId: Id; receiptId: Id }
  | { type: "create_room"; roomId: Id; title: string }
  | { type: "invite_agent"; roomId: Id; agentId: Id; participantId: Id }
  | { type: "remove_participant"; roomId: Id; participantId: Id }
  | { type: "leave_room"; roomId: Id; participantId: Id }
  | { type: "create_cron"; job: CronJob }
  | { type: "update_cron"; jobId: Id; patch: Partial<Pick<CronJob, "name" | "schedule" | "timezone" | "prompt" | "enabled">> }
  | { type: "delete_cron"; jobId: Id };

export type ToolExecutionResult = {
  text: string;
  structured: unknown;
  effects: TurnEffect[];
};

export type WorkspaceEvent = {
  id: number;
  type: "workspace.changed" | "turn.preview" | "scheduler.changed" | "cron.changed";
  revision: number;
  entityId?: Id;
  payload?: unknown;
  createdAt: string;
};
