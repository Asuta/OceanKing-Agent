"use client";

import { useState } from "react";
import { Bot, CheckCircle2, KeyRound, Plus, RotateCcw, Settings2, ShieldAlert, X } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";

type SendCommand = (draft: WorkspaceCommandDraft) => Promise<boolean>;
const tokensPerK = 1_000;
const minimumContextThresholdK = 1_024 / tokensPerK;
const maximumContextThresholdK = 1_000_000 / tokensPerK;

function ResetWorkspacePanel({ busy, sendCommand, onReset, onClose }: { busy: boolean; sendCommand: SendCommand; onReset: () => void; onClose: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return <div className="reset-workspace-panel">
    <div className="reset-workspace-heading"><span><RotateCcw size={18} /></span><div><h3>重置到初始状态</h3><p>删除全部房间、房间消息、Agent 对话、Turn、工具记录、Cron、附件记录和运行期创建的 Agent，然后重新创建唯一的“港湾协作室”。</p></div></div>
    <div className="reset-preserved"><CheckCircle2 size={15} /><span>只保留最初的“领航员”和“执行者”；全局模型、思考模式和思考强度保持不变。</span></div>
    {!confirming
      ? <button className="danger-button" disabled={busy} onClick={() => setConfirming(true)}><RotateCcw size={13} />重置工作台</button>
      : <div className="reset-confirmation" role="alert"><strong>确定要永久清空当前所有历史吗？</strong><p>此操作不可撤销。运行期创建的 Agent 及其私有工作区也会删除；重置后只保留最初两个 Agent 和一个没有对话历史的初始房间。</p><div><button disabled={busy} onClick={() => setConfirming(false)}>取消</button><button className="danger-button" disabled={busy} onClick={async () => { if (await sendCommand({ type: "reset_workspace" })) { onReset(); onClose(); } }}><RotateCcw size={13} />确认重置全部历史</button></div></div>}
  </div>;
}

export function SettingsDialog({ snapshot, busy, sendCommand, onReset, onClose }: { snapshot: WorkspaceSnapshot; busy: boolean; sendCommand: SendCommand; onReset: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"model" | "agents" | "tools" | "reset">("model");
  const [model, setModel] = useState(snapshot.settings.model); const [format, setFormat] = useState(snapshot.settings.apiFormat);
  const [thinkingMode, setThinkingMode] = useState(snapshot.settings.thinkingMode); const [reasoningEffort, setReasoningEffort] = useState(snapshot.settings.reasoningEffort);
  const [contextTokenThresholdK, setContextTokenThresholdK] = useState(snapshot.settings.contextTokenThreshold / tokensPerK);
  const [steps, setSteps] = useState(snapshot.settings.maxToolSteps); const [rounds, setRounds] = useState(snapshot.settings.maxRoomRounds);
  const [roots, setRoots] = useState(snapshot.settings.projectContextRoots.join("\n"));
  const [newAgent, setNewAgent] = useState({ label: "", summary: "", instruction: "" });
  const contextTokenThreshold = Math.round(contextTokenThresholdK * tokensPerK);
  const contextTokenThresholdValid = Number.isFinite(contextTokenThresholdK) && contextTokenThresholdK >= minimumContextThresholdK && contextTokenThresholdK <= maximumContextThresholdK;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="settings-dialog" role="dialog" aria-modal="true" aria-label="工作台设置">
    <header><div><span><Settings2 size={18} /></span><div><h2>工作台设置</h2><p>本地权威配置与 Agent 注册表</p></div></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
    <div className="settings-body"><nav><button className={tab === "model" ? "active" : ""} onClick={() => setTab("model")}><KeyRound size={16} />模型连接</button><button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}><Bot size={16} />Agent 注册表</button><button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}><ShieldAlert size={16} />工具与安全</button><button className={tab === "reset" ? "active danger-tab" : "danger-tab"} onClick={() => setTab("reset")}><RotateCcw size={16} />数据重置</button></nav><div className="settings-content">
      {tab === "model" ? <><div className="setting-status"><CheckCircle2 size={17} /><span><strong>{snapshot.settings.apiKeyConfigured ? "全局真实模型已配置" : "正在使用确定性假模型"}</strong><small>所有 Agent、房间调度与 Cron 工作流在运行时读取同一份全局配置；API Key 不写入 SQLite</small></span></div><label>Base URL<input value={snapshot.settings.baseUrl} disabled /></label><label>全局默认模型<select value={model} onChange={(event) => setModel(event.target.value)}>{snapshot.settings.availableModels.map((availableModel) => <option value={availableModel} key={availableModel}>{availableModel}</option>)}</select></label><label>接口格式<select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="auto">自动：Responses → Chat Completions</option><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></select></label><div className="field-pair"><label>思考模式<select value={thinkingMode} onChange={(event) => setThinkingMode(event.target.value as typeof thinkingMode)}><option value="provider_default">跟随服务商默认</option><option value="enabled">启用</option><option value="disabled">禁用</option></select></label><label>思考强度<select value={reasoningEffort} disabled={thinkingMode === "disabled"} onChange={(event) => setReasoningEffort(event.target.value as typeof reasoningEffort)}><option value="high">High</option><option value="max">Max</option></select></label></div><label>上下文压缩阈值（K Token）<input type="number" min={minimumContextThresholdK} max={maximumContextThresholdK} step={0.001} value={contextTokenThresholdK} onChange={(event) => setContextTokenThresholdK(Number(event.target.value))} aria-label="上下文压缩阈值（K Token）" /><small>以千 Token 为单位（1 K = 1,000 Token）；完整上下文超过该值时，先整体压缩一次，再继续正式请求。</small></label><div className="field-pair"><label>最大工具步骤<input type="number" min={1} max={256} value={steps} onChange={(event) => setSteps(Number(event.target.value))} /></label><label>房间最大轮次<input type="number" min={1} max={256} value={rounds} onChange={(event) => setRounds(Number(event.target.value))} /></label></div><label>项目上下文根目录<textarea rows={5} value={roots} onChange={(event) => setRoots(event.target.value)} placeholder="每行一个绝对路径" /></label><button className="primary-button" disabled={busy || !contextTokenThresholdValid} onClick={() => void sendCommand({ type: "update_settings", model, availableModels: snapshot.settings.availableModels, apiFormat: format, thinkingMode, reasoningEffort, contextTokenThreshold, maxToolSteps: steps, maxRoomRounds: rounds, projectContextRoots: roots.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) })}>保存全局模型设置</button></> : null}
      {tab === "agents" ? <><div className="agent-setting-list">{snapshot.agents.map((agent) => <article key={agent.id}><span><Bot size={17} /></span><div><strong>{agent.label}</strong><p>{agent.summary}</p><code>{agent.id}</code></div></article>)}</div><div className="new-agent-form"><h3><Plus size={15} />创建 Agent</h3><label>名称<input value={newAgent.label} onChange={(event) => setNewAgent({ ...newAgent, label: event.target.value })} /></label><label>简介<input value={newAgent.summary} onChange={(event) => setNewAgent({ ...newAgent, summary: event.target.value })} /></label><label>指令<textarea rows={5} value={newAgent.instruction} onChange={(event) => setNewAgent({ ...newAgent, instruction: event.target.value })} /></label><button className="primary-button" disabled={busy || !newAgent.label || !newAgent.instruction} onClick={async () => { if (await sendCommand({ type: "create_agent", ...newAgent })) setNewAgent({ label: "", summary: "", instruction: "" }); }}>加入注册表</button></div></> : null}
      {tab === "tools" ? <><div className="danger-notice"><ShieldAlert size={20} /><div><strong>全盘 shell · 无审批</strong><p>Agent shell 继承启动 OceanKing 的 Windows 用户权限，包括高危命令在内均自动执行。Panic Stop 会终止活动进程树，但不能撤销已经完成的副作用。</p></div></div><div className="tool-policy-list"><div><strong>工作区工具</strong><span>私有/共享根目录防路径穿越</span></div><div><strong>网页抓取</strong><span>拒绝 localhost 与内网地址</span></div><div><strong>房间工具</strong><span>已连接成员可邀请，移除成员需要 owner 权限</span></div><div><strong>API 服务</strong><span>仅监听 127.0.0.1 并校验 Origin</span></div></div></> : null}
      {tab === "reset" ? <ResetWorkspacePanel busy={busy} sendCommand={sendCommand} onReset={onReset} onClose={onClose} /> : null}
    </div></div>
  </section></div>;
}
