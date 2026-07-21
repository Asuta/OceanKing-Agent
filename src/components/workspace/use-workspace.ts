"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { RoomMessagePreview, WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";
import {
  appendAssistantPreview,
  appendReasoningPreview,
  completeReasoningPreview,
  markReasoningAnswerStarted,
  type ReasoningPreview,
} from "@/components/workspace/live-assistant-preview";

function persistedAssistantContent(snapshot: WorkspaceSnapshot, turnId: string): string {
  return snapshot.rooms.flatMap((room) => room.turns).find((turn) => turn.id === turnId)?.assistantContent ?? "";
}

export function useWorkspace(initialSnapshot: WorkspaceSnapshot, initialEventCursor: number) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [reasoningPreviews, setReasoningPreviews] = useState<Record<string, ReasoningPreview>>({});
  const [roomPreviews, setRoomPreviews] = useState<Record<string, RoomMessagePreview>>({});
  const [agentHistoryCheckpoints, setAgentHistoryCheckpoints] = useState<Record<string, number>>({});
  const versionRef = useRef(initialSnapshot.version);
  const snapshotRef = useRef(initialSnapshot);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { snapshotRef.current = snapshot; versionRef.current = snapshot.version; }, [snapshot]);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json() as WorkspaceSnapshot;
    const turns = new Map(next.rooms.flatMap((room) => room.turns).map((turn) => [turn.id, turn.status]));
    const committedKeys = new Set(next.rooms.flatMap((room) => room.messages.map((message) => message.messageKey).filter(Boolean)));
    snapshotRef.current = next;
    startTransition(() => setSnapshot(next));
    setRoomPreviews((current) => Object.fromEntries(Object.entries(current).filter(([, preview]) => turns.get(preview.turnId) === "running" && !committedKeys.has(preview.messageKey))));
    setPreviews((current) => Object.fromEntries(Object.entries(current).filter(([turnId]) => turns.get(turnId) === "running")));
    setReasoningPreviews((current) => Object.fromEntries(Object.entries(current).filter(([turnId]) => turns.get(turnId) === "running")));
    setAgentHistoryCheckpoints((current) => Object.fromEntries(Object.entries(current).filter(([turnId]) => turns.has(turnId))));
  }, []);

  useEffect(() => {
    const events = new EventSource(`/api/events?afterId=${initialEventCursor}`);
    const onEvent = (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as { id?: number; type: string; entityId?: string; payload?: { kind?: string; step?: number; delta?: string; roomId?: string; agentId?: string; messageKey?: string; content?: string; messageKind?: RoomMessagePreview["kind"]; status?: string } };
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "reasoning_delta" && Number.isInteger(event.payload.step) && event.payload.step! >= 0 && event.payload.delta) {
          const turnId = event.entityId;
          const step = event.payload.step!;
          const delta = event.payload.delta;
          setReasoningPreviews((current) => ({ ...current, [turnId]: appendReasoningPreview(current[turnId], step, delta) }));
        }
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "assistant_delta" && event.payload.delta) {
          const turnId = event.entityId;
          const delta = event.payload.delta;
          const persisted = persistedAssistantContent(snapshotRef.current, turnId);
          setPreviews((current) => ({
            ...current,
            [turnId]: appendAssistantPreview(current[turnId], persisted, delta),
          }));
          setReasoningPreviews((current) => {
            const previous = current[turnId];
            const next = markReasoningAnswerStarted(previous);
            return next !== previous ? { ...current, [turnId]: next } : current;
          });
        }
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "room_message_preview" && event.payload.roomId && event.payload.agentId && event.payload.messageKey && (event.payload.delta || event.payload.content !== undefined)) {
          const key = `${event.entityId}:${event.payload.messageKey}`;
          setRoomPreviews((current) => {
            const existing = current[key];
            const content = event.payload!.content ?? `${existing?.content ?? ""}${event.payload!.delta ?? ""}`;
            const preview: RoomMessagePreview = { turnId: event.entityId!, roomId: event.payload!.roomId!, agentId: event.payload!.agentId!, messageKey: event.payload!.messageKey!, content, kind: event.payload!.messageKind ?? "notify" };
            return { ...current, [key]: preview };
          });
          setReasoningPreviews((current) => {
            const previous = current[event.entityId!];
            const next = markReasoningAnswerStarted(previous);
            return next !== previous ? { ...current, [event.entityId!]: next } : current;
          });
        }
        if (event.type === "turn.preview" && event.entityId && event.payload?.kind === "history_checkpoint" && typeof event.id === "number") {
          setReasoningPreviews((current) => {
            const previous = current[event.entityId!];
            const next = completeReasoningPreview(previous);
            return next && next !== previous ? { ...current, [event.entityId!]: next } : current;
          });
          setAgentHistoryCheckpoints((current) => current[event.entityId!] === event.id ? current : { ...current, [event.entityId!]: event.id! });
        }
        const highFrequencyPreview = event.type === "turn.preview" && (event.payload?.kind === "assistant_delta" || event.payload?.kind === "reasoning_delta" || event.payload?.kind === "room_message_preview");
        if (!highFrequencyPreview) {
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => { void refresh(); }, 80);
        }
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
        setSnapshot(conflict.snapshot); snapshotRef.current = conflict.snapshot; versionRef.current = conflict.snapshot.version;
        response = await post(conflict.snapshot.version);
      }
      const body = await response.json() as { error?: string; snapshot?: WorkspaceSnapshot };
      if (!response.ok) throw new Error(body.error ?? "命令执行失败");
      if (body.snapshot) { setSnapshot(body.snapshot); snapshotRef.current = body.snapshot; versionRef.current = body.snapshot.version; }
      if (draft.type === "reset_workspace") { setPreviews({}); setReasoningPreviews({}); setRoomPreviews({}); setAgentHistoryCheckpoints({}); }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught)); return false;
    } finally { setBusy(false); }
  }, []);

  return { snapshot, busy, error, setError, previews, reasoningPreviews, roomPreviews, agentHistoryCheckpoints, refresh, sendCommand };
}
