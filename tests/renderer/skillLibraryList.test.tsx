import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type { ManagedSkillView, SkillDefinition } from '../../src/core/types';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { SettingsSkillLibrarySection } from '../../src/renderer/ui/agent/SettingsSkillLibrarySection';

/**
 * The library is one list over every source. What matters here is that a row's
 * enable state means the same thing regardless of where the Skill came from —
 * the UI must never claim a Skill is on while the model cannot see it.
 */

interface Rendered {
  cleanup: () => void;
  document: Document;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = ['document', 'window', 'navigator', 'Event', 'HTMLElement', 'MouseEvent', 'Node'] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

function localSkill(name: string, source: SkillDefinition['source']): SkillDefinition {
  return {
    name,
    source,
    rootDir: `/fixtures/${name}`,
    skillFile: `/fixtures/${name}/SKILL.md`,
    description: `Fixture ${name}.`,
    hasUserSpecifiedDescription: true,
    userInvocable: true,
    modelInvocable: true,
    ratified: true,
    allowedTools: [],
    argumentNames: [],
    execution: 'inline',
    contentLength: 10,
    body: '',
  };
}

function managedSkill(overrides: Partial<ManagedSkillView> = {}): ManagedSkillView {
  return {
    id: 'managed-pdf',
    name: 'pdf',
    description: 'Managed fixture.',
    repository: 'https://github.com/relixiaobo/linlab-skills',
    subdirectory: 'pdf',
    trackingRef: 'main',
    recommended: true,
    enabled: true,
    status: 'enabled',
    compatibility: { status: 'compatible', appVersion: '0.1.0' },
    active: {
      commit: '0'.repeat(40),
      contentHash: 'd'.repeat(64),
      installedAt: 1_720_000_000_000,
      fileCount: 1,
      totalBytes: 10,
    },
    scripts: [],
    ...overrides,
  };
}

function switchFor(document: Document, label: string): HTMLButtonElement {
  const control = document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
  if (!control) throw new Error(`Missing switch: ${label}`);
  return control;
}

describe('skill library list', () => {
  test('renders every source in one list', async () => {
    const rendered = await render({
      skills: [
        localSkill('skillify', 'built-in'),
        localSkill('user-notes', 'user'),
        localSkill('project-lint', 'project'),
      ],
      managed: [managedSkill()],
    });

    const labels = [...rendered.document.querySelectorAll('.inset-row-label')]
      .map((node) => node.textContent ?? '');
    // One group, sorted by the name the user reads — not grouped by origin.
    expect(labels.filter((label) => label.startsWith('/'))).toEqual([
      '/pdfmanagedRecommendedEnabled',
      '/project-lintproject',
      '/skillifybuilt-in',
      '/user-notesuser',
    ]);
    // A single list group holds them all.
    expect(rendered.document.querySelectorAll('.inset-group').length).toBeGreaterThan(0);
  });

  test('shows an installed-but-deactivated managed skill as a row that is off', async () => {
    // It is absent from the loaded catalog by design, so only the managed index
    // can report it. If the library read the catalog alone, the user would have
    // no way to see or reverse an install they turned off.
    const rendered = await render({
      skills: [],
      managed: [managedSkill({ enabled: false, status: 'installed-disabled' })],
    });

    expect(rendered.document.body.textContent).toContain('/pdf');
    expect(switchFor(rendered.document, 'Enable pdf').getAttribute('aria-checked')).toBe('false');
  });

  test('an activated managed skill named in disabledSkills reads as off', async () => {
    // The row applies the same predicate main does. Reporting the activation
    // flag alone would show "on" for a skill the model cannot see.
    const rendered = await render({
      skills: [],
      managed: [managedSkill()],
      disabledSkills: ['pdf'],
    });

    expect(switchFor(rendered.document, 'Enable pdf').getAttribute('aria-checked')).toBe('false');
  });

  test('a non-managed skill in disabledSkills reads as off', async () => {
    const rendered = await render({
      skills: [localSkill('user-notes', 'user')],
      managed: [],
      disabledSkills: ['user-notes'],
    });

    expect(switchFor(rendered.document, 'Toggle user-notes').getAttribute('aria-checked')).toBe('false');
  });

  test('the empty state is one list-level state, not one per source', async () => {
    const rendered = await render({ skills: [], managed: [] });

    expect(rendered.document.body.textContent).toContain('No skills yet.');
    // Exactly one empty row, and it stays inside the group so the `+` that fixes
    // the empty state is still reachable from it.
    expect(rendered.document.querySelectorAll('.inset-row')).toHaveLength(1);
    expect(rendered.document.querySelector('.inset-group-header-action button')).not.toBeNull();
  });

  test('acquisition is behind the + control, not on the page', async () => {
    const rendered = await render({ skills: [], managed: [] });

    // The catalog and the URL field are two inputs to the same act and live in
    // one panel; neither occupies the page until asked for.
    expect(rendered.document.body.textContent).not.toContain('Public repository or skill URL');
    expect(rendered.document.querySelector('.skill-acquire-dialog')).toBeNull();

    const add = rendered.document.querySelector<HTMLButtonElement>('.inset-group-header-action button');
    if (!add) throw new Error('Missing + control');
    await act(async () => {
      add.click();
      await Promise.resolve();
    });
    const entry = [...rendered.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Add Skill…');
    if (!entry) throw new Error('Missing add-skill menu entry');
    await act(async () => {
      entry.click();
      await Promise.resolve();
    });

    expect(rendered.document.querySelector('.skill-acquire-dialog')).not.toBeNull();
    expect(rendered.document.body.textContent).toContain('Public repository or skill URL');
  });
});

async function render(input: {
  skills: SkillDefinition[];
  managed: ManagedSkillView[];
  disabledSkills?: string[];
}): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke: async (command: string) => {
        if (command === 'agent_list_all_skills') return input.skills;
        if (command === 'agent_managed_skill_list') return { ok: true, value: input.managed };
        if (command === 'agent_managed_skill_check_updates') return { ok: true, value: input.managed };
        if (command === 'agent_managed_skill_catalog') {
          return { ok: true, value: { status: 'fresh', entries: [] } };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        <SettingsSkillLibrarySection
          disabledSkills={input.disabledSkills ?? []}
          onApplied={async () => undefined}
          onError={() => undefined}
          onNotice={() => undefined}
          onToggleSkill={() => undefined}
        />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });

  const rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) {
    savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  }
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
