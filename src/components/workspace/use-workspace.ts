"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { RoomMessagePreview, WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";

export function useWorkspace(initialSnapshot: WorkspaceSnapshot, initialEventCursor: number) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [roomPreviews, setRoomPreviews] = useState<Record<string, RoomMessagePreview>>({});
  const [agentHistoryCheckpoints, setAgentHistoryCheckpoints] = useState<Record<string, number>>({});
  const versionRef = useRef(initialSnapshot.version);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { versionRef.current = snapshot.version; }, [snapshot.version]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as WorkspaceSnapshot;
    const turns = new Map(next.rooms.flatMap((room) => room.turns).map((turn) => [turn.id, turn.status]));
    const committedKeys = new Set(next.rooms.flatMap((room) => room.messages.map((message) => message.messageKey).filter(Boolean)));
    startTransition(() => setSnapshot(next));
    setRoomPreviews((current) => Object.fromEntries(Object.entries(current).filter(([, preview]) => turns.get(preview.turnId) === "running" && !committedKeys.has(preview.messageKey))));
    setPreviews((current) => Object.fromEntries(Object.entries(current).filter(([turnId]) => turns.get(turnId) === "running")));
    setAgentHistoryCheckpoints((current) => Object.fromEntries(Object.entries(current).filter(([turnId]) => turns.has(turnId))));
  }, []);

  useEffect(() => {
    const events = new EventSource(`/api/events?afterId=${initialEventCursor}`);
    const onEvent = (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as { id?: number; type: string; entityId?: string; payload?: { kind?: string; delta?: string; roomId?: string; agentId?: string; messageKey?: string; content?: string; messageKind?: RoomMessagePreview["kind"]; status?: string } };
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "assistant_delta" && event.payload.delta) {
          setPreviews((current) => ({ ...current, [event.entityId!]: `${current[event.entityId!] ?? ""}${event.payload!.delta}` }));
        }
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "room_message_preview" && event.payload.roomId && event.payload.agentId && event.payload.messageKey && event.payload.content) {
          const preview: RoomMessagePreview = { turnId: event.entityId, roomId: event.payload.roomId, agentId: event.payload.agentId, messageKey: event.payload.messageKey, content: event.payload.content, kind: event.payload.messageKind ?? "answer" };
          setRoomPreviews((current) => ({ ...current, [event.entityId!]: preview }));
        }
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "history_checkpoint" && typeof event.id === "number") {
          setAgentHistoryCheckpoints((current) => current[event.entityId!] === event.id ? current : { ...current, [event.entityId!]: event.id! });
        }
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => { void refresh(); }, 80);
      } catch { /* ignore malformed event */ }
    };
    ["workspace.changed", "turn.preview", "scheduler.changed", "cron.changed"].forEach((name) => events.addEventListener(name, onEvent as EventListener));
    events.onerror = () => setError("实时连接正在重试，权威数据不会丢失");
    return () => { events.close(); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [initialEventCursor, refresh]);

  const sendCommand = useCallback(async (draft: WorkspaceCommandDraft) => {
    setBusy(true); setError(null);
    const post = async (version: number) => fetch("/api/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, commandId: crypto.randomUUID(), expectedVersion: version }) });
    try {
      let response = await post(versionRef.current);
      if (response.status === 409) {
        const conflict = await response.json() as { snapshot: WorkspaceSnapshot };
        setSnapshot(conflict.snapshot); versionRef.current = conflict.snapshot.version;
        response = await post(conflict.snapshot.version);
      }
      const body = await response.json() as { error?: string; snapshot?: WorkspaceSnapshot };
      if (!response.ok) throw new Error(body.error ?? "命令执行失败");
      if (body.snapshot) { setSnapshot(body.snapshot); versionRef.current = body.snapshot.version; }
      if (draft.type === "reset_workspace") { setPreviews({}); setRoomPreviews({}); setAgentHistoryCheckpoints({}); }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught)); return false;
    } finally { setBusy(false); }
  }, []);

  return { snapshot, busy, error, setError, previews, roomPreviews, agentHistoryCheckpoints, refresh, sendCommand };
}
