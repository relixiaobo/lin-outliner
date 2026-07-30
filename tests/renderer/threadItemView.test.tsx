import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { DocumentProjection } from '../../src/core/types';
import type {
  CommandExecutionThreadItem,
  ThreadItem,
  UserMessageThreadItem,
} from '../../src/core/agent/protocol';
import {
  ThreadItemView,
  type ThreadDisclosureState,
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

describe('ThreadItemView tool output disclosure', () => {
  test('keeps one read across item identity updates and settles a rejected read', async () => {
    let rejectRead: ((error: Error) => void) | null = null;
    let readCount = 0;
    let holdCount = 0;
    let settleCount = 0;
    const item = commandItem();
    const rendered = renderItem(item, {
      holdAnchorUntilSettled: () => {
        holdCount += 1;
        let settled = false;
        return {
          settle: () => {
            if (settled) return;
            settled = true;
            settleCount += 1;
          },
        };
      },
      onReadToolOutput: () => {
        readCount += 1;
        return new Promise<string | null>((_resolve, reject) => {
          rejectRead = reject;
        });
      },
    });

    const toggle = rendered.document.querySelector<HTMLButtonElement>('.thread-tool-toggle');
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    await flush();
    expect(readCount).toBe(1);
    expect(holdCount).toBe(1);
    expect(settleCount).toBe(0);

    rendered.rerender({ ...item, status: 'completed' });
    await flush();
    expect(readCount).toBe(1);
    expect(settleCount).toBe(0);

    rejectRead?.(new Error('output unavailable'));
    await flush();
    expect(readCount).toBe(1);
    expect(settleCount).toBe(1);
  });
});

interface RenderItemOptions {
  readonly holdAnchorUntilSettled?: ThreadDisclosureState['holdAnchorUntilSettled'];
  readonly onReadToolOutput?: (item: ThreadToolItem) => Promise<string | null>;
}

function renderItem(item: ThreadItem, options: RenderItemOptions = {}): {
  readonly document: Document;
  readonly rerender: (nextItem: ThreadItem) => void;
} {
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
  const holdAnchorUntilSettled = options.holdAnchorUntilSettled ?? (() => null);
  const onReadToolOutput = options.onReadToolOutput ?? (async () => null);
  const render = (nextItem: ThreadItem) => act(() => root.render(
      <I18nProvider>
        <ThreadItemProbe
          holdAnchorUntilSettled={holdAnchorUntilSettled}
          item={nextItem}
          onReadToolOutput={onReadToolOutput}
        />
      </I18nProvider>,
    ));
  render(item);
  mounted.push(() => act(() => root.unmount()));
  return { document, rerender: render };
}

function ThreadItemProbe({
  holdAnchorUntilSettled,
  item,
  onReadToolOutput,
}: {
  readonly holdAnchorUntilSettled: ThreadDisclosureState['holdAnchorUntilSettled'];
  readonly item: ThreadItem;
  readonly onReadToolOutput: (item: ThreadToolItem) => Promise<string | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ThreadItemView
      agentResponseTail={null}
      canEditUserMessage={false}
      defaultReasoningExpanded={false}
      expandState={{
        holdAnchorUntilSettled,
        isExpanded: () => expanded,
        toggle: (_id, currentlyExpanded) => setExpanded(!currentlyExpanded),
      }}
      index={buildIndex(emptyProjection())}
      item={item}
      onDisclosureToggle={() => undefined}
      onEditUserMessage={async () => undefined}
      onOpenNodeReference={() => undefined}
      onOpenThread={async () => undefined}
      onReadToolOutput={onReadToolOutput}
      showMessageActions={false}
      streaming={false}
      threadCwd="/workspace"
      threadId="thread-1"
    />
  );
}

function commandItem(): CommandExecutionThreadItem {
  return {
    id: 'tool-1',
    provenance: {
      originThreadId: 'thread-1',
      originTurnId: 'turn-1',
      originItemId: 'tool-1',
    },
    type: 'commandExecution',
    status: 'inProgress',
    outputRef: {
      id: 'a'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 64,
      summary: 'Full command output',
    },
    command: 'printf test',
    cwd: '/workspace',
    processId: 'process-1',
    commandActions: [],
    aggregatedOutput: 'Loading output',
    exitCode: null,
    durationMs: null,
  };
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
