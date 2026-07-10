import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentEditor } from '../../src/renderer/ui/agent/AgentEditor';
import type { AgentAuthoringInput, AgentDefinitionView, SkillDefinition } from '../../src/core/agentTypes';

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

const NOOP = {
  onUpdate: () => undefined,
};

// The one agent, Neva. Under the one-Neva invariant the editor only ever edits
// her: built-in, always writable, edited in place via the settings overlay.
function builtIn(): AgentDefinitionView {
  return {
    agentId: 'built-in:tenon:assistant',
    name: 'assistant',
    displayName: 'Neva',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/assistant',
    writable: true,
    description: 'Default Tenon assistant profile',
    body: 'You are Neva.',
  };
}

function skill(name: string): SkillDefinition {
  return { name, displayName: name, source: 'user', rootDir: '/s', skillFile: '/s/SKILL.md', description: '', hasUserSpecifiedDescription: false, userInvocable: true, modelInvocable: true, allowedTools: [], argumentNames: [], execution: 'inline', contentLength: 0, body: '' };
}

describe('AgentEditor', () => {
  test('the built-in assistant is directly editable: Save, no Delete, no Duplicate', async () => {
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor agent={builtIn()} availableSkills={[]} providerSettings={null} busy={false} {...NOOP} onUpdate={(agentId, input) => { updated = { agentId, input }; }} />,
    );
    // The Name field edits the display name (the stable id stays `assistant`), and the
    // definition controls are live — never read-only.
    const nameInput = rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('Neva');
    expect(nameInput?.hasAttribute('readOnly')).toBe(false);
    expect(rendered.document.querySelector('button[aria-label="Toggle file_read"]')?.hasAttribute('disabled')).toBe(false);
    // permissionMode / maxTurns / background steer only delegation child runs; the
    // single-agent editor never offers them — there is no second agent to delegate to.
    expect(rendered.container.textContent).not.toContain('Delegation Sandbox');
    expect(rendered.document.querySelector('input[aria-label="Max Turns"]')).toBeNull();
    expect(rendered.container.textContent).not.toContain('Run in background');
    // No "duplicate to edit" friction and no read-only hint — it is editable in place,
    // and there is nothing to duplicate to.
    expect(rendered.container.textContent).not.toContain('read-only');
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Duplicate'))).toBe(false);
    // Editable but not deletable: Save present, Delete absent (Neva always exists).
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Save'))).toBe(true);
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Delete'))).toBe(false);
    await click(rendered, textButton(rendered, 'Save'));
    expect((updated as unknown as { agentId: string } | null)?.agentId).toBe('built-in:tenon:assistant');
  });

  test('out-of-catalog effort values render as inherit and are dropped on save', async () => {
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor
        agent={{ ...builtIn(), effort: 'turbo' }}
        availableSkills={[]}
        providerSettings={null}
        busy={false}
        {...NOOP}
        onUpdate={(agentId, input) => { updated = { agentId, input }; }}
      />,
    );
    const effortSelect = rendered.document.querySelector('select[aria-label="Thinking Level"]') as HTMLSelectElement | null;
    expect(effortSelect?.value).toBe('');

    await click(rendered, textButton(rendered, 'Save'));
    expect((updated as unknown as { input: AgentAuthoringInput } | null)?.input.effort).toBeUndefined();
  });

  test('max is a first-class effort value and survives a form save', async () => {
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor
        agent={{ ...builtIn(), effort: 'max' }}
        availableSkills={[]}
        providerSettings={null}
        busy={false}
        {...NOOP}
        onUpdate={(agentId, input) => { updated = { agentId, input }; }}
      />,
    );
    const effortSelect = rendered.document.querySelector('select[aria-label="Thinking Level"]') as HTMLSelectElement | null;
    expect(effortSelect?.value).toBe('max');

    await click(rendered, textButton(rendered, 'Save'));
    expect((updated as unknown as { input: AgentAuthoringInput } | null)?.input.effort).toBe('max');
  });

  test('tools default to all-on; unchecking one is reflected when switching to Raw', async () => {
    const rendered = renderComponent(
      <AgentEditor agent={builtIn()} availableSkills={[]} providerSettings={null} busy={false} {...NOOP} />,
    );
    // All catalog tools start enabled (unrestricted) for the inherit-everything default.
    const readSwitch = rendered.document.querySelector('button[aria-label="Toggle file_read"]');
    expect(readSwitch?.getAttribute('aria-checked')).toBe('true');

    await click(rendered, readSwitch);
    expect(readSwitch?.getAttribute('aria-checked')).toBe('false');

    // Switching to Raw serializes the form; the now-restricted tool list omits file_read.
    await click(rendered, textButton(rendered, 'Raw'));
    const raw = textareaValue(rendered.document.querySelector('textarea[aria-label="AGENT.md"]'));
    expect(raw).toContain('tools:');
    expect(raw).toContain('file_glob');
    expect(raw).not.toContain('file_read');
  });

  test('skills toggle list shows installed skills', () => {
    const rendered = renderComponent(
      <AgentEditor agent={builtIn()} availableSkills={[skill('research'), skill('writing')]} providerSettings={null} busy={false} {...NOOP} />,
    );
    expect(rendered.document.querySelector('button[aria-label="Toggle research"]')).not.toBeNull();
    expect(rendered.document.querySelector('button[aria-label="Toggle writing"]')).not.toBeNull();
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

// React writes a controlled <textarea> value into the DOM node's `.value` only
// on an update; on the initial mount it sets `defaultValue` instead, which
// linkedom's `.value` getter doesn't reflect (a real browser would). The raw
// editor is freshly mounted when switching to Raw, so read both.
function textareaValue(el: Element | null): string {
  const ta = el as HTMLTextAreaElement | null;
  return ta?.value || ta?.defaultValue || '';
}
