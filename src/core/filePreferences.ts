import type { AgentDelegationSettings, AgentSkillSourceBinding } from './types';

export interface FilePreferences {
  readonly appearance: {
    readonly theme: 'system' | 'light' | 'dark';
    readonly language: string | null;
  };
  readonly agent: {
    readonly memory: { readonly enabled: boolean };
    readonly skills: {
      readonly disabled: readonly string[];
      readonly sources: readonly AgentSkillSourceBinding[];
    };
    readonly tools: { readonly disabled: readonly string[] };
    readonly provider: {
      readonly timeoutMs: number | null;
      readonly maxRetries: number | null;
      readonly maxRetryDelayMs: number;
      readonly cacheRetention: 'none' | 'short' | 'long';
    };
    readonly delegation: AgentDelegationSettings;
  };
  readonly updates: { readonly checkAutomatically: boolean };
  readonly models: {
    readonly connections: readonly {
      readonly providerId: string;
      readonly baseUrl: string | null;
      readonly enabled: boolean;
      readonly models: readonly string[];
    }[];
    readonly default: string;
    readonly imageDefault: string | null;
  };
}

export const DEFAULT_FILE_PREFERENCES: FilePreferences = Object.freeze({
  appearance: Object.freeze({ theme: 'system', language: null }),
  agent: Object.freeze({
    memory: Object.freeze({ enabled: true }),
    skills: Object.freeze({ disabled: Object.freeze([]), sources: Object.freeze([]) }),
    tools: Object.freeze({ disabled: Object.freeze([]) }),
    provider: Object.freeze({
      timeoutMs: null,
      maxRetries: null,
      maxRetryDelayMs: 60_000,
      cacheRetention: 'short',
    }),
    delegation: Object.freeze({
      enabled: false,
      defaultRunnerId: 'internal',
      maxConcurrentGlobal: 8,
      maxConcurrentThread: 4,
      maxQueuedGlobal: 32,
      maxQueuedThread: 8,
      runners: Object.freeze({}),
    }),
  }),
  updates: Object.freeze({ checkAutomatically: true }),
  models: Object.freeze({ connections: Object.freeze([]), default: 'auto', imageDefault: null }),
});
