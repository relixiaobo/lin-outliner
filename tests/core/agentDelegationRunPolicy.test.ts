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
  prepareRunBudgetAmendment,
  releaseAdmittedRunBudget,
  remainingBudgetMs,
  retryBudgetSlice,
  scopedAllowedToolNames,
  settleRunBudget,
  verifierAllowedToolNames,
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

  test('preserves exact absolute deadlines without rounding them up to a minute', () => {
    const now = 10_000;
    expect(normalizeRunBudgetInput({ deadlineAt: now + 1_234 })).toEqual({ deadlineAt: now + 1_234 });
    expect(normalizeRunBudget({ wallClockMinutes: 5, deadlineAt: now + 1_234 }, undefined, now)).toMatchObject({
      wallClockMinutes: 5,
      deadlineAt: now + 1_234,
    });
    expect(normalizeRunBudget({ deadlineAt: now - 1 }, undefined, now)).toMatchObject({
      deadlineAt: now - 1,
    });
    expect(retryBudgetSlice({ deadlineAt: now + 1_234 })).toEqual({ deadlineAt: now + 1_234 });
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
    expect(admitRunBudget(parent, { tokens: 10 }, now, false)).toMatchObject({
      tokens: 10,
      deadlineAt: parent.deadlineAt,
    });
  });

  test('prevalidates amended child budgets without mutating the parent ledger', () => {
    const now = 1_000;
    const parent: AgentRunBudget = {
      tokens: 100,
      reservedTokens: 80,
      spentTokens: 0,
      deadlineAt: now + 5 * 60_000,
    };
    const existing: AgentRunBudget = {
      tokens: 80,
      startedAt: now,
      deadlineAt: parent.deadlineAt,
    };

    expect(() => prepareRunBudgetAmendment(
      { tokens: 101 },
      existing,
      parent,
      false,
      now + 1_000,
    )).toThrow('Amended run budget exceeds parent remaining token budget.');
    expect(() => prepareRunBudgetAmendment(
      { deadlineAt: parent.deadlineAt + 1 },
      existing,
      parent,
      false,
      now + 1_000,
    )).toThrow('Amended run budget exceeds parent remaining wall-clock budget.');
    expect(parent.reservedTokens).toBe(80);

    expect(prepareRunBudgetAmendment(
      { tokens: 90 },
      existing,
      parent,
      false,
      now + 1_000,
    )).toEqual({
      budget: { ...existing, tokens: 90 },
      parentReservedTokens: 90,
    });
  });

  test('normalizes and narrows run scope without widening parent constraints', () => {
    const parent: AgentRunScope = {
      capabilities: ['file.read.local_path', 'outline.read'],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a', 'node:b'] },
    };

    expect(normalizeRunScope({
      capabilities: ['file_read', 'outline.read', 'unknown'],
      resources: { docs: [' spec '], paths: [' src '], nodes: [' node:a '] },
    })).toEqual({
      capabilities: [
        'file.read.local_path',
        'file.read.sensitive_local_path',
        'outline.read',
      ],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a'] },
    });

    expect(narrowRunScope(parent, undefined)).toEqual(parent);
    expect(narrowRunScope(parent, {
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a'] },
    })).toEqual({
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a'] },
    });

    expect(() => narrowRunScope(parent, { capabilities: ['outline.edit'] }))
      .toThrow('Run scope cannot widen capabilities: outline.edit');
    expect(() => narrowRunScope(parent, { resources: { paths: ['tmp'] } }))
      .toThrow('Run scope cannot widen paths: tmp');
    expect(() => narrowRunScope(parent, { resources: { nodes: ['node:c'] } }))
      .toThrow('Run scope cannot widen nodes: node:c');

    expect(normalizeRunScope({ resources: {
      nodes: [],
      writableNodes: [],
      creatableNodeParents: [],
    } })).toEqual({
      resources: { nodes: [], writableNodes: [], creatableNodeParents: [] },
    });
    expect(narrowRunScope({ resources: { nodes: [] } }, undefined)).toEqual({
      resources: { nodes: [] },
    });
    expect(() => narrowRunScope({ resources: { nodes: [] } }, { resources: { nodes: ['node:a'] } }))
      .toThrow('Run scope cannot widen nodes: node:a');
    expect(() => narrowRunScope(
      { resources: { nodes: ['node:a'], writableNodes: [] } },
      { resources: { nodes: ['node:a'], writableNodes: ['node:a'] } },
    )).toThrow('Run scope cannot widen writableNodes: node:a');
    expect(narrowRunScope(
      {
        resources: {
          nodes: ['node:a', 'node:b'],
          writableNodes: [],
          creatableNodeParents: ['node:a'],
        },
      },
      {
        resources: {
          nodes: ['node:a'],
          writableNodes: [],
          creatableNodeParents: ['node:a'],
        },
      },
    )).toEqual({
      resources: {
        nodes: ['node:a'],
        writableNodes: [],
        creatableNodeParents: ['node:a'],
      },
    });
    expect(() => narrowRunScope(
      {
        resources: {
          nodes: ['node:a', 'node:b'],
          writableNodes: [],
          creatableNodeParents: ['node:a'],
        },
      },
      { resources: { nodes: ['node:b'], creatableNodeParents: ['node:b'] } },
    )).toThrow('Run scope cannot widen creatableNodeParents: node:b');
  });

  test('derives allowed tools and verifier-only read scope from capabilities', () => {
    expect(scopedAllowedToolNames(['file_read', 'file_edit', 'node_read'], {
      capabilities: ['file.read.local_path', 'outline.read'],
    })).toEqual(['file_read', 'node_read']);

    expect(scopedAllowedToolNames(['file_read', 'file_edit'], undefined)).toEqual(['file_read', 'file_edit']);

    expect(verifierRunScope({
      capabilities: ['file.read.local_path', 'outline.edit', 'web.search'],
      resources: {
        docs: ['spec'],
        paths: ['src'],
        nodes: ['node:a'],
        writableNodes: ['node:a'],
        creatableNodeParents: ['node:a'],
      },
    })).toEqual({
      capabilities: ['file.read.local_path', 'web.search'],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a'] },
    });
    expect(verifierRunScope({ resources: { writableNodes: ['node:writable'] } })).toMatchObject({
      resources: { nodes: ['node:writable'] },
    });
    expect(verifierRunScope({ resources: { creatableNodeParents: ['node:create-parent'] } }))
      .toMatchObject({ resources: { nodes: ['node:create-parent'] } });
    expect(verifierRunScope({
      resources: {
        writableNodes: ['node:writable'],
        creatableNodeParents: ['node:create-parent'],
      },
    })).toMatchObject({
      resources: { nodes: ['node:writable', 'node:create-parent'] },
    });
    expect(verifierAllowedToolNames({ capabilities: ['outline.edit'] })).toEqual([]);
    expect(verifierAllowedToolNames({ capabilities: ['outline.read', 'web.search'] })).toEqual([
      'web_search',
      'node_search',
      'node_read',
    ]);
    expect(verifierAllowedToolNames(undefined, ['node_read', 'node_edit'])).toEqual(['node_read']);
    expect(verifierAllowedToolNames(
      { capabilities: ['outline.read', 'web.search'] },
      ['node_read'],
    )).toEqual(['node_read']);
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
    })).toEqual({ tokens: 200, wallClockMinutes: 15, deadlineAt: 2 });
    expect(formatRunBudgetForPrompt({ tokens: 10, wallClockMinutes: 2 })).toBe('- token budget: 10\n- wall-clock budget: 2 minutes');
    expect(formatRunBudgetForPrompt({ deadlineAt: 1_800_000_000_000 })).toBe('- deadline: 2027-01-15T08:00:00.000Z');
    expect(formatRunScopeForPrompt({
      capabilities: ['outline.read'],
      resources: { docs: ['spec'], paths: ['src'], nodes: ['node:a'] },
    })).toBe('- capabilities: outline.read\n- docs: spec\n- paths: src\n- nodes: node:a');
    expect(formatRunScopeForPrompt({ resources: { nodes: [] } })).toBe('- nodes: none (deny all)');
    expect(formatRunScopeForPrompt({ resources: { nodes: ['node:a'], writableNodes: [] } }))
      .toBe('- nodes: node:a\n- writable nodes: none (deny all)');
    expect(formatRunScopeForPrompt({
      resources: { nodes: ['node:a'], writableNodes: [], creatableNodeParents: ['node:a'] },
    })).toBe('- nodes: node:a\n- writable nodes: none (deny all)\n- creatable node parents: node:a');
  });
});
