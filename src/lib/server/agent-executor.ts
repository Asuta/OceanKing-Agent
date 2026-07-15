type ActiveRun = { roomId: string; controller: AbortController };
type SupersedeState = { cutoffRequestId: number; nextRoomId: string };
type AgentRunOptions = {
  supersedeActive?: boolean;
  onSuperseded?: (error: AgentRunSupersededError) => void | Promise<void>;
};

export class AgentRunSupersededError extends Error {
  originalError?: unknown;

  constructor(
    public readonly agentId: string,
    public readonly previousRoomId: string,
    public readonly nextRoomId: string,
  ) {
    super(previousRoomId === nextRoomId
      ? "同一房间的新消息已接管当前 Agent 任务"
      : `房间 ${nextRoomId} 的新消息已接管 Agent 在房间 ${previousRoomId} 的任务`);
    this.name = "AgentRunSupersededError";
  }
}

export class AgentExecutor {
  private tails = new Map<string, Promise<void>>();
  private active = new Map<string, ActiveRun>();
  private stoppedRooms = new Set<string>();
  private nextRequestId = 0;
  private supersedeState = new Map<string, SupersedeState>();

  allowRoom(roomId: string): void { this.stoppedRooms.delete(roomId); }

  private supersedeAgent(agentId: string, nextRoomId: string, cutoffRequestId: number): void {
    this.supersedeState.set(agentId, { cutoffRequestId, nextRoomId });
    const active = this.active.get(agentId);
    if (active) active.controller.abort(new AgentRunSupersededError(agentId, active.roomId, nextRoomId));
  }

  async run<T>(
    agentId: string,
    roomId: string,
    task: (signal: AbortSignal) => Promise<T>,
    options: AgentRunOptions = {},
  ): Promise<T> {
    const requestId = ++this.nextRequestId;
    if (options.supersedeActive) this.supersedeAgent(agentId, roomId, requestId);
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(agentId, previous.catch(() => undefined).then(() => gate));
    await previous.catch(() => undefined);
    if (this.stoppedRooms.has(roomId)) { release(); throw new DOMException("房间已停止", "AbortError"); }
    const superseded = this.supersedeState.get(agentId);
    if (superseded && requestId < superseded.cutoffRequestId) {
      const error = new AgentRunSupersededError(agentId, roomId, superseded.nextRoomId);
      try { await options.onSuperseded?.(error); }
      finally { release(); }
      throw error;
    }
    const controller = new AbortController(); this.active.set(agentId, { roomId, controller });
    try {
      let result!: T;
      let taskError: unknown;
      let taskFailed = false;
      try { result = await task(controller.signal); }
      catch (error) { taskFailed = true; taskError = error; }
      const reason = controller.signal.reason;
      if (reason instanceof AgentRunSupersededError) {
        if (taskFailed && taskError !== reason) reason.originalError = taskError;
        await options.onSuperseded?.(reason);
        throw reason;
      }
      if (taskFailed) throw taskError;
      return result;
    }
    finally { this.active.delete(agentId); release(); }
  }

  interruptAgentsForNewMessage(roomId: string, agentIds: string[]): void {
    for (const agentId of new Set(agentIds)) {
      this.supersedeAgent(agentId, roomId, ++this.nextRequestId);
    }
  }

  stopRoom(roomId: string): void {
    this.stoppedRooms.add(roomId);
    for (const active of this.active.values()) if (active.roomId === roomId) active.controller.abort();
  }
}

const globalExecutor = globalThis as typeof globalThis & { __oceanKingAgentExecutor?: AgentExecutor };
export function getAgentExecutor(): AgentExecutor { globalExecutor.__oceanKingAgentExecutor ??= new AgentExecutor(); return globalExecutor.__oceanKingAgentExecutor; }
