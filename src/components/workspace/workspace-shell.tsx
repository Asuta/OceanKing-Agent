"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, Menu, Moon, PanelRightClose, PanelRightOpen, Settings, Sun, X } from "lucide-react";
import type { Agent, Room, WorkspaceSnapshot } from "@/lib/domain/types";
import { AgentConversationPanel } from "@/components/workspace/agent-conversation-panel";
import { ConsolePanel } from "@/components/workspace/console-panel";
import { CronDrawer } from "@/components/workspace/cron-drawer";
import { RoomPanel } from "@/components/workspace/room-panel";
import { RoomSidebar } from "@/components/workspace/room-sidebar";
import { SettingsDialog } from "@/components/workspace/settings-dialog";
import { readDocumentTheme, themeStorageKey, type Theme } from "@/lib/theme";
import { useWorkspace } from "@/components/workspace/use-workspace";

export function getAgentHistoryVersion(snapshot: WorkspaceSnapshot, agentId: string | null, checkpoints: Record<string, number> = {}): string {
  if (!agentId) return "";
  const agentUpdatedAt = snapshot.agents.find((agent) => agent.id === agentId)?.updatedAt ?? "";
  let turnCount = 0;
  let latestTurnUpdatedAt = "";
  let latestCheckpoint = 0;
  const roomTitles: Array<[string, string]> = [];
  for (const room of snapshot.rooms) {
    let hasAgentTurn = false;
    for (const turn of room.turns) {
      if (turn.agentId !== agentId) continue;
      hasAgentTurn = true;
      turnCount += 1;
      if (turn.updatedAt > latestTurnUpdatedAt) latestTurnUpdatedAt = turn.updatedAt;
      latestCheckpoint = Math.max(latestCheckpoint, checkpoints[turn.id] ?? 0);
    }
    if (hasAgentTurn) roomTitles.push([room.id, room.title]);
  }
  roomTitles.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([agentUpdatedAt, turnCount, latestTurnUpdatedAt, latestCheckpoint, roomTitles]);
}

export function directRoomPlaceholder(agent: Agent): Room {
  const roomId = `direct_preview_${agent.id}`;
  const humanParticipantId = `${roomId}_human`;
  const agentParticipantId = `${roomId}_agent`;
  return {
    id: roomId,
    title: `${agent.label} · 单聊`,
    kind: "direct",
    directAgentId: agent.id,
    ownerParticipantId: humanParticipantId,
    participants: [
      { id: humanParticipantId, roomId, kind: "human", agentId: null, displayName: "你", enabled: true, sortOrder: 0, createdAt: agent.createdAt },
      { id: agentParticipantId, roomId, kind: "agent", agentId: agent.id, displayName: agent.label, enabled: true, sortOrder: 1, createdAt: agent.createdAt },
    ],
    messages: [],
    turns: [],
    scheduler: {
      roomId,
      status: "idle",
      nextAgentParticipantId: agentParticipantId,
      activeParticipantId: null,
      roundCount: 0,
      cursorByParticipantId: { [agentParticipantId]: 0 },
      receiptRevisionByParticipantId: { [agentParticipantId]: 0 },
      rerunRequested: false,
    },
    archivedAt: null,
    pinnedAt: null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

export function WorkspaceShell({ initialSnapshot, initialEventCursor }: { initialSnapshot: WorkspaceSnapshot; initialEventCursor: number }) {
  const workspace = useWorkspace(initialSnapshot, initialEventCursor);
  const [activeRoomId, setActiveRoomId] = useState(initialSnapshot.rooms.find((room) => room.kind === "shared" && !room.archivedAt)?.id ?? initialSnapshot.rooms.find((room) => room.kind === "shared")?.id ?? "");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"room" | "console">("room");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const room = useMemo(() => workspace.snapshot.rooms.find((item) => item.kind === "shared" && item.id === activeRoomId) ?? workspace.snapshot.rooms.find((item) => item.kind === "shared" && !item.archivedAt) ?? workspace.snapshot.rooms.find((item) => item.kind === "shared"), [activeRoomId, workspace.snapshot.rooms]);
  const activeAgent = useMemo(() => workspace.snapshot.agents.find((agent) => agent.id === activeAgentId), [activeAgentId, workspace.snapshot.agents]);
  const persistedDirectRoom = useMemo(() => activeAgent ? workspace.snapshot.rooms.find((item) => item.kind === "direct" && item.directAgentId === activeAgent.id) : undefined, [activeAgent, workspace.snapshot.rooms]);
  const directRoom = useMemo(() => {
    if (!activeAgent) return undefined;
    return persistedDirectRoom ?? directRoomPlaceholder(activeAgent);
  }, [activeAgent, persistedDirectRoom]);
  const displayedRoom = directRoom ?? room;
  const cronRoomId = activeAgent ? persistedDirectRoom?.id ?? "" : room?.id ?? "";
  const cronUnavailableReason = activeAgent && !persistedDirectRoom ? "请先发送第一条单聊消息，创建单聊房间后即可配置定时任务。" : undefined;
  const activeAgentHistoryVersion = useMemo(() => getAgentHistoryVersion(workspace.snapshot, activeAgentId, workspace.agentHistoryCheckpoints), [activeAgentId, workspace.agentHistoryCheckpoints, workspace.snapshot]);

  useEffect(() => {
    queueMicrotask(() => setTheme(readDocumentTheme()));
  }, []);

  const toggleTheme = () => {
    const next = readDocumentTheme() === "dark" ? "light" : "dark"; setTheme(next); document.documentElement.dataset.theme = next; localStorage.setItem(themeStorageKey, next);
  };

  return (
    <main className={`workspace-shell ${consoleOpen ? "console-visible" : ""}`}>
      <aside className={`workspace-nav ${navOpen ? "nav-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><Bot size={19} /></div>
          <div><strong>OceanKing</strong><span>多 Agent 协作台</span></div>
          <button className="icon-button mobile-only" onClick={() => setNavOpen(false)} aria-label="关闭导航"><X size={18} /></button>
        </div>
        <RoomSidebar snapshot={workspace.snapshot} activeRoomId={room?.id ?? ""} activeAgentId={activeAgentId} onSelect={(id) => { setActiveRoomId(id); setActiveAgentId(null); setMobileView("room"); setNavOpen(false); }} onSelectAgent={(id) => { setActiveAgentId(id); setConsoleOpen(true); setMobileView("room"); setNavOpen(false); }} sendCommand={workspace.sendCommand} busy={workspace.busy} />
        <div className="nav-footer">
          <button onClick={() => setCronOpen(true)}><CalendarClock size={17} /><span>定时任务</span><b>{workspace.snapshot.cronJobs.filter((job) => job.enabled).length}</b></button>
          <button onClick={() => setSettingsOpen(true)}><Settings size={17} /><span>工作台设置</span></button>
        </div>
      </aside>

      <section className={`room-stage ${mobileView !== "room" ? "mobile-hidden" : ""}`}>
        <div className="mobile-bar">
          <button className="icon-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
          <strong>{displayedRoom?.title ?? "OceanKing"}</strong>
          <button className="icon-button" onClick={() => setMobileView("console")} aria-label="打开 Console"><PanelRightOpen size={19} /></button>
        </div>
        {displayedRoom ? <RoomPanel key={`${displayedRoom.id}:${activeAgent?.id ?? "shared"}`} room={displayedRoom} directAgent={activeAgent} agents={workspace.snapshot.agents} previews={Object.values(workspace.roomPreviews)} assistantPreviews={workspace.previews} reasoningPreviews={workspace.reasoningPreviews} busy={workspace.busy} sendCommand={workspace.sendCommand} onToggleConsole={() => setConsoleOpen((value) => !value)} consoleOpen={consoleOpen} /> : <div className="empty-stage">创建一个房间开始协作</div>}
      </section>

      {consoleOpen ? <aside className={`console-stage ${mobileView !== "console" ? "mobile-hidden" : ""}`}>
        <div className="console-global-actions">
          <button className="icon-button" onClick={toggleTheme} aria-label="切换主题">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button className="icon-button desktop-only" onClick={() => setConsoleOpen(false)} aria-label="关闭 Console"><PanelRightClose size={17} /></button>
          <button className="icon-button mobile-only" onClick={() => setMobileView("room")} aria-label="返回房间"><X size={18} /></button>
        </div>
        {activeAgentId ? <AgentConversationPanel agentId={activeAgentId} historyVersion={activeAgentHistoryVersion} previews={workspace.previews} /> : <ConsolePanel room={room} previews={workspace.previews} />}
      </aside> : <button className="console-reopen desktop-only" onClick={() => setConsoleOpen(true)} aria-label="打开 Console"><PanelRightOpen size={18} /></button>}

      {workspace.error ? <div className="toast" role="status"><span>{workspace.error}</span><button onClick={() => workspace.setError(null)}><X size={15} /></button></div> : null}
      {settingsOpen ? <SettingsDialog snapshot={workspace.snapshot} busy={workspace.busy} sendCommand={workspace.sendCommand} onReset={() => { setActiveRoomId("room_harbor"); setActiveAgentId(null); setMobileView("room"); }} onClose={() => setSettingsOpen(false)} /> : null}
      {cronOpen ? <CronDrawer snapshot={workspace.snapshot} roomId={cronRoomId} allowedAgentIds={activeAgent ? [activeAgent.id] : undefined} unavailableReason={cronUnavailableReason} busy={workspace.busy} sendCommand={workspace.sendCommand} onClose={() => setCronOpen(false)} /> : null}
      {navOpen ? <button className="nav-scrim mobile-only" aria-label="关闭导航遮罩" onClick={() => setNavOpen(false)} /> : null}
    </main>
  );
}
