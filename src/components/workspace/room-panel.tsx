"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, Bot, Check, ChevronDown, FileText, LoaderCircle, Paperclip, PanelRightOpen, Pencil, Send, Square, UserPlus, X } from "lucide-react";
import type { Agent, AgentTurn, Attachment, Room, RoomMessagePreview } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";
import { mergedAssistantPreview, type ReasoningPreview } from "@/components/workspace/live-assistant-preview";
import { Markdown } from "@/components/workspace/markdown";

type SendCommand = (draft: WorkspaceCommandDraft) => Promise<boolean>;
const scrollFollowThreshold = 48;

function messageKindLabel(kind: RoomMessagePreview["kind"]): string {
  return kind === "handoff" ? "结束" : "过程";
}

function isAtMessageBottom(element: HTMLDivElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= scrollFollowThreshold;
}

export function RoomTitleEditor({ roomId, title, busy, sendCommand }: { roomId: string; title: string; busy: boolean; sendCommand: SendCommand }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const cancel = () => {
    setDraft(title);
    setEditing(false);
  };

  const save = async () => {
    const nextTitle = draft.trim();
    if (!nextTitle || busy) return;
    if (nextTitle === title) {
      cancel();
      return;
    }
    if (await sendCommand({ type: "rename_room", roomId, title: nextTitle })) setEditing(false);
  };

  if (!editing) return <div className="room-title-display">
    <h1>{title}</h1>
    <button className="rename-room-button" type="button" onClick={() => setEditing(true)} aria-label="修改房间名称" title="修改房间名称"><Pencil size={13} /></button>
  </div>;

  const empty = !draft.trim();
  return <form className="room-title-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <input ref={inputRef} value={draft} maxLength={120} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }} aria-label="房间名称" aria-invalid={empty} />
    <button type="submit" disabled={busy || empty} aria-label="保存房间名称" title="保存"><Check size={14} /></button>
    <button type="button" disabled={busy} onClick={cancel} aria-label="取消修改房间名称" title="取消"><X size={14} /></button>
  </form>;
}

function activityTail(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `…${normalized.slice(-(maxLength - 1)).trimStart()}`;
}

function privateActivity(content: string, reasoning: ReasoningPreview | undefined, publicReplyActive: boolean): { phase: string; text: string; singleLine: boolean } {
  const latestReasoning = reasoning?.steps.at(-1)?.content ?? "";
  if (reasoning?.phase === "thinking") return { phase: "思考中", text: activityTail(latestReasoning) || "正在思考…", singleLine: false };
  if (reasoning?.phase === "working") return { phase: "执行中", text: "正在处理工具结果…", singleLine: true };
  if (publicReplyActive) return { phase: "生成中", text: "正在生成公开回复…", singleLine: true };
  if (reasoning?.phase === "answering") return { phase: "组织中", text: activityTail(content) || "正在生成正文…", singleLine: false };
  if (content) return { phase: "私有执行中", text: activityTail(content), singleLine: false };
  return { phase: "私有执行中", text: "正在等待 Assistant 输出…", singleLine: true };
}

function PrivateAssistantStatus({ turn, agentLabel, content, reasoning, publicReplyActive }: { turn: AgentTurn; agentLabel: string; content: string; reasoning?: ReasoningPreview; publicReplyActive: boolean }) {
  const outputRef = useRef<HTMLDivElement>(null);
  const activity = privateActivity(content, reasoning, publicReplyActive);

  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activity.text]);

  return <article className="message from-agent private-status-message" aria-live="polite" aria-label={`${agentLabel} 私有执行状态`} data-turn-id={turn.id}>
    <div className="message-avatar"><LoaderCircle className="spin" size={16} /></div>
    <div className="message-body">
      <div className="message-meta"><strong>{agentLabel}</strong><span>{activity.phase}</span><em>临时状态</em></div>
      <div className="message-content private-status-content">
        <div className={`private-status-output${activity.singleLine ? " single-line" : ""}`} ref={outputRef}>
          <span>{activity.text}</span><span className="stream-cursor" aria-hidden="true" />
        </div>
      </div>
    </div>
  </article>;
}

export function RoomPanel({ room, directAgent, agents, previews, assistantPreviews, reasoningPreviews, busy, sendCommand, onToggleConsole, consoleOpen }: { room: Room; directAgent?: Agent; agents: Agent[]; previews: RoomMessagePreview[]; assistantPreviews: Record<string, string>; reasoningPreviews: Record<string, ReasoningPreview>; busy: boolean; sendCommand: SendCommand; onToggleConsole: () => void; consoleOpen: boolean }) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(false);
  const isDirect = room.kind === "direct";
  const directChatAgent = directAgent ?? (room.directAgentId ? agents.find((agent) => agent.id === room.directAgentId) : undefined);
  const availableAgents = isDirect ? [] : agents.filter((agent) => !room.participants.some((participant) => participant.agentId === agent.id));
  const visiblePreviews = previews.filter((preview) => preview.roomId === room.id && !room.messages.some((message) => message.messageKey === preview.messageKey));
  const publiclyStreamingTurnIds = new Set(visiblePreviews.map((preview) => preview.turnId));
  const runningTurns = room.turns.filter((turn) => turn.status === "running");
  const privateStatuses = runningTurns
    .map((turn) => ({ turn, content: mergedAssistantPreview(turn.assistantContent, assistantPreviews[turn.id]), reasoning: reasoningPreviews[turn.id], publicReplyActive: publiclyStreamingTurnIds.has(turn.id) }));
  const previewLength = visiblePreviews.reduce((total, preview) => total + preview.content.length, 0)
    + privateStatuses.reduce((total, status) => total + status.content.length + (status.reasoning?.steps.reduce((length, step) => length + step.content.length, 0) ?? 0), 0);

  useEffect(() => {
    const element = messageScrollRef.current;
    if (element) followLatestRef.current = isAtMessageBottom(element);
  }, [room.id]);

  useEffect(() => {
    const element = messageScrollRef.current;
    if (element && followLatestRef.current) element.scrollTop = element.scrollHeight;
  }, [previewLength, room.messages.length, visiblePreviews.length]);

  const submit = async () => {
    if ((!content.trim() && !attachments.length) || busy) return;
    if (isDirect && !directChatAgent) return;
    const ok = await sendCommand(isDirect
      ? { type: "send_direct_message", agentId: directChatAgent!.id, content, attachmentIds: attachments.map((item) => item.id) }
      : { type: "send_message", roomId: room.id, content, attachmentIds: attachments.map((item) => item.id) });
    if (ok) { setContent(""); setAttachments([]); }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try { const form = new FormData(); form.append("file", file); const response = await fetch("/api/uploads", { method: "POST", body: form }); const result = await response.json() as Attachment & { error?: string }; if (!response.ok) throw new Error(result.error ?? "上传失败"); setAttachments((current) => [...current, result]); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return <div className="room-panel">
    <header className="room-header">
      <div className="room-title-block"><div className="room-title-line">{isDirect ? <div className="room-title-display direct-chat-title"><span className="agent-avatar"><Bot size={15} /></span><h1>{directChatAgent?.label ?? room.title}</h1></div> : <RoomTitleEditor key={`${room.id}:${room.title}`} roomId={room.id} title={room.title} busy={busy} sendCommand={sendCommand} />}<span className={`status-label ${room.scheduler.status}`}>{room.scheduler.status === "running" ? "运行中" : "已就绪"}</span></div><p>{isDirect ? "你与该 Agent 的单聊 · 延续 Agent 的全局上下文" : `${room.participants.filter((participant) => participant.enabled).length} 位参与者 · 房间公开消息与 Agent 私有执行严格分层`}</p></div>
      <div className="room-header-actions">
        <div className="participant-stack" aria-label="房间成员">{room.participants.slice(0, 5).map((participant, index) => <span key={participant.id} title={participant.displayName} className={participant.kind === "human" ? "human" : `tone-${index % 4}`}>{participant.kind === "agent" ? <Bot size={14} /> : participant.displayName.slice(0, 1)}</span>)}</div>
        {availableAgents.length ? <label className="select-action"><UserPlus size={16} /><select aria-label="邀请 Agent" value="" onChange={(event) => { if (event.target.value) void sendCommand({ type: "add_agent", roomId: room.id, agentId: event.target.value }); }}><option value="">邀请 Agent</option>{availableAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.label}</option>)}</select><ChevronDown size={13} /></label> : null}
        {room.scheduler.status === "running" ? <button className="danger-button" onClick={() => void sendCommand({ type: "stop_room", roomId: room.id })}><Square size={13} fill="currentColor" />紧急停止</button> : null}
        {!isDirect ? <button className="icon-button desktop-only" onClick={() => void sendCommand({ type: "archive_room", roomId: room.id, archived: !room.archivedAt })} aria-label="归档房间"><Archive size={17} /></button> : null}
        {!consoleOpen ? <button className="icon-button desktop-only" onClick={onToggleConsole} aria-label="打开 Console"><PanelRightOpen size={18} /></button> : null}
      </div>
    </header>

    <div className="message-scroll" ref={messageScrollRef} onScroll={(event) => { followLatestRef.current = isAtMessageBottom(event.currentTarget); }}>
      <div className="message-day">{isDirect ? "单聊记录" : "公开房间转录"}</div>
      {room.messages.map((message) => message.source === "system" ? <div className="system-message" key={message.id}><span />{message.content}<span /></div> : <article key={message.id} className={`message ${message.source === "user" ? "from-user" : "from-agent"}`}>
        <div className="message-avatar">{message.source === "agent_emit" ? <Bot size={16} /> : message.sender.name.slice(0, 1)}</div>
        <div className="message-body"><div className="message-meta"><strong>{message.sender.name}</strong><span>#{message.seq}</span><time>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>{message.kind === "notify" || message.kind === "handoff" ? <em>{messageKindLabel(message.kind)}</em> : null}</div><div className="message-content"><Markdown>{message.content}</Markdown></div>
          {message.attachments.length ? <div className="attachment-list">{message.attachments.map((attachment) => <a href={`/api/uploads/${attachment.id}`} target="_blank" rel="noreferrer" key={attachment.id}><FileText size={15} /><span>{attachment.fileName}</span><small>{Math.ceil(attachment.byteSize / 1024)} KB</small></a>)}</div> : null}
          {message.receipts.length ? <div className="receipt-line">已阅不回 · {message.receipts.map((receipt) => room.participants.find((participant) => participant.id === receipt.agentParticipantId)?.displayName ?? "Agent").join("、")}</div> : null}
        </div>
      </article>)}
      {visiblePreviews.map((preview) => <article key={`${preview.turnId}:${preview.messageKey}`} className="message from-agent streaming-message" aria-live="polite" aria-label="Agent 正在生成公开回复">
        <div className="message-avatar"><Bot size={16} /></div>
        <div className="message-body"><div className="message-meta"><strong>{agents.find((agent) => agent.id === preview.agentId)?.label ?? "Agent"}</strong><span>生成中</span><em>{messageKindLabel(preview.kind)}</em></div><div className="message-content streaming-content"><span>{preview.content}</span><span className="stream-cursor" aria-hidden="true" /></div></div>
      </article>)}
      {privateStatuses.map(({ turn, content: privateContent, reasoning, publicReplyActive }) => <PrivateAssistantStatus key={turn.id} turn={turn} agentLabel={agents.find((agent) => agent.id === turn.agentId)?.label ?? room.participants.find((participant) => participant.id === turn.agentParticipantId)?.displayName ?? "Agent"} content={privateContent} reasoning={reasoning} publicReplyActive={publicReplyActive} />)}
      {room.scheduler.status === "running" && !runningTurns.length ? <div className="agent-working"><LoaderCircle className="spin" size={15} /><span>{room.participants.find((participant) => participant.id === room.scheduler.activeParticipantId)?.displayName ?? "Agent"} 正在私有执行区工作</span><small>正在等待执行状态同步</small></div> : null}
    </div>

    <footer className="composer-wrap">
      {attachments.length ? <div className="composer-attachments">{attachments.map((attachment) => <span key={attachment.id}><Paperclip size={13} />{attachment.fileName}<button onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}</div> : null}
      <div className="composer"><textarea value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={isDirect ? `给 ${directChatAgent?.label ?? "Agent"} 发送消息…` : "向这个房间发送公开消息…"} rows={3} /><div className="composer-tools"><input ref={fileRef} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} /><button className="icon-button" disabled={uploading} onClick={() => fileRef.current?.click()} aria-label="添加附件">{uploading ? <LoaderCircle className="spin" size={17} /> : <Paperclip size={17} />}</button><span>Enter 发送 · Shift+Enter 换行</span><button className="send-button" disabled={busy || (!content.trim() && !attachments.length) || (isDirect && !directChatAgent)} onClick={() => void submit()}><Send size={16} />发送</button></div></div>
    </footer>
  </div>;
}
