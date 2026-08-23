import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { LinApi } from '../../src/preload';
import type { OutlineResponse } from '../../src/outline/contract';
import {
  OutlineRequestError,
  projectionUpdateFromOutlineEvent,
  readDesktopProjection,
  requestOutline,
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

    await expect(requestOutline('show', {})).rejects.toBeInstanceOf(OutlineRequestError);
    await expect(requestOutline('show', {})).rejects.toMatchObject({
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
});

function installOutlineRequest(
  request: NonNullable<LinApi['outline']>['request'],
): void {
  Object.assign(window, {
    lin: {
      outline: {
        request,
        cancel: () => undefined,
        subscribe: () => () => undefined,
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

function projectionPage(page: number) {
  return {
    projection: {
      kind: 'outline',
      targets: { target: { selector: { by: 'alias', alias: 'home' }, cardinality: 'one' } },
      depth: 1_024,
      include: ['children'],
      page: { limit: 10_000 },
    },
    revision: 7,
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
