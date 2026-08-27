import { OutlineContractError } from '../outline/contract/errors';
import type {
  Change,
  ChangeSet,
  Diff,
  NoChangeResult,
  Operation,
  OperationLogPage,
  OutlineEvent,
  OutlineStreamRecord,
  ProjectionResult,
} from '../outline/contract/schemas';
import { OUTLINE_PROTOCOL_VERSION } from '../outline/contract/version';
import type { OutlineClient, OutlineClientSupervisor } from '../outline/client';
import {
  applyProjectionUpdate,
  projectionUpdateFromOutlineEvent,
  readCompleteDocumentProjection,
} from '../outline/client/documentProjection';
import type {
  CommandResult,
  DocumentProjection,
  FocusHint,
  NodeProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
  SearchHit,
} from '../core/types';

const EVENT_RECONNECT_MIN_DELAY_MS = 100;
const EVENT_RECONNECT_MAX_DELAY_MS = 2_000;
const OPERATION_EVENT_TIMEOUT_MS = 10_000;
const OPERATION_EVENT_CACHE_LIMIT = 256;

export interface OutlineMutationOptions {
  readonly acknowledgeDestructive?: boolean;
  readonly idempotencyKey?: string;
  readonly settlement?: 'accepted' | 'durable';
  readonly source?: ChangeSet['source'];
  readonly undoGroup?: Operation['undoGroup'];
  readonly focus?: FocusHint | ((settlement: Operation | NoChangeResult, diff: Diff, update: ProjectionUpdate) => FocusHint | undefined);
}

export interface OutlineProjectionDelivery {
  readonly event: OutlineEvent;
  readonly update: ProjectionUpdate;
}

type ProjectionListener = (delivery: OutlineProjectionDelivery) => void;

export class OutlineDocumentService {
  private requestClient: OutlineClient | null = null;
  private requestClientConnecting: Promise<OutlineClient> | null = null;
  private watchController: AbortController | null = null;
  private watchLoopPromise: Promise<void> | null = null;
  private watchReadyPromise: Promise<void> | null = null;
  private resolveWatchReady: (() => void) | null = null;
  private rejectWatchReady: ((error: Error) => void) | null = null;
  private watchReadySettled = false;
  private watchCursor: string | undefined;
  private reconnectDelayMs = EVENT_RECONNECT_MIN_DELAY_MS;
  private snapshot: ProjectionSnapshot | null = null;
  private readonly nodesById = new Map<string, NodeProjection>();
  private readonly bufferedEvents: OutlineEvent[] = [];
  private readonly listeners = new Set<ProjectionListener>();
  private readonly operationEvents = new Map<string, OutlineEvent>();
  private readonly operationWaiters = new Map<string, Set<{
    readonly resolve: (event: OutlineEvent) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>>();
  private initPromise: Promise<ProjectionSnapshot> | null = null;
  private mutationTail = Promise.resolve();
  private admissionFrozen = false;
  private admissionCommitted = false;
  private closed = false;

  constructor(private readonly supervisor: Pick<OutlineClientSupervisor, 'connect'>) {}

  init(): Promise<ProjectionSnapshot> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    if (!this.initPromise) {
      this.initPromise = this.initialize().finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  getProjection(): DocumentProjection {
    if (!this.snapshot) throw new Error('Outline Runtime Projection is not initialized.');
    return this.snapshot.projection;
  }

  liveProjection(): DocumentProjection {
    return this.getProjection();
  }

  revision(): number {
    if (!this.snapshot) throw new Error('Outline Runtime Projection is not initialized.');
    return this.snapshot.revision;
  }

  projectionNodesByIds(nodeIds: readonly string[]) {
    if (!this.snapshot) throw new Error('Outline Runtime Projection is not initialized.');
    return nodeIds.flatMap((nodeId) => {
      const node = this.nodesById.get(nodeId);
      return node ? [node] : [];
    });
  }

  onProjectionChanged(listener: ProjectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async searchNodeHits(query: string, limit: number): Promise<SearchHit[]> {
    const boundedLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    try {
      return await (await this.connectRequestClient()).searchDesktopNodes(query, boundedLimit);
    } catch (error) {
      if (!shouldReconnectRequestClient(error)) throw error;
      this.invalidateRequestClient();
      return (await this.connectRequestClient()).searchDesktopNodes(query, boundedLimit);
    }
  }

  runChanges(changes: readonly Change[], options: OutlineMutationOptions = {}): Promise<CommandResult> {
    return this.runChangeSet((revision) => ({
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.changeset',
      base: { revision },
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.source ? { source: options.source } : {}),
      operations: [...changes],
    }), options);
  }

  runChangeSet(
    build: (revision: number) => ChangeSet,
    options: OutlineMutationOptions = {},
  ): Promise<CommandResult> {
    if (this.admissionFrozen) return Promise.reject(new Error('Outline mutation admission is frozen.'));
    const idempotencyKey = options.idempotencyKey ?? `desktop:${crypto.randomUUID()}`;
    const result = this.mutationTail.then(async () => {
      const revision = this.revision();
      const input = build(revision);
      const changeSet: ChangeSet = {
        ...input,
        base: { ...input.base, revision },
        idempotencyKey: input.idempotencyKey ?? idempotencyKey,
      };
      const acceptedReceipt = options.acknowledgeDestructive || options.settlement === 'durable'
        ? null
        : await (await this.connectRequestClient()).commitDesktopChangeSet(changeSet, options.undoGroup);
      const accepted = acceptedReceipt as (typeof acceptedReceipt & { readonly update: ProjectionUpdate });
      const diff = accepted?.diff ?? await this.request<Diff>('diff', { changeSet });
      const settlement = accepted?.settlement ?? await this.request<Operation | NoChangeResult>('apply', {
        diff,
        ...(options.acknowledgeDestructive ? { acknowledgeDestructive: true } : {}),
      });
      const update = accepted?.update ?? (settlement.kind === 'outline.no-change'
        ? await this.currentFullUpdate(settlement.revision)
        : await this.updateFromOwnOperation(settlement.operationId));
      if (accepted) this.acceptOwnUpdate(settlement, update);
      return {
        update,
        ...(options.focus ? {
          focus: typeof options.focus === 'function'
            ? options.focus(settlement, diff, update)
            : options.focus,
        } : {}),
      };
    });
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private currentFullUpdate(revision: number): ProjectionUpdate {
    if (!this.snapshot) throw new Error('Outline Runtime Projection is not initialized.');
    return { kind: 'full', revision, projection: this.snapshot.projection };
  }

  private acceptOwnUpdate(settlement: Operation | NoChangeResult, update: ProjectionUpdate): void {
    if (!this.snapshot || update.revision <= this.snapshot.revision) return;
    this.snapshot = {
      revision: update.revision,
      projection: applyProjectionUpdate(this.snapshot.projection, update),
    };
    this.applyNodeUpdate(update);
    const operation = settlement.kind === 'outline.operation' ? settlement : undefined;
    this.emit({
      event: {
        protocolVersion: OUTLINE_PROTOCOL_VERSION,
        kind: 'outline.event',
        type: operation?.revertsOperationId ? 'operation.reverted' : 'operation.committed',
        instanceId: 'desktop:accepted',
        sequence: 0,
        revision: update.revision,
        cursor: `desktop:accepted:${update.revision}`,
        ...(operation ? { operation } : {}),
        ...(update.kind === 'delta' ? {
          changes: {
            todayId: update.todayId,
            changedNodes: update.changedNodes,
            removedIds: update.removedIds,
          },
        } : {}),
      },
      update,
    });
  }

  async log(input: {
    readonly operationId?: string;
    readonly idempotencyKey?: string;
    readonly limit?: number;
  }): Promise<readonly Operation[]> {
    return (await this.request<OperationLogPage>('log', input)).operations;
  }

  freezeMutationAdmission(): void {
    this.admissionFrozen = true;
  }

  async unfreezeMutationAdmission(): Promise<void> {
    if (this.admissionCommitted) return;
    const status = await this.manageRuntime('unfreeze');
    if (!status.admissionFrozen) this.admissionFrozen = false;
  }

  async commitMutationAdmissionFreeze(): Promise<void> {
    await this.manageRuntime('commit-freeze');
    this.admissionFrozen = true;
    this.admissionCommitted = true;
  }

  async latestAcceptedRevision(): Promise<number> {
    const status = await this.manageRuntime('freeze');
    return status.acceptedRevision;
  }

  async durableRevision(): Promise<number> {
    return (await this.manageRuntime('status')).durableRevision;
  }

  async drainToRevision(target: number): Promise<void> {
    await this.manageRuntime('drain', target);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.watchController?.abort();
    this.watchController = null;
    this.requestClient?.close();
    this.requestClient = null;
    for (const waiters of this.operationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Outline document service closed.'));
      }
    }
    this.operationWaiters.clear();
    this.listeners.clear();
  }

  private async initialize(): Promise<ProjectionSnapshot> {
    if (this.closed) throw new Error('Outline document service is closed.');
    this.startWatchLoop();
    await this.watchReadyPromise;
    const snapshot = await this.readProjection();
    this.snapshot = snapshot;
    this.reseedNodeIndex(snapshot.projection);
    const pending = this.bufferedEvents.splice(0).sort((left, right) => left.sequence - right.sequence);
    for (const event of pending) await this.acceptEvent(event);
    return this.snapshot;
  }

  private startWatchLoop(): void {
    if (this.watchLoopPromise || this.closed) return;
    this.watchController = new AbortController();
    this.watchReadyPromise = new Promise<void>((resolve, reject) => {
      this.resolveWatchReady = resolve;
      this.rejectWatchReady = reject;
    });
    this.watchLoopPromise = this.runWatchLoop(this.watchController.signal).finally(() => {
      this.watchLoopPromise = null;
    });
  }

  private async runWatchLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !this.closed) {
      let client: OutlineClient | null = null;
      try {
        client = await this.supervisor.connect();
        for await (const record of client.watchSubscription(
          this.watchCursor ? { cursor: this.watchCursor } : {},
          signal,
        )) {
          if (record.type === 'hello') {
            if (record.cursor) this.watchCursor = record.cursor;
            this.reconnectDelayMs = EVENT_RECONNECT_MIN_DELAY_MS;
            this.setWatchReady();
          } else if (record.type === 'event') {
            this.watchCursor = record.cursor;
            if (!this.snapshot) this.bufferedEvents.push(record.event);
            else await this.acceptEvent(record.event);
          } else if (record.type === 'error') {
            throw new OutlineContractError(record.error);
          }
        }
      } catch (error) {
        if (signal.aborted || this.closed) break;
        if (!this.watchReadySettled) {
          this.watchReadySettled = true;
          this.rejectWatchReady?.(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      } finally {
        client?.close();
      }
      if (signal.aborted || this.closed) break;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(EVENT_RECONNECT_MAX_DELAY_MS, delay * 2);
      await wait(delay, signal);
    }
  }

  private setWatchReady(): void {
    if (this.watchReadySettled) return;
    this.watchReadySettled = true;
    this.resolveWatchReady?.();
  }

  private async acceptEvent(event: OutlineEvent): Promise<void> {
    this.rememberOperation(event);
    if (!this.snapshot) {
      this.bufferedEvents.push(event);
      return;
    }
    if (event.revision <= this.snapshot.revision) return;
    const update = projectionUpdateFromOutlineEvent<NodeProjection>(event);
    if (event.type === 'resync.required' || !update || update.revision !== this.snapshot.revision + 1) {
      await this.resyncUpdate();
      return;
    }
    this.snapshot = {
      revision: update.revision,
      projection: applyProjectionUpdate(this.snapshot.projection, update),
    };
    this.applyNodeUpdate(update);
    this.emit({ event, update });
  }

  private async resyncUpdate(): Promise<ProjectionUpdate> {
    let snapshot: ProjectionSnapshot;
    try {
      snapshot = await this.readProjection();
    } catch (error) {
      if (!shouldReconnectRequestClient(error)) throw error;
      this.invalidateRequestClient();
      snapshot = await this.readProjection();
    }
    this.snapshot = snapshot;
    this.reseedNodeIndex(snapshot.projection);
    const update: ProjectionUpdate = { kind: 'full', ...snapshot };
    const event: OutlineEvent = {
      protocolVersion: OUTLINE_PROTOCOL_VERSION,
      kind: 'outline.event',
      type: 'resync.required',
      instanceId: 'desktop:resync',
      sequence: 0,
      revision: snapshot.revision,
      cursor: this.watchCursor ?? 'desktop:resync',
    };
    this.emit({ event, update });
    return update;
  }

  private readProjection(): Promise<ProjectionSnapshot> {
    return readCompleteDocumentProjection<NodeProjection>(<TResult>(command: string, input: unknown) => (
      this.request<TResult>(command, input)
    ));
  }

  private async request<TResult>(command: string, input: unknown): Promise<TResult> {
    try {
      const client = await this.connectRequestClient();
      const response = await client.request(command, input);
      return response.data as TResult;
    } catch (error) {
      if (shouldReconnectRequestClient(error)) this.invalidateRequestClient();
      throw error;
    }
  }

  private async manageRuntime(
    action: Parameters<OutlineClient['manageDesktopRuntime']>[0],
    targetRevision?: number,
  ) {
    try {
      return await (await this.connectRequestClient()).manageDesktopRuntime(action, targetRevision);
    } catch (error) {
      if (!shouldReconnectRequestClient(error)) throw error;
      this.invalidateRequestClient();
      return (await this.connectRequestClient()).manageDesktopRuntime(action, targetRevision);
    }
  }

  private async connectRequestClient(): Promise<OutlineClient> {
    if (this.requestClient) return this.requestClient;
    if (!this.requestClientConnecting) {
      this.requestClientConnecting = this.supervisor.connect().then((client) => {
        this.requestClient = client;
        return client;
      }).finally(() => {
        this.requestClientConnecting = null;
      });
    }
    return this.requestClientConnecting;
  }

  private invalidateRequestClient(): void {
    this.requestClient?.close();
    this.requestClient = null;
  }

  private applyNodeUpdate(update: ProjectionUpdate): void {
    if (update.kind === 'full') {
      this.reseedNodeIndex(update.projection);
      return;
    }
    for (const nodeId of update.removedIds) this.nodesById.delete(nodeId);
    for (const node of update.changedNodes) this.nodesById.set(node.id, node);
  }

  private reseedNodeIndex(projection: DocumentProjection): void {
    this.nodesById.clear();
    for (const node of projection.nodes) this.nodesById.set(node.id, node);
  }

  private async updateFromOwnOperation(operationId: string): Promise<ProjectionUpdate> {
    try {
      const event = await this.waitForOperation(operationId);
      return projectionUpdateFromOutlineEvent<NodeProjection>(event) ?? await this.resyncUpdate();
    } catch {
      return this.resyncUpdate();
    }
  }

  private waitForOperation(operationId: string): Promise<OutlineEvent> {
    const cached = this.operationEvents.get(operationId);
    if (cached) return Promise.resolve(cached);
    return new Promise<OutlineEvent>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const waiters = this.operationWaiters.get(operationId);
          waiters?.delete(waiter);
          if (waiters?.size === 0) this.operationWaiters.delete(operationId);
          reject(new Error(`Timed out waiting for Outline Operation Event: ${operationId}`));
        }, OPERATION_EVENT_TIMEOUT_MS),
      };
      const waiters = this.operationWaiters.get(operationId) ?? new Set();
      waiters.add(waiter);
      this.operationWaiters.set(operationId, waiters);
    });
  }

  private rememberOperation(event: OutlineEvent): void {
    const operationId = event.operation?.operationId;
    if (!operationId) return;
    this.operationEvents.delete(operationId);
    this.operationEvents.set(operationId, event);
    while (this.operationEvents.size > OPERATION_EVENT_CACHE_LIMIT) {
      const oldest = this.operationEvents.keys().next().value;
      if (!oldest) break;
      this.operationEvents.delete(oldest);
    }
    const waiters = this.operationWaiters.get(operationId);
    if (!waiters) return;
    this.operationWaiters.delete(operationId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }

  private emit(delivery: OutlineProjectionDelivery): void {
    for (const listener of this.listeners) {
      try {
        listener(delivery);
      } catch {
        // Projection consumers are observational and cannot break Runtime sync.
      }
    }
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function shouldReconnectRequestClient(error: unknown): boolean {
  if (!(error instanceof OutlineContractError)) return true;
  return error.outlineError.code === 'runtime_unavailable'
    || error.outlineError.code === 'unauthorized'
    || error.outlineError.code === 'protocol_incompatible';
}
