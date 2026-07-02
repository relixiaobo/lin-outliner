import { describe, expect, test } from 'bun:test';
import type { AgentRunBudget, AgentRunScope } from '../../src/core/agentEventLog';
import type { AgentMessage } from '../../src/core/agentTypes';
import {
  admitRunBudget,
  formatRunBudgetForPrompt,
  formatRunScopeForPrompt,
  narrowRunScope,
  normalizeRunBudget,
  normalizeRunBudgetInput,
  normalizeRunScope,
  releaseAdmittedRunBudget,
  remainingBudgetMs,
  retryBudgetSlice,
  scopedAllowedToolNames,
  settleRunBudget,
  verifierBudgetForRun,
  verifierRunScope,
} from '../../src/main/agentDelegationRunPolicy';

describe('agent delegation run policy', () => {
  test('normalizes partial budget updates without wiping untouched limits', () => {
    const now = 10_000;
    const existing: AgentRunBudget = {
      tokens: 120,
      wallClockMinutes: 30,
      reservedTokens: 40,
      spentTokens: 5,
      startedAt: now,
      deadlineAt: now + 30 * 60_000,
    };

    const next = normalizeRunBudget(normalizeRunBudgetInput({ wallClockMinutes: 5 }), existing, now + 1_000);

    expect(next).toEqual({
      tokens: 120,
      wallClockMinutes: 5,
      reservedTokens: 40,
      spentTokens: 5,
      startedAt: now,
      deadlineAt: now + 5 * 60_000,
    });
  });

  test('reserves, releases, and settles parent token budget slices', () => {
    const now = 1_000;
    const parent: AgentRunBudget = { tokens: 100, reservedTokens: 20, spentTokens: 10 };

    const releasedBudget = admitRunBudget(parent, { tokens: 30 }, now, false);
    expect(parent.reservedTokens).toBe(50);
    releaseAdmittedRunBudget(parent, releasedBudget);
    expect(parent.reservedTokens).toBe(20);

    const budget = admitRunBudget(parent, { tokens: 30 }, now, false);
    expect(parent.reservedTokens).toBe(50);

    const run = {
      budget,
      parentBudgetRef: parent,
      budgetSettled: false,
      messages: [
        { role: 'assistant', usage: { totalTokens: 12 } },
        { role: 'assistant', usage: { totalTokens: 50 } },
      ] as AgentMessage[],
    };
    settleRunBudget(run);

    expect(parent.reservedTokens).toBe(20);
    expect(parent.spentTokens).toBe(40);
    expect(run.budgetSettled).toBe(true);

    settleRunBudget(run);
    expect(parent.reservedTokens).toBe(20);
    expect(parent.spentTokens).toBe(40);
  });

  test('rejects child wall-clock budgets beyond the parent remainder', () => {
    const now = 1_000;
    const parent: AgentRunBudget = { wallClockMinutes: 5, startedAt: now, deadlineAt: now + 5 * 60_000 };

    expect(() => admitRunBudget(parent, { wallClockMinutes: 6 }, now, false))
      .toThrow('Run budget exceeds parent remaining wall-clock budget.');
  });

  test('normalizes and narrows run scope without widening parent constraints', () => {
    const parent: AgentRunScope = {
      capabilities: ['file.read.allowed_file_area', 'outline.read'],
      resources: { docs: ['spec'], paths: ['src'] },
    };

    expect(normalizeRunScope({
      capabilities: ['file_read', 'outline.read', 'unknown'],
      resources: { docs: [' spec '], paths: [' src '] },
    })).toEqual({
      capabilities: [
        'file.read.allowed_file_area',
        'file.read.outside_allowed_file_area',
        'file.read.sensitive_local_path',
        'outline.read',
      ],
      resources: { docs: ['spec'], paths: ['src'] },
    });

    expect(narrowRunScope(parent, undefined)).toEqual(parent);
    expect(narrowRunScope(parent, {
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'] },
    })).toEqual({
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'] },
    });

    expect(() => narrowRunScope(parent, { capabilities: ['outline.edit'] }))
      .toThrow('Run scope cannot widen capabilities: outline.edit');
    expect(() => narrowRunScope(parent, { resources: { paths: ['tmp'] } }))
      .toThrow('Run scope cannot widen paths: tmp');
  });

  test('derives allowed tools and verifier-only read scope from capabilities', () => {
    expect(scopedAllowedToolNames(['file_read', 'file_edit', 'node_read'], {
      capabilities: ['file.read.allowed_file_area', 'outline.read'],
    })).toEqual(['file_read', 'node_read']);

    expect(scopedAllowedToolNames(['file_read', 'file_edit'], undefined)).toEqual(['file_read', 'file_edit']);

    expect(verifierRunScope({
      capabilities: ['file.read.allowed_file_area', 'outline.edit', 'web.search'],
    })).toEqual({
      capabilities: ['file.read.allowed_file_area', 'web.search'],
    });
  });

  test('formats and slices budgets for prompts, retries, and timers', () => {
    const originalNow = Date.now;
    Date.now = () => 5_000;
    try {
      expect(remainingBudgetMs({ budget: { deadlineAt: 8_500 } })).toBe(3_500);
      expect(verifierBudgetForRun({ budget: { wallClockMinutes: 60, deadlineAt: 10 * 60_000 + 5_000 } }))
        .toEqual({ wallClockMinutes: 10 });
    } finally {
      Date.now = originalNow;
    }

    expect(retryBudgetSlice({
      tokens: 200,
      wallClockMinutes: 15,
      reservedTokens: 50,
      spentTokens: 25,
      startedAt: 1,
      deadlineAt: 2,
    })).toEqual({ tokens: 200, wallClockMinutes: 15 });
    expect(formatRunBudgetForPrompt({ tokens: 10, wallClockMinutes: 2 })).toBe('- token budget: 10\n- wall-clock budget: 2 minutes');
    expect(formatRunScopeForPrompt({
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'] },
    })).toBe('- capabilities: outline.read\n- docs: spec\n- paths: src');
  });
});
