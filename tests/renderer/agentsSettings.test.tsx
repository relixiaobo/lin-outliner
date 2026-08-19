import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import type { AgentEditorView } from '../../src/renderer/api/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const VIEW: AgentEditorView = {
  // Nothing is re-skinned: every built-in identity below is the resolved
  // default, which is exactly the case the editor must not write back.
  presentationOverrides: [],
  entries: [
    { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
    { agentType: 'general-purpose', persona: 'Bruno', color: 'amber', source: 'built-in' },
    { agentType: 'explore', persona: 'Rena', color: 'orange', source: 'built-in' },
    { agentType: 'auditor', persona: 'Wren', color: 'violet', source: 'user' },
  ],
  roles: [{
    name: 'auditor',
    layer: 'user',
    description: 'Audits a change.',
    developerInstructions: 'Read the diff.',
    persona: 'Wren',
    color: 'violet',
    model: null,
    reasoningEffort: null,
    tools: null,
  }],
};

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
  delete (globalThis as Record<string, unknown>).lin;
});

describe('the Agents editor', () => {
  test('lists the agents a user may edit apart from the ones they may only re-skin', async () => {
    const { document } = await renderAgents();

    const groups = [...document.querySelectorAll('.inset-group')];
    const named = (group: Element) => [...group.querySelectorAll('.inset-row-label')]
      .map((row) => row.textContent);

    expect(named(groups[0]!)).toEqual(['Wren']);
    // `auditor` is an Agent type like any other and appears in `entries` too.
    // Listing it in both groups would offer two editors for one identity —
    // one of which could not delete it.
    expect(named(groups[1]!)).toEqual(['Aspen', 'Bruno', 'Rena']);
  });

  test('offers no Delete for a built-in, because there is nothing of the user\'s to remove', async () => {
    const { document, click } = await renderAgents();

    await click(rowByLabel(document, 'Rena'));

    expect(document.querySelector('.agent-editor-delete')).toBeNull();
    // Its behaviour is not editable either: only the identity fields are shown.
    expect(document.querySelector('.agent-editor-dialog textarea')).toBeNull();
  });

  test('tells the write which agent already exists, so create cannot replace', async () => {
    const { document, click, calls } = await renderAgents();

    await click(rowByLabel(document, 'Wren'));
    await click(document.querySelector('.agent-editor-actions .button-primary')!);

    // Editing an existing Role is an update; only the + dialog creates.
    expect(calls[1]!.args).toMatchObject({ mode: 'update' });
  });

  test('re-skinning a built-in writes a presentation, never a Role', async () => {
    const { document, click, calls } = await renderAgents();
    await click(rowByLabel(document, 'Rena'));

    await click(swatch(document, 'Pink'));
    await click(document.querySelector('.agent-editor-actions .button-primary')!);

    expect(calls.map((call) => call.name)).toEqual(['agent_identity_catalog', 'agent_write_presentation']);
    expect(calls[1]!.args).toMatchObject({ agentType: 'explore', layer: 'user' });
    const written = (calls[1]!.args as { presentation: Record<string, unknown> }).presentation;
    expect(written.color).toBe('pink');
    // The persona was NOT touched, so it must not be written. Seeding the field
    // from the resolved catalog would save `Rena` as a permanent override and
    // opt this user out of every future change to the built-in's name.
    expect(written.persona).toBeFalsy();
  });

  test('a built-in with nothing written down offers Default as the chosen colour', async () => {
    const { document, click } = await renderAgents();

    await click(rowByLabel(document, 'Rena'));

    // Eight swatches: the palette plus "Default", which is the only way to send
    // an empty colour and so the only way the documented reset is reachable.
    const dialog = document.querySelector('.agent-editor-dialog');
    expect(dialog?.querySelectorAll('.agent-colour-choice').length).toBe(8);
    expect(dialog?.querySelector('.agent-colour-choice.is-selected')?.classList.contains('is-default'))
      .toBe(true);
  });

  test('an existing re-skin seeds the fields it actually wrote', async () => {
    const { document, click } = await renderAgents({
      view: {
        ...VIEW,
        presentationOverrides: [{ agentType: 'explore', layer: 'user', persona: null, color: 'pink' }],
      },
    });

    await click(rowByLabel(document, 'Rena'));

    expect((fieldByLabel(document, 'Name') as { value?: string }).value).toBe('');
    const selected = document.querySelector('.agent-editor-dialog .agent-colour-choice.is-selected');
    expect(selected?.getAttribute('aria-label')).toBe('Pink');
  });



  test('a Role is saved with the whole definition, not just what was retyped', async () => {
    const { document, click, calls } = await renderAgents();
    await click(rowByLabel(document, 'Wren'));

    await click(document.querySelector('.agent-editor-actions .button-primary')!);

    // Saving after changing only the colour must still carry the description
    // and instructions: the write replaces the Role wholesale, so a form that
    // sent only its own fields would erase the rest.
    expect(calls[1]!.name).toBe('agent_write_role');
    expect(calls[1]!.args).toMatchObject({
      layer: 'user',
      role: {
        name: 'auditor',
        description: 'Audits a change.',
        developerInstructions: 'Read the diff.',
        persona: 'Wren',
        color: 'violet',
      },
    });
  });

  test('an existing Role\'s type is fixed, because renaming would orphan its identity', async () => {
    const { document, click } = await renderAgents();

    await click(rowByLabel(document, 'Wren'));

    expect((fieldByLabel(document, 'Type') as { disabled?: boolean }).disabled).toBe(true);
    // A new Role's type is of course still open.
    await click(document.querySelector('.agent-editor-actions .button-ghost')!);
    await click(document.querySelector('.inset-group-header button')!);
    expect((fieldByLabel(document, 'Type') as { disabled?: boolean }).disabled).toBe(false);
  });

  test('a refused write reports why and leaves the editor standing', async () => {
    const { document, click, onError } = await renderAgents({
      onInvoke: (name) => {
        if (name !== 'agent_identity_catalog') throw new Error("Refused: Unknown identity colour 'chartreuse'");
        return VIEW;
      },
    });
    await click(rowByLabel(document, 'Wren'));

    await click(document.querySelector('.agent-editor-actions .button-primary')!);

    // The loader's own words reach the user: "refused" is the whole story, and
    // paraphrasing it would lose which field it was about.
    expect(onError.at(-1)).toBe("Refused: Unknown identity colour 'chartreuse'");
    // Still open, still populated. Closing on failure would discard the edit
    // the user is being asked to correct.
    expect(document.querySelector('.agent-editor-dialog')).not.toBeNull();
    expect((fieldByLabel(document, 'Name') as { value?: string }).value).toBe('Wren');
  });
});

function swatch(document: Document, label: string): Element {
  const found = [...document.querySelectorAll('.agent-colour-choice')]
    .find((node) => node.getAttribute('aria-label') === label);
  if (!found) throw new Error(`No colour swatch labelled ${label}`);
  return found;
}

function rowByLabel(document: Document, label: string): Element {
  const row = [...document.querySelectorAll('.inset-row-label')]
    .find((node) => node.textContent === label);
  if (!row) throw new Error(`No row labelled ${label}`);
  return row.closest('button')!;
}

function fieldByLabel(document: Document, label: string): Element {
  const field = [...document.querySelectorAll('.settings-sheet-row')]
    .find((row) => row.querySelector('.settings-sheet-row-label')?.textContent === label)
    ?.querySelector('input, textarea');
  if (!field) throw new Error(`No field labelled ${label}`);
  return field;
}

async function renderAgents(options: {
  onInvoke?: (name: string) => unknown;
  view?: AgentEditorView;
} = {}): Promise<{
  readonly document: Document;
  readonly calls: Array<{ name: string; args: unknown }>;
  readonly onError: string[];
  readonly click: (element: Element) => Promise<void>;
}> {
  const calls: Array<{ name: string; args: unknown }> = [];
  const onError: string[] = [];
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (savedGlobals.length === 0) {
    savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  }
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'window' ? window : (window as unknown as Record<string, unknown>)[key],
    });
  }
  (globalThis as Record<string, unknown>).lin = {
    invoke: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return options.onInvoke ? options.onInvoke(name) : (options.view ?? VIEW);
    },
  };
  (window as unknown as Record<string, unknown>).lin = (globalThis as Record<string, unknown>).lin;

  const { AgentsSettings } = await import('../../src/renderer/ui/agent/AgentsSettings');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentsSettings
          onError={(message) => { if (message !== null) onError.push(message); }}
          onNotice={() => undefined}
        />
      </I18nProvider>,
    );
  });
  // Drain the catalog load in its own act, so the tree under test is the
  // settled page rather than its empty first paint.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  mounted.push(() => act(() => root.unmount()));

  return {
    document: document as unknown as Document,
    calls,
    onError,
    click: async (element) => {
      await act(async () => {
        element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
      });
      // A click that starts a write settles a tick later; draining here keeps
      // every resulting state update inside act.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
  };
}
