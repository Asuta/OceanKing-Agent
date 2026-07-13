export class ResetCoordinator<T> {
  private queue: Promise<void> = Promise.resolve();
  private requests = new Map<string, Promise<T>>();

  run(commandId: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.requests.get(commandId);
    if (existing) return existing;

    const execution = this.queue.then(operation);
    const shared = execution.finally(() => {
      if (this.requests.get(commandId) === shared) this.requests.delete(commandId);
    });
    this.requests.set(commandId, shared);
    this.queue = shared.then(() => undefined, () => undefined);
    return shared;
  }
}
