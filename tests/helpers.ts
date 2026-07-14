import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "@/lib/server/db/client";
import { WorkspaceRepository } from "@/lib/server/repository";
import type { SchedulerPacket } from "@/lib/domain/types";

export async function withRepository(run: (repository: WorkspaceRepository) => Promise<void> | void) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oceanking-test-"));
  const handle = createDatabase(dir); const repository = new WorkspaceRepository(handle);
  try { await run(repository); }
  finally { handle.raw.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

export function commandBase(repository: WorkspaceRepository) {
  return { commandId: crypto.randomUUID(), expectedVersion: repository.getVersion().version };
}

export function sendUser(repository: WorkspaceRepository, roomId: string, content: string) {
  return repository.executeCommand({ ...commandBase(repository), type: "send_message", roomId, content, attachmentIds: [] });
}

export function packetFor(repository: WorkspaceRepository, roomId = "room_harbor"): SchedulerPacket {
  const snapshot = repository.getSnapshot(); const room = snapshot.rooms.find((entry) => entry.id === roomId)!; const target = room.messages.at(-1)!;
  return {
    type: "scheduler_packet", room: { id: room.id, title: room.title }, targetMessageId: target.id, cutoffSeq: target.seq,
    sender: { id: target.sender.id, name: target.sender.name },
    messages: [{ id: target.id, seq: target.seq, sender: { id: target.sender.id, name: target.sender.name }, content: target.content, source: target.source, kind: target.kind, attachments: target.attachments }],
    connectedRooms: snapshot.rooms.filter((entry) => entry.participants.some((participant) => participant.agentId === "navigator")).map(({ id, title }) => ({ id, title })),
    availableAgents: snapshot.agents.map(({ id, label, summary }) => ({ id, label, summary })),
  };
}
