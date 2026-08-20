import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import type { AgentIdentityEntry } from '../../src/core/agent/protocol';
import { identityCatalogFrom } from '../../src/renderer/agent/agentIdentity';
import { ThreadStore } from '../../src/renderer/agent/store/threadStore';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const ROSTER = [
  { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
  { agentType: 'explore', persona: 'Rena', color: 'orange', source: 'built-in' },
  { agentType: 'auditor', persona: 'auditor', color: 'violet', source: 'user' },
] satisfies AgentIdentityEntry[];

const mounted: Array<() => void> = [];
const GLOBAL_KEYS = ['document', 'Event', 'HTMLElement', 'Node', 'ResizeObserver', 'window'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('speaker headers', () => {
  test('names a participant by its persona, with what it is beside it', async () => {
    const { document } = await renderSpeaker({ avatarKey: 'explore', name: 'explore' });

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('Rena');
    // The type stays visible: a persona says who, the label says what.
    expect(document.querySelector('.thread-speaker-role')?.textContent).toBe('explore');
    // The mark wears the catalog colour as a palette token, never a literal.
    expect(document.querySelector('.thread-speaker-avatar svg [fill^="var(--identity-tint-"]')
      ?.getAttribute('fill')).toBe('var(--identity-tint-1)');
  });

  test('names the conversation\'s own agent and does not label it', async () => {
    const { document } = await renderSpeaker({ avatarKey: 'main', name: 'main' });

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('Aspen');
    // There is one `main`, the reader is addressing it, and saying so states
    // the only thing about this participant nobody was wondering. A type label
    // answers "which kind of helper is this" — a delegate's question.
    expect(document.querySelector('.thread-speaker-role')).toBeNull();
    expect(document.querySelector('.thread-speaker-avatar svg [fill^="var(--identity-tint-"]')
      ?.getAttribute('fill')).toBe('var(--identity-tint-4)');
  });

  test('forwards the caller\'s mood to the mark and defaults to idle', async () => {
    const idle = await renderSpeaker({ avatarKey: 'explore', name: 'explore' });
    expect(idle.document.querySelector('.thread-speaker-avatar svg')?.getAttribute('data-mood'))
      .toBe('idle');
    const failed = await renderSpeaker({ avatarKey: 'explore', name: 'explore', mood: 'failed' });
    // The face restates what the status text says — here, that the run failed.
    expect(failed.document.querySelector('.thread-speaker-avatar svg')?.getAttribute('data-mood'))
      .toBe('failed');
  });

  test('gives every identity the same mark with two independent eyes', async () => {
    const { document } = await renderSpeaker({ avatarKey: 'auditor', name: 'auditor' });

    const avatar = document.querySelector('.thread-speaker-avatar');
    // One generated form for everyone — no image assets, no letter fallback.
    expect(avatar?.querySelector('img')).toBeNull();
    // Two eye groups, each its own node, so one can close without the other.
    expect(avatar?.querySelectorAll('.agent-mark-eye').length).toBe(2);
  });

  test('stacks what a participant did under who they are', async () => {
    const { document } = await renderSpeaker({
      avatarKey: 'explore',
      name: 'explore',
      meta: <span className="thread-speaker-meta">Worked for 2min33s</span>,
    });

    // Who and what-they-did are separate lines: the elapsed time grows as a
    // Turn runs, and beside the name it would eat the one string that must
    // never truncate.
    const title = document.querySelector('.thread-speaker-title');
    expect(title?.querySelector('.thread-speaker-name')).not.toBeNull();
    expect(title?.querySelector('.thread-speaker-meta')).toBeNull();
    expect(document.querySelector('.thread-speaker-identity > .thread-speaker-meta')?.textContent)
      .toBe('Worked for 2min33s');
  });

  test('leaves a participant that is not a type unlabelled', async () => {
    // An isolated Skill: its own name IS what it is, so a role line would only
    // repeat it.
    const { document } = await renderSpeaker({ avatarKey: 'code-review', name: 'code-review' });

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('code-review');
    expect(document.querySelector('.thread-speaker-role')).toBeNull();
  });
});

async function renderSpeaker({ meta, ...speaker }: {
  readonly avatarKey: string;
  readonly name: string;
  readonly mood?: import('../../src/renderer/agent/agentMarkGeometry').MarkMood;
  readonly meta?: ReactNode;
}): Promise<{ readonly document: Document }> {
  const { ThreadSpeakerGroup } = await import('../../src/renderer/agent/components/ThreadSpeaker');
  const store = new ThreadStore(
    { agentCoreRequest: async () => ({}), onAgentCoreNotification: () => () => {} } as never,
    (flush) => flush(),
  );
  // Placed straight into the snapshot: this judge is about what a resolved
  // roster draws, not about how it is fetched. The unrelated root entry proves
  // the speaker resolves against its own transcript rather than the selection.
  (store as unknown as { snapshot: Record<string, unknown> }).snapshot = {
    ...store.getSnapshot(),
    identityCatalogByThread: new Map([
      ['thread-root', identityCatalogFrom([
        { agentType: 'main', persona: 'Juniper', color: 'pink', source: 'project' },
        { agentType: 'explore', persona: 'Juniper', color: 'pink', source: 'project' },
      ])],
      ['thread-speaker', identityCatalogFrom(ROSTER)],
    ]),
  };
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  // Captured ONCE per test: a second render inside one test would otherwise
  // record the first render's patched globals as the "original", and afterEach
  // would restore linkedom's document/window into every later test instead of
  // deleting them.
  if (savedGlobals.length === 0) {
    savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  }
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'window' ? window : (window as unknown as Record<string, unknown>)[key],
    });
  }
  const root = createRoot(document.getElementById('root')!);
  act(() => root.render(
    <I18nProvider>
      <ThreadSpeakerGroup
        meta={meta}
        speaker={{ participantId: speaker.avatarKey, ...speaker }}
        source={store}
        threadId="thread-speaker"
      >
        <p>said something</p>
      </ThreadSpeakerGroup>
    </I18nProvider>,
  ));
  mounted.push(() => act(() => root.unmount()));
  return { document };
}
