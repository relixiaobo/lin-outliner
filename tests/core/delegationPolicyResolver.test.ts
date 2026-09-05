import { describe, expect, test } from 'bun:test';
import type { AgentDelegationSettings } from '../../src/core/types';
import {
  DelegationAdmissionRefusal,
  DelegationRunnerRegistry,
  internalDelegationRunnerAdapter,
  type DelegationModelSelection,
} from '../../src/main/agent/delegation';

const PARENT: DelegationModelSelection = {
  providerId: 'anthropic',
  modelId: 'claude-parent',
  effort: 'high',
  supportedEfforts: ['low', 'high'],
};

describe('DelegationRunnerRegistry', () => {
  test('reports registered Runner readiness separately from user enablement', () => {
    const registry = fixtureRegistry();
    expect(registry.readiness(settings({ enabled: false }))).toEqual([{
      id: 'internal',
      version: '1',
      detected: true,
      ready: true,
      enabled: true,
      diagnostic: null,
    }]);
  });

  test('refuses while the experiment is disabled', async () => {
    const registry = fixtureRegistry();
    await expect(registry.resolve({
      settings: settings(),
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'disabled' });
  });

  test('inherits the concrete parent model and applies scheduling policy', async () => {
    const registry = fixtureRegistry();
    const resolved = await registry.resolve({
      settings: settings({ enabled: true }),
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'workspace-write',
    });

    expect(resolved).toMatchObject({
      runnerId: 'internal',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      access: 'workspace-write',
      configurationRevision: 'revision-one',
      scheduling: {
        pool: 'agent-provider',
        maxConcurrentProducer: 4,
        maxConcurrentPool: 4,
      },
      schedulerLimits: {
        maxConcurrentGlobal: 8,
        maxConcurrentThread: 4,
        maxQueuedGlobal: 32,
        maxQueuedThread: 8,
      },
    });
  });

  test('refuses an unavailable explicit model without inheriting the parent', async () => {
    let resolutions = 0;
    const registry = fixtureRegistry(async () => {
      resolutions += 1;
      return null;
    });
    const configured = settings({ enabled: true });
    configured.runners.internal!.model = 'openai/missing';

    await expect(registry.resolve({
      settings: configured,
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'model_unavailable' });
    expect(resolutions).toBe(1);
  });

  test('refuses an unsupported inherited effort for an explicit model', async () => {
    const registry = fixtureRegistry(async () => ({
      providerId: 'openai',
      modelId: 'gpt-explicit',
      effort: 'high',
      supportedEfforts: ['medium'],
    }));
    const configured = settings({ enabled: true });
    configured.runners.internal!.model = 'openai/gpt-explicit';

    await expect(registry.resolve({
      settings: configured,
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'effort_unavailable' });
  });

  test('narrows requested workspace access to the configured maximum', async () => {
    const registry = fixtureRegistry();
    const configured = settings({ enabled: true });
    configured.runners.internal!.maximumAccess = 'read-only';

    const resolved = await registry.resolve({
      settings: configured,
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'workspace-write',
    });
    expect(resolved.access).toBe('read-only');
  });

  test('refuses an unregistered configured Runner', async () => {
    const registry = fixtureRegistry();
    const configured = settings({ enabled: true, defaultRunnerId: 'claude' });

    await expect(registry.resolve({
      settings: configured,
      configurationRevision: 'revision-one',
      parentModel: PARENT,
      profile: 'general',
      requestedAccess: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'runner_unavailable' });
  });

  test('continues with the Session Runner after the default Runner changes', async () => {
    const registry = fixtureRegistry();
    const configured = settings({ enabled: true, defaultRunnerId: 'claude' });
    configured.runners.claude = {
      ...configured.runners.internal!,
      enabled: false,
      pool: 'claude-provider',
    };

    const resolved = await registry.resolveContinuation({
      settings: configured,
      configurationRevision: 'revision-two',
      runnerId: 'internal',
      runnerVersion: '1',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      profile: 'general',
      access: 'workspace-write',
    });

    expect(resolved).toMatchObject({
      runnerId: 'internal',
      runnerVersion: '1',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      profile: 'general',
      access: 'workspace-write',
      configurationRevision: 'revision-two',
      scheduling: { pool: 'agent-provider' },
    });
  });

  test('refuses continuation when the Session Runner is disabled or changes version', async () => {
    const registry = fixtureRegistry();
    const disabled = settings({ enabled: true });
    disabled.runners.internal!.enabled = false;

    await expect(registry.resolveContinuation({
      settings: disabled,
      configurationRevision: 'revision-two',
      runnerId: 'internal',
      runnerVersion: '1',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      profile: 'general',
      access: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'runner_unavailable' });

    await expect(registry.resolveContinuation({
      settings: settings({ enabled: true }),
      configurationRevision: 'revision-two',
      runnerId: 'internal',
      runnerVersion: '0',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      profile: 'general',
      access: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'runner_unavailable' });
  });

  test('refuses continuation when the pinned Session model disappears without fallback', async () => {
    let requestedModel: string | null = null;
    const registry = fixtureRegistry(async (model) => {
      requestedModel = model;
      return null;
    });

    await expect(registry.resolveContinuation({
      settings: settings({ enabled: true }),
      configurationRevision: 'revision-two',
      runnerId: 'internal',
      runnerVersion: '1',
      modelProvider: 'anthropic',
      modelId: 'claude-parent',
      effort: 'high',
      profile: 'general',
      access: 'read-only',
    })).rejects.toMatchObject<Partial<DelegationAdmissionRefusal>>({ code: 'model_unavailable' });
    expect(requestedModel).toBe('anthropic/claude-parent');
  });
});

function fixtureRegistry(
  resolver: Parameters<typeof internalDelegationRunnerAdapter>[0] = async (model, effort) => ({
    providerId: model.split('/')[0] ?? 'unknown',
    modelId: model.split('/').slice(1).join('/'),
    effort,
    supportedEfforts: [effort],
  }),
): DelegationRunnerRegistry {
  return new DelegationRunnerRegistry([internalDelegationRunnerAdapter(resolver)]);
}

function settings(overrides: Partial<AgentDelegationSettings> = {}): AgentDelegationSettings {
  return {
    enabled: false,
    defaultRunnerId: 'internal',
    maxConcurrentGlobal: 8,
    maxConcurrentThread: 4,
    maxQueuedGlobal: 32,
    maxQueuedThread: 8,
    runners: {
      internal: {
        enabled: true,
        model: null,
        effort: null,
        maximumAccess: 'workspace-write',
        timeoutMs: 3_600_000,
        maxConcurrent: 4,
        pool: 'agent-provider',
        maxConcurrentPool: 4,
      },
    },
    ...overrides,
  };
}
