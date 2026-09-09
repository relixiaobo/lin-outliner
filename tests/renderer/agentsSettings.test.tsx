import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentEditorView } from '../../src/renderer/api/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const VIEW: AgentEditorView = {
  sources: [
    { layer: 'user', path: '/user/agent/config.json', schemaPath: '/user/agent/config.schema.json', state: 'missing', digest: null, error: null },
    { layer: 'project', path: '/workspace/.tenon/agent.json', schemaPath: '/workspace/.tenon/agent.schema.json', state: 'missing', digest: null, error: null },
  ],
  presentationOverrides: [],
  profile: {
    name: 'default',
    layer: null,
    developerInstructions: null,
    model: null,
    reasoningEffort: null,
    tools: null,
    skills: null,
  },
  capabilities: {
    tools: [
      { key: 'file_read', description: 'Read a file.' },
      { key: 'bash', description: 'Run a command.' },
    ],
    skills: ['review'],
  },
  entries: [{ agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' }],
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

describe('the main Agent editor', () => {
  test('shows only the conversation Agent and no create control', async () => {
    const rendered = await renderAgents();
    expect(rendered.document.querySelectorAll('.inset-row-main')).toHaveLength(1);
    expect(rendered.document.body.textContent).toContain('Aspen');
    expect(rendered.document.querySelector('.rail-toggle')).toBeNull();
  });

  test('saves identity, instructions, and inherited capability ceilings atomically', async () => {
    const rendered = await renderAgents();
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.input(rendered.document.querySelector('input')!, 'Juniper');
    await rendered.input(rendered.document.querySelector('textarea')!, 'Answer directly.');
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.calls.at(-1)).toEqual({
      name: 'agent_write_profile',
      args: {
        layer: 'user',
        sourceDigest: null,
        name: 'default',
        presentation: { persona: 'Juniper', color: '' },
        profile: {
          developerInstructions: 'Answer directly.',
          tools: null,
          skills: null,
        },
      },
    });
  });

  test('previews presentation defaults using whole-object project replacement', async () => {
    const rendered = await renderAgents({ view: { ...VIEW, presentationOverrides: [
      { agentType: 'main', layer: 'user', persona: 'Willow', color: 'pink' },
      { agentType: 'main', layer: 'project', persona: 'Juniper', color: null },
    ] } });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    const name = rendered.document.querySelector('input[aria-label="Name"]')!;
    const defaultMark = () => rendered.document.querySelector('button[aria-label="Default"] svg')?.innerHTML;
    // A project name alone keeps the built-in colour, not the user colour.
    expect(defaultMark()).toContain('--identity-tint-4');
    await rendered.input(name, '');
    expect(name.getAttribute('placeholder')).toBe('Willow');
    expect(defaultMark()).toContain('--identity-tint-7');
    await rendered.click(rendered.document.querySelector('button[aria-label="Blue"]')!);
    expect(name.getAttribute('placeholder')).toBe('Aspen');
    await rendered.input(rendered.document.querySelector('select[aria-label="Apply to"]')!, 'user');
    expect(defaultMark()).toContain('--identity-tint-4');
  });

  test('writes an exact empty capability set instead of treating it as inheritance', async () => {
    const rendered = await renderAgents();
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    for (const label of ['Tools', 'Skills']) {
      await rendered.input(rendered.document.querySelector(`select[aria-label="${label}"]`)!, 'custom');
    }
    for (const button of [...rendered.document.querySelectorAll('button')].filter((button) => button.textContent === 'Deselect All')) {
      await rendered.click(button);
    }
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect((rendered.calls.at(-1)?.args as { profile: { tools: string[]; skills: string[] } }).profile)
      .toMatchObject({ tools: [], skills: [] });
  });

  test('keeps the edited source observation when a background refresh arrives', async () => {
    const rendered = await renderAgents();
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.refresh({ ...VIEW, sources: VIEW.sources.map((source) => ({ ...source, digest: 'new-source' })) });
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.calls.at(-1)?.args).toMatchObject({ sourceDigest: null });
  });

  test('keeps a refused write visible inside the editor', async () => {
    const rendered = await renderAgents({ rejectWrite: true });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.document.querySelector('.agent-editor-dialog')).not.toBeNull();
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('Refused');
  });

  test('preserves an explicit full selection when only the name changes', async () => {
    const rendered = await renderAgents({ view: { ...VIEW, profile: { ...VIEW.profile,
      tools: ['file_read', 'bash'], skills: ['review'] } } });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.input(rendered.document.querySelector('input[aria-label="Name"]')!, 'Juniper');
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.calls.at(-1)?.args).toMatchObject({ profile: { tools: ['file_read', 'bash'], skills: ['review'] } });
  });

  test('returns to inheritance only when the default mode is chosen', async () => {
    const rendered = await renderAgents({ view: { ...VIEW, profile: { ...VIEW.profile, tools: [], skills: [] } } });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    for (const label of ['Tools', 'Skills']) {
      await rendered.input(rendered.document.querySelector(`select[aria-label="${label}"]`)!, 'default');
    }
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.calls.at(-1)?.args).toMatchObject({ profile: { tools: null, skills: null } });
  });

  test('shows library-disabled skills without altering the profile or library switch', async () => {
    const rendered = await renderAgents({ disabledSkills: ['review'] });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.input(rendered.document.querySelector('select[aria-label="Skills"]')!, 'custom');
    expect(rendered.document.querySelector('.agent-capability-status')?.textContent).toBe('Off in Skill Library');
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.calls.at(-1)?.args).toMatchObject({ profile: { skills: ['review'] } });
    expect(rendered.calls.some((call) => call.name === 'agent_update_skill_settings')).toBe(false);
  });
});

async function renderAgents(options: { rejectWrite?: boolean; view?: AgentEditorView; disabledSkills?: string[] } = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  let currentView = options.view ?? VIEW;
  let refresh: (() => void) | undefined;
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
    onConfigurationChanged: (domain: string, callback: () => void) => { if (domain === 'agents') refresh = callback; return () => {}; },
    invoke: async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === 'agent_get_skill_settings') return { disabledSkills: options.disabledSkills ?? [], sourceBindings: [] };
      if (options.rejectWrite && name === 'agent_write_profile') throw new Error('Refused by test');
      return currentView;
    },
  };
  (window as unknown as Record<string, unknown>).lin = (globalThis as Record<string, unknown>).lin;

  const { AgentConfigurationEditor } = await import('../../src/renderer/ui/agent/AgentConfigurationEditor');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentConfigurationEditor />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  mounted.push(() => act(() => root.unmount()));

  return {
    document: document as unknown as Document,
    calls,
    refresh: async (next: AgentEditorView) => { currentView = next; await act(async () => { refresh?.(); }); },
    click: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
        if (element.getAttribute('type') === 'submit') {
          element.closest('form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        }
        await Promise.resolve();
      });
    },
    input: async (element: Element, value: string) => {
      await act(async () => {
        const propsKey = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
        const props = propsKey
          ? (element as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[propsKey]
          : undefined;
        if (!props?.onChange) throw new Error('Missing React change handler');
        props.onChange({ target: { value } });
      });
    },
  };
}
