import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LinApi } from '../../src/preload';
import type {
  ChangeSet,
  Diff,
  Operation,
  OutlineResponse,
  OutlineStreamRecord,
} from '../../src/outline/contract';
import {
  OutlineRequestError,
  projectionUpdateFromOutlineEvent,
  readDesktopProjection,
  requestOutline,
  runDesktopMutation,
  subscribeDesktopProjection,
} from '../../src/renderer/api/outline';

let savedWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.assign(globalThis, { window: {} });
});

afterEach(() => {
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else delete (globalThis as { window?: unknown }).window;
});

describe('renderer Outline client', () => {
  test('restarts a startup Projection read when Memory advances the revision between pages', async () => {
    let requests = 0;
    const cursors: Array<string | undefined> = [];
    installOutlineRequest(async (request) => {
      requests += 1;
      cursors.push((request.input as { projection: { page: { cursor?: string } } }).projection.page.cursor);
      if (requests === 2) return {
        protocolVersion: 1, requestId: request.requestId, command: request.command, ok: false,
        error: { code: 'stale_revision', category: 'conflict', message: 'Projection revision changed.', retryable: false },
      } as unknown as OutlineResponse;
      const page = projectionPage(requests === 1 || requests === 3 ? 1 : 2);
      return success(request.command, requests > 2 ? { ...page, revision: 8 } : page);
    });
    const snapshot = await readDesktopProjection();
    expect(snapshot.revision).toBe(8);
    expect(snapshot.projection.nodes.map((node) => node.id)).toEqual(['workspace', 'today']);
    expect(cursors).toEqual([undefined, 'page:2', undefined, 'page:2']);
  });

  test('bounds repeated stale Projection reads and preserves non-conflict failures', async () => {
    for (const code of ['stale_revision', 'invalid_request'] as const) {
      let requests = 0;
      installOutlineRequest(async (request) => {
        requests += 1;
        return {
          protocolVersion: 1, requestId: request.requestId, command: request.command, ok: false,
          error: { code, category: 'conflict', message: 'Cannot read Projection.', retryable: false },
        } as unknown as OutlineResponse;
      });
      await expect(readDesktopProjection()).rejects.toMatchObject({ outlineError: { code } });
      expect(requests).toBe(code === 'stale_revision' ? 3 : 1);
    }
  });

  test('assembles a full desktop Projection from revision-bound pages', async () => {
    const requests: unknown[] = [];
    let page = 0;
    installOutlineRequest(async (request) => {
      requests.push(request);
      page += 1;
      return success(request.command, projectionPage(page));
    });

    const snapshot = await readDesktopProjection();

    expect(snapshot.revision).toBe(7);
    expect(snapshot.projection.workspaceId).toBe('workspace-id');
    expect(snapshot.projection.todayId).toBe('today');
    expect(snapshot.projection.nodes.map((node) => node.id)).toEqual(['workspace', 'today']);
    expect(requests).toHaveLength(2);
    expect((requests[1] as { input: { projection: { page: { cursor?: string } } } })
      .input.projection.page.cursor).toBe('page:2');
  });

  test('preserves structured Runtime errors', async () => {
    installOutlineRequest(async (request) => ({
      protocolVersion: 1,
      requestId: request.requestId,
      command: request.command,
      ok: false,
      error: {
        code: 'stale_revision',
        category: 'conflict',
        message: 'The document changed.',
        retryable: false,
      },
    } as unknown as OutlineResponse));

    await expect(requestOutline('get', {})).rejects.toBeInstanceOf(OutlineRequestError);
    await expect(requestOutline('get', {})).rejects.toMatchObject({
      outlineError: { code: 'stale_revision', category: 'conflict' },
    });
  });

  test('maps exact Runtime Event changes onto the existing delta reducer contract', () => {
    expect(projectionUpdateFromOutlineEvent({
      protocolVersion: 1,
      kind: 'outline.event',
      type: 'operation.committed',
      instanceId: 'runtime:1',
      sequence: 1,
      revision: 8,
      cursor: 'cursor:1',
      changes: {
        todayId: 'today',
        changedNodes: [node('changed')],
        removedIds: ['removed'],
      },
    })).toEqual({
      kind: 'delta',
      revision: 8,
      todayId: 'today',
      changedNodes: [node('changed')],
      removedIds: ['removed'],
    });
  });

  test('buffers Events until the full desktop Projection is seeded', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    let resolveProjection!: (response: OutlineResponse) => void;
    installOutlineBridge({
      request: async (request) => new Promise<OutlineResponse>((resolve) => {
        resolveProjection = resolve;
      }),
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const updates: unknown[] = [];
    const subscription = subscribeDesktopProjection((update) => updates.push(update), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    stream?.(streamEvent(8, 'cursor:8'));
    resolveProjection(success('get', projectionPage(2)));

    await subscription.ready;

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ kind: 'full', revision: 7 });
    expect(updates[1]).toMatchObject({ kind: 'delta', revision: 8 });
    subscription.unsubscribe();
  });

  test('returns an accepted desktop delta before the durable Operation Event arrives', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    let submittedChangeSet: unknown;
    const subscriptionUpdates: unknown[] = [];
    installOutlineBridge({
      commit: async (request) => {
        submittedChangeSet = request.changeSet;
        return acceptedMutation(request.changeSet, 8);
      },
      request: async (request) => {
        if (request.command === 'get') return success('get', projectionPage(2));
        throw new Error(`Unexpected command: ${request.command}`);
      },
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const subscription = subscribeDesktopProjection((update) => subscriptionUpdates.push(update), () => undefined);
    await subscription.ready;

    const result = await runDesktopMutation((revision) => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      base: { revision },
      operations: [{
        op: 'update',
        targets: { target: { selector: { by: 'id', id: 'today' }, cardinality: 'one' } },
        changes: [{ kind: 'done', value: true }],
      }],
    }));

    expect(submittedChangeSet).toMatchObject({
      base: { revision: 7 },
      idempotencyKey: expect.stringMatching(/^desktop:/),
    });
    expect(result.update).toMatchObject({ kind: 'delta', revision: 8 });
    expect(subscriptionUpdates).toHaveLength(1);
    stream?.(streamEvent(8, 'cursor:8'));
    expect(subscriptionUpdates.at(-1)).toMatchObject({ kind: 'delta', revision: 8 });
    subscription.unsubscribe();
  });

  test('holds an early durable Event until its accepted update can be applied first', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    const subscriptionUpdates: unknown[] = [];
    installOutlineBridge({
      commit: async (request) => {
        stream?.(streamEvent(8, 'cursor:8'));
        return acceptedMutation(request.changeSet, 8);
      },
      request: async (request) => {
        if (request.command === 'get') return success('get', projectionPage(2));
        throw new Error(`Unexpected command: ${request.command}`);
      },
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const subscription = subscribeDesktopProjection((update) => subscriptionUpdates.push(update), () => undefined);
    await subscription.ready;

    const result = await runDesktopMutation((revision) => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      base: { revision },
      operations: [{
        op: 'update',
        targets: { target: { selector: { by: 'id', id: 'today' }, cardinality: 'one' } },
        changes: [{ kind: 'done', value: true }],
      }],
    }));

    expect(result.update).toMatchObject({ kind: 'delta', revision: 8 });
    expect(subscriptionUpdates).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(subscriptionUpdates.at(-1)).toMatchObject({ kind: 'delta', revision: 8 });
    subscription.unsubscribe();
  });

  test('does not advance a queued mutation base from a held Event', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    const bases: number[] = [];
    const projectionRevisions: number[] = [];
    installOutlineBridge({
      commit: async (request) => {
        bases.push(request.changeSet.base.revision);
        if (bases.length === 1) stream?.(streamEvent(8, 'cursor:8'));
        throw new Error('injected stale mutation');
      },
      request: async (request) => {
        if (request.command === 'get') return success('get', projectionPage(2));
        throw new Error(`Unexpected command: ${request.command}`);
      },
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const subscription = subscribeDesktopProjection((update) => {
      projectionRevisions.push(update.revision);
    }, () => undefined);
    await subscription.ready;

    const mutation = () => runDesktopMutation((revision) => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      base: { revision },
      operations: [{ op: 'ensure', resource: 'date', date: '2026-08-28' }],
    }));
    const first = mutation();
    const second = mutation();
    await Promise.allSettled([first, second]);

    expect(bases).toEqual([7, 7]);
    expect(projectionRevisions).toEqual([7]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(projectionRevisions).toEqual([7, 8]);
    subscription.unsubscribe();
  });

  test('settles a no-change desktop mutation without waiting for an Operation Event', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    const commands: string[] = [];
    installOutlineBridge({
      commit: async (request) => ({
        settlement: {
          protocolVersion: 1,
          kind: 'outline.no-change',
          changeSetHash: 'a'.repeat(64),
          diffHash: 'b'.repeat(64),
          revision: 7,
          affectedNodeCount: 0,
          recovery: { state: 'not-required' },
        },
        update: {
          kind: 'delta',
          revision: 7,
          todayId: 'today',
          changedNodes: [],
          removedIds: [],
        },
        diff: focusDiff(request.changeSet, 7),
      }),
      request: async (request) => {
        commands.push(request.command);
        if (request.command === 'get') return success('get', projectionPage(2));
        throw new Error(`Unexpected command: ${request.command}`);
      },
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const subscription = subscribeDesktopProjection(() => undefined, () => undefined);
    await subscription.ready;
    commands.length = 0;

    const result = await runDesktopMutation((revision) => ({
      protocolVersion: 1,
      kind: 'outline.changeset',
      base: { revision },
      operations: [{ op: 'ensure', resource: 'date', date: '2026-08-24' }],
    }));

    expect(result.update).toEqual({
      kind: 'delta',
      revision: 7,
      todayId: 'today',
      changedNodes: [],
      removedIds: [],
    });
    expect(commands).toEqual([]);
    expect(stream).toBeFunction();
    subscription.unsubscribe();
  });

  test('reconnects a completed watch from its last cursor', async () => {
    const subscriptions: Array<{ input: unknown; listener: (record: OutlineStreamRecord) => void }> = [];
    installOutlineBridge({
      request: async (request) => success(request.command, projectionPage(2)),
      subscribe: (subscription, listener) => {
        subscriptions.push({ input: subscription.input, listener });
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const subscription = subscribeDesktopProjection(() => undefined, () => undefined);
    await subscription.ready;
    subscriptions[0]!.listener({
      protocolVersion: 1,
      requestId: 'watch:1',
      sequence: 1,
      type: 'end',
      cursor: 'cursor:7',
    });

    await new Promise((resolve) => setTimeout(resolve, 125));

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]!.input).toEqual({ cursor: 'cursor:7' });
    subscription.unsubscribe();
  });

  test('buffers Events that arrive while a revision-gap resync is in flight', async () => {
    let stream: ((record: OutlineStreamRecord) => void) | undefined;
    let resolveResync!: (response: OutlineResponse) => void;
    let requestCount = 0;
    installOutlineBridge({
      request: async (request) => {
        requestCount += 1;
        if (requestCount === 1) return success(request.command, projectionPage(2, 7));
        return new Promise<OutlineResponse>((resolve) => { resolveResync = resolve; });
      },
      subscribe: (_subscription, listener) => {
        stream = listener;
        queueMicrotask(() => listener(streamHello('cursor:7')));
        return () => undefined;
      },
    });
    const updates: Array<{ kind: string; revision: number }> = [];
    const subscription = subscribeDesktopProjection((update) => updates.push(update), () => undefined);
    await subscription.ready;

    stream?.(streamEvent(9, 'cursor:9'));
    stream?.(streamEvent(10, 'cursor:10'));
    resolveResync(success('get', projectionPage(2, 9)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates.map(({ kind, revision }) => ({ kind, revision }))).toEqual([
      { kind: 'full', revision: 7 },
      { kind: 'full', revision: 9 },
      { kind: 'delta', revision: 10 },
    ]);
    subscription.unsubscribe();
  });
});

function installOutlineRequest(
  request: NonNullable<LinApi['outline']>['request'],
): void {
  Object.assign(window, {
    lin: {
      outline: {
        commit: async () => { throw new Error('Unexpected desktop commit.'); },
        request,
        cancel: () => undefined,
        subscribe: () => () => undefined,
      },
    } as unknown as LinApi,
  });
}

function installOutlineBridge(
  outline: Partial<NonNullable<LinApi['outline']>>
    & Pick<NonNullable<LinApi['outline']>, 'request' | 'subscribe'>,
): void {
  Object.assign(window, {
    lin: {
      outline: {
        commit: async () => { throw new Error('Unexpected desktop commit.'); },
        cancel: () => undefined,
        ...outline,
      },
    } as unknown as LinApi,
  });
}

function success(command: string, data: unknown): OutlineResponse {
  return {
    protocolVersion: 1,
    requestId: `runtime:${command}`,
    command,
    ok: true,
    revision: 7,
    data,
  };
}

function projectionPage(page: number, revision = 7) {
  return {
    projection: {
      kind: 'outline',
      targets: { target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' } },
      depth: 1_024,
      include: ['children'],
      page: { limit: 10_000 },
    },
    revision,
    anchors: {
      workspaceId: 'workspace-id',
      rootId: 'workspace',
      libraryId: 'library',
      dailyNotesId: 'daily-notes',
      schemaId: 'schema',
      searchesId: 'searches',
      recentsId: 'recents',
      trashId: 'trash',
      todayId: 'today',
    },
    nodes: [node(page === 1 ? 'workspace' : 'today')],
    ...(page === 1 ? { truncated: true, cursor: 'page:2' } : {}),
  };
}

function acceptedMutation(changeSet: ChangeSet, revision: number) {
  return {
    settlement: operation(revision),
    update: {
      kind: 'delta' as const,
      revision,
      todayId: 'today',
      changedNodes: [node('today')],
      removedIds: [],
    },
    diff: focusDiff(changeSet, revision - 1),
  };
}

function focusDiff(changeSet: ChangeSet, revision: number): Diff {
  return {
    protocolVersion: 1,
    kind: 'outline.diff',
    diffHash: 'a'.repeat(64),
    intentHash: 'c'.repeat(64),
    changeSetHash: 'b'.repeat(64),
    baseRevision: revision,
    normalizedChangeSet: changeSet,
    bindings: {},
    affected: [],
    destructive: [],
    warnings: [],
    resultEstimate: { nodeCount: 0, encodedBytes: 0 },
  };
}

function node(id: string) {
  return {
    id,
    children: [],
    content: { text: id, marks: [], inlineRefs: [] },
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    locked: false,
    autoCollected: false,
  };
}

function streamHello(cursor: string): OutlineStreamRecord {
  return {
    protocolVersion: 1,
    requestId: 'watch:1',
    sequence: 0,
    type: 'hello',
    cursor,
  };
}

function streamEvent(revision: number, cursor: string, committed = operation(revision)): OutlineStreamRecord {
  return {
    protocolVersion: 1,
    requestId: 'watch:1',
    sequence: revision,
    type: 'event',
    cursor,
    event: {
      protocolVersion: 1,
      kind: 'outline.event',
      type: 'operation.committed',
      instanceId: 'runtime:1',
      sequence: revision,
      revision,
      cursor,
      operation: committed,
      changes: {
        todayId: 'today',
        changedNodes: [node('today')],
        removedIds: [],
      },
    },
  } as OutlineStreamRecord;
}

function operation(revision: number): Operation {
  return {
    protocolVersion: 1,
    kind: 'outline.operation',
    operationId: `operation:${revision}`,
    intentHash: 'c'.repeat(64),
    changeSetHash: 'a'.repeat(64),
    diffHash: 'b'.repeat(64),
    origin: 'desktop',
    summary: 'Accepted desktop mutation.',
    affectedNodeIds: ['today'],
    affectedNodeCount: 1,
    affectedNodeIdsHash: 'c'.repeat(64),
    revisionBefore: revision - 1,
    revisionAfter: revision,
    createdAt: '2026-08-27T00:00:00.000Z',
    recovery: {
      recoveryPatchId: `recovery:${revision}`,
      state: 'available',
      retainedUntilAtLeast: '2026-09-27T00:00:00.000Z',
    },
  };
}
