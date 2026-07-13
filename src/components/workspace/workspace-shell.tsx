"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, CalendarClock, Menu, Moon, PanelRightClose, PanelRightOpen, Settings, Sun, X } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import { AgentConversationPanel } from "@/components/workspace/agent-conversation-panel";
import { ConsolePanel } from "@/components/workspace/console-panel";
import { CronDrawer } from "@/components/workspace/cron-drawer";
import { RoomPanel } from "@/components/workspace/room-panel";
import { RoomSidebar } from "@/components/workspace/room-sidebar";
import { SettingsDialog } from "@/components/workspace/settings-dialog";
import { useWorkspace } from "@/components/workspace/use-workspace";

export function getAgentHistoryVersion(snapshot: WorkspaceSnapshot, agentId: string | null): string {
  if (!agentId) return "";
  const agentUpdatedAt = snapshot.agents.find((agent) => agent.id === agentId)?.updatedAt ?? "";
  let turnCount = 0;
  let latestTurnUpdatedAt = "";
  const roomTitles: Array<[string, string]> = [];
  for (const room of snapshot.rooms) {
    let hasAgentTurn = false;
    for (const turn of room.turns) {
      if (turn.agentId !== agentId) continue;
      hasAgentTurn = true;
      turnCount += 1;
      if (turn.updatedAt > latestTurnUpdatedAt) latestTurnUpdatedAt = turn.updatedAt;
    }
    if (hasAgentTurn) roomTitles.push([room.id, room.title]);
  }
  roomTitles.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([agentUpdatedAt, turnCount, latestTurnUpdatedAt, roomTitles]);
}

export function WorkspaceShell({ initialSnapshot }: { initialSnapshot: WorkspaceSnapshot }) {
  const workspace = useWorkspace(initialSnapshot);
  const [activeRoomId, setActiveRoomId] = useState(initialSnapshot.rooms.find((room) => !room.archivedAt)?.id ?? initialSnapshot.rooms[0]?.id ?? "");
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"room" | "console">("room");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const room = useMemo(() => workspace.snapshot.rooms.find((item) => item.id === activeRoomId) ?? workspace.snapshot.rooms[0], [activeRoomId, workspace.snapshot.rooms]);
  const activeAgentHistoryVersion = useMemo(() => getAgentHistoryVersion(workspace.snapshot, activeAgentId), [activeAgentId, workspace.snapshot]);

  useEffect(() => {
    const saved = localStorage.getItem("oceanking-theme"); const next = saved === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    queueMicrotask(() => setTheme(next));
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark"; setTheme(next); document.documentElement.dataset.theme = next; localStorage.setItem("oceanking-theme", next);
  };

  return (
    <main className={`workspace-shell ${consoleOpen ? "console-visible" : ""}`}>
      <aside className={`workspace-nav ${navOpen ? "nav-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><Bot size={19} /></div>
          <div><strong>OceanKing</strong><span>多 Agent 协作台</span></div>
          <button className="icon-button mobile-only" onClick={() => setNavOpen(false)} aria-label="关闭导航"><X size={18} /></button>
        </div>
        <RoomSidebar snapshot={workspace.snapshot} activeRoomId={room?.id ?? ""} activeAgentId={activeAgentId} onSelect={(id) => { setActiveRoomId(id); setActiveAgentId(null); setNavOpen(false); }} onSelectAgent={(id) => { setActiveAgentId(id); setConsoleOpen(true); setMobileView("console"); setNavOpen(false); }} sendCommand={workspace.sendCommand} busy={workspace.busy} />
        <div className="nav-footer">
          <button onClick={() => setCronOpen(true)}><CalendarClock size={17} /><span>定时任务</span><b>{workspace.snapshot.cronJobs.filter((job) => job.enabled).length}</b></button>
          <button onClick={() => setSettingsOpen(true)}><Settings size={17} /><span>工作台设置</span></button>
        </div>
      </aside>

      <section className={`room-stage ${mobileView !== "room" ? "mobile-hidden" : ""}`}>
        <div className="mobile-bar">
          <button className="icon-button" onClick={() => setNavOpen(true)} aria-label="打开导航"><Menu size={19} /></button>
          <strong>{room?.title ?? "OceanKing"}</strong>
          <button className="icon-button" onClick={() => setMobileView("console")} aria-label="打开 Console"><PanelRightOpen size={19} /></button>
        </div>
        {room ? <RoomPanel room={room} agents={workspace.snapshot.agents} previews={Object.values(workspace.roomPreviews)} busy={workspace.busy} sendCommand={workspace.sendCommand} onToggleConsole={() => setConsoleOpen((value) => !value)} consoleOpen={consoleOpen} /> : <div className="empty-stage">创建一个房间开始协作</div>}
      </section>

      {consoleOpen ? <aside className={`console-stage ${mobileView !== "console" ? "mobile-hidden" : ""}`}>
        <div className="console-global-actions">
          <button className="icon-button" onClick={toggleTheme} aria-label="切换主题">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
          <button className="icon-button desktop-only" onClick={() => setConsoleOpen(false)} aria-label="关闭 Console"><PanelRightClose size={17} /></button>
          <button className="icon-button mobile-only" onClick={() => setMobileView("room")} aria-label="返回房间"><X size={18} /></button>
        </div>
        {activeAgentId ? <AgentConversationPanel agentId={activeAgentId} historyVersion={activeAgentHistoryVersion} /> : <ConsolePanel room={room} previews={workspace.previews} />}
      </aside> : <button className="console-reopen desktop-only" onClick={() => setConsoleOpen(true)} aria-label="打开 Console"><PanelRightOpen size={18} /></button>}

      {workspace.error ? <div className="toast" role="status"><span>{workspace.error}</span><button onClick={() => workspace.setError(null)}><X size={15} /></button></div> : null}
      {settingsOpen ? <SettingsDialog snapshot={workspace.snapshot} busy={workspace.busy} sendCommand={workspace.sendCommand} onClose={() => setSettingsOpen(false)} /> : null}
      {cronOpen ? <CronDrawer snapshot={workspace.snapshot} roomId={room?.id ?? ""} busy={workspace.busy} sendCommand={workspace.sendCommand} onClose={() => setCronOpen(false)} /> : null}
      {navOpen ? <button className="nav-scrim mobile-only" aria-label="关闭导航遮罩" onClick={() => setNavOpen(false)} /> : null}
    </main>
  );
}
