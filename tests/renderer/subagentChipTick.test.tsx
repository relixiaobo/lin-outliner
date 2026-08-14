import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadId } from '../../src/core/agent/protocol';
import { SubagentChip } from '../../src/renderer/agent/components/SubagentChip';
import { SubagentRegistryProvider } from '../../src/renderer/agent/components/SubagentRegistryContext';
import type { SubagentRegistryEntry } from '../../src/renderer/agent/subagentPresentation';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];
const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Agent chip elapsed ticking', () => {
  test('re-renders the chip alone, never the transcript beside it', async () => {
    let transcriptRenders = 0;
    const { document, root } = installDom();
    const entry = runningEntry(Date.now() - 4_000);

    await render(root, (
      <SubagentRegistryProvider
        actions={{ openAgent: () => undefined, stopAgent: null }}
        byAgentId={new Map<ThreadId, SubagentRegistryEntry>([[entry.agentId, entry]])}
      >
        <SubagentChip agentId={entry.agentId} fallbackName="survey" kind="spawn" />
        <TranscriptFixture onRender={() => { transcriptRenders += 1; }} />
      </SubagentRegistryProvider>
    ));

    const meta = () => document.querySelector('.thread-agent-chip-meta')?.textContent;
    const rendersAfterMount = transcriptRenders;
    expect(rendersAfterMount).toBeGreaterThan(0);
    const first = meta();

    // One second of the chip's own clock. The tick lives in the leaf that
    // displays the value, so nothing above it — least of all an Agent's
    // transcript — is re-rendered by a number changing.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    expect(meta()).not.toBe(first);
    expect(transcriptRenders).toBe(rendersAfterMount);
  });

  test('does not tick for an Agent that has settled', async () => {
    const { document, root } = installDom();
    const entry: SubagentRegistryEntry = {
      ...runningEntry(Date.now() - 4_000),
      status: 'completed',
      startedAt: null,
      durationMs: 192_000,
    };

    await render(root, (
      <SubagentRegistryProvider
        actions={{ openAgent: () => undefined, stopAgent: null }}
        byAgentId={new Map<ThreadId, SubagentRegistryEntry>([[entry.agentId, entry]])}
      >
        <SubagentChip agentId={entry.agentId} fallbackName="survey" kind="spawn" />
      </SubagentRegistryProvider>
    ));
    const settled = document.querySelector('.thread-agent-chip-meta')?.textContent;
    expect(settled).toBe('Completed · 3m 12s');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    // A settled Agent has no clock left to read: its span is what its own
    // generation recorded, and it never moves again.
    expect(document.querySelector('.thread-agent-chip-meta')?.textContent).toBe(settled);
  });
});

function TranscriptFixture({ onRender }: { readonly onRender: () => void }) {
  onRender();
  return <div className="transcript-fixture">A child transcript nobody touched.</div>;
}

function runningEntry(startedAt: number): SubagentRegistryEntry {
  return {
    agentId: 'thread-child',
    parentThreadId: 'thread-parent',
    displayName: 'survey the runtime',
    agentType: 'general-purpose',
    form: 'agent',
    runMode: 'background',
    generation: 1,
    status: 'running',
    stoppedByUser: false,
    startedAt,
    durationMs: null,
    settledAt: null,
    error: null,
    worktree: null,
    liveDescendantCount: 0,
  };
}

async function render(root: ReturnType<typeof createRoot>, tree: ReactNode): Promise<void> {
  await act(async () => { root.render(<I18nProvider>{tree}</I18nProvider>); });
}

function installDom(): { readonly document: Document; readonly root: ReturnType<typeof createRoot> } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke: async () => ({}),
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
  mounted.push(() => act(() => root.unmount()));
  return { document, root };
}
