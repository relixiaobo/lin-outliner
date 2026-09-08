import { PreviewOperations } from '../../src/main/hostDomain/previewOperations';
import type { LinApi } from '../../src/preload';
import type { PreviewAction, PreviewControls, PreviewView } from '../../src/core/previewOperations';

/** Exercise renderer controls through the real Host facade, not preference stubs. */
export function previewOperationsBridge(beforeConfigure?: () => Promise<void>) {
  const controls: PreviewControls[] = [];
  const listeners = new Set<(action: PreviewAction) => void>();
  const host = new PreviewOperations({
    cache: {
      inspect: async () => ({
        entries: { page: 0, caption: 0, document: 0 },
        logicalBytes: 0,
        maxBytes: 100,
        maxEntries: 100,
      }),
      clear: async (check) => {
        await check?.();
      },
      clearSource: async (_source, check) => {
        await check?.();
      },
    },
    review: async () => true,
    websites: async () => ({ available: true, cacheBytes: 0, activeGuests: 0 }),
    clearWebsites: async () => ({ steps: [], liveDisplays: 'reload_requested' }),
    send: (_owner, action) => {
      for (const listener of listeners) listener(action);
    },
    changed: () => {},
    ackTimeoutMs: 100,
  });
  const caller = () => ({
    key: crypto.randomUUID(),
    origin: { kind: 'window' as const, windowId: 1 },
    authorize: async () => {},
  });
  const bridge: Pick<
    LinApi,
    | 'registerPreview'
    | 'observePreview'
    | 'unregisterPreview'
    | 'acknowledgePreview'
    | 'onPreviewAction'
    | 'previewOperation'
    | 'onPreviewDataChanged'
  > = {
    registerPreview: async (observation) => host.register(1, observation),
    observePreview: async (id, observation) => host.observe(1, id, observation),
    unregisterPreview: async (id) => host.unregister(1, id),
    acknowledgePreview: async (ack) => {
      if (ack.state === 'applied') controls.push(ack.observation.controls);
      host.acknowledge(1, ack);
    },
    onPreviewAction: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    previewOperation: async (name, input) => {
      if (name === 'preview_manage') await beforeConfigure?.();
      return host.handle(name, input, caller());
    },
    onPreviewDataChanged: () => () => {},
  };
  const configure = async (changes: Partial<PreviewControls>) => {
    await Promise.resolve();
    await Promise.resolve();
    const result = (await host.handle('preview_inspect', { request: {} }, caller())) as {
      previews: PreviewView[];
    };
    const preview = result.previews[0];
    if (!preview) throw new Error('No test preview registered.');
    return bridge.previewOperation('preview_manage', {
      request: {
        operation: 'configure',
        previewId: preview.previewId,
        expectedRevision: preview.revision,
        changes,
      },
    });
  };
  return { bridge, controls, configure, host };
}
