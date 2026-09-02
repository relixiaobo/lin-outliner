import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ThreadId } from '../../src/core/agent/protocol';
import { SubagentChip } from '../../src/renderer/agent/components/SubagentChip';
import { SubagentReport } from '../../src/renderer/agent/components/SubagentReport';
import { SubagentRegistryProvider } from '../../src/renderer/agent/components/SubagentRegistryContext';
import { threadStore } from '../../src/renderer/agent/store/threadStore';
import {
  SUBAGENT_STRIP_LINGER_MS,
  SubagentWorkStrip,
} from '../../src/renderer/agent/components/SubagentWorkStrip';
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
        <SubagentChip agentId={entry.agentId} fallbackName="survey" generation={null} kind="spawn" />
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
      status: 'finished',
      startedAt: null,
      durationMs: 192_000,
    };

    await render(root, (
      <SubagentRegistryProvider
        actions={{ openAgent: () => undefined, stopAgent: null }}
        byAgentId={new Map<ThreadId, SubagentRegistryEntry>([[entry.agentId, entry]])}
      >
        <SubagentChip agentId={entry.agentId} fallbackName="survey" generation={null} kind="spawn" />
      </SubagentRegistryProvider>
    ));
    const settled = document.querySelector('.thread-agent-chip-meta')?.textContent;
    expect(settled).toBe('Finished · 3m 12s');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    // A settled Agent has no clock left to read: its span is what its own
    // generation recorded, and it never moves again.
    expect(document.querySelector('.thread-agent-chip-meta')?.textContent).toBe(settled);
  });

  test('shows durable fallback guidance and opens the matching Agent editor', async () => {
    const { document, root, window } = installDom();
    const targets: unknown[] = [];
    Object.assign(window.lin ?? {}, {
      openSettings: async (target: unknown) => { targets.push(target); },
    });
    const entry: SubagentRegistryEntry = {
      ...runningEntry(Date.now()),
      executionSelectionFallback: {
        requestedModelProvider: 'anthropic',
        requestedModel: 'anthropic/retired-model',
        requestedReasoningEffort: 'high',
        reason: 'unavailable',
      },
    };

    await render(root, (
      <SubagentRegistryProvider
        actions={{ openAgent: () => undefined, stopAgent: null }}
        byAgentId={new Map<ThreadId, SubagentRegistryEntry>([[entry.agentId, entry]])}
      >
        <SubagentChip agentId={entry.agentId} fallbackName="survey" generation={null} kind="spawn" />
      </SubagentRegistryProvider>
    ));
    expect(document.querySelector('.thread-agent-execution-warning')?.textContent)
      .toContain('this run followed its parent');

    await act(async () => {
      document.querySelector<HTMLElement>('.thread-agent-execution-warning-action')?.click();
      await Promise.resolve();
    });
    expect(targets).toEqual([{ page: 'agents', agentType: 'general-purpose' }]);
  });

  test('keeps fallback guidance on a delivered run that the user stopped', async () => {
    const { document, root } = installDom();
    const ensureHistory = spyOn(threadStore, 'ensureThreadHistory').mockResolvedValue(undefined as never);
    const receipt = {
      generation: 1,
      turnId: 'turn-child',
      parentItemId: 'agent-call',
      terminalStatus: 'interrupted' as const,
      stopProvenance: 'user' as const,
      durationMs: 1_000,
      error: null,
      partialOutputAvailable: false,
      parentThreadId: 'thread-parent',
      notificationState: 'delivered' as const,
      deliveryTurnId: 'turn-delivery',
    };
    const entry: SubagentRegistryEntry = {
      ...runningEntry(Date.now()),
      status: 'interrupted',
      stoppedByUser: true,
      generationReceipts: new Map([[1, receipt]]),
      executionSelectionFallback: {
        requestedModelProvider: 'anthropic',
        requestedModel: 'anthropic/retired-model',
        requestedReasoningEffort: 'high',
        reason: 'unavailable',
      },
    };

    try {
      await render(root, (
        <SubagentRegistryProvider
          actions={{ openAgent: () => undefined, stopAgent: null }}
          byAgentId={new Map<ThreadId, SubagentRegistryEntry>([[entry.agentId, entry]])}
        >
          <SubagentReport
            delivery={{ agentId: entry.agentId, generation: 1 }}
            index={{} as never}
            onOpenNodeReference={() => undefined}
          />
        </SubagentRegistryProvider>
      ));

      expect(document.querySelector('.thread-agent-note')?.textContent).toContain('stopped');
      expect(document.querySelector('.thread-agent-execution-warning')?.textContent)
        .toContain('this run followed its parent');
    } finally {
      ensureHistory.mockRestore();
    }
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
    generationReceipts: new Map(),
    status: 'running',
    stoppedByUser: false,
    startedAt,
    durationMs: null,
    settledAt: null,
    error: null,
    worktree: null,
    executionSelectionFallback: null,
    liveDescendantCount: 0,
  };
}

async function render(root: ReturnType<typeof createRoot>, tree: ReactNode): Promise<void> {
  await act(async () => { root.render(<I18nProvider>{tree}</I18nProvider>); });
}

describe('background work strip clock', () => {
  test('stops ticking once the last just-finished row has faded', async () => {
    // The clock exists to fade a settled row out. Held in a ref, the moment the
    // fade ended changed nothing the effect could see — the Agent map is
    // identical by then — so its interval outlived the strip and kept firing
    // once a second for the rest of the session.
    const { root, window } = installDom();
    const ticks = new Map<number, () => void>();
    let nextId = 1;
    Object.assign(window, {
      setInterval: (handler: () => void) => {
        const id = nextId;
        nextId += 1;
        ticks.set(id, handler);
        return id;
      },
      clearInterval: (id: number) => { ticks.delete(id); },
    });
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const settled: SubagentRegistryEntry = {
        ...runningEntry(clock - 4_000),
        status: 'finished',
        settledAt: clock - 1_000,
      };
      const byAgentId = new Map<ThreadId, SubagentRegistryEntry>([[settled.agentId, settled]]);
      const strip = (
        <SubagentRegistryProvider
          actions={{ openAgent: () => undefined, stopAgent: null }}
          byAgentId={byAgentId}
        >
          <SubagentWorkStrip byAgentId={byAgentId} />
        </SubagentRegistryProvider>
      );

      await render(root, strip);
      expect(ticks.size).toBe(1);

      // Time passes; the row finishes fading. The Agent map is untouched, which
      // is exactly the case a ref could not notice.
      clock += SUBAGENT_STRIP_LINGER_MS * 2;
      await act(async () => { for (const tick of [...ticks.values()]) tick(); });
      expect(ticks.size).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});

function installDom(): {
  readonly document: Document;
  readonly root: ReturnType<typeof createRoot>;
  readonly window: Window & typeof globalThis;
} {
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
  return { document, root, window: window as Window & typeof globalThis };
}
