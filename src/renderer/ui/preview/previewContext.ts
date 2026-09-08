import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Locale } from '../../../core/locale';
import type {
  PreviewAction,
  PreviewControls,
  PreviewObservation,
} from '../../../core/previewOperations';
import type { LinApi } from '../../../preload';

type Bridge = Pick<
  LinApi,
  | 'registerPreview'
  | 'observePreview'
  | 'unregisterPreview'
  | 'onPreviewAction'
  | 'acknowledgePreview'
  | 'previewOperation'
>;

/** One mounted preview owns intent; the Host mirror only routes exact, acknowledged actions. */
export class PreviewContext {
  private snapshot: PreviewObservation;
  private previewId: string | null = null;
  private bridge: Bridge | null = null;
  private publication: Promise<unknown> = Promise.resolve();
  private controlQueue: Promise<unknown> = Promise.resolve();
  private contentGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private applyControls:
    | ((
        controls: PreviewControls,
      ) => Pick<PreviewObservation, 'effectiveLanguage' | 'status'> | null)
    | null = null;

  constructor(paneId: string, locale: Locale) {
    this.snapshot = {
      paneId,
      revision: 0,
      kind: 'unavailable',
      sourceId: null,
      status: 'off',
      effectiveLanguage: locale,
      controls: { language: null, model: null, automatic: false, display: 'automatic' },
    };
  }
  read = (): PreviewObservation => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  bindControls(apply: NonNullable<PreviewContext['applyControls']>): void {
    this.applyControls = apply;
  }

  connect(bridge: Bridge): () => void {
    this.bridge = bridge;
    let connected = true;
    const unsubscribe = bridge.onPreviewAction((action) => {
      if (connected) this.accept(action);
    });
    const opening = this.publication.then(async () => {
      const sent = this.snapshot;
      const id = await bridge.registerPreview(sent);
      if (!connected) {
        await bridge.unregisterPreview(id);
        return;
      }
      this.previewId = id;
      if (sent !== this.snapshot) await bridge.observePreview(id, this.snapshot);
    });
    this.publication = opening.catch(() => {
      this.previewId = null;
    });
    return () => {
      connected = false;
      unsubscribe();
      const id = this.previewId;
      this.previewId = null;
      this.bridge = null;
      this.publication = this.publication
        .then(() => (id ? bridge.unregisterPreview(id) : undefined))
        .catch(() => undefined);
    };
  }

  observe(
    patch: Partial<Omit<PreviewObservation, 'paneId' | 'revision' | 'controls'>>,
    forceRevision = false,
  ): void {
    const next = { ...this.snapshot, ...patch };
    if (!forceRevision && JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    const { status: _previousStatus, ...previousIdentity } = this.snapshot;
    const { status: _nextStatus, ...nextIdentity } = next;
    const changed =
      forceRevision || JSON.stringify(previousIdentity) !== JSON.stringify(nextIdentity);
    if (
      forceRevision ||
      next.sourceId !== this.snapshot.sourceId ||
      next.kind !== this.snapshot.kind
    )
      this.contentGeneration++;
    this.replace({ ...next, revision: this.snapshot.revision + (changed ? 1 : 0) });
  }

  configure(
    update: Partial<PreviewControls> | ((current: PreviewObservation) => Partial<PreviewControls>),
  ): Promise<void> {
    const generation = this.contentGeneration;
    const apply = async () => {
      await this.publication;
      if (!this.bridge || !this.previewId || generation !== this.contentGeneration)
        throw new Error('Preview controls are unavailable.');
      const changes = typeof update === 'function' ? update(this.snapshot) : update;
      const result = await this.bridge.previewOperation('preview_manage', {
        request: {
          operation: 'configure',
          previewId: this.previewId,
          expectedRevision: this.snapshot.revision,
          changes,
        },
      });
      if (!('state' in result) || result.state !== 'applied')
        throw new Error('The preview control change was not acknowledged.');
    };
    const pending = this.controlQueue.then(apply, apply);
    this.controlQueue = pending.catch(() => undefined);
    return pending;
  }

  async clearCache(): Promise<void> {
    await this.publication;
    if (!this.bridge || !this.previewId) throw new Error('Preview data is unavailable.');
    const result = await this.bridge.previewOperation('preview_manage', {
      request: {
        operation: 'clear_cache',
        previewId: this.previewId,
        expectedRevision: this.snapshot.revision,
      },
    });
    if (!('state' in result) || (result.state !== 'cleared' && result.state !== 'canceled'))
      throw new Error('Saved translations could not be cleared.');
  }

  private accept(action: PreviewAction): void {
    if (action.previewId !== this.previewId || !this.bridge) return;
    let state: 'applied' | 'unavailable' = 'unavailable';
    if (action.expectedRevision === this.snapshot.revision && this.applyControls) {
      const controls = { ...this.snapshot.controls, ...action.changes };
      try {
        const applied = this.applyControls(controls);
        if (applied) {
          this.replace({
            ...this.snapshot,
            ...applied,
            controls,
            revision: this.snapshot.revision + 1,
          });
          state = 'applied';
        }
      } catch {
        /* The Host must not infer a successful controller change. */
      }
    }
    void this.bridge
      .acknowledgePreview({
        actionId: action.actionId,
        previewId: action.previewId,
        state,
        observation: this.snapshot,
      })
      .catch(() => undefined);
  }

  private replace(snapshot: PreviewObservation): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
    const bridge = this.bridge;
    const id = this.previewId;
    if (bridge && id)
      this.publication = this.publication
        .then(() => bridge.observePreview(id, snapshot))
        .catch(() => undefined);
  }
}

export function usePreviewContext(paneId: string, locale: Locale) {
  const [context] = useState(() => new PreviewContext(paneId, locale));
  const observation = useSyncExternalStore(context.subscribe, context.read, context.read);
  useEffect(() => {
    const bridge = window.lin;
    if (!bridge?.registerPreview) return;
    return context.connect(bridge);
  }, [context]);
  return { context, observation };
}
