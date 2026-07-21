import type { Participant, Room, SchedulerPacket } from "@/lib/domain/types";
import { AgentExecutor, AgentRunSupersededError, getAgentExecutor } from "@/lib/server/agent-executor";
import { completeCronRunsForRoom } from "@/lib/server/cron-run-tracker";
import { publishWorkspaceEvent } from "@/lib/server/events";
import { ModelRunError, runAgentModel } from "@/lib/server/model-runtime";
import { getRepository, WorkspaceRepository } from "@/lib/server/repository";
import { createId } from "@/lib/utils/id";

const maxTransientFailureRetries = 2;

function enabledAgents(room: Room): Participant[] {
  return room.participants.filter((participant) => participant.kind === "agent" && participant.enabled && participant.agentId).toSorted((a, b) => a.sortOrder - b.sortOrder);
}

function nextParticipant(agents: Participant[], currentId: string): Participant | null {
  if (!agents.length) return null; const index = agents.findIndex((agent) => agent.id === currentId);
  return agents[(index < 0 ? 0 : index + 1) % agents.length] ?? agents[0] ?? null;
}

export class RoomScheduler {
  private runningRooms = new Set<string>();
  private stoppedRooms = new Set<string>();
  private pendingMessageInterrupts = new Map<string, Map<string, number>>();
  private repository: WorkspaceRepository;
  private executor: AgentExecutor;

  constructor(repository = getRepository(), executor = getAgentExecutor()) {
    this.repository = repository;
    this.executor = executor;
  }

  enqueue(roomId: string, options: { interruptActive?: boolean } = {}): void {
    this.stoppedRooms.delete(roomId); this.executor.allowRoom(roomId);
    if (options.interruptActive) {
      const room = this.repository.getRoom(roomId);
      const agentIds = room?.participants
        .filter((participant) => participant.kind === "agent" && participant.enabled && participant.agentId)
        .map((participant) => participant.agentId!) ?? [];
      const messageSeq = room?.messages.findLast((message) => message.source === "user" || message.source === "agent_emit")?.seq;
      if (messageSeq !== undefined) {
        const pending = this.pendingMessageInterrupts.get(roomId) ?? new Map<string, number>();
        for (const agentId of agentIds) pending.set(agentId, Math.max(pending.get(agentId) ?? 0, messageSeq));
        this.pendingMessageInterrupts.set(roomId, pending);
      }
      this.executor.interruptAgentsForNewMessage(roomId, agentIds);
    }
    if (this.runningRooms.has(roomId)) {
      this.repository.setScheduler(roomId, { rerun: true });
      publishWorkspaceEvent("scheduler.changed", roomId, { rerunRequested: true, interrupted: options.interruptActive ?? false }, this.repository.getVersion().revision);
      return;
    }
    this.repository.setScheduler(roomId, { status: "running", rerun: false });
    this.runningRooms.add(roomId);
    setTimeout(() => { void this.drain(roomId); }, 0);
  }

  stop(roomId: string): void {
    this.stoppedRooms.add(roomId); this.executor.stopRoom(roomId); this.repository.stopRoomState(roomId);
    this.pendingMessageInterrupts.delete(roomId);
    for (const cancellation of this.repository.cancelContinuationHandoffsForSourceRoom(roomId)) {
      if (this.stoppedRooms.has(cancellation.targetRoomId)) continue;
      this.executor.interruptAgentsForNewMessage(cancellation.targetRoomId, [cancellation.agentId]);
      this.enqueue(cancellation.targetRoomId);
    }
    for (const fallbackRoomId of this.repository.releaseContinuationHandoffsForTargetRoom(roomId)) {
      if (fallbackRoomId !== roomId && !this.stoppedRooms.has(fallbackRoomId)) this.enqueue(fallbackRoomId);
    }
    completeCronRunsForRoom(roomId, "房间已停止", this.repository);
    publishWorkspaceEvent("scheduler.changed", roomId, { status: "idle", stopped: true }, this.repository.getVersion().revision);
  }

  private consumeMessageInterrupt(roomId: string, agentId: string, messages: SchedulerPacket["messages"]): boolean {
    const pending = this.pendingMessageInterrupts.get(roomId);
    const messageSeq = pending?.get(agentId);
    if (messageSeq === undefined || !messages.some((message) => (message.source === "user" || message.source === "agent_emit") && message.seq >= messageSeq)) return false;
    pending!.delete(agentId);
    if (!pending!.size) this.pendingMessageInterrupts.delete(roomId);
    return true;
  }

  async stopRoomsAndWait(roomIds: string[], timeoutMs = 15_000): Promise<void> {
    const targets = [...new Set(roomIds)];
    for (const roomId of targets) this.stop(roomId);
    const deadline = Date.now() + timeoutMs;
    while (targets.some((roomId) => this.runningRooms.has(roomId))) {
      if (Date.now() >= deadline) throw new Error("等待活动 Agent 停止超时，工作台尚未重置");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  private async drain(roomId: string): Promise<void> {
    let idlePasses = 0;
    let roundsConsumed = 0;
    let transientFailureRetries = 0;
    const maxRounds = this.repository.getSnapshot().settings.maxRoomRounds;
    try {
      publishWorkspaceEvent("scheduler.changed", roomId, { status: "running" }, this.repository.getVersion().revision);
      for (let round = 0; round < maxRounds && !this.stoppedRooms.has(roomId); round += 1) {
        roundsConsumed = round + 1;
        const room = this.repository.getRoom(roomId);
        if (!room || room.archivedAt) {
          this.pendingMessageInterrupts.delete(roomId);
          for (const fallbackRoomId of this.repository.releaseContinuationHandoffsForTargetRoom(roomId)) {
            if (fallbackRoomId !== roomId && !this.stoppedRooms.has(fallbackRoomId)) this.enqueue(fallbackRoomId);
          }
          break;
        }
        const agents = enabledAgents(room);
        if (!agents.length) {
          this.pendingMessageInterrupts.delete(roomId);
          for (const fallbackRoomId of this.repository.releaseContinuationHandoffsForTargetRoom(roomId)) {
            if (fallbackRoomId !== roomId && !this.stoppedRooms.has(fallbackRoomId)) this.enqueue(fallbackRoomId);
          }
          break;
        }
        const current = agents.find((agent) => agent.id === room.scheduler.nextAgentParticipantId) ?? agents[0];
        if (!current?.agentId) break;
        const next = nextParticipant(agents, current.id);
        const cutoffSeq = room.messages.at(-1)?.seq ?? 0;
        const cursor = room.scheduler.cursorByParticipantId[current.id] ?? 0;
        const unseen = room.messages.filter((message) => message.seq > cursor && message.seq <= cutoffSeq && message.sender.id !== current.id);
        const targets = unseen.filter((message) => message.sender.role === "participant");
        const pendingDelivery = this.repository.getPendingDeliveryObligations(roomId, current.agentId);
        const handedOffCutoff = this.repository.getPendingHandoffCutoff(roomId, current.id);
        const handedOffWithoutNewUser = handedOffCutoff !== null
          && !targets.some((message) => message.source === "user" && message.seq > handedOffCutoff);
        const hasNewTaskTarget = targets.some((message) => message.source === "user" || message.source === "system");
        const deliveryRetry = pendingDelivery.length > 0 && (handedOffWithoutNewUser || !hasNewTaskTarget);
        if (handedOffWithoutNewUser && !deliveryRetry) {
          this.repository.setScheduler(roomId, { next: next?.id ?? null, active: null, roundCount: room.scheduler.roundCount + 1 });
          idlePasses += 1;
          if (idlePasses >= agents.length) break;
          continue;
        }
        if (!targets.length && !deliveryRetry) {
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
          type: deliveryRetry ? "delivery_packet" : targets[0]?.sender.id.startsWith("cron:") ? "cron_packet" : "scheduler_packet",
          room: { id: room.id, title: room.title }, targetMessageId: deliveryRetry ? pendingDelivery.at(-1)!.messageId : targets.at(-1)?.id ?? targets[0]!.id, cutoffSeq,
          sender: deliveryRetry
            ? { id: "scheduler:delivery", name: "结果投递恢复器" }
            : { id: targets.at(-1)?.sender.id ?? "unknown", name: targets.at(-1)?.sender.name ?? "未知" },
          messages: deliveryRetry ? [] : targets.map((message) => ({ id: message.id, seq: message.seq, sender: { id: message.sender.id, name: message.sender.name }, content: message.content, source: message.source, kind: message.kind, attachments: message.attachments })),
          connectedRooms: connected.map(({ id, title }) => ({ id, title })),
          availableAgents: this.repository.getSnapshot().agents.map(({ id, label, summary }) => ({ id, label, summary })),
        };
        const supersedeActive = this.consumeMessageInterrupt(roomId, agent.id, packet.messages);
        const turnId = createId("turn"); this.repository.beginTurn({ turnId, roomId, agentId: agent.id, agentParticipantId: current.id, packet });
        publishWorkspaceEvent("workspace.changed", turnId, { status: "running", roomId, agentId: agent.id }, this.repository.getVersion().revision);
        try {
          const applied = await this.executor.run(
            agent.id,
            roomId,
            async (signal) => {
              const result = await runAgentModel({ repository: this.repository, agent, agentParticipantId: current.id, packet, turnId, signal });
              return this.repository.finishTurn({ turnId, assistantContent: result.assistantContent, systemPrompt: result.systemPrompt, sessionMessages: result.sessionMessages, auditMessages: result.auditMessages, tools: result.tools, timeline: result.timeline, effects: result.effects, modelMeta: result.modelMeta, contextCompaction: result.contextCompaction, cutoffSeq, nextParticipantId: next?.id ?? null });
            },
            {
              supersedeActive,
              onSuperseded: (interruption) => {
                const modelError = interruption.originalError instanceof ModelRunError ? interruption.originalError : null;
                this.repository.continueInterruptedTurn(turnId, interruption.message, interruption.nextRoomId, modelError?.modelMeta);
                if (this.stoppedRooms.has(interruption.nextRoomId)) {
                  for (const fallbackRoomId of this.repository.releaseContinuationHandoffsForTargetRoom(interruption.nextRoomId)) {
                    if (fallbackRoomId !== interruption.nextRoomId && !this.stoppedRooms.has(fallbackRoomId)) this.enqueue(fallbackRoomId);
                  }
                }
              },
            },
          );
          const messageRoomIds = new Set(applied.messageRoomIds);
          for (const targetRoomId of new Set([...applied.triggerRoomIds, ...applied.continuationRoomIds])) {
            if (targetRoomId !== roomId && !this.stoppedRooms.has(targetRoomId)) this.enqueue(targetRoomId, { interruptActive: messageRoomIds.has(targetRoomId) });
          }
          transientFailureRetries = 0;
          publishWorkspaceEvent("workspace.changed", turnId, { status: applied.superseded || applied.unresolvedRoomIds.length ? "continued" : "completed", emittedMessageIds: applied.emittedMessageIds, triggerRoomIds: applied.triggerRoomIds, messageRoomIds: applied.messageRoomIds, continuationRoomIds: applied.continuationRoomIds, unresolvedRoomIds: applied.unresolvedRoomIds }, this.repository.getVersion().revision);
        } catch (error) {
          if (error instanceof AgentRunSupersededError) {
            publishWorkspaceEvent("workspace.changed", turnId, { status: "continued", interruptedByRoomId: error.nextRoomId }, this.repository.getVersion().revision);
            break;
          }
          const originalError = error instanceof ModelRunError ? error.originalError : error;
          const stopped = originalError instanceof DOMException && originalError.name === "AbortError";
          const retryable = error instanceof ModelRunError && error.retryable;
          if (retryable) transientFailureRetries += 1;
          const retriesExhausted = retryable && transientFailureRetries > maxTransientFailureRetries;
          const terminalFailure = !stopped && (!retryable || retriesExhausted);
          this.repository.failTurn(
            turnId,
            originalError instanceof Error ? originalError.message : String(originalError),
            stopped,
            error instanceof ModelRunError ? error.modelMeta : undefined,
            terminalFailure,
          );
          if (stopped || terminalFailure || round + 1 >= maxRounds) {
            for (const fallbackRoomId of this.repository.releaseContinuationHandoffs(turnId)) {
              if (fallbackRoomId !== roomId && !this.stoppedRooms.has(fallbackRoomId)) this.enqueue(fallbackRoomId);
            }
          }
          publishWorkspaceEvent("workspace.changed", turnId, { status: stopped ? "stopped" : "error" }, this.repository.getVersion().revision);
          if (stopped || terminalFailure) break;
          await new Promise((resolve) => setTimeout(resolve, 100 * transientFailureRetries));
        }
      }
    } finally {
      const finalRoom = this.repository.getRoom(roomId);
      const rerun = finalRoom?.scheduler.rerunRequested ?? false;
      const deliveryFailure = "结果投递在房间最大轮次内仍未完成";
      const failedSourceRoomIds = roundsConsumed >= maxRounds && !rerun && !this.stoppedRooms.has(roomId)
        ? this.repository.failPendingDeliveryObligations(roomId, deliveryFailure)
        : [];
      const pendingContinuation = this.repository.hasPendingContinuationHandoffs(roomId);
      if (finalRoom) this.repository.setScheduler(roomId, { status: "idle", active: null, rerun: false });
      this.runningRooms.delete(roomId);
      publishWorkspaceEvent("scheduler.changed", roomId, { status: "idle" }, this.repository.getVersion().revision);
      for (const sourceRoomId of failedSourceRoomIds) completeCronRunsForRoom(sourceRoomId, deliveryFailure, this.repository);
      if ((!rerun && !pendingContinuation && !failedSourceRoomIds.includes(roomId)) || this.stoppedRooms.has(roomId)) completeCronRunsForRoom(roomId, this.stoppedRooms.has(roomId) ? "房间已停止" : undefined, this.repository);
      if (!this.stoppedRooms.has(roomId) && rerun) this.enqueue(roomId);
    }
  }
}

const globalScheduler = globalThis as typeof globalThis & { __oceanKingRoomScheduler?: RoomScheduler };
export function getRoomScheduler(): RoomScheduler { globalScheduler.__oceanKingRoomScheduler ??= new RoomScheduler(); return globalScheduler.__oceanKingRoomScheduler; }
