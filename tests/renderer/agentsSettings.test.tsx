import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { AgentEditorView } from '../../src/renderer/api/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';

const VIEW: AgentEditorView = {
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

  test('writes an exact empty capability set instead of treating it as inheritance', async () => {
    const rendered = await renderAgents();
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    for (const checkbox of rendered.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      await rendered.click(checkbox);
    }
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect((rendered.calls.at(-1)?.args as { profile: { tools: string[]; skills: string[] } }).profile)
      .toMatchObject({ tools: [], skills: [] });
  });

  test('keeps a refused write visible inside the editor', async () => {
    const rendered = await renderAgents({ rejectWrite: true });
    await rendered.click(rendered.document.querySelector('.inset-row-main')!);
    await rendered.click([...rendered.document.querySelectorAll('button')].find((button) => button.textContent === 'Save')!);
    expect(rendered.document.querySelector('.agent-editor-dialog')).not.toBeNull();
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('Refused');
  });
});

async function renderAgents(options: { rejectWrite?: boolean } = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
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
      if (options.rejectWrite && name === 'agent_write_profile') throw new Error('Refused by test');
      return VIEW;
    },
  };
  (window as unknown as Record<string, unknown>).lin = (globalThis as Record<string, unknown>).lin;

  const { AgentsSettings } = await import('../../src/renderer/ui/agent/AgentsSettings');
  const root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root.render(
      <I18nProvider>
        <AgentsSettings onError={() => undefined} onNotice={() => undefined} settings={null} />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });
  mounted.push(() => act(() => root.unmount()));

  return {
    document: document as unknown as Document,
    calls,
    click: async (element: Element) => {
      await act(async () => {
        element.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
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
