"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Code2, EyeOff, MessageSquareText, TriangleAlert, Wrench } from "lucide-react";
import type { AgentConversationHistory, AgentConversationTurn, AgentSessionMessage, AgentTurn, ToolExecution } from "@/lib/domain/types";
import { Markdown } from "@/components/workspace/markdown";

function prettyJson(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function statusIcon(status: AgentTurn["status"]) {
  if (status === "running") return <CircleDashed className="spin" size={13} />;
  if (status === "error" || status === "stopped") return <TriangleAlert size={13} />;
  return <CheckCircle2 size={13} />;
}

function ToolExecutionRecord({ tool, open, onToggle }: { tool: ToolExecution; open: boolean; onToggle: () => void }) {
  return <div className={`tool-row ${tool.status}`}><button aria-label={`查看工具执行 ${tool.name} ${tool.id}`} onClick={onToggle}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{tool.name}</span><small>{tool.durationMs}ms</small><em>{tool.status}</em></button>{open ? <div className="tool-detail"><label>实际执行输入</label><pre>{JSON.stringify(tool.input, null, 2)}</pre><label>实际执行结果</label><pre>{tool.outputText || "（无文本结果）"}</pre>{tool.error ? <p>{tool.error}</p> : null}</div> : null}</div>;
}

function ConversationMessage({ message, index, execution, executionOpen, onToggleExecution }: { message: AgentSessionMessage; index: number; execution?: ToolExecution; executionOpen: boolean; onToggleExecution: () => void }) {
  if (message.role === "user") return <article className="agent-conversation-message user-message">
    <header><span>模型输入</span><small>#{index + 1} · user</small></header>
    <pre>{message.content}</pre>
  </article>;
  if (message.role === "tool") return <article className="agent-conversation-message tool-message">
    <details className="agent-tool-return" aria-label={`工具返回 ${message.tool_call_id}`}>
      <summary><ChevronRight size={14} /><span>工具返回</span><small>{message.tool_call_id}</small></summary>
      <pre>{message.content}</pre>
      {execution ? <ToolExecutionRecord tool={execution} open={executionOpen} onToggle={onToggleExecution} /> : null}
    </details>
  </article>;
  return <article className="agent-conversation-message assistant-message">
    <header><span>Agent 回复</span><small>#{index + 1} · assistant</small></header>
    {message.reasoning_content !== undefined ? <div className="agent-reasoning"><label>推理内容</label><pre>{message.reasoning_content || "（模型返回了空的 reasoning_content）"}</pre></div> : null}
    {message.content ? <div className="agent-answer"><label>回复内容</label><Markdown>{message.content}</Markdown></div> : null}
    {message.tool_calls?.map((call) => <div className="agent-command" key={call.id}>
      <div><Code2 size={13} /><strong>{call.function.name}</strong><small>{call.id}</small></div>
      <pre>{prettyJson(call.function.arguments)}</pre>
    </div>)}
    {!message.content && message.reasoning_content === undefined && !message.tool_calls?.length ? <p className="agent-empty-value">（空 Assistant 消息）</p> : null}
  </article>;
}

function TimelineTurn({ turn, expandedTools, toggleTool }: { turn: AgentConversationTurn; expandedTools: Record<string, boolean>; toggleTool: (toolId: string) => void }) {
  const toolById = new Map(turn.tools.map((tool) => [tool.id, tool]));
  const linkedToolIds = new Set(turn.messages.flatMap((message) => message.role === "tool" ? [message.tool_call_id] : []));
  const unlinkedTools = turn.tools.filter((tool) => !linkedToolIds.has(tool.id));
  const source = turn.userEnvelope.type === "cron_packet" ? `Cron · ${turn.roomTitle}` : turn.roomTitle;
  return <section className="agent-timeline-turn" data-turn-id={turn.id}>
    <header className="agent-turn-marker">
      <span className={`turn-status ${turn.status}`}>{statusIcon(turn.status)}{turn.status}</span>
      <strong>{source}</strong>
      <time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString("zh-CN")}</time>
      <small>{String(turn.modelMeta?.format ?? "未知格式")} · {turn.messages.length} 条模型消息 · {turn.tools.length} 次工具执行</small>
    </header>

    <div className="agent-timeline-stage"><MessageSquareText size={14} /><span>发送给 Agent 的输入</span></div>
    <details className="agent-raw-details"><summary>System 指令</summary><pre>{turn.systemPrompt || "这条历史 Turn 创建于完整对话持久化功能之前，未保存 System 指令。"}</pre></details>
    <div className="agent-input-list">{turn.userEnvelope.messages.map((message) => <article key={message.id}><header><strong>{message.source === "user" ? "用户输入" : message.source === "system" ? "系统 / Cron 输入" : "Agent 公开消息"}</strong><small>#{message.seq} · {message.id}</small></header><pre>{message.content || "（仅附件）"}</pre>{message.attachments.length ? <small>{message.attachments.map((attachment) => attachment.fileName).join("、")}</small> : null}</article>)}</div>
    <details className="agent-raw-details"><summary>原始 scheduler packet</summary><pre>{JSON.stringify(turn.userEnvelope, null, 2)}</pre></details>

    <div className="agent-timeline-stage"><Bot size={14} /><span>模型对话与命令</span></div>
    <div className="agent-conversation-list">{turn.messages.map((message, index) => {
      const execution = message.role === "tool" ? toolById.get(message.tool_call_id) : undefined;
      return <ConversationMessage key={`${turn.id}-${index}`} message={message} index={index} execution={execution} executionOpen={Boolean(execution && expandedTools[execution.id])} onToggleExecution={() => { if (execution) toggleTool(execution.id); }} />;
    })}</div>
    {unlinkedTools.length ? <><div className="agent-timeline-stage"><Wrench size={14} /><span>未关联到模型消息的工具执行</span></div><div className="tool-list">{unlinkedTools.map((tool) => <ToolExecutionRecord key={tool.id} tool={tool} open={Boolean(expandedTools[tool.id])} onToggle={() => toggleTool(tool.id)} />)}</div></> : null}
    {turn.error ? <div className="agent-turn-error"><TriangleAlert size={13} /><span>{turn.error}</span></div> : null}
  </section>;
}

export function AgentConversationPanel({ agentId, historyVersion }: { agentId: string; historyVersion: string }) {
  const [loadResult, setLoadResult] = useState<{ agentId: string; historyVersion: string; history: AgentConversationHistory | null; error: string | null } | null>(null);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/agents/${encodeURIComponent(agentId)}/conversation`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as AgentConversationHistory | { error?: string };
        if (!response.ok) throw new Error("error" in body ? body.error ?? "读取 Agent 对话失败" : "读取 Agent 对话失败");
        setLoadResult({ agentId, historyVersion, history: body as AgentConversationHistory, error: null });
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setLoadResult((current) => ({
          agentId, historyVersion, history: current?.agentId === agentId ? current.history : null,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
      });
    return () => controller.abort();
  }, [agentId, historyVersion]);

  const currentResult = loadResult?.agentId === agentId ? loadResult : null;
  const history = currentResult?.history ?? null;
  const error = currentResult?.error ?? null;
  const loading = !currentResult || currentResult.historyVersion !== historyVersion;
  const timelineTurns = useMemo(() => history?.turns.toReversed() ?? [], [history?.turns]);
  const roomCount = useMemo(() => new Set(history?.turns.map((turn) => turn.roomId) ?? []).size, [history]);
  const toolCount = useMemo(() => history?.turns.reduce((count, turn) => count + turn.tools.length, 0) ?? 0, [history]);
  const latestTurn = timelineTurns.at(-1);
  const latestTurnId = latestTurn?.id;
  const latestTurnUpdatedAt = latestTurn?.updatedAt;

  useEffect(() => {
    const panel = panelRef.current;
    if (panel && latestTurnId) panel.scrollTop = panel.scrollHeight;
  }, [agentId, latestTurnId, latestTurnUpdatedAt]);

  const toggleTool = (toolId: string) => setExpandedTools((current) => ({ ...current, [toolId]: !current[toolId] }));

  return <div className="console-panel agent-conversation-panel" ref={panelRef}>
    <header className="console-header"><div><span className="console-icon"><Bot size={16} /></span><div><h2>{history?.agent.label ?? "Agent 对话"}</h2><p>全局底层对话 · 跨房间 / Cron / 任务</p></div></div><span className="private-label"><EyeOff size={12} />PRIVATE</span></header>
    <div className="console-tabs agent-timeline-tabs"><span>连续时间线 · {history?.turns.length ?? 0} 轮</span><small>{toolCount} 次工具执行</small></div>
    {loading && !history ? <div className="console-empty" aria-live="polite"><CircleDashed className="spin" size={27} /><strong>正在读取底层对话</strong><p>正在汇总这个 Agent 在所有房间和任务中的输入、回复与命令。</p></div> : null}
    {error && !history ? <div className="console-empty"><TriangleAlert size={27} /><strong>无法读取 Agent 对话</strong><p>{error}</p></div> : null}
    {!loading && !error && history && !timelineTurns.length ? <div className="console-empty"><MessageSquareText size={27} /><strong>还没有底层对话</strong><p>这个 Agent 首次执行后，完整输入、回复和工具命令会出现在这里。</p></div> : null}
    {history && timelineTurns.length ? <>
      <div className="agent-history-summary"><span><strong>{timelineTurns.length}</strong> 轮次</span><span><strong>{roomCount}</strong> 房间</span><span><strong>{toolCount}</strong> 工具执行</span>{loading ? <CircleDashed className="spin" size={12} aria-label="正在刷新" /> : null}</div>
      {error ? <div className="agent-refresh-error" role="status"><TriangleAlert size={12} />{error}</div> : null}
      <div className="agent-timeline" aria-label="Agent 连续底层对话时间线">{timelineTurns.map((turn) => <TimelineTurn key={turn.id} turn={turn} expandedTools={expandedTools} toggleTool={toggleTool} />)}</div>
    </> : null}
  </div>;
}
