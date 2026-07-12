"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Pause, Play, Plus, Trash2, X } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/domain/types";
import type { WorkspaceCommandDraft } from "@/lib/domain/schemas";

type SendCommand = (draft: WorkspaceCommandDraft) => Promise<boolean>;

export function CronDrawer({ snapshot, roomId, busy, sendCommand, onClose }: { snapshot: WorkspaceSnapshot; roomId: string; busy: boolean; sendCommand: SendCommand; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "每日跟进", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "检查这个房间中的未完成事项，并通过房间工具公开进展。", agentId: snapshot.agents[0]?.id ?? "" });
  const jobs = useMemo(() => snapshot.cronJobs.filter((job) => !roomId || job.roomId === roomId), [roomId, snapshot.cronJobs]);
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="cron-drawer"><header><div><span><CalendarClock size={18} /></span><div><h2>定时任务</h2><p>Cron 与网页消息复用同一套 turn 规则</p></div></div><button className="icon-button" onClick={onClose}><X size={18} /></button></header>
    <div className="drawer-actions"><button className="primary-button" onClick={() => setCreating((value) => !value)}><Plus size={15} />创建任务</button></div>
    {creating ? <div className="cron-form"><label>名称<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Cron 表达式<input value={draft.schedule} onChange={(event) => setDraft({ ...draft, schedule: event.target.value })} /></label><label>时区<input value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></label><label>执行 Agent<select value={draft.agentId} onChange={(event) => setDraft({ ...draft, agentId: event.target.value })}>{snapshot.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></label><label>内部任务输入<textarea rows={5} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} /></label><button className="primary-button" disabled={busy || !roomId} onClick={async () => { if (await sendCommand({ type: "create_cron", roomId, ...draft })) setCreating(false); }}>保存并启用</button></div> : null}
    <div className="cron-list">{jobs.length ? jobs.map((job) => <article key={job.id}><div className="cron-card-head"><span className={job.enabled ? "enabled" : "paused"}><CalendarClock size={16} /></span><div><strong>{job.name}</strong><code>{job.schedule} · {job.timezone}</code></div><button className="icon-button" onClick={() => void sendCommand({ type: "update_cron", jobId: job.id, enabled: !job.enabled })} aria-label={job.enabled ? "暂停" : "启用"}>{job.enabled ? <Pause size={15} /> : <Play size={15} />}</button><button className="icon-button danger-icon" onClick={() => void sendCommand({ type: "delete_cron", jobId: job.id })} aria-label="删除"><Trash2 size={15} /></button></div><p>{job.prompt}</p><footer><span>Agent · {snapshot.agents.find((agent) => agent.id === job.agentId)?.label ?? job.agentId}</span><button disabled={busy} onClick={() => void sendCommand({ type: "run_cron", jobId: job.id })}><Play size={12} />立即运行</button></footer></article>) : <div className="drawer-empty"><CalendarClock size={25} /><strong>这个房间还没有定时任务</strong><p>创建后，任务输入会作为内部调度事件进入 Agent，不会伪装成人类消息。</p></div>}</div>
  </aside></div>;
}
