import type {
  AgentCoreExtension,
  ExtensionStateScope,
  ExtensionStateStore,
  ExtensionToolContribution,
  OrderedTurnItemContribution,
  ThreadContextContribution,
  ToolLifecycleContext,
  ToolLifecycleResult,
  TurnAdmissionContext,
  TurnAdmissionContribution,
} from '../../core/agent/extensions';
import type { AgentCoreNotification, Thread, Turn } from '../../core/agent/protocol';

export class ExtensionRegistry {
  private readonly extensions: AgentCoreExtension[] = [];

  register(extension: AgentCoreExtension): void {
    if (!extension.id.trim()) throw new Error('Agent Core extension id must be non-empty');
    if (this.extensions.some((candidate) => candidate.id === extension.id)) {
      throw new Error(`Duplicate Agent Core extension: ${extension.id}`);
    }
    this.extensions.push(extension);
  }

  all(): readonly AgentCoreExtension[] {
    return [...this.extensions];
  }

  async threadStarted(thread: Thread): Promise<void> {
    await this.invoke((extension) => extension.onThreadStarted?.(thread));
  }

  async threadResumed(thread: Thread): Promise<void> {
    await this.invoke((extension) => extension.onThreadResumed?.(thread));
  }

  async threadIdle(thread: Thread): Promise<void> {
    await this.invoke((extension) => extension.onThreadIdle?.(thread));
  }

  async threadStopped(thread: Thread): Promise<void> {
    await this.invoke((extension) => extension.onThreadStopped?.(thread));
  }

  async contributeAdmission(context: TurnAdmissionContext): Promise<readonly TurnAdmissionContribution[]> {
    return this.collect(async (extension) => extension.contributeTurnAdmission?.(context) ?? null);
  }

  async turnStarted(thread: Thread, turn: Turn): Promise<void> {
    await this.invoke((extension) => extension.onTurnStarted?.(thread, turn));
  }

  async turnStopped(thread: Thread, turn: Turn): Promise<void> {
    await this.invoke((extension) => extension.onTurnStopped?.(thread, turn));
  }

  async turnAborted(thread: Thread, turn: Turn): Promise<void> {
    await this.invoke((extension) => extension.onTurnAborted?.(thread, turn));
  }

  async turnError(thread: Thread, turn: Turn, error: Error): Promise<void> {
    await this.invoke((extension) => extension.onTurnError?.(thread, turn, error));
  }

  async threadContext(thread: Thread): Promise<readonly ThreadContextContribution[]> {
    return this.collect(async (extension) => extension.contributeThreadContext?.(thread) ?? null);
  }

  async tools(thread: Thread): Promise<readonly ExtensionToolContribution[]> {
    return this.collect(async (extension) => extension.contributeTools?.(thread) ?? null);
  }

  async toolStarted(context: ToolLifecycleContext): Promise<void> {
    await this.invoke((extension) => extension.onToolStarted?.(context));
  }

  async toolCompleted(context: ToolLifecycleResult): Promise<void> {
    await this.invoke((extension) => extension.onToolCompleted?.(context));
  }

  async turnItems(thread: Thread, turn: Turn): Promise<readonly OrderedTurnItemContribution[]> {
    const values: OrderedTurnItemContribution[] = [];
    for (const extension of this.extensions) {
      const contributed = await extension.contributeTurnItems?.(thread, turn);
      if (contributed) values.push(...contributed);
    }
    return values;
  }

  async notification(notification: AgentCoreNotification): Promise<void> {
    await this.invoke((extension) => extension.onNotification?.(notification));
  }

  private async invoke(
    operation: (extension: AgentCoreExtension) => void | Promise<void> | undefined,
  ): Promise<void> {
    for (const extension of this.extensions) await operation(extension);
  }

  private async collect<T>(
    operation: (extension: AgentCoreExtension) => T | null | Promise<T | null>,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    for (const extension of this.extensions) {
      const value = await operation(extension);
      if (value !== null) values.push(value);
    }
    return values;
  }
}

export class InMemoryExtensionStateStore<T> implements ExtensionStateStore<T> {
  private readonly values = new Map<string, T>();

  get(extensionId: string, scope: ExtensionStateScope): T | undefined {
    return this.values.get(scopeKey(extensionId, scope));
  }

  set(extensionId: string, scope: ExtensionStateScope, value: T): void {
    this.values.set(scopeKey(extensionId, scope), value);
  }

  delete(extensionId: string, scope: ExtensionStateScope): void {
    this.values.delete(scopeKey(extensionId, scope));
  }
}

function scopeKey(extensionId: string, scope: ExtensionStateScope): string {
  switch (scope.kind) {
    case 'hostSession':
      return JSON.stringify([extensionId, scope.kind]);
    case 'thread':
      return JSON.stringify([extensionId, scope.kind, scope.threadId]);
    case 'turn':
      return JSON.stringify([extensionId, scope.kind, scope.threadId, scope.turnId]);
  }
}
