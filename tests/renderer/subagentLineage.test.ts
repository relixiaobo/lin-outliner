import { describe, expect, test } from 'bun:test';
import type { Thread } from '../../src/core/agent/protocol';
import { lineagePathFromRoot } from '../../src/renderer/agent/components/ThreadDock';
import type { SubagentRegistryEntry } from '../../src/renderer/agent/subagentPresentation';

const ROOT = 'thread-root';

describe('Agent lineage resolution', () => {
  test('resolves from the execution records, before any child Thread is read', () => {
    // The state a restored conversation starts in: `thread/list` is roots-only,
    // so the records and their chips arrive before the child Threads do.
    expect(lineagePathFromRoot('agent-child', ROOT, new Map(), registry([
      { agentId: 'agent-child', parentThreadId: ROOT },
    ]))).toEqual(['agent-child']);
  });

  test('carries a grandchild\'s whole lineage, so Back unwinds through its delegator', () => {
    expect(lineagePathFromRoot('agent-grandchild', ROOT, new Map(), registry([
      { agentId: 'agent-child', parentThreadId: ROOT },
      { agentId: 'agent-grandchild', parentThreadId: 'agent-child' },
    ]))).toEqual(['agent-child', 'agent-grandchild']);
  });

  test('falls back to the Thread catalog for a child with no execution record', () => {
    expect(lineagePathFromRoot('agent-child', ROOT, new Map([
      ['agent-child', thread('agent-child', ROOT)],
    ]), new Map())).toEqual(['agent-child']);
  });

  test('refuses a target that is not in this conversation at all', () => {
    expect(lineagePathFromRoot('agent-elsewhere', ROOT, new Map(), registry([
      { agentId: 'agent-elsewhere', parentThreadId: 'thread-other-root' },
    ]))).toBeNull();
    expect(lineagePathFromRoot('agent-unknown', ROOT, new Map(), new Map())).toBeNull();
  });

  test('refuses a cycle rather than walking it', () => {
    expect(lineagePathFromRoot('agent-a', ROOT, new Map(), registry([
      { agentId: 'agent-a', parentThreadId: 'agent-b' },
      { agentId: 'agent-b', parentThreadId: 'agent-a' },
    ]))).toBeNull();
  });
});

function registry(
  entries: readonly { readonly agentId: string; readonly parentThreadId: string }[],
): ReadonlyMap<string, SubagentRegistryEntry> {
  return new Map(entries.map((entry) => [entry.agentId, {
    agentId: entry.agentId,
    parentThreadId: entry.parentThreadId,
    displayName: entry.agentId,
    agentType: 'general-purpose',
    form: 'agent' as const,
    runMode: 'background' as const,
    generation: 1,
    status: 'completed' as const,
    stoppedByUser: false,
    startedAt: null,
    durationMs: null,
    settledAt: null,
    error: null,
    worktree: null,
    liveDescendantCount: 0,
  }]));
}

function thread(id: string, parentThreadId: string): Thread {
  return {
    id,
    sessionId: 'session',
    parentThreadId,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name: null,
    preview: '',
    ephemeral: false,
    source: 'collaboration',
    threadSource: 'subagent',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    status: { type: 'idle' },
    historyMode: 'paginated',
  };
}
