import type { SchedulerPacket, ToolExecution } from "@/lib/domain/types";
import { formatSchedulerPacketForModel } from "@/lib/server/scheduler-prompt";

const maxAssistantCharacters = 4_000;
const maxToolInputCharacters = 1_200;
const maxToolOutputCharacters = 600;

export const interruptedTurnSystemInstructions = [
  "把新到达的房间消息视为信息更新事件，而不是自动允许放弃或替换更早的未完成任务。",
  "新消息到达时，先判断它是在明确取消旧义务、为旧义务补充信息，还是创建了一个需要同时处理的独立义务。不要仅因为消息更新就把它当成取消或更高优先级。",
  "除非用户明确取消或替代旧义务，否则在处理新消息的同时继续完成旧任务。",
  "被打断的房间义务仍然是活跃义务，不是仅供参考的背景上下文。",
  "结束当前轮之前，检查是否仍欠任何房间承诺过的答复、跟进、工具结果或进度说明；若未被明确取消，就完成它，或通过 send_message_to_room 向正确的原房间发送可见进度。",
] as const;

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 个字符）`;
}

function formatTool(tool: ToolExecution): string {
  const input = truncate(JSON.stringify(tool.input), maxToolInputCharacters);
  const output = truncate(tool.outputText || tool.error || "（无输出）", maxToolOutputCharacters);
  return [
    `- ${tool.name}（${tool.status}，${tool.durationMs}ms）`,
    `  输入：${input}`,
    `  输出：${output}`,
  ].join("\n");
}

export function buildInterruptedTurnSnapshot(args: {
  packet: SchedulerPacket;
  assistantContent: string;
  tools: ToolExecution[];
  reason: string;
}): string {
  const sections = [
    "[被新消息打断的未完成任务快照]",
    `中断原因：${args.reason}`,
    "原任务增量：",
    formatSchedulerPacketForModel(args.packet),
    "已产生的私有草稿：",
    args.assistantContent.trim() ? truncate(args.assistantContent, maxAssistantCharacters) : "（尚未产生草稿）",
    "已执行的工具：",
    args.tools.length ? args.tools.map(formatTool).join("\n") : "（尚未执行工具）",
  ];
  sections.push(
    [
      "续接要求：较新的房间消息现已到达，但这只是信息更新，不是自动允许放弃当前未完成任务。",
      "除非较新的消息明确取消或替代原任务，否则原房间的未完成义务仍然有效；处理新任务时也要继续处理好原任务。",
      "把被打断的房间义务视为活跃义务，而不是背景上下文。",
      "结束当前轮之前，要么完成原房间义务，要么通过 send_message_to_room 向正确的原房间发送可见进度。",
    ].join("\n"),
    "注意：上述工具可能已经产生外部副作用，不要盲目重复执行；本轮尚未提交的房间消息、receipt 和房间管理变更不会生效。",
  );
  return sections.join("\n\n");
}
