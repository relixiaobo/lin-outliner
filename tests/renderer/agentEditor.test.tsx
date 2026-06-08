import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentEditor } from '../../src/renderer/ui/agent/AgentEditor';
import type { AgentAuthoringInput, AgentDefinitionView, AgentStorageLocation } from '../../src/core/agentTypes';

interface Rendered {
  cleanup: () => void;
  container: HTMLElement;
  document: Document;
  window: Window;
}

const mounted: Rendered[] = [];
// Snapshot the globals we overwrite so each render is hermetic — leaking a
// linkedom realm's `HTMLInputElement`/`document` into a later test breaks its
// cross-realm `instanceof` checks (e.g. the ProseMirror spike).
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

function builtIn(): AgentDefinitionView {
  return {
    agentId: 'built-in:tenon:general',
    name: 'general',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/general',
    description: 'General-purpose subagent',
    body: 'You are a focused subagent.',
  };
}

function userAgent(): AgentDefinitionView {
  return {
    agentId: 'user:abc123:my-helper',
    name: 'My-Helper',
    displayName: 'My-Helper',
    source: 'user',
    rootDir: '/home/u/.agents/agents/my-helper',
    agentFile: '/home/u/.agents/agents/my-helper/AGENT.md',
    description: 'Helps with research',
    body: 'You help with research.',
    model: 'claude-opus-4-8',
  };
}

describe('AgentEditor', () => {
  test('built-in renders read-only with a Duplicate action', async () => {
    let duplicated: AgentDefinitionView | null = null;
    const rendered = renderComponent(
      <AgentEditor
        agent={builtIn()}
        busy={false}
        onCreate={() => undefined}
        onUpdate={() => undefined}
        onDelete={() => undefined}
        onDuplicate={(agent) => { duplicated = agent; }}
      />,
    );
    expect(rendered.container.textContent).toContain('Built-in agents are read-only');
    // No editable name input is rendered for a built-in.
    expect(rendered.document.querySelector('input[aria-label="Name"]')).toBeNull();
    await click(rendered, textButton(rendered, 'Duplicate to my agents'));
    expect(duplicated).not.toBeNull();
    expect((duplicated as unknown as AgentDefinitionView).agentId).toBe('built-in:tenon:general');
  });

  test('create mode shows a blank form with a storage choice and blocks an empty name', async () => {
    const calls: Array<{ input: AgentAuthoringInput; storage: AgentStorageLocation }> = [];
    const rendered = renderComponent(
      <AgentEditor
        agent={null}
        busy={false}
        onCreate={(input, storage) => { calls.push({ input, storage }); }}
        onUpdate={() => undefined}
        onDelete={() => undefined}
        onDuplicate={() => undefined}
      />,
    );
    // Blank, with the global/workspace storage choice and a Create action.
    expect((rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value).toBe('');
    expect(rendered.container.textContent).toContain('Storage location');
    expect(textButton(rendered, 'Create')).toBeDefined();
    // Empty name → submit is blocked and surfaces the validation error.
    await click(rendered, textButton(rendered, 'Create'));
    expect(calls.length).toBe(0);
    expect(rendered.container.textContent).toContain('Enter an agent name');
  });

  test('edit mode exposes Save and Delete for a user agent', async () => {
    let deleted: AgentDefinitionView | null = null;
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor
        agent={userAgent()}
        busy={false}
        onCreate={() => undefined}
        onUpdate={(agentId, input) => { updated = { agentId, input }; }}
        onDelete={(agent) => { deleted = agent; }}
        onDuplicate={() => undefined}
      />,
    );
    expect((rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value).toBe('My-Helper');
    await click(rendered, textButton(rendered, 'Save'));
    expect(updated).not.toBeNull();
    expect((updated as unknown as { agentId: string }).agentId).toBe('user:abc123:my-helper');

    await click(rendered, textButton(rendered, 'Delete'));
    expect(deleted).not.toBeNull();
  });
});

function renderComponent(element: ReactNode): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  savedGlobals = GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
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

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => { root.render(element); });
  const rendered: Rendered = { cleanup: () => { act(() => root.unmount()); }, container, document, window };
  mounted.push(rendered);
  return rendered;
}

async function click(rendered: Rendered, element: Element | null) {
  if (!element) throw new Error('Missing clickable element');
  await act(async () => {
    element.dispatchEvent(new rendered.window.Event('click', { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function textButton(rendered: Rendered, text: string): HTMLButtonElement {
  const found = Array.from(rendered.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
