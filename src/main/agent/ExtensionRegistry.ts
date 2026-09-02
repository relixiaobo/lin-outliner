import type {
  AgentCoreExtension,
  ExtensionStateScope,
  ExtensionStateStore,
  ExtensionToolContribution,
  OrderedTurnItemContribution,
  ThreadContextContribution,
  ToolLifecycleContext,
  ToolLifecycleResult,
  ThreadHistoryRollbackContext,
  TurnAdmissionContext,
  TurnAdmissionContribution,
} from '../../core/agent/extensions';
import type { AgentCoreRecordedNotification, Thread, Turn } from '../../core/agent/protocol';

export interface ExtensionCapabilities {
  readonly applicationInstructions?: true;
}

export interface AdmittedThreadContextContribution extends ThreadContextContribution {
  readonly applicationInstructions: boolean;
}

interface RegisteredExtension {
  readonly extension: AgentCoreExtension;
  readonly applicationInstructions: boolean;
}

export class ExtensionRegistry {
  private readonly registrations: RegisteredExtension[] = [];

  register(extension: AgentCoreExtension, capabilities: ExtensionCapabilities = {}): void {
    if (!extension.id.trim()) throw new Error('Agent Core extension id must be non-empty');
    if (this.registrations.some((candidate) => candidate.extension.id === extension.id)) {
      throw new Error(`Duplicate Agent Core extension: ${extension.id}`);
    }
    const rollbackHookCount = [
      extension.prepareHistoryRollback,
      extension.abortHistoryRollback,
      extension.commitHistoryRollback,
    ].filter(Boolean).length;
    if (rollbackHookCount !== 0 && rollbackHookCount !== 3) {
      throw new Error(`Extension must implement the complete history rollback lifecycle: ${extension.id}`);
    }
    this.registrations.push({
      extension,
      applicationInstructions: capabilities.applicationInstructions === true,
    });
  }

  all(): readonly AgentCoreExtension[] {
    return this.registrations.map(({ extension }) => extension);
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

  historyRollbackExtensions(): readonly AgentCoreExtension[] {
    return this.all().filter((extension) => extension.prepareHistoryRollback);
  }

  async invokeHistoryRollbackHook(
    extension: AgentCoreExtension,
    target: 'prepare' | 'abort' | 'commit',
    context: ThreadHistoryRollbackContext,
  ): Promise<void> {
    switch (target) {
      case 'prepare':
        await extension.prepareHistoryRollback?.(context);
        return;
      case 'abort':
        await extension.abortHistoryRollback?.(context);
        return;
      case 'commit':
        await extension.commitHistoryRollback?.(context);
        return;
    }
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

  async threadContext(thread: Thread): Promise<readonly AdmittedThreadContextContribution[]> {
    const contributions: AdmittedThreadContextContribution[] = [];
    for (const { extension, applicationInstructions } of this.registrations) {
      if (!extension.contributeThreadContext) continue;
      const contribution = await extension.contributeThreadContext(thread);
      if (contribution && contribution.extensionId !== extension.id) {
        throw new Error(`Extension context contribution owner mismatch: ${extension.id}`);
      }
      contributions.push({
        ...(contribution ?? { extensionId: extension.id, additionalContext: {} }),
        applicationInstructions,
      });
    }
    return contributions;
  }

  async tools(thread: Thread): Promise<readonly ExtensionToolContribution[]> {
    const contributions: ExtensionToolContribution[] = [];
    for (const { extension } of this.registrations) {
      const contribution = await extension.contributeTools?.(thread) ?? null;
      if (!contribution) continue;
      if (contribution.extensionId !== extension.id) {
        throw new Error(`Extension tool contribution owner mismatch: ${extension.id}`);
      }
      contributions.push(contribution);
    }
    return contributions;
  }

  async toolStarted(context: ToolLifecycleContext): Promise<void> {
    await this.invoke((extension) => extension.onToolStarted?.(context));
  }

  async toolCompleted(context: ToolLifecycleResult): Promise<void> {
    await this.invoke((extension) => extension.onToolCompleted?.(context));
  }

  async turnItems(thread: Thread, turn: Turn): Promise<readonly OrderedTurnItemContribution[]> {
    const values: OrderedTurnItemContribution[] = [];
    for (const { extension } of this.registrations) {
      const contributed = await extension.contributeTurnItems?.(thread, turn);
      if (contributed) values.push(...contributed);
    }
    return values;
  }

  async notification(notification: AgentCoreRecordedNotification): Promise<void> {
    await this.invoke((extension) => extension.onNotification?.(notification));
  }

  private async invoke(
    operation: (extension: AgentCoreExtension) => void | Promise<void> | undefined,
  ): Promise<void> {
    for (const { extension } of this.registrations) await operation(extension);
  }

  private async collect<T>(
    operation: (extension: AgentCoreExtension) => T | null | Promise<T | null>,
  ): Promise<readonly T[]> {
    const values: T[] = [];
    for (const { extension } of this.registrations) {
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
