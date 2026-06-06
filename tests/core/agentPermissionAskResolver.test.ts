import { describe, expect, mock, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall, type Api, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { AgentPermissionAskDecision } from '../../src/main/agentPermissions';
import { resolveAgentPermissionAsk } from '../../src/main/agentPermissionAskResolver';
import {
  PERMISSION_CLASSIFIER_TOOL_NAME,
  PERMISSION_CLASSIFIER_SYSTEM_PROMPT,
  buildPermissionClassifierTranscript,
  parsePermissionClassifierResponse,
} from '../../src/main/agentPermissionClassifierPrompt';

mock.module('electron', () => ({
  app: {
    getPath: () => '/tmp/lin-agent-permission-classifier-test-user-data',
  },
}));

function askDecision(overrides: Partial<AgentPermissionAskDecision> = {}): AgentPermissionAskDecision {
  const descriptor = {
    toolName: 'file_edit',
    actionKind: 'file.edit.allowed_file_area',
    accessScope: 'allowed_file_area',
    title: 'local file edit',
    summary: 'Edit a local file.',
    consequence: 'This changes local files inside the allowed file area.',
    defaultDecision: 'ask',
    reversible: false,
    externalEffect: false,
    highConsequence: false,
    classifierAutoAllowEligible: true,
  } satisfies AgentPermissionAskDecision['descriptor'];

  return {
    behavior: 'ask',
    access: 'write',
    code: 'file.edit.allowed_file_area',
    reason: descriptor.consequence,
    preapproved: false,
    conversationApproved: false,
    permissionSource: 'default',
    descriptor,
    request: {
      title: 'Approve local file edit?',
      target: descriptor.summary,
      details: [{ label: 'Action', value: descriptor.title }],
    },
    ...overrides,
  };
}

describe('agent permission ask resolver', () => {
  test('allows safe default ask decisions without showing approval', async () => {
    const decision = askDecision({
      access: 'read',
      code: 'file.read.allowed_file_area',
      descriptor: {
        toolName: 'file_read',
        actionKind: 'file.read.allowed_file_area',
        accessScope: 'allowed_file_area',
        title: 'local file read',
        summary: 'Read a local file.',
        consequence: 'This reads local files inside the allowed file area.',
        defaultDecision: 'ask',
        reversible: true,
        externalEffect: false,
        highConsequence: false,
        classifierAutoAllowEligible: false,
      },
    });

    await expect(resolveAgentPermissionAsk({
      decision,
      interactionAvailable: false,
    })).resolves.toEqual({ outcome: 'allow', source: 'safe_allowlist' });
  });

  test('configured ask rules always require the user', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: askDecision({ permissionSource: 'configured_ask' }),
      interactionAvailable: true,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('uses the classifier only for eligible low-risk actions', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: askDecision(),
      classifierProjection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      classifier: () => ({ outcome: 'allow', reason: 'Matches requested local edit.', model: 'test-classifier' }),
      interactionAvailable: false,
    })).resolves.toEqual({ outcome: 'allow', source: 'classifier' });

    await expect(resolveAgentPermissionAsk({
      decision: askDecision(),
      classifierProjection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      classifier: () => ({ outcome: 'block', reason: 'Looks destructive.', model: 'test-classifier' }),
      interactionAvailable: false,
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'classifier_blocked',
      message: 'Looks destructive.',
    });
  });

  test('falls back safely when the classifier is unavailable', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: askDecision(),
      classifierProjection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      interactionAvailable: true,
    })).resolves.toEqual({ outcome: 'needs_user' });

    await expect(resolveAgentPermissionAsk({
      decision: askDecision(),
      classifierProjection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      interactionAvailable: false,
    })).resolves.toEqual({
      outcome: 'block',
      reason: 'classifier_unavailable',
      message: 'Permission classifier is unavailable.',
    });
  });

  test('does not auto-allow high-consequence eligible decisions', async () => {
    await expect(resolveAgentPermissionAsk({
      decision: askDecision({
        descriptor: {
          ...askDecision().descriptor!,
          highConsequence: true,
        },
      }),
      classifierProjection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      classifier: () => ({ outcome: 'allow', reason: 'Would allow if eligible.', model: 'test-classifier' }),
      interactionAvailable: true,
    })).resolves.toEqual({ outcome: 'needs_user' });
  });

  test('classifier prompt contract is strict JSON and fails closed on long transcripts', () => {
    expect(PERMISSION_CLASSIFIER_SYSTEM_PROMPT).toContain('Default to block when uncertain.');
    expect(PERMISSION_CLASSIFIER_SYSTEM_PROMPT).toContain('Temperature must be 0.');
    expect(parsePermissionClassifierResponse('{"outcome":"allow","reason":"local edit"}')).toEqual({
      outcome: 'allow',
      reason: 'local edit',
    });
    expect(parsePermissionClassifierResponse('not json')).toBeNull();
    expect(buildPermissionClassifierTranscript([{ ok: true }])).toBe('{"ok":true}');
    expect(buildPermissionClassifierTranscript([{ text: 'x'.repeat(30_000) }])).toBeNull();
  });

  test('default classifier uses a constrained tool contract and temperature zero', async () => {
    const { createDefaultPermissionClassifier } = await import('../../src/main/agentPermissionClassifier');
    const model = {
      id: 'classifier-model',
      name: 'Classifier Model',
      api: 'openai-completions',
      provider: 'openai',
      reasoning: false,
      input: ['text'],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 128000,
      maxTokens: 8192,
    } satisfies Model<Api>;
    let capturedContext: Context | undefined;
    let capturedOptions: SimpleStreamOptions & { toolChoice?: unknown } | undefined;
    const classifier = createDefaultPermissionClassifier({
      sessionId: 'session-1',
      model: () => model,
      providerConfig: {
        providerId: 'openai',
        modelId: model.id,
        reasoningLevel: 'low',
        enabled: true,
      },
      providerApiKeyLoader: () => 'test-key',
      runtimeSettingsLoader: async () => ({
        permissionMode: 'trusted',
        automaticSkillsEnabled: true,
        slashSkillsEnabled: true,
        compactEnabled: true,
        additionalSkillDirectories: [],
      }),
      completeSimpleFn: async (_model, context, options) => {
        capturedContext = context;
        capturedOptions = options as SimpleStreamOptions & { toolChoice?: unknown };
        return fauxAssistantMessage([
          fauxToolCall(PERMISSION_CLASSIFIER_TOOL_NAME, {
            outcome: 'allow',
            reason: 'Ordinary local edit.',
          }),
        ], { stopReason: 'toolUse' });
      },
    });

    await expect(classifier({
      decision: askDecision(),
      projection: { tool: 'file_edit', input: { file_path: '/tmp/workspace/a.ts' } },
      contextRecords: [{ user: 'Edit the local file.' }],
    })).resolves.toEqual({
      outcome: 'allow',
      reason: 'Ordinary local edit.',
      model: model.id,
    });
    expect(capturedContext?.tools?.map((tool) => tool.name)).toEqual([PERMISSION_CLASSIFIER_TOOL_NAME]);
    expect(capturedContext?.systemPrompt).toContain('Default to block when uncertain.');
    expect(capturedOptions?.temperature).toBe(0);
    expect(capturedOptions?.toolChoice).toEqual({
      type: 'function',
      function: { name: PERMISSION_CLASSIFIER_TOOL_NAME },
    });
  });
});
