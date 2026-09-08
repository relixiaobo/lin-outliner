import type { AgentDelegationSettings } from './types';
export interface DelegationRunnerReadiness {
  readonly id: string;
  readonly version: string | null;
  readonly detected: boolean;
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly diagnostic: string | null;
}
export interface DelegationSettingsView {
  readonly delegation: AgentDelegationSettings;
  readonly runners: readonly DelegationRunnerReadiness[];
}

export const MAX_DELEGATION_CONCURRENCY = 64;
export const MAX_DELEGATION_GLOBAL_QUEUE = 1_024;
export const MAX_DELEGATION_THREAD_QUEUE = 128;
