"use client";

import { useMemo, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock3, Code2, EyeOff, TerminalSquare, TriangleAlert, Wrench } from "lucide-react";
import type { Room } from "@/lib/domain/types";
import { Markdown } from "@/components/workspace/markdown";

export function ConsolePanel({ room, previews }: { room?: Room; previews: Record<string, string> }) {
  const turns = useMemo(() => room?.turns.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? [], [room?.turns]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const selected = turns.find((turn) => turn.id === selectedId) ?? turns[0];
  return <div className="console-panel">
    <header className="console-header"><div><span className="console-icon"><TerminalSquare size={16} /></span><div><h2>Agent Console</h2><p>私有执行记录 · 不进入房间</p></div></div><span className="private-label"><EyeOff size={12} />PRIVATE</span></header>
    <div className="console-tabs"><button className="active">执行流</button><button>工具 · {selected?.tools.length ?? 0}</button></div>
    {!selected ? <div className="console-empty"><CircleDashed size={27} /><strong>等待第一个 Agent Turn</strong><p>发送房间消息后，模型原文、工具调用和诊断信息会出现在这里。</p></div> : <>
      <div className="turn-selector"><span className={`turn-status ${selected.status}`}>{selected.status === "running" ? <CircleDashed className="spin" size={13} /> : selected.status === "error" ? <TriangleAlert size={13} /> : <CheckCircle2 size={13} />}{selected.status}</span><select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{turns.map((turn) => <option value={turn.id} key={turn.id}>{turn.agentId} · {new Date(turn.createdAt).toLocaleTimeString("zh-CN")}</option>)}</select><ChevronDown size={13} /></div>
      <div className="turn-context"><div><Bot size={14} /><span>触发 Agent</span><strong>{selected.agentId}</strong></div><div><Clock3 size={14} /><span>锚点</span><strong>{selected.anchorMessageId?.slice(0, 12) ?? "—"}</strong></div></div>
      <section className="console-section"><div className="console-section-title"><Code2 size={14} /><span>Assistant 原文</span><small>仅 Console</small></div><div className="assistant-draft"><Markdown>{selected.assistantContent || previews[selected.id] || "Agent 尚未产生普通文本。"}</Markdown></div></section>
      <section className="console-section"><div className="console-section-title"><Wrench size={14} /><span>工具执行</span><small>{selected.tools.length}</small></div>{selected.tools.length ? <div className="tool-list">{selected.tools.map((tool) => { const open = expandedTools[tool.id]; return <div className={`tool-row ${tool.status}`} key={tool.id}><button onClick={() => setExpandedTools((current) => ({ ...current, [tool.id]: !open }))}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{tool.name}</span><small>{tool.durationMs}ms</small><em>{tool.status}</em></button>{open ? <div className="tool-detail"><label>输入</label><pre>{JSON.stringify(tool.input, null, 2)}</pre><label>结果</label><pre>{tool.outputText || "（无文本结果）"}</pre>{tool.error ? <p>{tool.error}</p> : null}</div> : null}</div>; })}</div> : <div className="empty-tools">这个 turn 没有调用工具，因此不会自动产生公开消息。</div>}</section>
      <section className="console-section compact"><div className="console-section-title"><Clock3 size={14} /><span>执行摘要</span></div><dl><div><dt>状态</dt><dd>{selected.status}</dd></div><div><dt>公开消息</dt><dd>{selected.emittedMessageIds.length}</dd></div><div><dt>时间线事件</dt><dd>{selected.timeline.length}</dd></div><div><dt>模型格式</dt><dd>{String(selected.modelMeta?.format ?? "—")}</dd></div></dl></section>
    </>}
  </div>;
}
