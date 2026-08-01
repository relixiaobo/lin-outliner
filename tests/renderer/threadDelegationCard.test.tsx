import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ThreadDelegationCard } from '../../src/renderer/agent/components/ThreadDelegationCard';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import type {
  SubagentPresentation,
  SubagentTurnProjection,
} from '../../src/renderer/agent/subagentPresentation';

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

describe('live delegation card', () => {
  test('lists every delegated form of this Turn and offers Stop only where there is a Turn to stop', () => {
    const stopped: string[] = [];
    const { document } = render(
      projection([
        presentation('thread-running', { displayName: 'research', status: 'running', startedAt: Date.now() - 5_000 }),
        presentation('thread-skill', {
          displayName: 'skill_audit_ab12cd34ef56',
          form: 'isolatedSkill',
          status: 'running',
          startedAt: Date.now() - 2_000,
        }),
        presentation('thread-done', { displayName: 'summary', status: 'completed' }),
      ]),
      (threadId) => { stopped.push(threadId); },
    );

    const lines = [...document.querySelectorAll('.thread-delegation-line')];
    expect(lines).toHaveLength(3);
    // A Skill child is delegated work too: the card replaces the rows for every
    // form, and does not re-split by source.
    expect(lines.map((line) => line.querySelector('.thread-delegation-line-name')?.textContent))
      .toEqual(['research', 'skill_audit_ab12cd34ef56', 'summary']);
    expect(lines[0]?.querySelector('.thread-delegation-line-status')?.textContent)
      .toMatch(/^Running · \d+[smhd]/u);
    // Time and status only — a delegation surface never asks for a token judgement.
    expect(document.body.textContent).not.toMatch(/token/iu);

    const stopButtons = [...document.querySelectorAll('button[aria-label^="Stop "]')];
    expect(stopButtons.map((button) => button.getAttribute('aria-label')))
      .toEqual(['Stop research', 'Stop skill_audit_ab12cd34ef56']);
    act(() => { (stopButtons[0] as HTMLElement).click(); });
    expect(stopped).toEqual(['thread-running']);
  });

  test('is absent once no child of this Turn is alive, leaving the rows to say what happened', () => {
    const { document } = render(projection([
      presentation('thread-done', { displayName: 'research', status: 'completed' }),
    ]));

    expect(document.querySelector('.thread-delegation-card')).toBeNull();
  });
});

function render(
  subagents: SubagentTurnProjection,
  onInterruptThread: (threadId: string) => void = () => undefined,
): { readonly document: Document } {
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
  act(() => root.render(
    <I18nProvider>
      <ThreadDelegationCard
        onInterruptThread={async (threadId) => { onInterruptThread(threadId); }}
        onOpenThread={async () => undefined}
        subagents={subagents}
      />
    </I18nProvider>,
  ));
  mounted.push(() => act(() => root.unmount()));
  return { document };
}

function projection(entries: readonly SubagentPresentation[]): SubagentTurnProjection {
  const byThreadId = new Map(entries.map((entry) => [entry.agentThreadId, entry]));
  return {
    activeThreadIds: entries
      .filter((entry) => entry.status === 'running' || entry.status === 'pendingInit')
      .map((entry) => entry.agentThreadId),
    byThreadId,
    collaborationThreadIds: entries
      .filter((entry) => entry.form === 'collaboration')
      .map((entry) => entry.agentThreadId),
    items: [],
  };
}

function presentation(
  agentThreadId: string,
  overrides: Partial<SubagentPresentation>,
): SubagentPresentation {
  return {
    agentThreadId,
    displayName: agentThreadId,
    error: null,
    form: 'collaboration',
    nickname: null,
    role: null,
    startedAt: null,
    status: 'running',
    taskPath: `/root/${agentThreadId}`,
    ...overrides,
  };
}
