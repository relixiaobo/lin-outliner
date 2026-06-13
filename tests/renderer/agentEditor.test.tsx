import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AgentEditor } from '../../src/renderer/ui/agent/AgentEditor';
import type { AgentAuthoringInput, AgentDefinitionView, AgentStorageLocation, SkillDefinition } from '../../src/core/agentTypes';

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
  onCreate: () => undefined,
  onUpdate: () => undefined,
  onDelete: () => undefined,
  onDuplicate: () => undefined,
};

function builtIn(): AgentDefinitionView {
  return {
    agentId: 'built-in:tenon:assistant',
    name: 'assistant',
    displayName: 'Tenon Assistant',
    source: 'built-in',
    rootDir: 'built-in',
    agentFile: 'built-in/assistant',
    writable: false,
    description: 'Default Tenon assistant profile',
    body: 'You are Tenon Assistant.',
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
    writable: true,
    description: 'Helps with research',
    body: 'You help with research.',
    model: 'claude-opus-4-8',
  };
}

function additionalDirectoryAgent(): AgentDefinitionView {
  return {
    agentId: 'user:external123:external-reviewer',
    name: 'external-reviewer',
    displayName: 'external-reviewer',
    source: 'user',
    rootDir: '/opt/shared-agents/external-reviewer',
    agentFile: '/opt/shared-agents/external-reviewer/AGENT.md',
    writable: false,
    description: 'Reviews work from a shared directory',
    body: 'You review work.',
    effort: 'high',
  };
}

function skill(name: string): SkillDefinition {
  return { name, displayName: name, source: 'user', rootDir: '/s', skillFile: '/s/SKILL.md', description: '', hasUserSpecifiedDescription: false, userInvocable: true, modelInvocable: true, allowedTools: [], argumentNames: [], context: 'inline', contentLength: 0, body: '' };
}

describe('AgentEditor', () => {
  test('built-in renders through the same editor, view-only, with a Duplicate action', async () => {
    let duplicated: AgentDefinitionView | null = null;
    const rendered = renderComponent(
      <AgentEditor agent={builtIn()} availableSkills={[]} busy={false} {...NOOP} onDuplicate={(agent) => { duplicated = agent; }} />,
    );
    expect(rendered.container.textContent).toContain('Built-in agents are view-only');
    // Same Form editor as a user agent — the Name field exists and is pre-filled;
    // the controls are read-only (the tool toggles render natively disabled).
    const nameInput = rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('Tenon Assistant');
    expect(rendered.document.querySelector('button[aria-label="Toggle file_read"]')?.hasAttribute('disabled')).toBe(true);
    // The only action is Duplicate (no Save / Delete).
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Save'))).toBe(false);
    await click(rendered, textButton(rendered, 'Duplicate to my agents'));
    expect((duplicated as unknown as AgentDefinitionView | null)?.agentId).toBe('built-in:tenon:assistant');
  });

  test('create mode is a pre-filled scaffold with a storage choice', async () => {
    const calls: Array<{ input: AgentAuthoringInput; storage: AgentStorageLocation }> = [];
    const rendered = renderComponent(
      <AgentEditor agent={null} availableSkills={[]} busy={false} {...NOOP} onCreate={(input, storage) => { calls.push({ input, storage }); }} />,
    );
    // Pre-filled with the scaffold (not blank), so neither mode starts empty.
    expect((rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value).toBe('my-agent');
    expect(rendered.container.textContent).toContain('Storage location');
    await click(rendered, textButton(rendered, 'Create'));
    expect(calls.length).toBe(1);
    expect(calls[0]?.input.name).toBe('my-agent');
    expect(calls[0]?.input.permissionMode).toBe('restricted');
    expect(calls[0]?.storage).toBe('user');
  });

  test('a new agent scaffolds the Raw AGENT.md with sensible default fields', async () => {
    const rendered = renderComponent(<AgentEditor agent={null} availableSkills={[]} busy={false} {...NOOP} />);
    await click(rendered, textButton(rendered, 'Raw'));
    const raw = textareaValue(rendered.document.querySelector('textarea[aria-label="AGENT.md"]'));
    expect(raw).toContain('name: my-agent');
    expect(raw).toContain('permission-mode: restricted');
    expect(raw).toContain('max-turns: 20');
    expect(raw).toContain('You are a focused child agent.');
    // All tools on + model inherit by default ⇒ neither key appears in Raw.
    expect(raw).not.toContain('tools:');
    expect(raw).not.toContain('model:');
  });

  test('edit mode exposes Save and Delete for a user agent', async () => {
    let deleted: AgentDefinitionView | null = null;
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor agent={userAgent()} availableSkills={[]} busy={false} {...NOOP} onUpdate={(agentId, input) => { updated = { agentId, input }; }} onDelete={(agent) => { deleted = agent; }} />,
    );
    expect((rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value).toBe('My-Helper');
    await click(rendered, textButton(rendered, 'Save'));
    expect((updated as unknown as { agentId: string } | null)?.agentId).toBe('user:abc123:my-helper');
    await click(rendered, textButton(rendered, 'Delete'));
    expect(deleted).not.toBeNull();
  });

  test('non-writable additional-directory agents render read-only with Duplicate only', async () => {
    let duplicated: AgentDefinitionView | null = null;
    const rendered = renderComponent(
      <AgentEditor agent={additionalDirectoryAgent()} availableSkills={[]} busy={false} {...NOOP} onDuplicate={(agent) => { duplicated = agent; }} />,
    );
    const nameInput = rendered.document.querySelector('input[aria-label="Name"]') as HTMLInputElement | null;
    expect(nameInput?.value).toBe('external-reviewer');
    expect(nameInput?.hasAttribute('readOnly')).toBe(true);
    expect((rendered.document.querySelector('select[aria-label="Thinking Level"]') as HTMLSelectElement | null)?.hasAttribute('disabled')).toBe(true);
    expect(rendered.document.querySelector('button[aria-label="Toggle file_read"]')?.hasAttribute('disabled')).toBe(true);
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Save'))).toBe(false);
    expect(Array.from(rendered.document.querySelectorAll('button')).some((b) => b.textContent?.includes('Delete'))).toBe(false);

    await click(rendered, textButton(rendered, 'Duplicate to my agents'));
    expect((duplicated as unknown as AgentDefinitionView | null)?.agentId).toBe('user:external123:external-reviewer');
  });

  test('out-of-catalog effort values render as inherit and are dropped on save', async () => {
    let updated: { agentId: string; input: AgentAuthoringInput } | null = null;
    const rendered = renderComponent(
      <AgentEditor
        agent={{ ...userAgent(), effort: 'turbo' }}
        availableSkills={[]}
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

  test('tools default to all-on; unchecking one is reflected when switching to Raw', async () => {
    const rendered = renderComponent(
      <AgentEditor agent={null} availableSkills={[]} busy={false} {...NOOP} />,
    );
    // All catalog tools start enabled (unrestricted).
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
      <AgentEditor agent={null} availableSkills={[skill('research'), skill('writing')]} busy={false} {...NOOP} />,
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
