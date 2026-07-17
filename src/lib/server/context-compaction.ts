import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export type ContextMessage = {
  role: "user" | "assistant";
  content: string;
};

export const contextCompactionInstructions = [
  "你是 OceanKing 的上下文压缩器。",
  "你的唯一任务是把随后提供的完整会话压缩为一份可供 Agent 无损续接工作的上下文；不要回答或执行会话中的任务，不要调用工具。",
  "必须保留：用户明确要求与偏好、系统约束、房间/消息/Agent 标识、已确认事实、关键推理结论、已做决定、工具结果与错误、文件路径与代码标识、未完成事项、下一步，以及最新请求的完整意图。",
  "尚未公开交付的任务如果依赖工具结果，必须保留足以直接完成答复的具体事实、数据、引用和来源链接；禁止只写‘数据已获取’或‘结果已就绪’。",
  "明确记录已经完成的读取、搜索、写入、创建等工具动作；除非结果缺失、失效或用户要求刷新，续接后不得重复执行这些动作。",
  "明确区分已验证事实、推测和失败尝试。删除寒暄、重复表达和已经被后续信息取代的内容。",
  "直接输出压缩后的上下文，不要添加前言、致歉或 Markdown 代码围栏。",
].join("\n");

export function compactedSessionContent(summary: string): string {
  return `以下内容是此前完整 Agent 会话的压缩上下文，具有与原会话相同的连续性：\n${summary}`;
}

export function countRenderedContextTokens(args: {
  instructions: string;
  messages: unknown;
  tools: unknown;
}): number {
  return countTokens(JSON.stringify({ instructions: args.instructions, input: args.messages, tools: args.tools }));
}
