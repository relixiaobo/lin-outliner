// The e2e harness runs the REAL `ActionInvocationService` inside the page.
//
// The alternative — a hand-written action bridge in `outlinerMock.ts` — would
// be a second implementation of the registry, which is exactly what this plan
// exists to remove; it would drift and the e2e suite would then be asserting
// the mock's opinion rather than the product's. So this entry is bundled and
// injected, and the mock supplies only a host over its own document state.
//
// Bundled by `installElectronMock`; never imported by product code.

import { ActionInvocationService } from '../../src/main/actionInvocationService';
import type { ActionInvocationHost } from '../../src/main/actionInvocationService';
import type {
  ActionRequest,
  InvocationEvent,
  InvocationSeed,
  ParameterObjectQueryRequest,
} from '../../src/core/actions/types';

export interface MockActionBridgeHost {
  projection: ActionInvocationHost['projection'];
  runCommand: ActionInvocationHost['runCommand'];
  writeClipboard: ActionInvocationHost['writeClipboard'];
  runRendererStep: (envelope: { invocationRef: string; step: unknown }) => void;
}

function createBridge(host: MockActionBridgeHost) {
  const service = new ActionInvocationService({
    projection: host.projection,
    runCommand: host.runCommand,
    // The mock has no text-search index; `Move to` falls back to its
    // empty-query ordering, which is the branch the e2e specs exercise.
    searchNodes: () => [],
    executeRendererStep: async (step, invocationRef) => {
      // The invocation ref is what routes the step to the surface that opened
      // it, so it has to survive the hop — a placeholder here would silently
      // drop every renderer leg.
      host.runRendererStep({ invocationRef, step });
      return { status: 'ok' };
    },
    activateAppSurface: async () => undefined,
    writeClipboard: host.writeClipboard,
    untitled: () => 'Untitled',
    now: () => Date.now(),
  });
  return {
    open: async (seed: InvocationSeed) => service.openFromSeed(seed, {
      webContentsId: 1,
      renderGeneration: 1,
    }),
    queryParameters: async (request: ParameterObjectQueryRequest) => (
      service.queryParameterObjects(request, 1)
    ),
    request: async (request: ActionRequest) => service.request(request, 1),
    event: async (event: InvocationEvent) => service.event(event, 1),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __linActionBridgeFactory: typeof createBridge | undefined;
}

globalThis.__linActionBridgeFactory = createBridge;
