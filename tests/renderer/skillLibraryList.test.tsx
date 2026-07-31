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
  /** Every bridge command the section issued, in order. */
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  /** Replaces what the managed list command answers with, for the next fetch. */
  setManaged: (next: ManagedSkillView[]) => void;
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
    expect(rendered.document.querySelector('.inset-group-header-action button[aria-haspopup="menu"]')).not.toBeNull();
  });

  test('enabling a suppressed managed skill persists both halves, not one', async () => {
    // Activation goes to the managed index immediately. If clearing the
    // disabledSkills entry were only a draft, Cancel would leave the Skill
    // activated on disk but still suppressed by the predicate — invisible to
    // the model, and back to off with no explanation on reopen.
    const persisted: Array<[string, boolean]> = [];
    const drafted: string[] = [];
    const rendered = await render({
      skills: [],
      managed: [managedSkill()],
      disabledSkills: ['pdf'],
      onPersistSkillDisabled: async (name, disabled) => { persisted.push([name, disabled]); },
      onToggleSkill: (name) => { drafted.push(name); },
    });

    const control = switchFor(rendered.document, 'Enable pdf');
    expect(control.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      control.click();
      await Promise.resolve();
    });

    expect(persisted).toEqual([['pdf', false]]);
    expect(drafted).toEqual([]);
  });

  test('a non-managed toggle stays a draft the footer Save commits', async () => {
    const persisted: Array<[string, boolean]> = [];
    const drafted: string[] = [];
    const rendered = await render({
      skills: [localSkill('user-notes', 'user')],
      managed: [],
      onPersistSkillDisabled: async (name, disabled) => { persisted.push([name, disabled]); },
      onToggleSkill: (name) => { drafted.push(name); },
    });

    await act(async () => {
      switchFor(rendered.document, 'Toggle user-notes').click();
      await Promise.resolve();
    });

    expect(drafted).toEqual(['user-notes']);
    expect(persisted).toEqual([]);
  });

  test('a failed update check keeps the skill description', async () => {
    // An offline launch produces this for every installed Skill, from an action
    // the user never requested; it must not repaint the library.
    const rendered = await render({
      skills: [],
      managed: [managedSkill({
        status: 'failed',
        diagnostic: { code: 'github_unavailable' },
      })],
    });

    expect(rendered.document.body.textContent).toContain('Managed fixture.');
  });

  test('an integrity fault does replace the description', async () => {
    const rendered = await render({
      skills: [],
      managed: [managedSkill({
        status: 'modified',
        diagnostic: { code: 'skill_modified', detail: 'pdf' },
      })],
    });

    // Here the Skill's own content is what is untrustworthy, so it must not be
    // the thing the row shows.
    expect(rendered.document.body.textContent).not.toContain('Managed fixture.');
  });

  test('reports the update count up, and revises it when one is applied', async () => {
    // The shell reads the count once, before the ambient check has run and
    // before anything is applied. Left at that, the badge reported work that no
    // longer existed until the window was reopened.
    const counts: number[] = [];
    const withUpdate = managedSkill({ status: 'update-available', updateCommit: 'b'.repeat(40) });
    const rendered = await render({
      skills: [],
      managed: [withUpdate],
      onUpdateCountChange: (count) => { counts.push(count); },
    });

    expect(counts.at(-1)).toBe(1);

    // Applying an update clears updateCommit on the record. Re-listing is what
    // every managed mutation does, so drive that and require the count to follow.
    rendered.setManaged([managedSkill()]);
    const check = rendered.document.querySelector<HTMLButtonElement>(
      '.inset-group-header-action button[aria-label="Check all skills for updates"]',
    );
    if (!check) throw new Error('Missing check-for-updates control');
    await act(async () => {
      check.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(counts.at(-1)).toBe(0);
  });

  test('offers an explicit check that the ambient throttle cannot suppress', async () => {
    const rendered = await render({ skills: [], managed: [managedSkill()] });

    const check = rendered.document.querySelector<HTMLButtonElement>(
      '.inset-group-header-action button[aria-label="Check all skills for updates"]',
    );
    if (!check) throw new Error('Missing check-for-updates control');
    expect(check.disabled).toBe(false);

    await act(async () => {
      check.click();
      await Promise.resolve();
    });

    // Opening the pane already fired an ambient check; the click must be the
    // unthrottled kind. No `ambient` flag means main applies no throttle.
    const checks = rendered.calls.filter((entry) => entry.command === 'agent_managed_skill_check_updates');
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks[0]?.args?.ambient).toBe(true);
    expect(checks.at(-1)?.args?.ambient).toBeUndefined();
  });

  test('every skill with a real folder can be opened from its row', async () => {
    const rendered = await render({
      skills: [localSkill('user-notes', 'user')],
      managed: [],
    });

    await act(async () => {
      rendered.document
        .querySelector<HTMLButtonElement>('[aria-label="user-notes actions"]')
        ?.click();
      await Promise.resolve();
    });
    const reveal = [...rendered.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Show in Finder');
    if (!reveal) throw new Error('Missing reveal action');

    await act(async () => {
      reveal.click();
      await Promise.resolve();
    });

    const call = rendered.calls.find((entry) => entry.command === 'agent_reveal_skill_directory');
    expect(call?.args?.path).toBe('/fixtures/user-notes');
  });

  test('a code-registered built-in offers no folder to open', async () => {
    // Its rootDir is a display-safe pseudo path, not a location — an action that
    // cannot open anything is worse than no action.
    const rendered = await render({
      skills: [{ ...localSkill('skillify', 'built-in'), rootDir: 'built-in/skillify' }],
      managed: [],
    });

    const menu = rendered.document.querySelector('[aria-label="skillify actions"]');
    expect(menu).toBeNull();
  });

  test('a skill from a bound directory carries the local chip', async () => {
    const rendered = await render({
      skills: [{ ...localSkill('notes', 'user'), rootDir: '/work/skills/notes' }],
      managed: [],
      directories: ['/work/skills'],
    });

    const label = [...rendered.document.querySelectorAll('.inset-row-label')]
      .map((node) => node.textContent ?? '')
      .find((text) => text.startsWith('/notes'));
    // The source chip reports where it actually came from, not the user/project
    // bucket the runtime happens to file it under.
    expect(label).toContain('local');
    expect(label).not.toContain('user');
  });

  test('a bound directory with no skills is still listed, so it can be unbound', async () => {
    const rendered = await render({ skills: [], managed: [], directories: ['/work/empty'] });

    expect(rendered.document.body.textContent).toContain('/work/empty');
    expect(rendered.document.body.textContent).toContain('No skills found in this directory.');
  });

  test('unbinding a directory only drops the pointer', async () => {
    const changes: string[][] = [];
    const rendered = await render({
      skills: [],
      managed: [],
      directories: ['/work/a', '/work/b'],
      onDirectoriesChange: async (next) => { changes.push(next); },
    });

    const menu = rendered.document.querySelector<HTMLButtonElement>('[aria-label="/work/a actions"]');
    if (!menu) throw new Error('Missing directory row menu');
    await act(async () => {
      menu.click();
      await Promise.resolve();
    });
    const unbind = [...rendered.document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Unbind directory');
    if (!unbind) throw new Error('Missing unbind action');
    // The label says unbind, and this asserts the handler agrees: the only
    // effect is that the path leaves the list. Nothing deletes anything.
    expect(unbind.textContent).not.toContain('Delete');
    await act(async () => {
      unbind.click();
      await Promise.resolve();
    });

    expect(changes).toEqual([['/work/b']]);
  });

  test('acquisition is behind the + control, not on the page', async () => {
    const rendered = await render({ skills: [], managed: [] });

    // The catalog and the URL field are two inputs to the same act and live in
    // one panel; neither occupies the page until asked for.
    expect(rendered.document.body.textContent).not.toContain('Public repository or skill URL');
    expect(rendered.document.querySelector('.skill-acquire-dialog')).toBeNull();

    const add = rendered.document.querySelector<HTMLButtonElement>('.inset-group-header-action button[aria-haspopup="menu"]');
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
  directories?: string[];
  onDirectoriesChange?: (next: string[]) => Promise<void>;
  onPersistSkillDisabled?: (skillName: string, disabled: boolean) => Promise<void>;
  onToggleSkill?: (skillName: string) => void;
  onUpdateCountChange?: (count: number) => void;
}): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let managed = input.managed;
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke: async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, ...(args ? { args } : {}) });
        if (command === 'agent_list_all_skills') return input.skills;
        if (command === 'agent_managed_skill_list') return { ok: true, value: managed };
        if (command === 'agent_managed_skill_check_updates') return { ok: true, value: managed };
        if (command === 'agent_reveal_skill_directory') return { revealed: true };
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
          additionalSkillDirectories={input.directories ?? []}
          disabledSkills={input.disabledSkills ?? []}
          onDirectoriesChange={input.onDirectoriesChange ?? (async () => undefined)}
          onApplied={async () => undefined}
          onError={() => undefined}
          onNotice={() => undefined}
          onPersistSkillDisabled={input.onPersistSkillDisabled ?? (async () => undefined)}
          onToggleSkill={input.onToggleSkill ?? (() => undefined)}
          onUpdateCountChange={input.onUpdateCountChange ?? (() => undefined)}
        />
      </I18nProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); });

  const rendered = {
    cleanup: () => act(() => root.unmount()),
    document,
    calls,
    setManaged: (next: ManagedSkillView[]) => { managed = next; },
  };
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
