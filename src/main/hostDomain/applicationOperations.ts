import {
  APPLICATION_DESTINATIONS,
  type ApplicationOperationCaller,
  type BundledApplicationRelease,
  normalizeDiagnosticsManageResult,
} from '../../core/applicationOperations';
import type { AppInfo, DiagnosticsActionResult } from '../../core/errorObservability';
export type { ApplicationOperationCaller } from '../../core/applicationOperations';

/** User-interface services only; update checks stay with AppUpdateService. */
export function createApplicationOperations(options: {
  readonly appInfo: () => Promise<AppInfo>;
  readonly bundledRelease: () => Promise<BundledApplicationRelease | null>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly revealDiagnostics: () => Promise<DiagnosticsActionResult>;
  readonly exportDiagnostics: (caller: ApplicationOperationCaller) => Promise<DiagnosticsActionResult>;
}) {
  return {
    info: options.appInfo,
    release: options.bundledRelease,
    async diagnostics(operation: 'reveal' | 'export', caller: ApplicationOperationCaller) {
      caller.signal?.throwIfAborted();
      await caller.authorize();
      const result = operation === 'reveal'
        ? await options.revealDiagnostics()
        : await options.exportDiagnostics(caller);
      return normalizeDiagnosticsManageResult(operation, result);
    },
    async openDestination(destination: keyof typeof APPLICATION_DESTINATIONS) {
      if (!Object.hasOwn(APPLICATION_DESTINATIONS, destination)) {
        throw new Error('Only fixed application destinations may be opened.');
      }
      await options.openExternal(APPLICATION_DESTINATIONS[destination]);
    },
  };
}

export type ApplicationOperation = ReturnType<typeof createApplicationOperations>;
