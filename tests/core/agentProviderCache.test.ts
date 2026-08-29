import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import {
  applyAnthropicStablePromptCacheBreakpoints,
  providerCacheAffinity,
} from '../../src/main/agent/context/ProviderCache';
import type { StablePrompt } from '../../src/main/agent/context/stablePrompt';

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

describe('provider cache topology', () => {
  test('keeps affinity stable within one Thread epoch and changes it only after reset', () => {
    const threadId = '0199a000-0000-7000-8000-000000000001';
    const ordinaryTurn = turn('turn-before', [{
      type: 'userMessage',
      author: { kind: 'reader' },
      id: 'user-before',
      provenance: provenance(threadId, 'turn-before', 'user-before'),
      clientId: null,
      acceptedAt: 1,
      content: [{ type: 'text', text: 'Before reset' }],
    }]);
    const resetTurn = turn('turn-reset', [{
      type: 'contextReset',
      id: 'reset-boundary',
      provenance: provenance(threadId, 'turn-reset', 'reset-boundary'),
      clearedThrough: { turnId: ordinaryTurn.id, itemId: ordinaryTurn.items[0]!.id },
    }]);
    const compactTurn = turn('turn-compact', [{
      type: 'contextCompaction',
      id: 'compact-boundary',
      provenance: provenance(threadId, 'turn-compact', 'compact-boundary'),
      trigger: 'manual',
      coveredFrom: { turnId: ordinaryTurn.id, itemId: ordinaryTurn.items[0]!.id },
      coveredThrough: { turnId: ordinaryTurn.id, itemId: ordinaryTurn.items[0]!.id },
      preservedFrom: null,
      summaryRef: contextRef('compactionSummary', 'a'),
      restoredStateRef: contextRef('compactionRestoredState', 'b'),
      instructionsRef: null,
      contextRefs: [],
      resourceRefs: [],
      outputRefs: [],
    }]);
    const afterTurn = turn('turn-after', [{
      type: 'userMessage',
      author: { kind: 'reader' },
      id: 'user-after',
      provenance: provenance(threadId, 'turn-after', 'user-after'),
      clientId: null,
      acceptedAt: 3,
      content: [{ type: 'text', text: 'After reset' }],
    }]);

    const initial = providerCacheAffinity(threadId, []);
    expect(providerCacheAffinity(threadId, [ordinaryTurn])).toBe(initial);
    expect(providerCacheAffinity(threadId, [ordinaryTurn, compactTurn])).toBe(initial);
    const reset = providerCacheAffinity(threadId, [ordinaryTurn, resetTurn]);
    expect(reset).not.toBe(initial);
    expect(providerCacheAffinity(threadId, [ordinaryTurn, resetTurn, afterTurn])).toBe(reset);
    expect(providerCacheAffinity(`${threadId}-other`, [ordinaryTurn])).not.toBe(initial);
    expect(initial).toBe(createHash('sha256')
      .update('tenon-agent-cache-affinity-v1\0')
      .update(threadId)
      .update('\0initial')
      .digest('hex'));
  });

  test('splits structured Anthropic stable prompt blocks and preserves four useful breakpoints', () => {
    const prompt = stablePrompt('FRAMEWORK', 'FILES', 'IDENTITY');
    const payload = {
      system: [{ type: 'text', text: prompt.text, cache_control: cacheControl() }],
      tools: [{ name: 'file_read', cache_control: cacheControl() }],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Inspect it', cache_control: cacheControl() }],
      }],
    };

    const result = applyAnthropicStablePromptCacheBreakpoints(
      payload,
      ANTHROPIC_MODEL,
      prompt,
    ) as typeof payload;

    expect(result).not.toBe(payload);
    expect(result.system).toEqual([
      { type: 'text', text: 'FRAMEWORK', cache_control: cacheControl() },
      { type: 'text', text: 'FILES\n\nIDENTITY', cache_control: cacheControl() },
    ]);
    expect(countCacheControls(result)).toBe(4);
  });

  test('removes the OAuth identity breakpoint before the L0, execution, tool, or user breakpoints', () => {
    const prompt = stablePrompt('FRAMEWORK', 'TOOLS', 'ROLE');
    const payload = {
      system: [
        {
          type: 'text',
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: cacheControl(),
        },
        { type: 'text', text: prompt.text, cache_control: cacheControl() },
      ],
      tools: [{ name: 'file_read', cache_control: cacheControl() }],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Read it', cache_control: cacheControl() }],
      }],
    };

    const result = applyAnthropicStablePromptCacheBreakpoints(
      payload,
      ANTHROPIC_MODEL,
      prompt,
    ) as typeof payload;

    expect(result.system).toHaveLength(3);
    expect(result.system[0]).not.toHaveProperty('cache_control');
    expect(result.system[1]).toHaveProperty('cache_control');
    expect(result.system[2]).toHaveProperty('cache_control');
    expect(countCacheControls(result)).toBe(4);
  });

  test('matches provider-sanitized text without parsing prompt markers', () => {
    const prompt = stablePrompt('FRAMEWORK', 'TOOLS', 'ROLE\uD800');
    const payload = {
      system: [{
        type: 'text',
        text: prompt.text.replace('\uD800', '\uFFFD'),
        cache_control: cacheControl(),
      }],
    };

    const result = applyAnthropicStablePromptCacheBreakpoints(
      payload,
      ANTHROPIC_MODEL,
      prompt,
    ) as typeof payload;

    expect(result.system).toEqual([
      { type: 'text', text: 'FRAMEWORK', cache_control: cacheControl() },
      { type: 'text', text: 'TOOLS\n\nROLE\uFFFD', cache_control: cacheControl() },
    ]);
  });

  test('matches raw lone surrogates before the provider adapter sanitizes them', () => {
    const prompt = stablePrompt('FRAMEWORK', 'TOOLS', 'ROLE\uD800');
    const payload = {
      system: [{ type: 'text', text: prompt.text, cache_control: cacheControl() }],
    };

    const result = applyAnthropicStablePromptCacheBreakpoints(
      payload,
      ANTHROPIC_MODEL,
      prompt,
    ) as typeof payload;

    expect(result.system).toEqual([
      { type: 'text', text: 'FRAMEWORK', cache_control: cacheControl() },
      { type: 'text', text: 'TOOLS\n\nROLE\uFFFD', cache_control: cacheControl() },
    ]);
  });

  test('leaves non-Anthropic and uncached payloads untouched', () => {
    const prompt = stablePrompt('FRAMEWORK', 'TOOLS', 'IDENTITY');
    const cached = {
      system: [{ type: 'text', text: prompt.text, cache_control: cacheControl() }],
    };
    const uncached = { system: [{ type: 'text', text: prompt.text }] };

    expect(applyAnthropicStablePromptCacheBreakpoints(cached, OPENAI_MODEL, prompt)).toBeUndefined();
    expect(applyAnthropicStablePromptCacheBreakpoints(uncached, ANTHROPIC_MODEL, prompt)).toBeUndefined();
    expect(cached.system).toHaveLength(1);
    expect(uncached.system).toHaveLength(1);
  });
});

function stablePrompt(l0: string, l1: string, l2: string): StablePrompt {
  const text = [l0, l1, l2].join('\n\n');
  return {
    text,
    blocks: [
      { id: 'framework', layer: 'L0', text: l0, fingerprint: 'l0' },
      { id: 'capabilities', layer: 'L1', text: l1, fingerprint: 'l1' },
      { id: 'identity', layer: 'L2', text: l2, fingerprint: 'l2' },
    ],
    fingerprints: { l0: 'l0', l1: 'l1', l2: 'l2', complete: 'complete' },
  };
}

function cacheControl() {
  return { type: 'ephemeral' };
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCacheControls(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  return ('cache_control' in record ? 1 : 0)
    + Object.values(record).reduce((total, item) => total + countCacheControls(item), 0);
}

function provenance(threadId: string, turnId: string, itemId: string) {
  return { originThreadId: threadId, originTurnId: turnId, originItemId: itemId };
}

function turn(id: string, items: readonly ThreadItem[]): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    provenance: { originThreadId: items[0]!.provenance.originThreadId, originTurnId: id, trigger: { kind: 'user' } },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'anthropic',
      model: 'claude-test',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function contextRef(kind: 'compactionSummary' | 'compactionRestoredState', seed: string) {
  return {
    id: seed.repeat(64),
    mimeType: 'application/vnd.tenon.agent-context+json' as const,
    byteLength: 1,
    schemaVersion: 1 as const,
    kind,
  };
}
