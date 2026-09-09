import { describe, expect, test } from 'bun:test';
import type { Thread } from '../../src/core/agent/protocol';
import type { ThreadCore } from '../../src/main/agent/thread/ThreadCore';
import { ThreadHistoryReferenceService } from '../../src/main/agent/thread/ThreadHistoryReference';

const CURRENT_ID = '01951d6e-7c25-7c31-8d62-313038616239';
const TARGET_ID = '01951d6e-7c25-7c31-8d62-313038616240';
const OTHER_PROFILE_ID = '01951d6e-7c25-7c31-8d62-313038616241';
const DELEGATION_ID = '01951d6e-7c25-7c31-8d62-313038616242';

function historyFixture() {
  const records = new Map([
    [CURRENT_ID, record(thread(CURRENT_ID, 'Current', 300), 'default')],
    [
      TARGET_ID,
      record(
        { ...thread(TARGET_ID, 'Prior work', 200), preview: 'Draft at /Users/example/private/report.key' },
        'default',
      ),
    ],
    [
      OTHER_PROFILE_ID,
      record({ ...thread(OTHER_PROFILE_ID, 'Automation root', 100), threadSource: 'automation' }, 'other'),
    ],
    [
      DELEGATION_ID,
      record(
        {
          ...thread(DELEGATION_ID, 'Hidden delegated work', 250),
          parentThreadId: CURRENT_ID,
          threadSource: 'delegation',
        },
        'default',
      ),
    ],
  ]);
  const excluded = new Set<string>();
  const corrupt = new Set<string>();
  const core = {
    metadata: {
      read: (id: string) => records.get(id) ?? null,
      list: ({ archived }: { archived: boolean }) => ({
        data: archived ? [] : [...records.values()].map((r) => r.thread),
        nextCursor: null,
      }),
    },
    history: {
      visibleHistoryEntries: (ids: string[]) => {
        if (ids.some((id) => corrupt.has(id))) throw new Error('Corrupt history must not be decoded');
        return ids.includes(TARGET_ID)
          ? [
              {
                threadId: TARGET_ID,
                turnPosition: 0,
                item: {
                  id: 'message',
                  type: 'agentMessage',
                  text: 'Decision: use ordinary files. OPENAI_API_KEY=sk-proj-test-secret-value-1234567890',
                },
              },
            ]
          : [];
      },
    },
  } as unknown as ThreadCore;
  return {
    records,
    excluded,
    corrupt,
    service: new ThreadHistoryReferenceService(
      core,
      (id) => !corrupt.has(id),
      (id) => !excluded.has(id),
    ),
  };
}

describe('Composer Thread references', () => {
  test('discovers persistent user and Automation roots across Profiles, including self', () => {
    const { service } = historyFixture();
    expect(service.searchReferences({ currentThreadId: CURRENT_ID }).data.map((r) => r.threadId)).toEqual([
      CURRENT_ID,
      TARGET_ID,
      OTHER_PROFILE_ID,
    ]);
    expect(
      service
        .resolveReferences({
          currentThreadId: CURRENT_ID,
          threadIds: [CURRENT_ID, TARGET_ID, OTHER_PROFILE_ID, DELEGATION_ID, 'missing'],
        })
        .data.map((r) => r.availability),
    ).toEqual(['current', 'available', 'available', 'denied', 'missing']);
  });
  test('applies exclusions and ephemeral eligibility to discovery and explicit resolution', () => {
    const { service, records, excluded } = historyFixture();
    excluded.add(CURRENT_ID);
    excluded.add(TARGET_ID);
    records.get(OTHER_PROFILE_ID)!.thread.ephemeral = true;
    expect(service.searchReferences({ currentThreadId: CURRENT_ID }).data).toEqual([]);
    expect(
      service
        .resolveReferences({
          currentThreadId: CURRENT_ID,
          threadIds: [CURRENT_ID, TARGET_ID, OTHER_PROFILE_ID],
        })
        .data.every((r) => r.availability === 'denied'),
    ).toBe(true);
  });
  test('keeps snippets bounded and redacted while returning metadata for corrupt history', () => {
    const { service, corrupt } = historyFixture();
    const results = service.searchReferences({ currentThreadId: CURRENT_ID, query: 'ordinary' }).data;
    expect(results).toHaveLength(1);
    expect(results[0]!.snippet).toContain('Decision: use ordinary files');
    expect(JSON.stringify(results).includes('sk-proj-test-secret')).toBe(false);
    expect(service.searchReferences({ currentThreadId: CURRENT_ID, query: 'Users' }).data).toEqual([]);
    corrupt.add(TARGET_ID);
    expect(
      service.searchReferences({ currentThreadId: CURRENT_ID, query: 'Prior' }).data[0]!.availability,
    ).toBe('corrupt');
    expect(service.searchReferences({ currentThreadId: CURRENT_ID, query: 'ordinary' }).data).toEqual([]);
    expect(
      service.resolveReferences({ currentThreadId: CURRENT_ID, threadIds: [TARGET_ID] }).data[0]!
        .availability,
    ).toBe('corrupt');
  });
});

function thread(id: string, name: string, updatedAt: number): Thread {
  return {
    id,
    sessionId: `session:${id}`,
    parentThreadId: null,
    forkedFromId: null,
    name,
    preview: name,
    ephemeral: false,
    source: 'test',
    threadSource: 'user',
    modelProvider: 'openai',
    configurationSource: { kind: 'user' },
    createdAt: updatedAt - 1,
    updatedAt,
    status: { type: 'idle' },
    historyMode: 'full',
  };
}

function record(threadValue: Thread, profileName: string) {
  return {
    thread: threadValue,
    configuration: { profileName },
  };
}
