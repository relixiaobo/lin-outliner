import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection } from '../../src/core/types';
import type {
  CommandExecutionThreadItem,
  ItemExecutionStatus,
  ThreadItem,
  UserMessageThreadItem,
} from '../../src/core/agent/protocol';
import { en } from '../../src/core/i18n';
import {
  ThreadItemView,
  ThreadToolActivityGroup,
  summarizeThreadToolActivity,
  summarizeThreadToolItem,
  type ThreadToolItem,
} from '../../src/renderer/agent/components/items/ThreadItemView';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { buildIndex } from '../../src/renderer/state/document';

const mounted: Array<() => void> = [];
const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('ThreadItemView user message presentation', () => {
  test('renders one leading gallery and keeps every file reference in the ordered narrative', async () => {
    const item: UserMessageThreadItem = {
      id: 'message-1',
      provenance: {
        originThreadId: 'thread-1',
        originTurnId: 'turn-1',
        originItemId: 'message-1',
      },
      type: 'userMessage',
      clientId: 'client-1',
      content: [
        { type: 'text', text: 'Compare ' },
        image('image-a', 'first.png'),
        file('file-a', 'notes.pdf'),
        image('image-b', 'second.png'),
        { type: 'text', text: ' with the notes.' },
      ],
      acceptedAt: 1,
    };
    const rendered = renderItem(item);
    await flush();

    const sequence = rendered.document.querySelector('.thread-user-content-sequence');
    expect(sequence?.children).toHaveLength(2);
    expect(sequence?.children[0]?.classList.contains('thread-image-gallery')).toBe(true);
    expect(sequence?.children[1]?.classList.contains('thread-user-content-shell')).toBe(true);

    const gallery = sequence?.children[0];
    expect(gallery?.querySelectorAll('.thread-image-gallery-preview')).toHaveLength(2);
    expect([...gallery?.querySelectorAll<HTMLButtonElement>('.thread-image-gallery-preview') ?? []]
      .map((button) => button.title)).toEqual(['first.png', 'second.png']);

    const narrative = sequence?.children[1];
    const fileReferences = [...narrative?.querySelectorAll<HTMLElement>('.thread-message-file-ref') ?? []];
    expect(fileReferences).toHaveLength(3);
    expect(fileReferences.map((reference) => reference.dataset.inlineRefPath)).toEqual([
      '/workspace/first.png',
      '/workspace/notes.pdf',
      '/workspace/second.png',
    ]);
    expect(narrative?.textContent).toBe('Compare first.png notes.pdf second.png with the notes.');
  });
});

describe('ThreadItemView tool row status presentation', () => {
  test('keeps the tool own glyph on failed and interrupted rows and only swaps it while running', async () => {
    const glyphs = new Map<ItemExecutionStatus, string>();
    for (const status of ['completed', 'failed', 'interrupted', 'inProgress'] as const) {
      const rendered = renderItem(command({ status }));
      await flush();
      const row = rendered.document.querySelector('.thread-tool');
      expect(row?.className).toContain(`thread-tool-${status}`);
      const glyph = row?.querySelector('.thread-disclosure-status svg')?.outerHTML ?? '';
      expect(glyph).not.toBe('');
      glyphs.set(status, glyph);
      while (mounted.length > 0) mounted.pop()?.();
    }

    expect(glyphs.get('failed')).toBe(glyphs.get('completed'));
    expect(glyphs.get('interrupted')).toBe(glyphs.get('completed'));
    expect(glyphs.get('inProgress')).not.toBe(glyphs.get('completed'));
  });

  test('hides the decorative indicator from assistive tech and titles the truncating label', async () => {
    const rendered = renderItem(command({ status: 'failed' }));
    await flush();

    const indicator = rendered.document.querySelector('.thread-disclosure-indicator');
    expect(indicator?.getAttribute('aria-hidden')).toBe('true');
    const label = rendered.document.querySelector<HTMLElement>('.thread-tool-label');
    expect(label?.title).toBe('Command failed · "npm test"');
    expect(label?.textContent).toBe(label?.title);
  });

  test('explains a failure that never produced an exit code without inventing one', async () => {
    const rendered = renderItem(command({ status: 'failed', exitCode: null }), { expanded: true });
    await flush();

    const error = rendered.document.querySelector('.thread-inline-error');
    expect(error?.getAttribute('role')).toBe('status');
    expect(error?.textContent).toBe('Command failed');
  });

  test('gives a failed file change a failure sentence instead of a silent body', async () => {
    const item: ThreadItem = {
      ...base('file-1'),
      type: 'fileChange',
      status: 'failed',
      outputRef: null,
      changes: [{ path: '/workspace/a.ts', kind: 'update' }],
    };
    const rendered = renderItem(item, { expanded: true });
    await flush();

    expect(rendered.document.querySelector('.thread-inline-error')?.textContent)
      .toBe('Failed without an error message.');
  });

  test('labels failed dynamic-tool prose as an error rather than a result', async () => {
    const item: ThreadItem = {
      ...base('dynamic-1'),
      type: 'dynamicToolCall',
      status: 'failed',
      outputRef: null,
      namespace: null,
      tool: 'file_read',
      arguments: { file_path: '/workspace/missing.ts' },
      contentItems: [{ type: 'text', text: 'ENOENT: no such file' }],
      success: false,
      durationMs: 4,
    };
    const rendered = renderItem(item, { expanded: true });
    await flush();

    const headers = [...rendered.document.querySelectorAll('.thread-tool-section > header')]
      .map((header) => header.textContent);
    expect(headers).toContain('Error');
    expect(headers).not.toContain('Result');
    expect(rendered.document.querySelector('.thread-inline-error')).toBeNull();
  });

  test('colours only the failure tally in a group summary, not the whole line', async () => {
    const items = [
      command({ id: 'command-1', status: 'completed' }),
      command({ id: 'command-2', status: 'failed' }),
      command({ id: 'command-3', status: 'interrupted' }),
    ];
    const rendered = renderGroup(items);
    await flush();

    const group = rendered.document.querySelector('.thread-tool-activity-group');
    expect(group?.className).toContain('thread-tool-failed');
    const summary = group?.querySelector('.thread-tool-activity-summary');
    expect(summary?.textContent).toBe('Ran 3 commands · 1 failed · 1 interrupted');
    // "Ran 3 commands" stays neutral — only the tally is tinted, so the row
    // never reads as "all three failed".
    expect(summary?.querySelector('.thread-tool-activity-count-failed')?.textContent).toBe('1 failed');
    expect(summary?.querySelector('.thread-tool-activity-count-interrupted')?.textContent)
      .toBe('1 interrupted');
    expect(summary?.querySelectorAll('span')).toHaveLength(2);
  });
});

describe('thread tool summaries', () => {
  const labels = en.agent.thread.activity;

  test('reads interrupted work as interrupted, never as past-tense success', () => {
    expect(summarizeThreadToolItem(command({ status: 'interrupted' }), labels))
      .toBe('Command interrupted · "npm test"');
    expect(summarizeThreadToolItem({
      ...base('mcp-1'),
      type: 'mcpToolCall',
      status: 'interrupted',
      outputRef: null,
      server: 'files',
      tool: 'read',
      arguments: {},
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    }, labels)).toBe('files.read interrupted');
    expect(summarizeThreadToolItem({
      ...base('search-1'),
      type: 'webSearch',
      status: 'interrupted',
      outputRef: null,
      query: 'tenon',
      results: [],
      error: null,
    }, labels)).toBe('Web search interrupted · "tenon"');
    expect(summarizeThreadToolItem({
      ...base('file-2'),
      type: 'fileChange',
      status: 'interrupted',
      outputRef: null,
      changes: [{ path: '/workspace/a.ts', kind: 'update' }],
    }, labels)).toBe('Interrupted changing 1 file');
  });

  test('leaves a clean group summary untouched', () => {
    expect(summarizeThreadToolActivity([
      command({ id: 'command-1', status: 'completed' }),
      command({ id: 'command-2', status: 'completed' }),
    ], labels)).toBe('Ran 2 commands');
  });
});

function command(overrides: Partial<CommandExecutionThreadItem> = {}): CommandExecutionThreadItem {
  return {
    ...base('command-1'),
    type: 'commandExecution',
    status: 'completed',
    outputRef: null,
    command: 'npm test',
    cwd: '/workspace',
    processId: null,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: 12,
    ...overrides,
  };
}

function base(id: string) {
  return {
    id,
    provenance: { originThreadId: 'thread-1', originTurnId: 'turn-1', originItemId: id },
  } as const;
}

function renderGroup(items: readonly ThreadToolItem[]): { readonly document: Document } {
  return renderTree(
    <ThreadToolActivityGroup
      expandState={{ isExpanded: () => false, toggle: () => undefined }}
      items={items}
      onOpenThread={async () => undefined}
      onReadToolOutput={async () => null}
      threadCwd="/workspace"
      threadId="thread-1"
    />,
  );
}

function renderItem(
  item: ThreadItem,
  options: { readonly expanded?: boolean } = {},
): { readonly document: Document } {
  return renderTree(
    <ThreadItemView
      agentResponseTail={null}
      canEditUserMessage={false}
      defaultReasoningExpanded={false}
      expandState={{ isExpanded: () => options.expanded === true, toggle: () => undefined }}
      index={buildIndex(emptyProjection())}
      item={item}
      onDisclosureToggle={() => undefined}
      onEditUserMessage={async () => undefined}
      onOpenNodeReference={() => undefined}
      onOpenThread={async () => undefined}
      onReadToolOutput={async () => null}
      showMessageActions={false}
      streaming={false}
      threadCwd="/workspace"
      threadId="thread-1"
    />,
  );
}

function renderTree(tree: ReactNode): { readonly document: Document } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(window, {
    getComputedStyle: () => ({ lineHeight: '26px' }),
    lin: {
      initialLanguage: 'en',
      invoke: async () => ({ bytes: null, error: 'unavailable' }),
      onLanguageChanged: () => () => undefined,
    },
  });
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => root.render(<I18nProvider>{tree}</I18nProvider>));
  mounted.push(() => act(() => root.unmount()));
  return { document };
}

function image(id: string, name: string) {
  return {
    type: 'attachment' as const,
    id,
    name,
    mimeType: 'image/png',
    sizeBytes: 10,
    source: { kind: 'localFile' as const, path: `/workspace/${name}` },
  };
}

function file(id: string, name: string) {
  return {
    type: 'attachment' as const,
    id,
    name,
    mimeType: 'application/pdf',
    sizeBytes: 20,
    source: { kind: 'localFile' as const, path: `/workspace/${name}` },
  };
}

function emptyProjection(): DocumentProjection {
  return {
    workspaceId: 'workspace',
    rootId: 'root',
    libraryId: 'root',
    dailyNotesId: 'daily-notes',
    schemaId: 'schema',
    searchesId: 'searches',
    recentsId: 'recents',
    trashId: 'trash',
    todayId: 'today',
    nodes: [],
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
