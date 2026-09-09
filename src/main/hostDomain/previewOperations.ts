import { randomUUID } from 'node:crypto';
import type { TSchema } from 'typebox';
import {
  DATA_INSPECT_SCHEMA,
  DATA_MANAGE_SCHEMA,
  PREVIEW_INSPECT_SCHEMA,
  PREVIEW_MANAGE_SCHEMA,
  PREVIEW_OBSERVATION_SCHEMA,
  type DataOperationView,
  type DataScope,
  type PreviewAction,
  type PreviewActionAck,
  type PreviewControlResult,
  type PreviewManageRequest,
  type PreviewObservation,
  type PreviewOperationName,
  type PreviewOperationResult,
  type PreviewView,
  type PreviewDataStatus,
} from '../../core/previewOperations';
import { isUrlPageTranslationModel } from '../../core/urlPageTranslation';
import { compileToolParameters } from '../agent/runtime/kernel/exactToolArguments';
import { AgentToolFailure } from '../agent/AgentToolFailure';
import type { PreviewTranslationCacheStore } from '../previewTranslationCacheStore';

export interface PreviewOperationCaller {
  readonly key: string;
  readonly origin: { readonly kind: 'window'; readonly windowId: number };
  readonly authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}
interface RegisteredPreview {
  ownerId: number;
  observation: PreviewObservation;
}
interface PendingAction {
  previewId: string;
  ownerId: number;
  revision: number;
  changes: PreviewAction['changes'];
  sourceId: string | null;
  finish: (state: PreviewControlResult['state']) => void;
}

export class PreviewOperations {
  private readonly previews = new Map<string, RegisteredPreview>();
  private readonly actions = new Map<string, PendingAction>();
  private readonly operations = new Map<string, DataOperationView>();
  private readonly invocations = new Map<
    string,
    { input: string; promise: Promise<DataOperationView> }
  >();
  private busy = false;

  constructor(
    private readonly options: {
      cache: Pick<PreviewTranslationCacheStore, 'inspect' | 'clear' | 'clearSource'>;
      review: (scope: DataScope, caller: PreviewOperationCaller) => Promise<boolean>;
      websites: () => Promise<PreviewDataStatus['websites']>;
      clearWebsites: () => Promise<Pick<DataOperationView, 'steps' | 'liveDisplays'>>;
      send: (ownerId: number, action: PreviewAction) => void;
      changed: () => void;
      ackTimeoutMs?: number;
    },
  ) {}

  register(ownerId: number, raw: unknown): string {
    const observation = this.observation(raw);
    for (const [id, entry] of this.previews)
      if (entry.ownerId === ownerId && entry.observation.paneId === observation.paneId)
        this.unregister(ownerId, id);
    if (this.previews.size >= 4)
      throw failure('preview_unavailable', 'The preview limit was reached.');
    const id = randomUUID();
    this.previews.set(id, { ownerId, observation });
    return id;
  }

  observe(ownerId: number, previewId: string, raw: unknown): void {
    const entry = this.owned(ownerId, previewId);
    const observation = this.observation(raw);
    if (
      observation.paneId !== entry.observation.paneId ||
      observation.revision < entry.observation.revision
    ) {
      throw failure('stale_preview', 'The preview observation is stale.');
    }
    const { status: _oldStatus, ...oldIdentity } = entry.observation;
    const { status: _newStatus, ...newIdentity } = observation;
    if (
      observation.revision === entry.observation.revision &&
      JSON.stringify(newIdentity) !== JSON.stringify(oldIdentity)
    )
      throw failure('stale_preview', 'A changed observation requires a new revision.');
    entry.observation = observation;
  }

  unregister(ownerId: number, previewId: string): void {
    if (this.previews.get(previewId)?.ownerId !== ownerId) return;
    this.previews.delete(previewId);
    for (const action of this.actions.values())
      if (action.previewId === previewId) action.finish('unavailable');
  }

  releaseOwner(ownerId: number): void {
    for (const [id, entry] of this.previews)
      if (entry.ownerId === ownerId) this.unregister(ownerId, id);
  }

  async settle(): Promise<void> {
    await Promise.allSettled(
      [...this.invocations.values()].map((invocation) => invocation.promise),
    );
  }

  acknowledge(ownerId: number, ack: PreviewActionAck): void {
    if (!ack || typeof ack !== 'object') return;
    const action = this.actions.get(ack.actionId);
    if (!action || action.ownerId !== ownerId || action.previewId !== ack.previewId) return;
    if (ack.state !== 'applied' && ack.state !== 'unavailable') return;
    const observation = this.observation(ack.observation);
    if (ack.state === 'applied' && observation.revision <= action.revision) return;
    if (
      ack.state === 'applied' &&
      (observation.sourceId !== action.sourceId ||
        Object.entries(action.changes).some(
          ([key, value]) =>
            observation.controls[key as keyof typeof observation.controls] !== value,
        ))
    ) {
      action.finish('unavailable');
      return;
    }
    this.observe(ownerId, ack.previewId, observation);
    action.finish(ack.state);
  }

  async handle(
    name: PreviewOperationName,
    input: unknown,
    caller: PreviewOperationCaller,
  ): Promise<PreviewOperationResult> {
    const schemas = {
      preview_inspect: PREVIEW_INSPECT_SCHEMA,
      preview_manage: PREVIEW_MANAGE_SCHEMA,
      data_inspect: DATA_INSPECT_SCHEMA,
      data_manage: DATA_MANAGE_SCHEMA,
    };
    if (!compileToolParameters(schemas[name] as TSchema).Check(input))
      throw failure('invalid_request', 'The operation does not match its schema.');
    const recheck = async () => {
      caller.signal?.throwIfAborted();
      await caller.authorize(name, input, caller.signal);
    };
    await recheck();
    if (name === 'preview_inspect') {
      const { request } = input as { request: { previewId?: string } };
      return {
        previews: request.previewId
          ? [this.select(request.previewId).view]
          : [...this.previews].map(([id, entry]) => this.view(id, entry)),
      };
    }
    if (name === 'data_inspect')
      return {
        translations: await this.options.cache.inspect(),
        websites: await this.options.websites(),
        operations: [...this.operations.values()],
      };
    if (name === 'data_manage') {
      const { scope } = (input as { request: { scope: 'translations' | 'websites' } }).request;
      return this.clear(scope, caller, input, recheck);
    }
    const request = (input as { request: PreviewManageRequest }).request;
    const selected = this.select(request.previewId, request.expectedRevision);
    const checkTarget = () => this.select(selected.view.previewId, request.expectedRevision);
    if (request.operation === 'clear_cache') {
      if (!selected.entry.observation.sourceId)
        throw failure('preview_unavailable', 'The preview has no cacheable content identity.');
      return this.clear(
        'content',
        caller,
        input,
        async () => {
          await recheck();
          checkTarget();
        },
        selected.entry.observation.sourceId,
      );
    }
    if (
      request.changes.model !== undefined &&
      request.changes.model !== null &&
      !isUrlPageTranslationModel(request.changes.model)
    ) {
      throw failure('invalid_request', 'The model must be provider-qualified.');
    }
    await recheck();
    checkTarget();
    return this.dispatch(selected.view.previewId, selected.entry, request, caller.signal);
  }

  private observation(raw: unknown): PreviewObservation {
    if (!compileToolParameters(PREVIEW_OBSERVATION_SCHEMA as TSchema).Check(raw))
      throw failure('invalid_request', 'Invalid preview observation.');
    const observation = raw as PreviewObservation;
    if (
      observation.controls.model !== null &&
      !isUrlPageTranslationModel(observation.controls.model)
    )
      throw failure('invalid_request', 'Invalid preview model.');
    return structuredClone(observation);
  }
  private owned(ownerId: number, id: string): RegisteredPreview {
    const entry = this.previews.get(id);
    if (!entry || entry.ownerId !== ownerId)
      throw failure('preview_unavailable', 'The preview is no longer available to this window.');
    return entry;
  }
  private view(id: string, entry: RegisteredPreview): PreviewView {
    const { sourceId, ...observation } = entry.observation;
    return structuredClone({ ...observation, previewId: id, cacheAvailable: sourceId !== null });
  }
  private select(id?: string, revision?: number) {
    const candidates = [...this.previews].filter(
      ([key, entry]) => (!id || key === id) && entry.observation.kind !== 'unavailable',
    );
    if (candidates.length !== 1)
      throw failure(
        'preview_unavailable',
        'Select an available preview in the workspace.',
      );
    const [key, entry] = candidates[0]!;
    if (revision !== undefined && revision !== entry.observation.revision)
      throw failure('stale_preview', 'The preview changed. Inspect it again.');
    return { entry, view: this.view(key, entry) };
  }
  private dispatch(
    id: string,
    entry: RegisteredPreview,
    request: Extract<PreviewManageRequest, { operation: 'configure' }>,
    signal?: AbortSignal,
  ): Promise<PreviewControlResult> {
    const actionId = randomUUID();
    const previous = this.view(id, entry);
    return new Promise((resolve) => {
      const finish = (state: PreviewControlResult['state']) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.actions.delete(actionId);
        resolve({ state, preview: this.previews.has(id) ? this.view(id, entry) : previous });
      };
      const abort = () => finish('unknown');
      const timer = setTimeout(() => finish('unknown'), this.options.ackTimeoutMs ?? 3000);
      this.actions.set(actionId, {
        previewId: id,
        ownerId: entry.ownerId,
        revision: request.expectedRevision,
        changes: request.changes,
        sourceId: entry.observation.sourceId,
        finish,
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.options.send(entry.ownerId, {
          actionId,
          previewId: id,
          expectedRevision: request.expectedRevision,
          changes: request.changes,
        });
      } catch {
        finish('unavailable');
      }
    });
  }

  private clear(
    scope: DataScope,
    caller: PreviewOperationCaller,
    input: unknown,
    recheck: () => Promise<void>,
    sourceId?: string,
  ): Promise<DataOperationView> {
    const prior = this.invocations.get(caller.key);
    const fingerprint = JSON.stringify(input);
    if (prior) {
      if (prior.input !== fingerprint)
        throw failure('invalid_request', 'A maintenance invocation cannot change its target.');
      return prior.promise;
    }
    if (this.busy) throw failure('data_busy', 'Another preview data operation is in progress.');
    this.busy = true;
    const view: DataOperationView = {
      operationId: randomUUID(),
      scope,
      state: 'confirming',
      liveDisplays: 'retained',
      steps: [],
    };
    this.operations.set(view.operationId, view);
    while (this.operations.size > 32) this.operations.delete(this.operations.keys().next().value!);
    const promise = (async () => {
      try {
        this.notify();
        if (!(await this.options.review(scope, caller))) {
          view.state = 'canceled';
          return structuredClone(view);
        }
        await recheck();
        view.state = 'running';
        this.notify();
        if (scope === 'websites') Object.assign(view, await this.options.clearWebsites());
        else {
          if (scope === 'content') await this.options.cache.clearSource(sourceId!, recheck);
          else await this.options.cache.clear(recheck);
          view.steps.push({ name: 'saved_translations', state: 'completed' });
        }
        view.state = view.steps.some((step) => step.state === 'failed') ? 'failed' : 'cleared';
        return structuredClone(view);
      } catch (error) {
        view.state = caller.signal?.aborted && view.state === 'confirming' ? 'canceled' : 'failed';
        if (error instanceof AgentToolFailure || caller.signal?.aborted) throw error;
        return structuredClone(view);
      } finally {
        this.busy = false;
        this.notify();
      }
    })();
    this.invocations.set(caller.key, { input: fingerprint, promise });
    while (this.invocations.size > 32)
      this.invocations.delete(this.invocations.keys().next().value!);
    return promise;
  }
  private notify(): void {
    try {
      this.options.changed();
    } catch {
      /* Observation must not change operation settlement. */
    }
  }
}

function failure(code: string, message: string) {
  return new AgentToolFailure(
    code,
    message,
    'Inspect current preview/data state. Never edit the private cache or replay an unknown control change blindly.',
  );
}
