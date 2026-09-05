import type {
  ChangeSet,
  Diff,
  OutlineError,
  OutlineEvent,
  OutlineStreamRecord,
  NoChangeResult,
  Operation,
  Projection,
  ProjectionResult,
} from '../../outline/contract';
import type {
  CommandResult,
  DocumentProjection,
  FocusHint,
  NodeProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from '../../core/types';
import {
  fullDocumentProjection,
  projectionUpdateFromOutlineEvent,
  readCompleteDocumentProjection,
} from '../../outline/client/documentProjection';

const EVENT_RECONNECT_MIN_DELAY_MS = 100;
const EVENT_RECONNECT_MAX_DELAY_MS = 2_000;
const OPERATION_EVENT_TIMEOUT_MS = 10_000;
const OPERATION_EVENT_CACHE_LIMIT = 256;

export class OutlineRequestError extends Error {
  constructor(readonly outlineError: OutlineError) {
    super(outlineError.message);
    this.name = 'OutlineRequestError';
  }
}

export async function requestOutline<TResult>(command: string, input: unknown): Promise<TResult> {
  const bridge = window.lin?.outline;
  if (!bridge) throw new Error('Tenon Outline bridge is unavailable');
  const response = await bridge.request({
    requestId: `renderer:${crypto.randomUUID()}`,
    command,
    input,
  });
  if (!response.ok) throw new OutlineRequestError(response.error as OutlineError);
  return response.data as TResult;
}

export async function readDesktopProjection(): Promise<ProjectionSnapshot> {
  // Startup Memory writes may advance Runtime between revision-bound pages.
  // Discard the partial read and reseed; never combine pages from two revisions.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readCompleteDocumentProjection<NodeProjection>(requestOutline);
    } catch (error) {
      if (attempt >= 2 || !(error instanceof OutlineRequestError)
        || error.outlineError.code !== 'stale_revision') throw error;
    }
  }
}

export function noteDesktopProjectionApplied(revision: number): void {
  sharedEventSource?.noteRevision(revision);
}

export type DesktopFocusHint = FocusHint | ((
  settlement: Operation | NoChangeResult,
  diff: Diff,
  update: ProjectionUpdate,
) => FocusHint | undefined);

export interface DesktopMutationOptions {
  readonly acknowledgeDestructive?: boolean;
  readonly requiresDiff?: boolean;
  readonly undoGroup?: Operation['undoGroup'];
}

let desktopMutationTail = Promise.resolve();

export function runDesktopMutation(
  build: (revision: number) => ChangeSet,
  focus?: DesktopFocusHint,
  options: DesktopMutationOptions = {},
): Promise<CommandResult> {
  const idempotencyKey = `desktop:${crypto.randomUUID()}`;
  const result = desktopMutationTail.then(async () => {
    const source = sharedEventSource;
    const revision = source?.latestRevision;
    if (!source || revision === undefined) {
      throw new Error('Tenon Outline session has not loaded a document revision.');
    }
    const input = build(revision);
    const changeSet: ChangeSet = {
      ...input,
      base: { ...input.base, revision },
      idempotencyKey: input.idempotencyKey ?? idempotencyKey,
    };
    const releaseEvents = source.holdEvents();
    try {
      const needsReviewedDiff = options.acknowledgeDestructive === true
        || options.requiresDiff === true;
      const diff = needsReviewedDiff
        ? await requestOutline<Diff>('preview', { changeSet })
        : null;
      const acceptedReceipt = diff ? null : await requestAcceptedDesktopMutation(changeSet, options.undoGroup);
      const accepted = acceptedReceipt as (typeof acceptedReceipt & { readonly update: ProjectionUpdate });
      const settlement = accepted?.settlement ?? (diff
        ? await requestOutline<Operation | NoChangeResult>('apply', {
            diff,
            ...(options.acknowledgeDestructive ? { acknowledgeDestructive: true } : {}),
          })
        : neverAcceptedMutation());
      const update = accepted?.update ?? (settlement.kind === 'outline.no-change'
        ? await fullProjectionUpdate()
        : await updateFromOwnOperation(source, settlement.operationId));
      const focusDiff = accepted?.diff ?? diff ?? directCommitFocusDiff(changeSet, revision);
      return {
        update,
        ...(focus ? {
          focus: typeof focus === 'function'
            ? focus(settlement, focusDiff, update)
            : focus,
        } : {}),
      };
    } finally {
      releaseEvents();
    }
  });
  desktopMutationTail = result.then(yieldForProjectionFold, yieldForProjectionFold);
  return result;
}

function neverAcceptedMutation(): never {
  throw new Error('Desktop mutation did not produce an accepted or reviewed settlement.');
}

function requestAcceptedDesktopMutation(
  changeSet: ChangeSet,
  undoGroup?: Operation['undoGroup'],
) {
  const bridge = window.lin?.outline;
  if (!bridge) throw new Error('Tenon Outline bridge is unavailable');
  return bridge.commit({
    requestId: `renderer:${crypto.randomUUID()}`,
    changeSet,
    ...(undoGroup ? { undoGroup } : {}),
  });
}

function directCommitFocusDiff(changeSet: ChangeSet, revision: number): Diff {
  return {
    protocolVersion: 1,
    kind: 'outline.diff',
    diffHash: '0'.repeat(64),
    intentHash: '0'.repeat(64),
    changeSetHash: '0'.repeat(64),
    baseRevision: revision,
    normalizedChangeSet: changeSet,
    bindings: {},
    affected: [],
    destructive: [],
    warnings: [],
    resultEstimate: { nodeCount: 0, encodedBytes: 0 },
  };
}

export function previewDesktopMutation(build: (revision: number) => ChangeSet): Promise<Diff> {
  const revision = sharedEventSource?.latestRevision;
  if (revision === undefined) {
    return Promise.reject(new Error('Tenon Outline session has not loaded a document revision.'));
  }
  const input = build(revision);
  return requestOutline<Diff>('preview', {
    changeSet: {
      ...input,
      base: { ...input.base, revision },
      idempotencyKey: input.idempotencyKey ?? `desktop:${crypto.randomUUID()}`,
    },
  });
}

export function runDesktopHistory(command: 'undo' | 'redo'): Promise<CommandResult> {
  const idempotencyKey = `desktop:${crypto.randomUUID()}`;
  const result = desktopMutationTail.then(async () => {
    const source = sharedEventSource;
    if (!source) throw new Error('Tenon Outline session is unavailable.');
    const releaseEvents = source.holdEvents();
    try {
      const operation = await requestOutline<Operation>(command, { idempotencyKey });
      return { update: await updateFromOwnOperation(source, operation.operationId) };
    } finally {
      releaseEvents();
    }
  });
  desktopMutationTail = result.then(yieldForProjectionFold, yieldForProjectionFold);
  return result;
}

async function yieldForProjectionFold(): Promise<void> {
  await Promise.resolve();
}

export { projectionUpdateFromOutlineEvent };

async function updateFromOwnOperation(
  source: DesktopOutlineEventSource,
  operationId: string,
): Promise<ProjectionUpdate> {
  try {
    const event = await source.waitForOperation(operationId);
    return projectionUpdateFromOutlineEvent<NodeProjection>(event) ?? await fullProjectionUpdate();
  } catch {
    return fullProjectionUpdate();
  }
}

export interface DesktopOutlineEventSubscription {
  readonly ready: Promise<void>;
  readonly unsubscribe: () => void;
}

export interface DesktopProjectionSubscription {
  readonly ready: Promise<ProjectionSnapshot>;
  readonly unsubscribe: () => void;
}

type EventListener = (event: OutlineEvent) => void;
type ErrorListener = (error: Error) => void;

let sharedEventSource: DesktopOutlineEventSource | null = null;

export function subscribeDesktopOutlineEvents(
  listener: EventListener,
  onError: ErrorListener,
): DesktopOutlineEventSubscription {
  sharedEventSource ??= new DesktopOutlineEventSource();
  const source = sharedEventSource;
  const unsubscribeListener = source.add(listener, onError);
  return {
    ready: source.ready,
    unsubscribe: () => {
      unsubscribeListener();
      if (source.empty) {
        source.close();
        if (sharedEventSource === source) sharedEventSource = null;
      }
    },
  };
}

export function subscribeDesktopProjection(
  listener: (update: ProjectionUpdate) => void,
  onError: ErrorListener,
): DesktopProjectionSubscription {
  let active = true;
  let seededRevision: number | undefined;
  let buffered: OutlineEvent[] = [];
  let resyncInFlight: Promise<ProjectionSnapshot> | null = null;

  const seed = () => {
    if (resyncInFlight) return resyncInFlight;
    seededRevision = undefined;
    resyncInFlight = readDesktopProjection().then((snapshot) => {
      if (!active) return snapshot;
      listener({ kind: 'full', ...snapshot });
      seededRevision = snapshot.revision;
      noteDesktopProjectionApplied(snapshot.revision);
      const pending = buffered;
      buffered = [];
      for (const event of pending.sort((left, right) => left.sequence - right.sequence)) acceptEvent(event);
      return snapshot;
    }).finally(() => {
      resyncInFlight = null;
    });
    return resyncInFlight;
  };

  const acceptEvent = (event: OutlineEvent) => {
    if (!active) return;
    if (seededRevision === undefined) {
      buffered.push(event);
      return;
    }
    if (event.type === 'resync.required') {
      void seed().catch(onError);
      return;
    }
    if (event.revision <= seededRevision) return;
    const update = projectionUpdateFromOutlineEvent<NodeProjection>(event);
    if (!update || event.revision !== seededRevision + 1) {
      void seed().catch(onError);
      return;
    }
    listener(update);
    seededRevision = event.revision;
    noteDesktopProjectionApplied(event.revision);
  };

  const subscription = subscribeDesktopOutlineEvents(acceptEvent, onError);
  const ready = subscription.ready.then(seed);
  return {
    ready,
    unsubscribe: () => {
      active = false;
      buffered = [];
      subscription.unsubscribe();
    },
  };
}

class DesktopOutlineEventSource {
  private readonly listeners = new Set<EventListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: Error) => void;
  private unsubscribeBridge: (() => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heldEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = EVENT_RECONNECT_MIN_DELAY_MS;
  private cursor: string | undefined;
  private closed = false;
  private revision: number | undefined;
  private readonly operationEvents = new Map<string, OutlineEvent>();
  private readonly heldEvents: OutlineEvent[] = [];
  private eventHoldCount = 0;
  private readonly operationWaiters = new Map<string, Set<{
    readonly resolve: (event: OutlineEvent) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>>();
  readonly ready: Promise<void>;
  private readySettled = false;

  constructor() {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.resolveReady = resolveReady;
    this.rejectReady = rejectReady;
    this.connect();
  }

  get empty(): boolean {
    return this.listeners.size === 0;
  }

  get latestRevision(): number | undefined {
    return this.revision;
  }

  noteRevision(revision: number): void {
    this.revision = Math.max(this.revision ?? 0, revision);
  }

  waitForOperation(operationId: string): Promise<OutlineEvent> {
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

  holdEvents(): () => void {
    this.eventHoldCount += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.eventHoldCount = Math.max(0, this.eventHoldCount - 1);
      if (this.eventHoldCount !== 0 || this.heldEvents.length === 0 || this.heldEventFlushTimer) return;
      this.heldEventFlushTimer = setTimeout(() => {
        this.heldEventFlushTimer = null;
        if (this.closed || this.eventHoldCount !== 0) return;
        const pending = this.heldEvents.splice(0);
        for (const event of pending) this.dispatchEvent(event);
      }, 0);
    };
  }

  add(listener: EventListener, onError: ErrorListener): () => void {
    this.listeners.add(listener);
    this.errorListeners.add(onError);
    return () => {
      this.listeners.delete(listener);
      this.errorListeners.delete(onError);
    };
  }

  close(): void {
    this.closed = true;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heldEventFlushTimer) clearTimeout(this.heldEventFlushTimer);
    this.heldEventFlushTimer = null;
    this.heldEvents.length = 0;
    const error = new Error('Tenon Outline session closed.');
    for (const waiters of this.operationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.operationWaiters.clear();
  }

  private connect(): void {
    if (this.closed) return;
    const bridge = window.lin?.outline;
    if (!bridge) {
      this.fail(new Error('Tenon Outline bridge is unavailable'), false);
      return;
    }
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = bridge.subscribe(
      {
        subscriptionId: `renderer-watch:${crypto.randomUUID()}`,
        input: this.cursor ? { cursor: this.cursor } : {},
      },
      (record) => this.accept(record),
    );
  }

  private accept(record: OutlineStreamRecord): void {
    if (record.type === 'hello') {
      if (record.cursor) this.cursor = record.cursor;
      this.reconnectDelayMs = EVENT_RECONNECT_MIN_DELAY_MS;
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady();
      }
      return;
    }
    if (record.type === 'event') {
      this.cursor = record.cursor;
      this.rememberOperation(record.event);
      if (this.eventHoldCount > 0) this.heldEvents.push(record.event);
      else this.dispatchEvent(record.event);
      return;
    }
    if (record.type === 'error') {
      const error = new OutlineRequestError(record.error as OutlineError);
      this.fail(error, record.error.retryable === true);
      return;
    }
    if (record.type === 'end') {
      if (record.cursor) this.cursor = record.cursor;
      this.scheduleReconnect();
    }
  }

  private dispatchEvent(event: OutlineEvent): void {
    for (const listener of this.listeners) listener(event);
    if (event.type === 'resync.required') {
      this.cursor = undefined;
      this.scheduleReconnect();
    }
  }

  private fail(error: Error, retryable: boolean): void {
    if (!this.readySettled && !retryable) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const listener of this.errorListeners) listener(error);
    if (retryable) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(EVENT_RECONNECT_MAX_DELAY_MS, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private rememberOperation(event: OutlineEvent): void {
    const operationId = event.operation?.operationId;
    if (!operationId) return;
    this.operationEvents.delete(operationId);
    this.operationEvents.set(operationId, event);
    while (this.operationEvents.size > OPERATION_EVENT_CACHE_LIMIT) {
      const oldest = this.operationEvents.keys().next().value;
      if (oldest === undefined) break;
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
}

async function fullProjectionUpdate(): Promise<ProjectionUpdate> {
  const snapshot = await readDesktopProjection();
  return { kind: 'full', ...snapshot };
}
