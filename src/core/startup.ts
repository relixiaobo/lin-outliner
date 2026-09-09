export const STARTUP_STATE_CHANNEL = 'lin:startup-state';
export const STARTUP_GET_CHANNEL = 'lin:startup-get';
export const STARTUP_RETRY_CHANNEL = 'lin:startup-retry';
export const STARTUP_QUIT_CHANNEL = 'lin:startup-quit';
export const STARTUP_ISSUE_ACTION_CHANNEL = 'lin:startup-issue-action';

export type StartupAvailability = 'starting' | 'ready' | 'unavailable';
export type StartupIssueCategory = 'version-mismatch' | 'invalid-data' | 'permission'
  | 'storage-full' | 'locked' | 'dependency' | 'unknown';
export type StartupIssueAction = 'copy-details' | 'open-source';

export interface StartupIssue {
  readonly id: string;
  readonly domain: 'outline' | 'agent' | 'configuration' | 'desktop';
  readonly operation: string;
  readonly category: StartupIssueCategory;
  readonly message: string;
  readonly details: string;
  readonly actions: readonly StartupIssueAction[];
  readonly threadId?: string;
  readonly retryable?: false;
  readonly source?: 'preferences' | 'agent';
  readonly format?: { readonly found: number; readonly expected: number };
}

/** Session-only quarantine derived from trusted catalog lineage, never persisted status. */
export interface StartupThreadAvailability {
  readonly threadId: string;
  readonly sourceThreadId: string;
}

export interface StartupAvailabilityState {
  readonly revision: number;
  readonly capabilities: {
    readonly outline: StartupAvailability;
    readonly agent: StartupAvailability;
  };
  readonly issues: readonly StartupIssue[];
  readonly threads: readonly StartupThreadAvailability[];
}

export type StartupState = StartupAvailabilityState & (
  | { readonly status: 'starting' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly step: string; readonly message: string }
);

export function initialStartupState(ready = false): StartupState {
  return {
    status: ready ? 'ready' : 'starting', revision: 0, issues: [], threads: [],
    capabilities: { outline: ready ? 'ready' : 'starting', agent: ready ? 'ready' : 'starting' },
  };
}
