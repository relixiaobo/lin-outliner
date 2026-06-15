import { describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentDefinition } from '../../src/core/types';
import { applyAgentPromptCacheBreakpoints } from '../../src/main/agentProviderCacheBreakpoints';
import { AGENT_L0_FIRMWARE_PROMPT, composeAgentPrompt, sanitizeAgentPromptForProvider } from '../../src/main/agentSystemPrompt';

const ANTHROPIC_MODEL: Model<Api> = {
  id: 'claude-test',
  name: 'Claude Test',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

const OPENAI_MODEL: Model<Api> = {
  ...ANTHROPIC_MODEL,
  api: 'openai-responses',
  provider: 'openai',
};

function def(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'reviewer',
    displayName: 'Reviewer',
    source: 'project',
    rootDir: '/workspace/.agents/agents/reviewer',
    agentFile: '/workspace/.agents/agents/reviewer/AGENT.md',
    description: 'Reviews implementation plans.',
    body: 'REVIEWER_AGENT_BODY',
    ...overrides,
  };
}

function cacheControl() {
  return { type: 'ephemeral' };
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControls(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return ('cache_control' in record ? 1 : 0)
    + Object.values(record).reduce((total, item) => total + countCacheControls(item), 0);
}

describe('agent prompt provider cache breakpoints', () => {
  test('splits Anthropic system prompt into L0 and rest while keeping provider breakpoints in budget', () => {
    const systemPrompt = composeAgentPrompt(def(), { mode: 'member' });
    const payload = {
      system: [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }],
      tools: [{ name: 'node_read', cache_control: cacheControl() }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: cacheControl() }] }],
    };

    const result = applyAgentPromptCacheBreakpoints(payload, ANTHROPIC_MODEL, {
      enabled: true,
      systemPrompt,
    }) as typeof payload;

    expect(result).not.toBeUndefined();
    expect(result).toBe(payload);
    expect(result.system).toHaveLength(2);
    expect(result.system[0]).toMatchObject({ type: 'text', text: AGENT_L0_FIRMWARE_PROMPT });
    expect(String(result.system[1]?.text)).toContain('REVIEWER_AGENT_BODY');
    expect(result.system[0]).toHaveProperty('cache_control');
    expect(result.system[1]).toHaveProperty('cache_control');
    expect(countCacheControls(result)).toBe(4);
  });

  test('removes an extra OAuth identity breakpoint before exceeding Anthropic limit', () => {
    const systemPrompt = composeAgentPrompt(def(), { mode: 'member' });
    const payload = {
      system: [
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: cacheControl() },
        { type: 'text', text: systemPrompt, cache_control: cacheControl() },
      ],
      tools: [{ name: 'node_read', cache_control: cacheControl() }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: cacheControl() }] }],
    };

    const result = applyAgentPromptCacheBreakpoints(payload, ANTHROPIC_MODEL, {
      enabled: true,
      systemPrompt,
    }) as typeof payload;

    expect(result).toBe(payload);
    expect(result.system).toHaveLength(3);
    expect(result.system[0]).not.toHaveProperty('cache_control');
    expect(result.system[1]).toHaveProperty('cache_control');
    expect(result.system[2]).toHaveProperty('cache_control');
    expect(countCacheControls(result)).toBe(4);
  });

  test('matches the provider-sanitized prompt text when splitting the L0 breakpoint', () => {
    const systemPrompt = composeAgentPrompt(def({ body: 'REVIEWER_AGENT_BODY\uD800' }), { mode: 'member' });
    const payload = {
      system: [{ type: 'text', text: sanitizeAgentPromptForProvider(systemPrompt), cache_control: cacheControl() }],
      messages: [],
    };

    const result = applyAgentPromptCacheBreakpoints(payload, ANTHROPIC_MODEL, {
      enabled: true,
      systemPrompt,
    }) as typeof payload;

    expect(result).toBe(payload);
    expect(result.system).toHaveLength(2);
    expect(result.system[0]?.text).toBe(AGENT_L0_FIRMWARE_PROMPT);
    expect(String(result.system[1]?.text)).toContain('REVIEWER_AGENT_BODY');
    expect(String(result.system[1]?.text)).not.toContain('\uD800');
  });

  test('does not split a system prompt block that has no provider cache control', () => {
    const systemPrompt = composeAgentPrompt(def(), { mode: 'member' });
    const payload = {
      system: [{ type: 'text', text: systemPrompt }],
      messages: [],
    };

    expect(applyAgentPromptCacheBreakpoints(payload, ANTHROPIC_MODEL, {
      enabled: true,
      systemPrompt,
    })).toBeUndefined();
    expect(payload.system).toHaveLength(1);
  });

  test('leaves disabled and non-Anthropic payloads untouched', () => {
    const systemPrompt = composeAgentPrompt(def(), { mode: 'member' });
    const payload = {
      system: [{ type: 'text', text: systemPrompt, cache_control: cacheControl() }],
    };

    expect(applyAgentPromptCacheBreakpoints(payload, ANTHROPIC_MODEL, {
      enabled: false,
      systemPrompt,
    })).toBeUndefined();
    expect(applyAgentPromptCacheBreakpoints(payload, OPENAI_MODEL, {
      enabled: true,
      systemPrompt,
    })).toBeUndefined();
  });
});
