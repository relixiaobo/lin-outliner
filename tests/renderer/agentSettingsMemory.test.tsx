import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { DreamHistoryGroup, dreamMetaChips } from '../../src/renderer/ui/agent/DreamHistoryGroup';
import { DEFAULT_MESSAGES } from '../../src/core/i18n';
import type { AgentRenderDreamRunEntity } from '../../src/core/agentRenderProjection';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'getComputedStyle', 'Event', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

const fmtDate = (timestamp: number) => `at ${timestamp}`;

function dreamEntry(): AgentRenderDreamRunEntity {
  return {
    id: 'dream:dream-run-1',
    kind: 'dream',
    status: 'completed',
    trigger: 'schedule',
    principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
    startedAt: 100,
    updatedAt: 150,
    completedAt: 150,
    runId: 'dream-run-1',
    window: { start: '2026-06-22', end: '2026-06-23' },
    processed: { totalMessageCount: 3, totalCharCount: 900, consolidateOnly: false },
    changes: { added: 2, updated: 1, forgotten: 0, skipped: 0 },
  };
}

describe('Settings → Agent Dream history group', () => {
  test('renders one read-only dream row with title, trigger, and aggregated change count', () => {
    const rendered = renderComponent(
      <DreamHistoryGroup entries={[dreamEntry()]} formatDate={fmtDate} loading={false} t={DEFAULT_MESSAGES} />,
    );
    expect(rendered.container.textContent).toContain('Dream history');
    expect(rendered.container.textContent).toContain('Memory Dream');
    expect(rendered.container.textContent).toContain('Scheduled');
    expect(rendered.container.textContent).toContain('2026-06-22 to 2026-06-23');
    // 2 added + 1 updated + 0 forgotten = 3 memory changes.
    expect(rendered.container.textContent).toContain('3 memory changes');
    expect(rendered.container.textContent).toContain('3 messages');
    // Read-only: no edit/forget affordance on a dream row.
    expect(rendered.container.querySelector('button')).toBeNull();
    expect(rendered.container.querySelector('.settings-dream-meta')).not.toBeNull();
  });

  test('renders the empty state when there are no dreams', () => {
    const rendered = renderComponent(
      <DreamHistoryGroup entries={[]} formatDate={fmtDate} loading={false} t={DEFAULT_MESSAGES} />,
    );
    expect(rendered.container.textContent).toContain('No Dream activity yet.');
    expect(rendered.container.querySelector('.inset-card')).toBeNull();
  });

  test('renders the loading state while fetching', () => {
    const rendered = renderComponent(
      <DreamHistoryGroup entries={[]} formatDate={fmtDate} loading t={DEFAULT_MESSAGES} />,
    );
    expect(rendered.container.textContent).toContain('Loading activity…');
  });

  test('dreamMetaChips drops processed/changes when absent', () => {
    const minimal: AgentRenderDreamRunEntity = {
      id: 'dream:2',
      kind: 'dream',
      status: 'running',
      trigger: 'manual',
      principal: { type: 'agent', agentId: 'built-in:tenon:assistant' },
      startedAt: 200,
      updatedAt: 200,
      runId: 'dream-run-2',
    };
    const chips = dreamMetaChips(minimal, DEFAULT_MESSAGES, fmtDate);
    expect(chips).toEqual(['Manual', 'Running', 'Started at 200']);
  });
});

function renderComponent(element: ReactNode): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { restore } = installDomGlobals(window);

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });

  const rendered: Rendered = {
    cleanup: () => {
      act(() => root.unmount());
      restore();
    },
    container,
    document,
    window,
  };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window) {
  for (const key of GLOBAL_KEYS) {
    savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  }
  const getComputedStyle = () => ({
    lineHeight: '26px',
    getPropertyValue: (property: string) => (property === 'line-height' ? '26px' : ''),
  });
  Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: getComputedStyle });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: getComputedStyle });
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return { restore: () => undefined };
}
