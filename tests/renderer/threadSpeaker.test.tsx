import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

// agentPortraits.ts loads the vendored roster through Vite's import.meta.glob,
// which does not exist outside the bundler. Stubbed with markup so the header's
// portrait branch — the one production takes — is what these assertions read,
// rather than the initial-disc fallback it degrades to under a test runner.
mock.module('../../src/renderer/agent/agentPortraits', () => ({
  agentPortraitSvg: (avatarKey: string | null) => (
    avatarKey === null ? undefined : `<svg data-fixture-portrait="${avatarKey}"></svg>`
  ),
}));

import type { AgentIdentityEntry } from '../../src/core/agent/protocol';
import { identityCatalogFrom } from '../../src/renderer/agent/agentIdentity';
import { ThreadStore } from '../../src/renderer/agent/store/threadStore';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const ROSTER = [
  { agentType: 'main', persona: 'Tenon', avatar: 'beaver', source: 'built-in' },
  { agentType: 'explore', persona: 'Rena', avatar: 'fox', source: 'built-in' },
  { agentType: 'auditor', persona: 'auditor', avatar: null, source: 'user' },
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
    expect(document.querySelector('.thread-speaker-avatar svg')?.getAttribute('data-fixture-portrait'))
      .toBe('fox');
  });

  test('names the conversation\'s own agent and does not label it', async () => {
    const { document } = await renderSpeaker({ avatarKey: 'main', name: 'main' });

    expect(document.querySelector('.thread-speaker-name')?.textContent).toBe('Tenon');
    // There is one `main`, the reader is addressing it, and saying so states
    // the only thing about this participant nobody was wondering. A type label
    // answers "which kind of helper is this" — a delegate's question.
    expect(document.querySelector('.thread-speaker-role')).toBeNull();
    expect(document.querySelector('.thread-speaker-avatar svg')?.getAttribute('data-fixture-portrait'))
      .toBe('beaver');
  });

  test('wears the initial disc when an identity has no portrait', async () => {
    const { document } = await renderSpeaker({ avatarKey: 'auditor', name: 'auditor' });

    const avatar = document.querySelector('.thread-speaker-avatar');
    expect(avatar?.querySelector('svg')).toBeNull();
    expect(avatar?.textContent).toBe('A');
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
  readonly meta?: ReactNode;
}): Promise<{ readonly document: Document }> {
  const { ThreadSpeakerGroup } = await import('../../src/renderer/agent/components/ThreadSpeaker');
  const store = new ThreadStore(
    { agentCoreRequest: async () => ({}), onAgentCoreNotification: () => () => {} } as never,
    (flush) => flush(),
  );
  // Placed straight into the snapshot: this judge is about what a resolved
  // roster draws, not about how it is fetched.
  (store as unknown as { snapshot: Record<string, unknown> }).snapshot = {
    ...store.getSnapshot(),
    identityCatalog: identityCatalogFrom(ROSTER),
  };
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
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
      >
        <p>said something</p>
      </ThreadSpeakerGroup>
    </I18nProvider>,
  ));
  mounted.push(() => act(() => root.unmount()));
  return { document };
}
