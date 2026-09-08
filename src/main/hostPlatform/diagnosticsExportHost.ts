import type {
  DiagnosticEnvironment,
  DiagnosticsActionResult,
} from '../../core/errorObservability';
import type { ApplicationOperationCaller } from '../hostDomain/applicationOperations';
import { AgentToolFailure } from '../agent/AgentToolFailure';

export interface DiagnosticsExportWindow {
  isDestroyed(): boolean;
}

export interface DiagnosticsSaveSelection {
  readonly canceled: boolean;
  readonly filePath?: string;
}

export function createDiagnosticsExportHost<Window extends DiagnosticsExportWindow>(options: {
  readonly available: () => boolean;
  readonly operationWindow: (caller: ApplicationOperationCaller) => Window | null;
  readonly defaultPath: () => string;
  readonly selectPath: (
    parent: Window,
    defaultPath: string,
  ) => Promise<DiagnosticsSaveSelection>;
  readonly environment: () => Promise<DiagnosticEnvironment>;
  readonly writeExport: (path: string, environment: DiagnosticEnvironment) => Promise<string>;
}): (caller: ApplicationOperationCaller) => Promise<DiagnosticsActionResult> {
  return async (caller) => {
    caller.signal?.throwIfAborted();
    const parent = liveOperationWindow(options, caller);
    let selection: DiagnosticsSaveSelection;
    try {
      selection = await options.selectPath(parent, options.defaultPath());
    } catch (error) {
      return failed(error);
    }
    if (selection.canceled || !selection.filePath) return { ok: false, canceled: true };

    let environment: DiagnosticEnvironment;
    try {
      environment = await options.environment();
    } catch (error) {
      return failed(error);
    }

    caller.signal?.throwIfAborted();
    await caller.authorize(
      'diagnostics_manage',
      { request: { operation: 'export' } },
      caller.signal,
    );
    caller.signal?.throwIfAborted();
    const currentParent = liveOperationWindow(options, caller);
    if (currentParent !== parent) throw unavailable();

    try {
      return { ok: true, path: await options.writeExport(selection.filePath, environment) };
    } catch (error) {
      return failed(error);
    }
  };
}

function liveOperationWindow<Window extends DiagnosticsExportWindow>(
  options: {
    readonly available: () => boolean;
    readonly operationWindow: (caller: ApplicationOperationCaller) => Window | null;
  },
  caller: ApplicationOperationCaller,
): Window {
  if (!options.available()) throw unavailable();
  const window = options.operationWindow(caller);
  if (!window || window.isDestroyed()) throw unavailable();
  return window;
}

function unavailable(): AgentToolFailure {
  return new AgentToolFailure(
    'interaction_unavailable',
    'The originating window or application Host is no longer available.',
    'Start a new diagnostics export only from a live root Turn or Settings window.',
  );
}

function failed(error: unknown): DiagnosticsActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
