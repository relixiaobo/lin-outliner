import type { DiagnosticsActionResult } from './errorObservability';

export const LIN_APP_OPEN_DESTINATION_CHANNEL = 'lin:application/open-destination';
export const LIN_APP_RELEASE_CHANNEL = 'lin:application/release';

export const APPLICATION_DESTINATIONS = {
  help: 'https://github.com/relixiaobo/lin-outliner',
  issues: 'https://github.com/relixiaobo/lin-outliner/issues',
  license: 'https://github.com/relixiaobo/lin-outliner/blob/main/LICENSE',
} as const;

export const APPLICATION_RELEASE_NOTE_MAX_LENGTH = 50_000;

export type ApplicationDestination = keyof typeof APPLICATION_DESTINATIONS | 'release' | 'download';

export interface BundledApplicationRelease {
  readonly version: string;
  readonly date: string | null;
  readonly note: string;
  readonly noteTruncated: boolean;
  readonly changelogUrl: string;
}

export type DiagnosticsManageResult =
  | { readonly operation: 'reveal' | 'export'; readonly ok: true; readonly path: string }
  | { readonly operation: 'export'; readonly ok: false; readonly canceled: true }
  | { readonly operation: 'reveal' | 'export'; readonly ok: false; readonly error: string };

export interface ApplicationOperationCaller {
  readonly origin: { readonly kind: 'window'; readonly windowId: number };
  readonly authorize: () => Promise<void>;
  readonly signal?: AbortSignal;
}

export function normalizeDiagnosticsManageResult(
  operationName: 'reveal' | 'export',
  result: DiagnosticsActionResult,
): DiagnosticsManageResult {
  if (result.ok && typeof result.path === 'string' && result.path.length > 0) {
    return { operation: operationName, ok: true, path: result.path };
  }
  if (operationName === 'export' && result.canceled) {
    return { operation: operationName, ok: false, canceled: true };
  }
  return {
    operation: operationName,
    ok: false,
    error: typeof result.error === 'string' && result.error.length > 0
      ? result.error.slice(0, 2_048)
      : `The diagnostics ${operationName} operation failed.`,
  };
}
