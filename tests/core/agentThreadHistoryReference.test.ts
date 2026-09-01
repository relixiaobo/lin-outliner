import { describe, expect, test } from 'bun:test';
import type { Thread, ThreadResourceReference, Turn } from '../../src/core/agent/protocol';
import type { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { ThreadHistoryReferenceService } from '../../src/main/agent/thread/ThreadHistoryReference';
import type { ThreadResourceOps } from '../../src/main/agent/thread/ThreadResourceOps';

const CURRENT_ID = '01951d6e-7c25-7c31-8d62-313038616239';
const TARGET_ID = '01951d6e-7c25-7c31-8d62-313038616240';
const OTHER_PROFILE_ID = '01951d6e-7c25-7c31-8d62-313038616241';

const resourceRef: ThreadResourceReference = {
  id: 'resource:11111111-1111-4111-8111-111111111111',
  fileName: 'report.txt',
  mimeType: 'text/plain',
  byteLength: 12,
};

describe('Thread history references', () => {
  test('searches bounded visible same-profile roots and signs match cursors', async () => {
    const fixture = historyFixture();
    const results = fixture.service.searchForAgent({
      currentThreadId: CURRENT_ID,
      query: 'presentation',
      limit: 20,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ threadId: TARGET_ID, title: 'Prior work' });
    expect(results[0]?.snippet).toContain('presentation');
    expect(results[0]?.readCursor).toEqual(expect.any(String));
    expect(JSON.stringify(results)).not.toContain('sk-proj-test-secret-value-1234567890');
    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      cursor: `${results[0]!.readCursor}tampered`,
    })).rejects.toThrow('Invalid Thread history cursor');
    expect(() => fixture.service.searchForAgent({
      currentThreadId: CURRENT_ID,
      query: '',
    })).toThrow('must be non-empty');
    expect(fixture.service.searchForAgent({
      currentThreadId: CURRENT_ID,
      query: 'private',
    })).toEqual([]);
    expect(fixture.service.searchReferences({
      currentThreadId: CURRENT_ID,
      query: 'Users',
    }).data).toEqual([]);
    expect(fixture.service.searchReferences({
      currentThreadId: CURRENT_ID,
    }).data[0]?.snippet).toBe('Draft at [local path]');
  });

  test('reads bounded untrusted pages without projecting hidden content or raw tool output', async () => {
    const fixture = historyFixture();
    const result = await fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      turnLimit: 1,
      includeToolOutput: true,
    });
    const serialized = JSON.stringify(result.data);

    expect(result.resourceRefs).toEqual([]);
    expect(result.data).toMatchObject({
      threadId: TARGET_ID,
      untrusted: true,
      coverage: { turnCount: 1 },
    });
    expect(serialized).not.toContain('hidden reasoning');
    expect(serialized).not.toContain('ghp_0123456789abcdefghij');
    expect(serialized).toContain('bounded tool output');
    expect(serialized).not.toContain('sk-proj-test-secret-value-1234567890');
    expect(serialized).toContain('[redacted secret-like content]');
    expect(serialized).not.toContain('/Users/alice/private.txt');
    expect(serialized).not.toContain('file:///Users/alice/private.txt');
    expect(serialized).toContain('[local path]');
    expect(serialized).toContain('[historical file: private.txt]');
    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: CURRENT_ID,
    })).rejects.toThrow('cannot read itself');
    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: OTHER_PROFILE_ID,
    })).rejects.toThrow('another profile');
  });

  test('removes partial credentials that cross the bounded tool-output prefix', async () => {
    const boundaryCases = [
      {
        partialCredential: `sk-proj-${'A'.repeat(18)}`,
        leakedEvidence: `sk-proj-${'A'.repeat(12)}`,
      },
      {
        partialCredential: 'OPENAI_API_KEY=shortvalue',
        leakedEvidence: 'shortval',
      },
      {
        partialCredential: [
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          `MI${'B'.repeat(40)}`,
          '-----END RSA PRIVATE KEY-----',
          `MI${'C'.repeat(40)}`,
        ].join('\n'),
        leakedEvidence: `MI${'B'.repeat(12)}`,
      },
      {
        partialCredential: [
          '-----BEGIN OPENSSH PRIVATE KEY-----',
          `MI${'D'.repeat(40)}`,
          '-----END OPENSSH PRIVATE KEY-----',
        ].join('\n'),
        leakedEvidence: `MI${'D'.repeat(12)}`,
      },
      {
        partialCredential: 'postgres://user:secretpass@',
        leakedEvidence: 'secretpass',
      },
      {
        partialCredential: 'PASSWORD=complete-secret!',
        leakedEvidence: 'complete-secret',
      },
    ];
    for (const { partialCredential, leakedEvidence } of boundaryCases) {
      const leading = 'safe historical output\n';
      const padding = 'x'.repeat(4_000 - leading.length - 1 - partialCredential.length);
      const fixture = historyFixture({
        textPrefix: `${leading}${padding}\n${partialCredential}`,
        truncated: true,
      });

      const result = await fixture.service.readForAgent({
        currentThreadId: CURRENT_ID,
        threadId: TARGET_ID,
        turnLimit: 1,
        includeToolOutput: true,
      });
      const serialized = JSON.stringify(result.data);

      expect(serialized).toContain('safe historical output');
      expect(serialized).not.toContain(leakedEvidence);
    }
  });

  test('links only a selected citation from the same page and rejects a wrong-page key', async () => {
    const fixture = historyFixture();
    const newest = await fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      turnLimit: 1,
    });
    const citationKey = (newest.data.citations as Array<{ citationKey: string }>)[0]?.citationKey;
    expect(citationKey).toEqual(expect.any(String));
    expect(newest.data.citations).toHaveLength(20);
    expect(fixture.linked).toEqual([]);

    const selected = await fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      turnLimit: 1,
      citations: [{ citationKey: citationKey!, representation: 'replay' }],
    });
    expect(selected.resourceRefs).toEqual([resourceRef]);
    expect(fixture.linked).toEqual([resourceRef]);

    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      turnLimit: 1,
      citations: [
        { citationKey: citationKey!, representation: 'replay' },
        { citationKey: citationKey!, representation: 'edit' },
      ],
    })).rejects.toThrow('must be unique');
    expect(fixture.linked).toEqual([resourceRef]);

    fixture.advance(15 * 60_000);
    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      turnLimit: 1,
      citations: [{ citationKey: citationKey!, representation: 'replay' }],
    })).rejects.toThrow('stale or does not belong');

    const olderCursor = newest.data.previousCursor as string;
    await expect(fixture.service.readForAgent({
      currentThreadId: CURRENT_ID,
      threadId: TARGET_ID,
      cursor: olderCursor,
      turnLimit: 1,
      citations: [{ citationKey: citationKey!, representation: 'replay' }],
    })).rejects.toThrow('stale or does not belong');
  });
});

function historyFixture(toolOutputProjection: {
  readonly textPrefix: string;
  readonly truncated: boolean;
} = {
  textPrefix: [
    'bounded tool output with ghp_0123456789abcdefghij',
    'source /Users/alice/private.txt',
    'bound [[file:///Users/alice/private.txt]]',
  ].join('\n'),
  truncated: false,
}): {
  readonly service: ThreadHistoryReferenceService;
  readonly linked: ThreadResourceReference[];
  readonly advance: (milliseconds: number) => void;
} {
  const current = record(thread(CURRENT_ID, 'Current', 300), 'default');
  const target = record({
    ...thread(TARGET_ID, 'Prior work', 200),
    preview: 'Draft at /Users/example/private/report.key',
  }, 'default');
  const otherProfile = record(thread(OTHER_PROFILE_ID, 'Private', 100), 'other');
  const records = new Map([
    [CURRENT_ID, current],
    [TARGET_ID, target],
    [OTHER_PROFILE_ID, otherProfile],
  ]);
  const olderTurn = turnWithItems('turn-older', 100, [{
    id: 'user-old',
    type: 'userMessage',
    author: { kind: 'reader' },
    content: [{ type: 'text', text: 'Initial notes' }],
  }]);
  const newestTurn = turnWithItems('turn-newest', 200, [
    {
      id: 'assistant-visible',
      type: 'agentMessage',
      phase: 'final_answer',
      text: [
        'Created the presentation with OPENAI_API_KEY=sk-proj-test-secret-value-1234567890',
        `Cross-profile marker [[thread://${OTHER_PROFILE_ID}]]`,
      ].join('\n'),
      finalCitations: [],
    },
    { id: 'reasoning-hidden', type: 'reasoning', text: 'hidden reasoning' },
    {
      id: 'tool-summary',
      type: 'dynamicToolCall',
      namespace: null,
      tool: 'build',
      status: 'completed',
      output: 'raw tool output',
      outputRef: {
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        mimeType: 'text/plain',
        byteLength: 24,
        summary: 'bounded output',
      },
      resourceRefs: [
        resourceRef,
        ...Array.from({ length: 24 }, (_, index) => ({
          ...resourceRef,
          id: `resource:11111111-1111-4111-8111-${(index + 2).toString().padStart(12, '0')}`,
          fileName: `report-${index + 2}.txt`,
        })),
      ],
    },
  ]);
  const turns = [olderTurn, newestTurn];
  const core = {
    metadata: {
      read: (threadId: string) => records.get(threadId) ?? null,
      list: ({ archived }: { archived: boolean }) => ({
        data: archived ? [] : [current.thread, target.thread, otherProfile.thread],
        nextCursor: null,
      }),
    },
    history: {
      visibleHistoryEntries: (threadIds: readonly string[]) => threadIds.includes(TARGET_ID)
        ? newestTurn.items.map((item, itemIndex) => ({
            threadId: TARGET_ID,
            turnId: newestTurn.id,
            turnPosition: 1,
            itemIndex,
            item,
          }))
        : [],
      historyTurnPage: (_threadId: string, anchor: number | null, limit: number) => {
        const maximum = anchor ?? turns.length - 1;
        const selected = turns
          .map((turnValue, position) => ({ position, turn: turnValue }))
          .filter((entry) => entry.position <= maximum)
          .slice(-limit);
        const oldestPosition = selected[0]?.position ?? null;
        const newestPosition = selected.at(-1)?.position ?? null;
        return {
          turns: selected.map((entry) => entry.turn),
          oldestPosition,
          newestPosition,
          hasOlder: oldestPosition !== null && oldestPosition > 0,
          hasNewer: newestPosition !== null && newestPosition < turns.length - 1,
        };
      },
    },
    payloads: {
      readTextReferencePrefix: async () => toolOutputProjection,
    },
  } as unknown as ThreadCore;
  const linked: ThreadResourceReference[] = [];
  let now = 1_000;
  const resourceOps = {
    selectHistoricalResource: async (
      _current: string,
      _historical: string,
      ref: ThreadResourceReference,
    ) => {
      linked.push(ref);
      return { ref, path: null, entryKind: 'file' as const };
    },
  } as unknown as ThreadResourceOps;
  return {
    service: new ThreadHistoryReferenceService(core, resourceOps, () => true, () => now),
    linked,
    advance: (milliseconds) => { now += milliseconds; },
  };
}

function thread(id: string, name: string, updatedAt: number): Thread {
  return {
    id,
    sessionId: `session:${id}`,
    parentThreadId: null,
    forkedFromId: null,
    agentNickname: null,
    agentRole: null,
    name,
    preview: name,
    ephemeral: false,
    source: 'test',
    threadSource: 'user',
    modelProvider: 'openai',
    cwd: '/workspace',
    createdAt: updatedAt - 1,
    updatedAt,
    status: 'idle',
    historyMode: 'fullContext',
  };
}

function record(threadValue: Thread, profileName: string) {
  return {
    thread: threadValue,
    configuration: { profileName },
  };
}

function turnWithItems(id: string, startedAt: number, items: readonly unknown[]): Turn {
  return {
    id,
    status: 'completed',
    items,
    startedAt,
    completedAt: startedAt + 1,
    durationMs: 1,
    error: null,
    provenance: {
      originThreadId: TARGET_ID,
      kind: 'local',
      forkDepth: 0,
      sourceTurnId: null,
    },
    execution: {
      resetEpoch: 0,
      diagnosticsRef: null,
      contextRefs: [],
      internalTextRefs: [],
      toolOutputRefs: [],
    },
  } as unknown as Turn;
}
