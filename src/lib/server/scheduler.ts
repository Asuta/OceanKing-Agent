import type { Participant, Room, SchedulerPacket } from "@/lib/domain/types";
import { getAgentExecutor } from "@/lib/server/agent-executor";
import { completeCronRunsForRoom } from "@/lib/server/cron-run-tracker";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { runAgentModel } from "@/lib/server/model-runtime";
import { getRepository, WorkspaceRepository } from "@/lib/server/repository";
import { createId } from "@/lib/utils/id";

function enabledAgents(room: Room): Participant[] {
  return room.participants.filter((participant) => participant.kind === "agent" && participant.enabled && participant.agentId).toSorted((a, b) => a.sortOrder - b.sortOrder);
}

function nextParticipant(agents: Participant[], currentId: string): Participant | null {
  if (!agents.length) return null; const index = agents.findIndex((agent) => agent.id === currentId);
  return agents[(index < 0 ? 0 : index + 1) % agents.length] ?? agents[0] ?? null;
}

class RoomScheduler {
  private runningRooms = new Set<string>();
  private stoppedRooms = new Set<string>();
  private repository: WorkspaceRepository;

  constructor(repository = getRepository()) { this.repository = repository; }

  enqueue(roomId: string): void {
    this.stoppedRooms.delete(roomId); getAgentExecutor().allowRoom(roomId);
    if (this.runningRooms.has(roomId)) {
      this.repository.setScheduler(roomId, { rerun: true }); publishWorkspaceEvent("scheduler.changed", roomId, { rerunRequested: true }); return;
    }
    this.runningRooms.add(roomId);
    setTimeout(() => { void this.drain(roomId); }, 0);
  }

  stop(roomId: string): void {
    this.stoppedRooms.add(roomId); getAgentExecutor().stopRoom(roomId); this.repository.stopRoomState(roomId);
    publishWorkspaceEvent("scheduler.changed", roomId, { status: "idle", stopped: true });
  }

  private async drain(roomId: string): Promise<void> {
    let idlePasses = 0;
    try {
      this.repository.setScheduler(roomId, { status: "running", rerun: false }); publishWorkspaceEvent("scheduler.changed", roomId, { status: "running" });
      const maxRounds = this.repository.getSnapshot().settings.maxRoomRounds;
      for (let round = 0; round < maxRounds && !this.stoppedRooms.has(roomId); round += 1) {
        const room = this.repository.getRoom(roomId); if (!room || room.archivedAt) break;
        const agents = enabledAgents(room); if (!agents.length) break;
        const current = agents.find((agent) => agent.id === room.scheduler.nextAgentParticipantId) ?? agents[0];
        if (!current?.agentId) break;
        const next = nextParticipant(agents, current.id);
        const cutoffSeq = room.messages.at(-1)?.seq ?? 0;
        const cursor = room.scheduler.cursorByParticipantId[current.id] ?? 0;
        const unseen = room.messages.filter((message) => message.seq > cursor && message.seq <= cutoffSeq && message.sender.id !== current.id);
        const targets = unseen.filter((message) => message.sender.role === "participant");
        if (!targets.length) {
          const cursors = { ...room.scheduler.cursorByParticipantId, [current.id]: cutoffSeq };
          this.repository.setScheduler(roomId, { next: next?.id ?? null, active: null, cursors, roundCount: room.scheduler.roundCount + 1 });
          idlePasses += 1;
          if (idlePasses >= agents.length) {
            const latest = this.repository.getRoom(roomId);
            if (!latest?.scheduler.rerunRequested) break;
            this.repository.setScheduler(roomId, { rerun: false }); idlePasses = 0;
          }
          continue;
        }
        idlePasses = 0;
        const agent = this.repository.getAgent(current.agentId); if (!agent) continue;
        const connected = this.repository.getSnapshot().rooms.filter((candidate) => candidate.participants.some((participant) => participant.agentId === agent.id && participant.enabled));
        const packet: SchedulerPacket = {
          type: targets[0]?.sender.id.startsWith("cron:") ? "cron_packet" : "scheduler_packet",
          room: { id: room.id, title: room.title }, targetMessageId: targets.at(-1)?.id ?? targets[0]!.id, cutoffSeq,
          sender: { id: targets.at(-1)?.sender.id ?? "unknown", name: targets.at(-1)?.sender.name ?? "未知" },
          messages: targets.map((message) => ({ id: message.id, seq: message.seq, content: message.content, source: message.source, kind: message.kind, attachments: message.attachments })),
          connectedRooms: connected.map(({ id, title }) => ({ id, title })),
          availableAgents: this.repository.getSnapshot().agents.map(({ id, label, summary }) => ({ id, label, summary })),
        };
        const turnId = createId("turn"); this.repository.beginTurn({ turnId, roomId, agentId: agent.id, agentParticipantId: current.id, packet });
        publishWorkspaceEvent("workspace.changed", turnId, { status: "running", roomId, agentId: agent.id });
        try {
          const result = await getAgentExecutor().run(agent.id, roomId, (signal) => runAgentModel({ repository: this.repository, agent, agentParticipantId: current.id, packet, turnId, signal }));
          const applied = this.repository.finishTurn({ turnId, assistantContent: result.assistantContent, sessionMessages: result.sessionMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq, nextParticipantId: next?.id ?? null });
          publishWorkspaceEvent("workspace.changed", turnId, { status: applied.superseded ? "continued" : "completed", emittedMessageIds: applied.emittedMessageIds });
        } catch (error) {
          const stopped = error instanceof DOMException && error.name === "AbortError";
          this.repository.failTurn(turnId, error instanceof Error ? error.message : String(error), stopped);
          publishWorkspaceEvent("workspace.changed", turnId, { status: stopped ? "stopped" : "error" });
          if (stopped) break;
        }
      }
    } finally {
      const rerun = this.repository.getRoom(roomId)?.scheduler.rerunRequested ?? false;
      this.repository.setScheduler(roomId, { status: "idle", active: null, rerun: false }); this.runningRooms.delete(roomId);
      publishWorkspaceEvent("scheduler.changed", roomId, { status: "idle" });
      if (!rerun || this.stoppedRooms.has(roomId)) completeCronRunsForRoom(roomId, this.stoppedRooms.has(roomId) ? "房间已停止" : undefined);
      if (!this.stoppedRooms.has(roomId) && rerun) this.enqueue(roomId);
    }
  }
}

const globalScheduler = globalThis as typeof globalThis & { __oceanKingRoomScheduler?: RoomScheduler };
export function getRoomScheduler(): RoomScheduler { globalScheduler.__oceanKingRoomScheduler ??= new RoomScheduler(); return globalScheduler.__oceanKingRoomScheduler; }
