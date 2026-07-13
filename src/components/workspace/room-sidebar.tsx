"use client";

import { Archive, Bot, Check, Circle, MessageSquare, Plus } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";

type SendCommand = (draft: WorkspaceCommandDraft) => Promise<boolean>;

export function RoomSidebar({ snapshot, activeRoomId, activeAgentId, onSelect, onSelectAgent, sendCommand, busy }: { snapshot: WorkspaceSnapshot; activeRoomId: string; activeAgentId: string | null; onSelect: (id: string) => void; onSelectAgent: (id: string) => void; sendCommand: SendCommand; busy: boolean }) {
  const activeRooms = snapshot.rooms.filter((room) => !room.archivedAt);
  const archived = snapshot.rooms.filter((room) => room.archivedAt);
  return <div className="sidebar-content">
    <div className="section-heading"><span>协作房间</span><button className="icon-button subtle" disabled={busy} onClick={() => void sendCommand({ type: "create_room", title: "新协作室", agentId: snapshot.agents[0]?.id })} aria-label="创建房间"><Plus size={16} /></button></div>
    <nav className="room-list" aria-label="房间列表">
      {activeRooms.map((room) => {
        const active = room.id === activeRoomId; const running = room.scheduler.status === "running";
        return <button key={room.id} className={active ? "active" : ""} onClick={() => onSelect(room.id)}>
          <span className={`room-glyph ${running ? "running" : ""}`}><MessageSquare size={15} /></span>
          <span className="room-copy"><strong>{room.title}</strong><small>{running ? "Agent 正在执行" : `${room.messages.length} 条公开消息`}</small></span>
          {running ? <span className="live-dot" /> : null}
        </button>;
      })}
    </nav>
    {archived.length ? <details className="archive-list"><summary><Archive size={14} />已归档 · {archived.length}</summary>{archived.map((room) => <button key={room.id} onClick={() => onSelect(room.id)}>{room.title}</button>)}</details> : null}
    <div className="section-heading agent-heading"><span>Agent</span><small>{snapshot.agents.length}</small></div>
    <div className="agent-roster">
      {snapshot.agents.map((agent, index) => {
        const active = snapshot.rooms.some((room) => room.scheduler.activeParticipantId && room.participants.some((participant) => participant.id === room.scheduler.activeParticipantId && participant.agentId === agent.id));
        return <button type="button" className={activeAgentId === agent.id ? "active" : ""} key={agent.id} onClick={() => onSelectAgent(agent.id)} aria-label={`查看 ${agent.label} 的底层对话`}><span className={`agent-avatar tone-${index % 4}`}><Bot size={15} /></span><span><strong>{agent.label}</strong><small>{agent.summary}</small></span>{active ? <Circle className="agent-live" size={9} fill="currentColor" /> : <Check className="agent-ready" size={13} />}</button>;
      })}
    </div>
  </div>;
}
