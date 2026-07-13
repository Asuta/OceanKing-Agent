"use client";

import { useMemo, useState } from "react";
import {
  Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Clock3, Code2, Database,
  EyeOff, TerminalSquare, TriangleAlert, Wrench,
} from "lucide-react";
import type { ModelCallRecord, Room } from "@/lib/domain/types";
import { Markdown } from "@/components/workspace/markdown";

function readModelCalls(modelMeta: Record<string, unknown> | null): ModelCallRecord[] {
  const calls = modelMeta?.modelCalls;
  if (!Array.isArray(calls)) return [];
  return calls.filter((call) => call && typeof call === "object" && typeof call.index === "number") as ModelCallRecord[];
}

function formatTokens(value: number | null): string {
  return value === null ? "未返回" : value.toLocaleString("zh-CN");
}

function formatCacheRate(value: number | null): string {
  return value === null ? "未返回" : `${(value * 100).toFixed(1)}%`;
}

export function ConsolePanel({ room, previews }: { room?: Room; previews: Record<string, string> }) {
  const turns = useMemo(() => room?.turns.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)) ?? [], [room?.turns]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const selected = turns.find((turn) => turn.id === selectedId) ?? turns[0];
  const modelCalls = readModelCalls(selected?.modelMeta ?? null);

  return <div className="console-panel">
    <header className="console-header"><div><span className="console-icon"><TerminalSquare size={16} /></span><div><h2>Agent Console</h2><p>私有执行记录 · 不进入房间</p></div></div><span className="private-label"><EyeOff size={12} />PRIVATE</span></header>
    <div className="console-tabs"><button className="active">执行流</button><button>工具 · {selected?.tools.length ?? 0}</button></div>
    {!selected ? <div className="console-empty"><CircleDashed size={27} /><strong>等待第一个 Agent Turn</strong><p>发送房间消息后，模型原文、工具调用和诊断信息会出现在这里。</p></div> : <>
      <div className="turn-selector"><span className={`turn-status ${selected.status}`}>{selected.status === "running" ? <CircleDashed className="spin" size={13} /> : selected.status === "error" ? <TriangleAlert size={13} /> : <CheckCircle2 size={13} />}{selected.status}</span><select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{turns.map((turn) => <option value={turn.id} key={turn.id}>{turn.agentId} · {new Date(turn.createdAt).toLocaleTimeString("zh-CN")}</option>)}</select><ChevronDown size={13} /></div>
      <div className="turn-context"><div><Bot size={14} /><span>触发 Agent</span><strong>{selected.agentId}</strong></div><div><Clock3 size={14} /><span>锚点</span><strong>{selected.anchorMessageId?.slice(0, 12) ?? "—"}</strong></div></div>
      <section className="console-section"><div className="console-section-title"><Code2 size={14} /><span>Assistant 原文</span><small>仅 Console</small></div><div className="assistant-draft"><Markdown>{selected.assistantContent || previews[selected.id] || "Agent 尚未产生普通文本。"}</Markdown></div></section>
      <section className="console-section">
        <div className="console-section-title"><Database size={14} /><span>模型调用与缓存</span><small>{modelCalls.length} 次</small></div>
        {modelCalls.length ? <div className="model-call-list">{modelCalls.map((call) => <article className={`model-call-card ${call.status}`} key={`${call.index}-${call.startedAt}`}>
          <header><div><strong>调用 #{call.index}</strong><span>{call.purpose === "compaction" ? "上下文压缩" : "模型生成"}</span></div><small>{call.format === "responses" ? "Responses" : "Chat Completions"} · {call.durationMs}ms</small></header>
          <dl className="model-call-metrics">
            <div><dt>输入 Token</dt><dd>{formatTokens(call.inputTokens)}</dd></div>
            <div className="cache-hit"><dt>缓存命中</dt><dd>{formatTokens(call.cachedInputTokens)}</dd></div>
            <div><dt>缓存未命中</dt><dd>{formatTokens(call.cacheMissInputTokens)}</dd></div>
            <div><dt>命中率</dt><dd>{formatCacheRate(call.cacheHitRate)}</dd></div>
            <div><dt>缓存写入</dt><dd>{formatTokens(call.cacheWriteInputTokens)}</dd></div>
            <div><dt>输出 Token</dt><dd>{formatTokens(call.outputTokens)}</dd></div>
          </dl>
          {call.cacheHitRate !== null ? <div className="cache-rate-bar" aria-label={`缓存命中率 ${formatCacheRate(call.cacheHitRate)}`}><span style={{ width: `${call.cacheHitRate * 100}%` }} /></div> : null}
          {call.error ? <p className="model-call-error">{call.error}</p> : null}
          <details className="raw-usage"><summary>服务商原始 usage</summary><pre>{call.rawUsage ? JSON.stringify(call.rawUsage, null, 2) : "该次调用未返回 usage，无法判断缓存命中。"}</pre></details>
        </article>)}</div> : <div className="empty-tools">这个 Turn 没有可用的模型调用统计。历史 Turn、假模型或未返回 usage 的旧记录不会显示缓存数据。</div>}
      </section>
      <section className="console-section"><div className="console-section-title"><Wrench size={14} /><span>工具执行</span><small>{selected.tools.length}</small></div>{selected.tools.length ? <div className="tool-list">{selected.tools.map((tool) => { const open = expandedTools[tool.id]; return <div className={`tool-row ${tool.status}`} key={tool.id}><button onClick={() => setExpandedTools((current) => ({ ...current, [tool.id]: !open }))}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{tool.name}</span><small>{tool.durationMs}ms</small><em>{tool.status}</em></button>{open ? <div className="tool-detail"><label>输入</label><pre>{JSON.stringify(tool.input, null, 2)}</pre><label>结果</label><pre>{tool.outputText || "（无文本结果）"}</pre>{tool.error ? <p>{tool.error}</p> : null}</div> : null}</div>; })}</div> : <div className="empty-tools">这个 turn 没有调用工具，因此不会自动产生公开消息。</div>}</section>
      <section className="console-section compact"><div className="console-section-title"><Clock3 size={14} /><span>执行摘要</span></div><dl><div><dt>状态</dt><dd>{selected.status}</dd></div><div><dt>公开消息</dt><dd>{selected.emittedMessageIds.length}</dd></div><div><dt>时间线事件</dt><dd>{selected.timeline.length}</dd></div><div><dt>模型格式</dt><dd>{String(selected.modelMeta?.format ?? "—")}</dd></div></dl></section>
    </>}
  </div>;
}
