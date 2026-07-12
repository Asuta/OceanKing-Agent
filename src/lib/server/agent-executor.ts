type ActiveRun = { roomId: string; controller: AbortController };

class AgentExecutor {
  private tails = new Map<string, Promise<void>>();
  private active = new Map<string, ActiveRun>();
  private stoppedRooms = new Set<string>();

  allowRoom(roomId: string): void { this.stoppedRooms.delete(roomId); }

  async run<T>(agentId: string, roomId: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(agentId, previous.catch(() => undefined).then(() => gate));
    await previous.catch(() => undefined);
    if (this.stoppedRooms.has(roomId)) { release(); throw new DOMException("房间已停止", "AbortError"); }
    const controller = new AbortController(); this.active.set(agentId, { roomId, controller });
    try { return await task(controller.signal); }
    finally { this.active.delete(agentId); release(); }
  }

  stopRoom(roomId: string): void {
    this.stoppedRooms.add(roomId);
    for (const active of this.active.values()) if (active.roomId === roomId) active.controller.abort();
  }
}

const globalExecutor = globalThis as typeof globalThis & { __oceanKingAgentExecutor?: AgentExecutor };
export function getAgentExecutor(): AgentExecutor { globalExecutor.__oceanKingAgentExecutor ??= new AgentExecutor(); return globalExecutor.__oceanKingAgentExecutor; }
