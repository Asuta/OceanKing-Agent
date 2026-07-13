import { EventEmitter } from "node:events";
import type { WorkspaceEvent } from "@/lib/domain/types";
import { getRepository } from "@/lib/server/repository";

const globalEvents = globalThis as typeof globalThis & {
  __oceanKingEmitter?: EventEmitter;
  __oceanKingEventHistory?: WorkspaceEvent[];
  __oceanKingEventCursor?: number;
};

const emitter = globalEvents.__oceanKingEmitter ??= new EventEmitter();
emitter.setMaxListeners(100);
const history = globalEvents.__oceanKingEventHistory ??= [];

function nextEventId(): number {
  const timeCursor = Date.now() * 1_000;
  const next = Math.max((globalEvents.__oceanKingEventCursor ?? timeCursor) + 1, timeCursor);
  globalEvents.__oceanKingEventCursor = next;
  return next;
}

export function publishWorkspaceEvent(type: WorkspaceEvent["type"], entityId?: string, payload?: unknown, explicitRevision?: number): WorkspaceEvent {
  const revision = explicitRevision ?? getRepository().getVersion().revision;
  const event: WorkspaceEvent = { id: nextEventId(), type, revision, entityId, payload, createdAt: new Date().toISOString() };
  history.push(event);
  if (history.length > 500) history.splice(0, history.length - 500);
  emitter.emit("event", event);
  return event;
}

export function subscribeWorkspaceEvents(listener: (event: WorkspaceEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function eventsAfterRevision(revision: number): WorkspaceEvent[] {
  return history.filter((event) => event.revision > revision);
}

export function eventsAfterId(eventId: number): WorkspaceEvent[] {
  return history.filter((event) => event.id > eventId);
}

export function resetWorkspaceEventHistory(): void {
  history.length = 0;
}
