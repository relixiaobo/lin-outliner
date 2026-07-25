export interface MemoryServiceLifecycle {
  stopWorker(): Promise<void>;
  closeStore(): void;
}

export interface ThreadServiceLifecycle {
  close(): Promise<void>;
}

export interface AutomationServiceLifecycle {
  stop(): Promise<void>;
  closeStore(): void;
}

export async function closeAgentServices(
  memory: MemoryServiceLifecycle,
  threads: ThreadServiceLifecycle,
  automations?: AutomationServiceLifecycle,
): Promise<void> {
  const failures: unknown[] = [];
  for (const stop of [
    () => automations?.stop() ?? Promise.resolve(),
    () => memory.stopWorker(),
  ]) {
    try {
      await stop();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await threads.close();
  } catch (error) {
    failures.push(error);
  }
  for (const close of [
    () => memory.closeStore(),
    () => automations?.closeStore(),
  ]) {
    try {
      close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Agent services failed to close cleanly');
}
