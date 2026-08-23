import type {
  OutlineError,
  OutlineEvent,
  OutlineStreamRecord,
  Projection,
  ProjectionResult,
} from '../../outline/contract';
import type {
  DocumentProjection,
  NodeProjection,
  ProjectionSnapshot,
  ProjectionUpdate,
} from '../../core/types';

const FULL_PROJECTION_PAGE_SIZE = 10_000;
const FULL_PROJECTION_MAX_NODES = 1_000_000;
const FULL_PROJECTION_INCLUDE = [
  'description',
  'children',
  'tags',
  'fields',
  'references',
  'media',
  'view',
  'trash',
] as const;

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
  const nodes: NodeProjection[] = [];
  let first: ProjectionResult | null = null;
  let cursor: string | undefined;
  do {
    const projection = fullDesktopProjection(cursor);
    const result = await requestOutline<ProjectionResult>('show', {
      selector: { by: 'alias', alias: 'home' },
      projection,
    });
    assertProjectionResult(result);
    if (!first) first = result;
    else if (result.revision !== first.revision) {
      throw new Error('Outline Runtime changed revision while reading the desktop Projection.');
    }
    nodes.push(...result.nodes as NodeProjection[]);
    if (nodes.length > FULL_PROJECTION_MAX_NODES) {
      throw new Error('Outline Runtime desktop Projection exceeds the supported Node limit.');
    }
    cursor = result.truncated ? result.cursor : undefined;
    if (result.truncated && !cursor) {
      throw new Error('Outline Runtime returned a truncated desktop Projection without a cursor.');
    }
  } while (cursor);

  if (!first) throw new Error('Outline Runtime returned no desktop Projection page.');
  const projection: DocumentProjection = {
    ...first.anchors,
    nodes,
  };
  return { revision: first.revision, projection };
}

export function projectionUpdateFromOutlineEvent(event: OutlineEvent): ProjectionUpdate | null {
  if (!event.changes) return null;
  if (!Array.isArray(event.changes.changedNodes) || !Array.isArray(event.changes.removedIds)) {
    throw new Error('Outline Runtime Event changes are invalid.');
  }
  return {
    kind: 'delta',
    revision: event.revision,
    todayId: event.changes.todayId,
    changedNodes: event.changes.changedNodes as NodeProjection[],
    removedIds: event.changes.removedIds,
  };
}

export interface DesktopOutlineEventSubscription {
  readonly ready: Promise<void>;
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

class DesktopOutlineEventSource {
  private readonly listeners = new Set<EventListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: Error) => void;
  private unsubscribeBridge: (() => void) | null = null;
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
    const bridge = window.lin?.outline;
    if (!bridge) {
      this.fail(new Error('Tenon Outline bridge is unavailable'));
      return;
    }
    this.unsubscribeBridge = bridge.subscribe(
      { subscriptionId: `renderer-watch:${crypto.randomUUID()}`, input: {} },
      (record) => this.accept(record),
    );
  }

  get empty(): boolean {
    return this.listeners.size === 0;
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
    this.unsubscribeBridge?.();
    this.unsubscribeBridge = null;
  }

  private accept(record: OutlineStreamRecord): void {
    if (record.type === 'hello') {
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady();
      }
      return;
    }
    if (record.type === 'event') {
      for (const listener of this.listeners) listener(record.event);
      return;
    }
    if (record.type === 'error') this.fail(new OutlineRequestError(record.error as OutlineError));
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    for (const listener of this.errorListeners) listener(error);
  }
}

function fullDesktopProjection(cursor: string | undefined): Projection {
  return {
    kind: 'outline',
    targets: {
      target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' },
    },
    depth: 1_024,
    include: [...FULL_PROJECTION_INCLUDE],
    page: {
      limit: FULL_PROJECTION_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    },
  };
}

function assertProjectionResult(value: ProjectionResult): void {
  if (!value
    || typeof value !== 'object'
    || !Number.isSafeInteger(value.revision)
    || !value.anchors
    || !Array.isArray(value.nodes)) {
    throw new Error('Outline Runtime returned an invalid desktop Projection.');
  }
}
