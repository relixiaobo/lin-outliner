import { createHash } from 'node:crypto';
import type {
  AgentDelegationSettings,
  AgentReasoningLevel,
} from '../../../core/types';
import type {
  DelegateAccess,
  DelegateTaskProfile,
} from '../../../delegate/contract';
import type { ToolTaskSchedulerLimits, ToolTaskSchedulingPolicy } from '../tasks/toolTaskTypes';

export interface DelegationModelSelection {
  readonly providerId: string;
  readonly modelId: string;
  readonly effort: AgentReasoningLevel;
  readonly supportedEfforts: readonly AgentReasoningLevel[];
}

export interface DelegationRunnerAdapter {
  readonly id: string;
  readonly version: string | null;
  readonly detected: boolean;
  readonly ready: boolean;
  readonly diagnostic: string | null;
  resolveExplicitModel(model: string, effort: AgentReasoningLevel): Promise<DelegationModelSelection | null>;
}

export interface DelegationRunnerReadiness {
  readonly id: string;
  readonly version: string | null;
  readonly detected: boolean;
  readonly ready: boolean;
  readonly enabled: boolean;
  readonly diagnostic: string | null;
}

export interface DelegationAdmissionPolicy {
  readonly runnerId: string;
  readonly runnerVersion: string | null;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly effort: AgentReasoningLevel;
  readonly profile: DelegateTaskProfile;
  readonly access: DelegateAccess;
  readonly timeoutMs: number;
  readonly configurationRevision: string;
  readonly scheduling: ToolTaskSchedulingPolicy;
  readonly schedulerLimits: ToolTaskSchedulerLimits;
}

export class DelegationAdmissionRefusal extends Error {
  constructor(
    readonly code: 'disabled' | 'runner_unavailable' | 'model_unavailable' | 'effort_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'DelegationAdmissionRefusal';
  }
}

export class DelegationRunnerRegistry {
  private readonly adapters: ReadonlyMap<string, DelegationRunnerAdapter>;

  constructor(adapters: readonly DelegationRunnerAdapter[]) {
    const byId = new Map<string, DelegationRunnerAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.id)) throw new Error(`Duplicate Delegate Runner registration: ${adapter.id}`);
      byId.set(adapter.id, adapter);
    }
    this.adapters = byId;
  }

  readiness(settings: AgentDelegationSettings): readonly DelegationRunnerReadiness[] {
    return [...this.adapters.values()]
      .map((adapter) => ({
        id: adapter.id,
        version: adapter.version,
        detected: adapter.detected,
        ready: adapter.ready,
        enabled: settings.runners[adapter.id]?.enabled === true,
        diagnostic: adapter.diagnostic,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async resolve(input: {
    readonly settings: AgentDelegationSettings;
    readonly configurationRevision: string;
    readonly parentModel: DelegationModelSelection;
    readonly profile: DelegateTaskProfile;
    readonly requestedAccess: DelegateAccess;
  }): Promise<DelegationAdmissionPolicy> {
    const { settings } = input;
    if (!settings.enabled) {
      throw new DelegationAdmissionRefusal('disabled', 'Experimental delegation is disabled in Settings.');
    }
    const adapter = this.adapters.get(settings.defaultRunnerId);
    const runnerSettings = settings.runners[settings.defaultRunnerId];
    if (!adapter || !adapter.detected || !adapter.ready || !runnerSettings?.enabled) {
      throw new DelegationAdmissionRefusal(
        'runner_unavailable',
        `Configured Delegate Runner is not ready: ${settings.defaultRunnerId}`,
      );
    }

    const effort = runnerSettings.effort ?? input.parentModel.effort;
    const model = runnerSettings.model === null
      ? input.parentModel
      : await adapter.resolveExplicitModel(runnerSettings.model, effort);
    if (!model) {
      throw new DelegationAdmissionRefusal(
        'model_unavailable',
        `Configured Delegate Runner model is unavailable: ${runnerSettings.model}`,
      );
    }
    if (!model.supportedEfforts.includes(effort)) {
      throw new DelegationAdmissionRefusal(
        'effort_unavailable',
        `Configured Delegate Runner effort ${effort} is unavailable for ${model.providerId}/${model.modelId}`,
      );
    }

    return {
      runnerId: adapter.id,
      runnerVersion: adapter.version,
      modelProvider: model.providerId,
      modelId: model.modelId,
      effort,
      profile: input.profile,
      access: input.requestedAccess === 'workspace-write' && runnerSettings.maximumAccess === 'workspace-write'
        ? 'workspace-write'
        : 'read-only',
      timeoutMs: runnerSettings.timeoutMs,
      configurationRevision: input.configurationRevision,
      scheduling: {
        pool: runnerSettings.pool,
        configurationRevision: input.configurationRevision,
        maxConcurrentProducer: runnerSettings.maxConcurrent,
        maxConcurrentPool: runnerSettings.maxConcurrentPool,
      },
      schedulerLimits: {
        maxConcurrentGlobal: settings.maxConcurrentGlobal,
        maxConcurrentThread: settings.maxConcurrentThread,
        maxQueuedGlobal: settings.maxQueuedGlobal,
        maxQueuedThread: settings.maxQueuedThread,
      },
    };
  }

  async resolveContinuation(input: {
    readonly settings: AgentDelegationSettings;
    readonly configurationRevision: string;
    readonly runnerId: string;
    readonly runnerVersion: string | null;
    readonly modelProvider: string;
    readonly modelId: string;
    readonly effort: AgentReasoningLevel;
    readonly profile: DelegateTaskProfile;
    readonly access: DelegateAccess;
  }): Promise<DelegationAdmissionPolicy> {
    const { settings } = input;
    if (!settings.enabled) {
      throw new DelegationAdmissionRefusal('disabled', 'Experimental delegation is disabled in Settings.');
    }
    const adapter = this.adapters.get(input.runnerId);
    const runnerSettings = settings.runners[input.runnerId];
    if (!adapter || !adapter.detected || !adapter.ready || !runnerSettings?.enabled
      || adapter.version !== input.runnerVersion) {
      throw new DelegationAdmissionRefusal(
        'runner_unavailable',
        `Delegation Session Runner is not ready: ${input.runnerId}`,
      );
    }
    const qualifiedModel = `${input.modelProvider}/${input.modelId}`;
    const model = await adapter.resolveExplicitModel(qualifiedModel, input.effort);
    if (!model || model.providerId !== input.modelProvider || model.modelId !== input.modelId) {
      throw new DelegationAdmissionRefusal(
        'model_unavailable',
        `Delegation Session model is unavailable: ${qualifiedModel}`,
      );
    }
    if (!model.supportedEfforts.includes(input.effort)) {
      throw new DelegationAdmissionRefusal(
        'effort_unavailable',
        `Delegation Session effort ${input.effort} is unavailable for ${qualifiedModel}`,
      );
    }
    return {
      runnerId: input.runnerId,
      runnerVersion: input.runnerVersion,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      effort: input.effort,
      profile: input.profile,
      access: input.access,
      timeoutMs: runnerSettings.timeoutMs,
      configurationRevision: input.configurationRevision,
      scheduling: {
        pool: runnerSettings.pool,
        configurationRevision: input.configurationRevision,
        maxConcurrentProducer: runnerSettings.maxConcurrent,
        maxConcurrentPool: runnerSettings.maxConcurrentPool,
      },
      schedulerLimits: {
        maxConcurrentGlobal: settings.maxConcurrentGlobal,
        maxConcurrentThread: settings.maxConcurrentThread,
        maxQueuedGlobal: settings.maxQueuedGlobal,
        maxQueuedThread: settings.maxQueuedThread,
      },
    };
  }
}

export function delegationSettingsRevision(settings: AgentDelegationSettings): string {
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

export function internalDelegationRunnerAdapter(
  resolveExplicitModel: DelegationRunnerAdapter['resolveExplicitModel'],
): DelegationRunnerAdapter {
  return {
    id: 'internal',
    version: '1',
    detected: true,
    ready: true,
    diagnostic: null,
    resolveExplicitModel,
  };
}
