export interface MemoryServiceLifecycle {
  stopWorker(): Promise<void>;
  closeStore(): void;
}

export interface ThreadServiceLifecycle {
  close(): Promise<void>;
}

export async function closeAgentServices(
  memory: MemoryServiceLifecycle,
  threads: ThreadServiceLifecycle,
): Promise<void> {
  await memory.stopWorker();
  try {
    await threads.close();
  } finally {
    memory.closeStore();
  }
}
