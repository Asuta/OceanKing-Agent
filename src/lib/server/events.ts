import { EventEmitter } from "node:events";
import type { WorkspaceEvent } from "@/lib/domain/types";
import { getRepository } from "@/lib/server/repository";

const globalEvents = globalThis as typeof globalThis & {
  __oceanKingEmitter?: EventEmitter;
  __oceanKingEventHistory?: WorkspaceEvent[];
};

const emitter = globalEvents.__oceanKingEmitter ??= new EventEmitter();
emitter.setMaxListeners(100);
const history = globalEvents.__oceanKingEventHistory ??= [];

export function publishWorkspaceEvent(type: WorkspaceEvent["type"], entityId?: string, payload?: unknown): WorkspaceEvent {
  const { revision } = getRepository().getVersion();
  const event: WorkspaceEvent = { id: revision, type, revision, entityId, payload, createdAt: new Date().toISOString() };
  history.push(event);
  if (history.length > 500) history.splice(0, history.length - 500);
  emitter.emit("event", event);
  return event;
}

export function subscribeWorkspaceEvents(listener: (event: WorkspaceEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function eventsAfter(revision: number): WorkspaceEvent[] {
  return history.filter((event) => event.revision > revision);
}
