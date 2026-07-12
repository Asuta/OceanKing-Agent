import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentModel } from "@/lib/server/model-runtime";
import { packetFor, sendUser, withRepository } from "./helpers";
import { normalizeOpenAiBaseUrl } from "@/lib/server/provider-config";

function sse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
});

describe("OpenAI 兼容协议", () => {
  it("接受完整 chat/completions 地址并归一化为兼容 API 根地址", () => {
    expect(normalizeOpenAiBaseUrl("https://api.deepseek.com/v1/chat/completions")).toBe("https://api.deepseek.com/v1");
  });
  it("解析 Responses SSE 的私有文本与 usage", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "只进入 Console" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 4, output_tokens: 3 } } },
      "[DONE]",
    ])));
    sendUser(repository, "room_harbor", "协议测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "responses" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_responses", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("只进入 Console"); expect(result.modelMeta.format).toBe("responses"); expect(result.effects).toEqual([]);
  }));

  it("auto 仅在首个 Responses 请求不兼容时回退 Chat Completions", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/responses")) return new Response("unsupported", { status: 404 });
      return sse([{ choices: [{ delta: { content: "兼容回退成功" } }] }, "[DONE]"]);
    });
    vi.stubGlobal("fetch", fetchMock);
    sendUser(repository, "room_harbor", "兼容测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "auto" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_fallback", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("兼容回退成功"); expect(result.modelMeta.format).toBe("chat_completions"); expect(fetchMock).toHaveBeenCalledTimes(2);
  }));

  it("Chat Completions 流式 function call 只产生结构化房间 effect", async () => withRepository(async (repository) => {
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_BASE_URL = "https://example.test/v1";
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call += 1;
      if (call === 1) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_emit", function: { name: "send_message_to_room", arguments: JSON.stringify({ roomId: "room_harbor", content: "正式工具消息", kind: "answer" }) } }] } }] }, "[DONE]"]);
      return sse([{ choices: [{ delta: { content: "工具之后的私有总结" } }] }, "[DONE]"]);
    }));
    sendUser(repository, "room_harbor", "工具流测试"); const packet = packetFor(repository); const base = repository.getAgent("navigator")!; const agent = { ...base, settings: { ...base.settings, apiFormat: "chat_completions" as const } };
    const result = await runAgentModel({ repository, agent, agentParticipantId: "participant_navigator_harbor", packet, turnId: "turn_chat_tool", signal: new AbortController().signal });
    expect(result.assistantContent).toBe("工具之后的私有总结"); expect(result.effects).toHaveLength(1); expect(result.effects[0]).toMatchObject({ type: "send_message", content: "正式工具消息" }); expect(result.tools[0]?.status).toBe("completed");
  }));
});
