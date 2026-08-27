import { describe, expect, test } from 'bun:test';
import type { ThreadItem, Turn } from '../../src/core/agent/protocol';
import {
  IDLE_THREAD_COMPOSER_HISTORY_STATE,
  navigateThreadComposerHistory,
  selectReaderComposerHistoryEntries,
  type ThreadComposerHistoryState,
} from '../../src/renderer/agent/threadComposerHistory';
import {
  ComposerHistoryResourceRegistry,
  type OpaqueCurrentResourceAdapter,
} from '../../src/renderer/agent/composerHistoryResourceRegistry';

describe('Agent composer input history', () => {
  test('selects only reader-authored user Items in canonical chronological order', () => {
    const turns = [
      turn('turn-1', [userItem('reader-1', 'reader'), userItem('feature-1', 'feature')]),
      turn('turn-2', [userItem('host-1', 'host'), userItem('reader-2', 'reader')]),
      turn('turn-3', [userItem('agent-1', 'agent'), userItem('reader-3', 'reader')]),
    ];

    expect(selectReaderComposerHistoryEntries(turns).map((item) => item.id))
      .toEqual(['reader-1', 'reader-2', 'reader-3']);
  });

  test('navigates older and newer while preserving terminal boundary fallthrough', () => {
    const entries = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    expect(navigateThreadComposerHistory(IDLE_THREAD_COMPOSER_HISTORY_STATE, entries, 'newer').kind)
      .toBe('declined');

    let state: ThreadComposerHistoryState = IDLE_THREAD_COMPOSER_HISTORY_STATE;
    const newest = navigateThreadComposerHistory(state, entries, 'older');
    expect(newest).toMatchObject({ kind: 'select', entry: { id: 'third' }, reanchored: false });
    state = newest.state;
    const middle = navigateThreadComposerHistory(state, entries, 'older');
    expect(middle).toMatchObject({ kind: 'select', entry: { id: 'second' } });
    state = middle.state;
    const oldest = navigateThreadComposerHistory(state, entries, 'older');
    expect(oldest).toMatchObject({ kind: 'select', entry: { id: 'first' } });
    state = oldest.state;
    expect(navigateThreadComposerHistory(state, entries, 'older').kind).toBe('boundary');

    const newer = navigateThreadComposerHistory(state, entries, 'newer');
    expect(newer).toMatchObject({ kind: 'select', entry: { id: 'second' } });
    state = navigateThreadComposerHistory(newer.state, entries, 'newer').state;
    const scratch = navigateThreadComposerHistory(state, entries, 'newer');
    expect(scratch).toMatchObject({ kind: 'restoreScratch', state: { kind: 'scratch' } });
    expect(navigateThreadComposerHistory(scratch.state, entries, 'older'))
      .toMatchObject({ kind: 'select', entry: { id: 'third' } });
    expect(navigateThreadComposerHistory(scratch.state, entries, 'newer').kind).toBe('declined');
  });

  test('keeps an ID anchor stable when newer accepted inputs arrive', () => {
    const initial = [{ id: 'first' }, { id: 'second' }];
    const selected = navigateThreadComposerHistory(IDLE_THREAD_COMPOSER_HISTORY_STATE, initial, 'older');
    const withNewer = [...initial, { id: 'third' }];

    expect(navigateThreadComposerHistory(selected.state, withNewer, 'newer'))
      .toMatchObject({ kind: 'select', entry: { id: 'third' }, reanchored: false });
  });

  test('reanchors a removed selection once by old index, then successor, predecessor, or scratch', () => {
    const selectedMiddle: ThreadComposerHistoryState = {
      kind: 'browsing',
      selectedItemId: 'removed',
      selectedIndex: 1,
    };
    const successor = navigateThreadComposerHistory(
      selectedMiddle,
      [{ id: 'first' }, { id: 'successor' }, { id: 'third' }],
      'older',
    );
    expect(successor).toMatchObject({
      kind: 'select',
      entry: { id: 'successor' },
      reanchored: true,
      state: { selectedIndex: 1 },
    });
    expect(navigateThreadComposerHistory(successor.state, [{ id: 'first' }, { id: 'successor' }], 'older'))
      .toMatchObject({ kind: 'select', entry: { id: 'first' }, reanchored: false });

    const predecessor = navigateThreadComposerHistory(
      { kind: 'browsing', selectedItemId: 'removed-tail', selectedIndex: 4 },
      [{ id: 'first' }, { id: 'last-survivor' }],
      'newer',
    );
    expect(predecessor).toMatchObject({
      kind: 'select',
      entry: { id: 'last-survivor' },
      reanchored: true,
    });
    expect(navigateThreadComposerHistory(selectedMiddle, [], 'older').kind).toBe('restoreScratch');
  });

  test('retains whole opaque handles across hidden slots without observing or copying them', () => {
    type Attachment = { readonly handle: object; readonly label: string };
    type Bundle = { readonly attachments: readonly Attachment[] };
    const discarded: object[] = [];
    const opaque = new Proxy({}, {
      get: () => { throw new Error('Opaque handle fields must not be observed'); },
    });
    const adapter: OpaqueCurrentResourceAdapter<Attachment, object> = {
      handleOf: (attachment) => attachment.handle,
      sameHandle: Object.is,
      requestDiscardIfUnlinked: (handle) => discarded.push(handle),
    };
    const registry = new ComposerHistoryResourceRegistry<string, Bundle, Attachment, object>(
      adapter,
      (bundle) => bundle.attachments,
    );
    const scratch = { attachments: [{ handle: opaque, label: 'scratch' }] };
    const working = { attachments: [{ handle: opaque, label: 'working' }] };

    registry.set('scratch', scratch);
    registry.set('working', working);
    expect(registry.take('working')).toBe(working);
    expect(registry.release('scratch', working.attachments)).toEqual(scratch.attachments);
    expect(discarded).toEqual([]);

    registry.set('working', working);
    expect(registry.releaseAll([])).toEqual(working.attachments);
    expect(discarded).toEqual([opaque]);
  });

  test('keeps navigation behavior independent from the replaceable resource adapter', () => {
    const navigateWith = (adapter: OpaqueCurrentResourceAdapter<{ handle: symbol }, symbol>) => {
      const registry = new ComposerHistoryResourceRegistry<
        string,
        { attachments: readonly { handle: symbol }[] },
        { handle: symbol },
        symbol
      >(adapter, (bundle) => bundle.attachments);
      const handle = Symbol('resource');
      registry.set('scratch', { attachments: [{ handle }] });
      const selected = navigateThreadComposerHistory(
        IDLE_THREAD_COMPOSER_HISTORY_STATE,
        [{ id: 'first' }, { id: 'second' }],
        'older',
      );
      registry.take('scratch');
      return selected;
    };
    const fakeAdapter = (): OpaqueCurrentResourceAdapter<{ handle: symbol }, symbol> => ({
      handleOf: (attachment) => attachment.handle,
      sameHandle: Object.is,
      requestDiscardIfUnlinked: () => undefined,
    });

    expect(navigateWith(fakeAdapter())).toEqual(navigateWith(fakeAdapter()));
  });
});

function turn(id: string, items: readonly ThreadItem[]): Turn {
  return {
    id,
    items,
    itemsView: 'full',
    provenance: {
      originThreadId: '01910000-0000-7000-8000-000000000001',
      originTurnId: id,
      trigger: { kind: 'user' },
    },
    status: 'completed',
    error: null,
    execution: {
      modelProvider: 'openai',
      model: 'test',
      reasoningEffort: 'medium',
      diagnosticsRef: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
    },
    startedAt: 1,
    completedAt: 2,
    durationMs: 1,
  };
}

function userItem(
  id: string,
  authorKind: 'reader' | 'agent' | 'feature' | 'host',
): Extract<ThreadItem, { readonly type: 'userMessage' }> {
  const author = authorKind === 'agent'
    ? { kind: 'agent' as const, threadId: '01910000-0000-7000-8000-000000000002' }
    : authorKind === 'feature'
      ? { kind: 'feature' as const, feature: 'automation' }
      : { kind: authorKind };
  return {
    type: 'userMessage',
    id,
    provenance: {
      originThreadId: '01910000-0000-7000-8000-000000000001',
      originTurnId: '01910000-0000-7000-8000-000000000003',
      originItemId: id,
    },
    author,
    clientId: null,
    content: [{ type: 'text', text: id }],
    acceptedAt: 1,
  };
}
