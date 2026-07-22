"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Archive, Bot, Check, Circle, MessageSquare, Pin, Plus } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";

type SendCommand = (draft: WorkspaceCommandDraft) => Promise<boolean>;
type RoomMenuState = { roomId: string; x: number; y: number };

const menuWidth = 168;
const menuHeight = 44;
const viewportMargin = 8;

export function RoomSidebar({ snapshot, activeRoomId, activeAgentId, onSelect, onSelectAgent, sendCommand, busy }: { snapshot: WorkspaceSnapshot; activeRoomId: string; activeAgentId: string | null; onSelect: (id: string) => void; onSelectAgent: (id: string) => void; sendCommand: SendCommand; busy: boolean }) {
  const [roomMenu, setRoomMenu] = useState<RoomMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeRooms = snapshot.rooms.filter((room) => room.kind === "shared" && !room.archivedAt);
  const archived = snapshot.rooms.filter((room) => room.kind === "shared" && room.archivedAt);
  const menuRoom = roomMenu ? activeRooms.find((room) => room.id === roomMenu.roomId) : null;

  useEffect(() => {
    if (!roomMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setRoomMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setRoomMenu(null);
    };
    const close = () => setRoomMenu(null);
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [roomMenu]);

  useEffect(() => {
    if (roomMenu) menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [roomMenu]);

  const openRoomMenu = (roomId: string, target: HTMLButtonElement, clientX?: number, clientY?: number) => {
    const bounds = target.getBoundingClientRect();
    const requestedX = clientX && clientX > 0 ? clientX : bounds.left + 24;
    const requestedY = clientY && clientY > 0 ? clientY : bounds.top + bounds.height / 2;
    setRoomMenu({
      roomId,
      x: Math.max(viewportMargin, Math.min(requestedX, window.innerWidth - menuWidth - viewportMargin)),
      y: Math.max(viewportMargin, Math.min(requestedY, window.innerHeight - menuHeight - viewportMargin)),
    });
  };

  const handleContextMenu = (event: MouseEvent<HTMLButtonElement>, roomId: string) => {
    event.preventDefault();
    openRoomMenu(roomId, event.currentTarget, event.clientX, event.clientY);
  };

  const handleRoomKeyDown = (event: KeyboardEvent<HTMLButtonElement>, roomId: string) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openRoomMenu(roomId, event.currentTarget);
  };

  const togglePinned = async () => {
    if (!menuRoom) return;
    const draft = { type: "set_room_pinned" as const, roomId: menuRoom.id, pinned: !menuRoom.pinnedAt };
    setRoomMenu(null);
    await sendCommand(draft);
  };

  return <div className="sidebar-content" onScroll={() => setRoomMenu(null)}>
    <div className="section-heading"><span>协作房间</span><button className="icon-button subtle" disabled={busy} onClick={() => void sendCommand({ type: "create_room", title: "新协作室", agentId: snapshot.agents[0]?.id })} aria-label="创建房间"><Plus size={16} /></button></div>
    <nav className="room-list" aria-label="房间列表">
      {activeRooms.map((room) => {
        const active = room.id === activeRoomId;
        const running = room.scheduler.status === "running";
        return <button
          key={room.id}
          className={active ? "active" : ""}
          aria-haspopup="menu"
          onClick={() => { setRoomMenu(null); onSelect(room.id); }}
          onContextMenu={(event) => handleContextMenu(event, room.id)}
          onKeyDown={(event) => handleRoomKeyDown(event, room.id)}
        >
          <span className={`room-glyph ${running ? "running" : ""}`}><MessageSquare size={15} /></span>
          <span className="room-copy"><strong>{room.title}</strong><small>{running ? "Agent 正在执行" : `${room.messages.length} 条公开消息`}</small></span>
          <span className="room-trailing">
            {room.pinnedAt ? <span className="room-pin" title="已置顶"><Pin size={12} aria-hidden="true" /></span> : null}
            {running ? <span className="live-dot" /> : null}
          </span>
        </button>;
      })}
    </nav>
    {archived.length ? <details className="archive-list"><summary><Archive size={14} />已归档 · {archived.length}</summary>{archived.map((room) => <button key={room.id} onClick={() => onSelect(room.id)}>{room.title}</button>)}</details> : null}
    <div className="section-heading agent-heading"><span>Agent</span><small>{snapshot.agents.length}</small></div>
    <div className="agent-roster">
      {snapshot.agents.map((agent, index) => {
        const active = snapshot.rooms.some((room) => room.scheduler.activeParticipantId && room.participants.some((participant) => participant.id === room.scheduler.activeParticipantId && participant.agentId === agent.id));
        return <button type="button" className={activeAgentId === agent.id ? "active" : ""} key={agent.id} onClick={() => onSelectAgent(agent.id)} aria-label={`与 ${agent.label} 单聊`}><span className={`agent-avatar tone-${index % 4}`}><Bot size={15} /></span><span><strong>{agent.label}</strong><small>{agent.summary}</small></span>{active ? <Circle className="agent-live" size={9} fill="currentColor" /> : <Check className="agent-ready" size={13} />}</button>;
      })}
    </div>
    {roomMenu && menuRoom ? <div ref={menuRef} className="room-context-menu" role="menu" aria-label={`${menuRoom.title} 房间菜单`} style={{ left: roomMenu.x, top: roomMenu.y }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => void togglePinned()}><Pin size={14} />{menuRoom.pinnedAt ? "取消置顶" : "置顶房间"}</button>
    </div> : null}
  </div>;
}
