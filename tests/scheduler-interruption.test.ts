import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentExecutor } from "@/lib/server/agent-executor";
import { resetCronRunTrackerForTests, trackCronRun } from "@/lib/server/cron-run-tracker";
import { RoomScheduler } from "@/lib/server/scheduler";
import { commandBase, sendUser, withRepository } from "./helpers";

const originalEnvironment = {
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: process.env.OPENAI_BASE_URL,
  apiFormat: process.env.OPENAI_API_FORMAT,
};

function restoreEnvironment(name: keyof typeof originalEnvironment, variable: "OPENAI_API_KEY" | "OPENAI_BASE_URL" | "OPENAI_API_FORMAT"): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[variable];
  else process.env[variable] = value;
}

async function waitUntil(assertion: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("等待调度状态收敛超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function completedResponse(content: string, responseId: string, roomIds = ["room_harbor"]): Response {
  const events = roomIds.flatMap((roomId, index) => {
    const item = {
      id: `${responseId}_item_${index}`,
      call_id: `${responseId}_call_${index}`,
      type: "function_call",
      name: "send_message_to_room",
      arguments: JSON.stringify({ roomId, content, kind: "answer" }),
    };
    return [
      `data: ${JSON.stringify({ type: "response.output_item.added", item })}`,
      `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
    ];
  });
  events.push(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId } })}`,
    "data: [DONE]",
    "",
  );
  return new Response(events.join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function privateResponse(content: string, responseId: string): Response {
  const events = [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolResponse(name: string, args: Record<string, unknown>, responseId: string): Response {
  const item = {
    id: `${responseId}_item`, call_id: `${responseId}_call`, type: "function_call", name, arguments: JSON.stringify(args),
  };
  const events = [
    `data: ${JSON.stringify({ type: "response.output_item.added", item })}`,
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}`,
    `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId } })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
  return new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function setMaxRoomRounds(repository: Parameters<typeof commandBase>[0], maxRoomRounds: number): void {
  const settings = repository.getSnapshot().settings;
  repository.executeCommand({
    ...commandBase(repository), type: "update_settings", model: settings.model, availableModels: settings.availableModels,
    apiFormat: "responses", thinkingMode: settings.thinkingMode, reasoningEffort: settings.reasoningEffort,
    contextTokenThreshold: settings.contextTokenThreshold, maxToolSteps: settings.maxToolSteps, maxRoomRounds,
    projectContextRoots: settings.projectContextRoots,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCronRunTrackerForTests();
  restoreEnvironment("apiKey", "OPENAI_API_KEY");
  restoreEnvironment("baseUrl", "OPENAI_BASE_URL");
  restoreEnvironment("apiFormat", "OPENAI_API_FORMAT");
});

describe("房间消息自动打断", () => {
  it("新用户消息中止旧模型流并由下一轮接管全部未处理消息", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount === 1) {
        markFirstStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return completedResponse("已接管新旧任务", "response_after_interrupt");
    });
    vi.stubGlobal("fetch", fetchMock);

    await withRepository(async (repository) => {
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "第一条长任务");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;

      sendUser(repository, "room_harbor", "第二条紧急补充");
      scheduler.enqueue("room_harbor", { interruptActive: true });

      await waitUntil(() => {
        const room = repository.getRoom("room_harbor")!;
        return room.scheduler.status === "idle" && room.turns.length === 2 && room.turns.every((turn) => turn.status !== "running");
      });

      const room = repository.getRoom("room_harbor")!;
      expect(room.turns.map((turn) => turn.status)).toEqual(["continued", "completed"]);
      expect(room.turns[0]?.modelMeta).toMatchObject({ format: "responses" });
      expect(room.turns[1]?.userEnvelope.messages.map((message) => message.content)).toEqual(["第一条长任务", "第二条紧急补充"]);
      expect(repository.getAgentSession("navigator").some((message) => message.role === "assistant" && message.content?.includes("[被新消息打断的未完成任务快照]"))).toBe(true);
      expect(requestBodies).toHaveLength(2);
      expect(JSON.stringify(requestBodies[1]?.input)).toContain("[被新消息打断的未完成任务快照]");
      expect(JSON.stringify(requestBodies[1]?.input)).toContain("第一条长任务");
      expect(JSON.stringify(requestBodies[1]?.input)).toContain("第二条紧急补充");
      expect(JSON.stringify(requestBodies[1])).toContain("把新到达的房间消息视为信息更新事件");
      expect(JSON.stringify(requestBodies[1])).toContain("被打断的房间义务仍然是活跃义务");
      expect(JSON.stringify(requestBodies[1])).toContain("结束当前轮之前");
    });
  });

  it("另一个房间的新消息抢占同一 Agent 时先把旧房间快照交给新 run", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    let secondRoomId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount === 1) {
        markFirstStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return completedResponse("已分别完成跨房间任务", "response_cross_room", [secondRoomId, "room_harbor"]);
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({
        commandId: crypto.randomUUID(), expectedVersion: repository.getVersion().version,
        type: "create_room", title: "第二房间", agentId: "navigator",
      });
      const secondRoom = repository.getSnapshot().rooms.find((room) => room.title === "第二房间")!;
      secondRoomId = secondRoom.id;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "旧房间的长期分析");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;

      sendUser(repository, secondRoom.id, "新房间的紧急问题");
      scheduler.enqueue(secondRoom.id, { interruptActive: true });

      await waitUntil(() => {
        const first = repository.getRoom("room_harbor")!;
        const second = repository.getRoom(secondRoom.id)!;
        return first.scheduler.status === "idle" && second.scheduler.status === "idle"
          && first.turns[0]?.status === "continued" && second.turns[0]?.status === "completed";
      });

      expect(requestBodies).toHaveLength(2);
      const newInput = JSON.stringify(requestBodies[1]?.input);
      expect(newInput).toContain("[被新消息打断的未完成任务快照]");
      expect(newInput).toContain("旧房间的长期分析");
      expect(newInput).toContain("新房间的紧急问题");
    });
  });

  it("接管 run 只回复新房间时自动把未交付任务退回旧房间", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let takeoverRoomId = "";
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        markFirstStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (callCount === 2) return completedResponse("新房间先收到结果", "response_only_takeover", [takeoverRoomId]);
      if (callCount <= 5) return privateResponse("仍未向旧房间交付", `response_ignored_repair_${callCount}`);
      return completedResponse("旧房间补交最终结果", "response_source_retry");
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "只回复新房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "只回复新房间")!;
      takeoverRoomId = takeoverRoom.id;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "旧房间任务不能丢");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;
      sendUser(repository, takeoverRoom.id, "新房间任务");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });

      await waitUntil(() => {
        const source = repository.getRoom("room_harbor")!;
        const takeover = repository.getRoom(takeoverRoom.id)!;
        return source.scheduler.status === "idle" && takeover.scheduler.status === "idle"
          && source.messages.some((message) => message.content === "旧房间补交最终结果")
          && takeover.messages.some((message) => message.content === "新房间先收到结果");
      });

      expect(callCount).toBe(6);
      expect(repository.getRoom("room_harbor")!.turns.map((turn) => turn.status)).toEqual(["continued", "completed"]);
      expect(repository.getRoom(takeoverRoom.id)!.turns.map((turn) => turn.status)).toEqual(["continued"]);
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("缺少最终回复时只重试投递而不重放已经执行的副作用", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount === 1) return toolResponse("create_room", { title: "副作用只能执行一次", agentIds: [] }, "response_create_once");
      if (callCount <= 4) return privateResponse("任务已做完，但仍未公开结果", `response_missing_delivery_${callCount}`);
      return completedResponse("补交既有任务结果", "response_delivery_only");
    }));

    await withRepository(async (repository) => {
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "创建一个房间并汇报结果");
      scheduler.enqueue("room_harbor", { interruptActive: true });

      await waitUntil(() => {
        const room = repository.getRoom("room_harbor")!;
        return room.scheduler.status === "idle" && room.messages.some((message) => message.content === "补交既有任务结果");
      });

      expect(callCount).toBe(5);
      expect(repository.getSnapshot().rooms.filter((room) => room.title === "副作用只能执行一次")).toHaveLength(1);
      expect(repository.getRoom("room_harbor")!.turns.map((turn) => turn.userEnvelope.type)).toEqual(["scheduler_packet", "delivery_packet"]);
      const retryTools = requestBodies[4]?.tools as Array<{ name: string }>;
      expect(retryTools.map((tool) => tool.name).sort()).toEqual(["read_no_reply", "send_message_to_room"]);
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("接管 run 达到错误重试上限时把旧任务退回原房间", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount === 1) {
        markFirstStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (callCount === 2) return new Response("provider failed", { status: 500 });
      return completedResponse("原房间已恢复", "response_fallback");
    }));

    await withRepository(async (repository) => {
      setMaxRoomRounds(repository, 1);
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "失败接管房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "失败接管房间")!;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "不能丢失的旧任务");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;
      sendUser(repository, takeoverRoom.id, "会调用失败的新任务");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });

      await waitUntil(() => {
        const source = repository.getRoom("room_harbor")!;
        const takeover = repository.getRoom(takeoverRoom.id)!;
        return source.scheduler.status === "idle" && takeover.scheduler.status === "idle"
          && source.turns.map((turn) => turn.status).join(",") === "continued,completed"
          && takeover.turns[0]?.status === "error";
      });

      expect(callCount).toBe(3);
      expect(JSON.stringify(requestBodies[2]?.input)).toContain("不能丢失的旧任务");
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("接管房间被停止时把旧任务退回原房间", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      if (callCount <= 2) {
        if (callCount === 1) markFirstStarted(); else markSecondStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return completedResponse("停止后恢复原任务", "response_after_stop");
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "会被停止的房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "会被停止的房间")!;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "停止后也要恢复的旧任务");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;
      sendUser(repository, takeoverRoom.id, "接管中的任务");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });
      await secondStarted;
      scheduler.stop(takeoverRoom.id);

      await waitUntil(() => {
        const source = repository.getRoom("room_harbor")!;
        return source.scheduler.status === "idle" && source.turns.map((turn) => turn.status).join(",") === "continued,completed";
      });

      expect(repository.getRoom(takeoverRoom.id)!.turns[0]?.status).toBe("stopped");
      expect(callCount).toBe(3);
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("接管房间在目标 turn 启动前停止也不会遗留悬空 handoff", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        markFirstStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return completedResponse("启动前停止后恢复", "response_before_start_stop");
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "立即停止的接管房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "立即停止的接管房间")!;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "接管未启动也不能丢失");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;
      sendUser(repository, takeoverRoom.id, "尚未开始的接管消息");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });
      scheduler.stop(takeoverRoom.id);

      await waitUntil(() => {
        const source = repository.getRoom("room_harbor")!;
        return source.scheduler.status === "idle" && source.turns.map((turn) => turn.status).join(",") === "continued,completed";
      });

      expect(repository.getRoom(takeoverRoom.id)!.turns).toHaveLength(0);
      expect(callCount).toBe(2);
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("停止原房间会取消已转交任务且不会重新启动原房间", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    let takeoverRoomId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount <= 2) {
        if (callCount === 1) markFirstStarted(); else markSecondStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return completedResponse("只继续接管房间自己的任务", "response_after_source_stop", [takeoverRoomId]);
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "来源停止接管房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "来源停止接管房间")!;
      takeoverRoomId = takeoverRoom.id;
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "随后会被明确取消的旧任务");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await firstStarted;
      sendUser(repository, takeoverRoom.id, "接管房间自己的新任务");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });
      await secondStarted;

      scheduler.stop("room_harbor");

      await waitUntil(() => {
        const source = repository.getRoom("room_harbor")!;
        const takeover = repository.getRoom(takeoverRoom.id)!;
        return source.scheduler.status === "idle" && takeover.scheduler.status === "idle"
          && source.turns.map((turn) => turn.status).join(",") === "continued"
          && takeover.turns.map((turn) => turn.status).join(",") === "continued,completed";
      });

      expect(callCount).toBe(3);
      expect(JSON.stringify(requestBodies[2]?.input)).toContain("[任务取消通知]");
      expect(JSON.stringify(requestBodies[2]?.input)).toContain("取消此前从该房间转交的未完成任务");
      expect(repository.getRoom("room_harbor")!.turns).toHaveLength(1);
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
    });
  });

  it("启用 Agent 处理历史用户消息时不会抢占其他房间的新任务", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markActiveStarted!: () => void;
    let finishActive!: (response: Response) => void;
    const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve; });
    const activeResponse = new Promise<Response>((resolve) => { finishActive = resolve; });
    let activeAborted = false;
    let callCount = 0;
    let historicalRoomId = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        markActiveStarted();
        return await new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => { activeAborted = true; reject(signal.reason); }, { once: true });
          activeResponse.then(resolve, reject);
        });
      }
      return completedResponse("历史消息已处理", "response_historical_message", [historicalRoomId]);
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "历史消息房间" });
      const historicalRoom = repository.getSnapshot().rooms.find((room) => room.title === "历史消息房间")!;
      historicalRoomId = historicalRoom.id;
      sendUser(repository, historicalRoom.id, "Agent 加入前的历史消息");
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      sendUser(repository, "room_harbor", "正在执行的新任务");
      scheduler.enqueue("room_harbor", { interruptActive: true });
      await activeStarted;

      repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: historicalRoom.id, agentId: "navigator" });
      scheduler.enqueue(historicalRoom.id);
      await waitUntil(() => repository.getRoom(historicalRoom.id)!.turns.length === 1);

      expect(callCount).toBe(1);
      expect(activeAborted).toBe(false);
      finishActive(completedResponse("新任务先完成", "response_active_first"));
      await waitUntil(() => {
        const activeRoom = repository.getRoom("room_harbor")!;
        const oldRoom = repository.getRoom(historicalRoom.id)!;
        return activeRoom.turns[0]?.status === "completed" && oldRoom.turns[0]?.status === "completed";
      });
      expect(callCount).toBe(2);
    });
  });

  it("跨房间接管 Cron 时直到接管成功才完成 Cron run", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markCronStarted!: () => void;
    let markTakeoverStarted!: () => void;
    let finishTakeover!: (response: Response) => void;
    const cronStarted = new Promise<void>((resolve) => { markCronStarted = resolve; });
    const takeoverStarted = new Promise<void>((resolve) => { markTakeoverStarted = resolve; });
    const takeoverResponse = new Promise<Response>((resolve) => { finishTakeover = resolve; });
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      if (callCount === 1) {
        markCronStarted();
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      markTakeoverStarted();
      return takeoverResponse;
    }));

    await withRepository(async (repository) => {
      repository.executeCommand({ ...commandBase(repository), type: "create_room", title: "Cron 接管房间", agentId: "navigator" });
      const takeoverRoom = repository.getSnapshot().rooms.find((room) => room.title === "Cron 接管房间")!;
      repository.executeCommand({
        ...commandBase(repository), type: "create_cron", roomId: "room_harbor", agentId: "navigator",
        name: "接管测试", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "执行长期 Cron",
      });
      const job = repository.getSnapshot().cronJobs[0]!;
      const cron = repository.appendCronMessage(job.id);
      trackCronRun(cron.roomId, cron.runId);
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      scheduler.enqueue(cron.roomId);
      await cronStarted;
      sendUser(repository, takeoverRoom.id, "打断 Cron 的紧急消息");
      scheduler.enqueue(takeoverRoom.id, { interruptActive: true });
      await takeoverStarted;

      expect(repository.getSnapshot().cronRuns.find((run) => run.id === cron.runId)?.status).toBe("running");
      finishTakeover(completedResponse("Cron 已由新 run 接管", "response_cron_takeover", [takeoverRoom.id, "room_harbor"]));
      await waitUntil(() => repository.getSnapshot().cronRuns.find((run) => run.id === cron.runId)?.status === "completed");
      expect(callCount).toBe(2);
    });
  });

  it("多 Agent 房间会等待每个持久化投递义务后再完成 Cron", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let markDeliveryRetryStarted!: () => void;
    let finishDeliveryRetry!: (response: Response) => void;
    const deliveryRetryStarted = new Promise<void>((resolve) => { markDeliveryRetryStarted = resolve; });
    const deliveryRetryResponse = new Promise<Response>((resolve) => { finishDeliveryRetry = resolve; });
    const requestBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      callCount += 1;
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount <= 3) return privateResponse("领航员尚未公开 Cron 结果", `response_cron_private_${callCount}`);
      if (callCount === 4) return completedResponse("执行者已完成自己的处理", "response_builder_cron");
      markDeliveryRetryStarted();
      return deliveryRetryResponse;
    }));

    await withRepository(async (repository) => {
      setMaxRoomRounds(repository, 3);
      repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: "room_harbor", agentId: "builder" });
      repository.executeCommand({
        ...commandBase(repository), type: "create_cron", roomId: "room_harbor", agentId: "navigator",
        name: "多 Agent 投递测试", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "执行并分别交付结果",
      });
      const job = repository.getSnapshot().cronJobs[0]!;
      const cron = repository.appendCronMessage(job.id);
      trackCronRun(cron.roomId, cron.runId);
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      scheduler.enqueue(cron.roomId);

      await deliveryRetryStarted;
      expect(repository.getSnapshot().cronRuns.find((run) => run.id === cron.runId)?.status).toBe("running");
      expect(repository.getRoom("room_harbor")!.turns.at(-1)?.userEnvelope.type).toBe("delivery_packet");
      const retryTools = requestBodies[4]?.tools as Array<{ name: string }>;
      expect(retryTools.map((tool) => tool.name).sort()).toEqual(["read_no_reply", "send_message_to_room"]);

      finishDeliveryRetry(completedResponse("领航员补交 Cron 最终结果", "response_navigator_cron_retry"));
      await waitUntil(() => repository.getSnapshot().cronRuns.find((run) => run.id === cron.runId)?.status === "completed");
      expect(callCount).toBe(5);
    });
  });

  it("多 Agent Cron 达到最大轮次时把未交付义务明确标记为失败", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://example.test/v1";
    process.env.OPENAI_API_FORMAT = "responses";
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => {
      callCount += 1;
      if (callCount <= 3) return privateResponse("领航员始终没有公开结果", `response_cron_exhausted_${callCount}`);
      return completedResponse("执行者已完成自己的处理", "response_builder_before_failure");
    }));

    await withRepository(async (repository) => {
      setMaxRoomRounds(repository, 2);
      repository.executeCommand({ ...commandBase(repository), type: "add_agent", roomId: "room_harbor", agentId: "builder" });
      repository.executeCommand({
        ...commandBase(repository), type: "create_cron", roomId: "room_harbor", agentId: "navigator",
        name: "投递耗尽测试", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "必须公开结果",
      });
      const job = repository.getSnapshot().cronJobs[0]!;
      const cron = repository.appendCronMessage(job.id);
      trackCronRun(cron.roomId, cron.runId);
      const scheduler = new RoomScheduler(repository, new AgentExecutor());
      scheduler.enqueue(cron.roomId);

      await waitUntil(() => repository.getSnapshot().cronRuns.find((run) => run.id === cron.runId)?.status === "error");
      const run = repository.getSnapshot().cronRuns.find((entry) => entry.id === cron.runId)!;
      expect(run.error).toContain("最大轮次");
      expect(repository.getRoom("room_harbor")!.turns[0]).toMatchObject({ status: "error", error: "结果投递在房间最大轮次内仍未完成" });
      expect((repository.raw.prepare("SELECT COUNT(*) count FROM turn_handoffs").get() as { count: number }).count).toBe(0);
      expect(callCount).toBe(4);
    });
  });
});
