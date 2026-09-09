import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import type {
  ManagedSkillCatalogView,
  ManagedSkillCommandResult,
  ManagedSkillDiscoveryView,
  ManagedSkillErrorCode,
  ManagedSkillView,
} from '../../src/core/types';
import type { Locale } from '../../src/core/locale';
import { I18nProvider } from '../../src/renderer/i18n/I18nProvider';
import { SkillLibrary } from '../../src/renderer/ui/agent/SkillLibrary';
import { SkillReviewWindow } from '../../src/renderer/ui/agent/SkillReviewWindow';
import type { SkillReview } from '../../src/core/agent/skillOperations';

interface Rendered {
  cleanup: () => void;
  document: Document;
}

const mounted: Rendered[] = [];
const GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'Event',
  'HTMLElement',
  'HTMLInputElement',
  'KeyboardEvent',
  'MouseEvent',
  'Node',
] as const;
let savedGlobals: Array<[string, PropertyDescriptor | undefined]> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.cleanup();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals = [];
});

describe('Skill library — managed sources', () => {
  test.each([false, true])('install uses the Host owner and preserves configured disablement: %s', async (disabled) => {
    let installed = false;
    const requests: unknown[] = [];
    const toggles: string[] = [];
    const rendered = renderComponent(async (command, args) => {
      if (command === 'agent_managed_skill_catalog') return catalog(installed);
      if (command === 'agent_managed_skill_list' || command === 'agent_managed_skill_check_updates') return installed ? [managedSkill()] : [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_skill_manage') {
        requests.push(args?.request); installed = true;
        return { committed: true, runtimeRefresh: { state: 'applied' } };
      }
      throw new Error(`Unexpected command: ${command}`);
    }, 'en', { disabledSkills: disabled ? ['demo-skill'] : [], onToggleSkill: (name) => toggles.push(name) });
    await flush();
    await openAcquisition(rendered);
    await clickText(rendered, 'Install');
    expect(requests).toEqual([{ operation: 'install', discoveryId: 'discovery', candidateId: 'candidate', expectedCommit: 'a'.repeat(40) }]);
    expect(toggles).toEqual([]);
    expect(rendered.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable demo-skill"]')?.getAttribute('aria-checked')).toBe(String(!disabled));
    expect(rendered.document.body.textContent).toContain('demo-skill installed.');
    expect(rendered.document.body.textContent).not.toContain('installed and enabled');
  });

  test('native review renders the pinned source and full instructions as inert text', async () => {
    const found = discovery({ skillBody: '<script>untrusted()</script>\nRead a PDF and summarize it.' });
    const decisions: boolean[] = [];
    const rendered = renderComponent(async () => [], 'en', {
      review: { kind: 'install', discovery: found, candidate: found.candidates[0]! },
      decide: async (approved) => { decisions.push(approved); },
    });
    await flush();
    expect(rendered.document.body.textContent).toContain('aaaaaaaaaaaa');
    expect(rendered.document.body.textContent).toContain('scripts/run.py');
    expect(rendered.document.body.textContent).toContain('<script>untrusted()</script>');
    expect(rendered.document.querySelector('script')).toBeNull();
    await clickText(rendered, 'Install');
    expect(decisions).toEqual([true]);
    expect(buttons(rendered.document).filter((button) => button.disabled).length).toBeGreaterThan(0);
  });

  test('truncated instructions cannot be approved in the review window', async () => {
    const found = discovery({ skillBodyTruncated: true });
    const rendered = renderComponent(async () => [], 'en', {
      review: { kind: 'install', discovery: found, candidate: found.candidates[0]! },
    });
    await flush();
    expect(rendered.document.body.textContent).toContain('too large to review in full');
    expect(buttons(rendered.document).find((button) => button.textContent === 'Install')?.disabled).toBe(true);
  });

  test('the native review keeps Cancel reachable while loading and after a bridge failure', async () => {
    let reject!: (error: Error) => void;
    const loading = new Promise<SkillReview>((_resolve, fail) => { reject = fail; });
    let closed = false;
    const rendered = renderComponent(async () => [], 'en', {
      loadReview: () => loading, closeReview: () => { closed = true; },
    });
    expect(rendered.document.querySelector('[role="status"]')?.textContent).toContain('Loading');
    expect(buttons(rendered.document).some((button) => button.textContent === 'Cancel')).toBe(true);
    await act(async () => { reject(new Error('Review expired')); });
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('Review expired');
    await clickText(rendered, 'Cancel');
    expect(closed).toBe(true);
  });

  test('a rejected decision leaves an error and a working close action', async () => {
    let closed = false;
    const found = discovery();
    const rendered = renderComponent(async () => [], 'en', {
      review: { kind: 'install', discovery: found, candidate: found.candidates[0]! },
      decide: async () => { throw new Error('Caller unavailable'); }, closeReview: () => { closed = true; },
    });
    await flush(); await clickText(rendered, 'Install');
    expect(rendered.document.querySelector('[role="alert"]')?.textContent).toContain('Caller unavailable');
    await clickText(rendered, 'Cancel');
    expect(closed).toBe(true);
  });

  test.each(['rollback', 'uninstall'] as const)('the review window can cancel %s without issuing a lifecycle command', async (kind) => {
    const decisions: boolean[] = [];
    const rendered = renderComponent(async () => { throw new Error('No broad bridge'); }, 'en', {
      review: { kind, skill: managedSkill() }, decide: async (approved) => { decisions.push(approved); },
    });
    await flush();
    await clickText(rendered, 'Cancel');
    expect(decisions).toEqual([false]);
  });

  test('a cancelled Host review leaves the library free of false success or error', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_skill_manage') return managedFailure('cancelled');
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush(); await openAcquisition(rendered); await clickText(rendered, 'Install');
    expect(rendered.document.querySelector('[role="alert"]')).toBeNull();
    expect(rendered.document.querySelector('.agent-settings-notice')).toBeNull();
  });

  test('localizes Host operation failure in the acquisition surface', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_skill_manage') return managedFailure('github_not_found');
      throw new Error(`Unexpected command: ${command}`);
    }, 'zh-Hans');
    await flush(); await openAcquisition(rendered); await clickText(rendered, '安装');
    expect(rendered.document.querySelector('.skill-acquire-dialog [role="alert"]')?.textContent)
      .toContain('未找到对应的 GitHub 仓库、引用或技能路径。');
  });

  test('multi-candidate discovery requires an explicit choice before Host review', async () => {
    const requests: unknown[] = [];
    const found = discovery();
    const rendered = renderComponent(async (command, args) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return { ...found, selectionRequired: true,
        candidates: ['alpha', 'beta'].map((id) => ({ ...found.candidates[0], id, name: id })) };
      if (command === 'agent_skill_manage') { requests.push(args?.request); return { committed: true }; }
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush(); await openAcquisition(rendered); await clickText(rendered, 'Install');
    expect(requests).toEqual([]);
    const beta = buttons(rendered.document).find((button) => button.textContent?.startsWith('beta'))!;
    await act(async () => { beta.click(); });
    await clickText(rendered, 'Continue');
    expect(requests).toMatchObject([{ operation: 'install', candidateId: 'beta' }]);
  });
  test('keeps catalog failure separate from the library empty state', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') {
        return { status: 'unavailable', entries: [], error: { code: 'github_unavailable' } } satisfies ManagedSkillCatalogView;
      }
      if (command === 'agent_managed_skill_list') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();
    await openAcquisition(rendered);

    expect(rendered.document.body.textContent).toContain('Catalog unavailable');
    expect(rendered.document.body.textContent).toContain('GitHub is unavailable');
    // The per-group "no managed skills" state is gone: there is one list-level
    // empty state now, because managed skills are rows in the one library list.
    expect(rendered.document.body.textContent).toContain('No skills yet.');
    expect(rendered.document.body.textContent).toContain('Install from GitHub');
  });

  test('renders update-available, modified, recommended, and unverified states without collapsing rows', async () => {
    const update = { ...managedSkill(), status: 'update-available' as const, updateCommit: 'b'.repeat(40) };
    const modified = {
      ...managedSkill(),
      id: 'modified-skill',
      name: 'modified-skill',
      recommended: false,
      status: 'modified' as const,
      diagnostic: { code: 'skill_modified' as const, detail: 'modified-skill' },
    };
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return { status: 'fresh', entries: [] } satisfies ManagedSkillCatalogView;
      if (command === 'agent_managed_skill_list' || command === 'agent_managed_skill_check_updates') return [update, modified];
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();
    await openAcquisition(rendered);

    expect(rendered.document.body.textContent).toContain('Update available');
    expect(rendered.document.body.textContent).toContain('Modified');
    expect(rendered.document.body.textContent).toContain('Recommended');
    expect(rendered.document.body.textContent).toContain('Unverified');
    // Acquisition and file diagnostics do not add entries to the installed library.
    expect(rendered.document.querySelectorAll('.settings-skills-section > .inset-group .inset-row')).toHaveLength(2);
  });

  // Every failure of the GitHub flow rendered into page flow, underneath the
  // acquire dialog's dimming backdrop, so the primary error path of the panel was
  // invisible: the button returned from "Resolving…" to "Add" and nothing else
  // happened. The alert belongs inside whichever surface is on top.
  test('shows a discovery failure inside the acquire dialog, not behind it', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return managedFailure('github_not_found');
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();
    await openAcquisition(rendered);

    // Catalog Install resolves through the same discovery call the GitHub field
    // uses, so it exercises the identical failure path without driving an input.
    const catalogInstall = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Install');
    if (!catalogInstall) throw new Error('Missing catalog install button');
    await act(async () => {
      catalogInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialogAlert = rendered.document.querySelector('.skill-acquire-dialog [role="alert"]');
    expect(dialogAlert?.textContent).toContain('The GitHub repository, ref, or skill path was not found.');
  });
});

function renderComponent(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  locale: Locale = 'en',
  options: {
    disabledSkills?: string[];
    onToggleSkill?: (name: string) => void;
    review?: SkillReview;
    decide?: (approved: boolean) => Promise<void>;
    loadReview?: () => Promise<SkillReview>;
    closeReview?: () => void;
  } = {},
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    close: options.closeReview ?? (() => {}),
    lin: {
      initialLanguage: locale,
      skillReview: { get: options.loadReview ?? (async () => options.review), decide: options.decide ?? (async () => {}) },
      invoke: async (command: string, args?: Record<string, unknown>) => {
        // The library list loads the non-managed sources too. These specs are
        // about managed skills, so that call is answered with an empty list
        // here and left unwrapped — it is not a managed command envelope.
        if (command === 'agent_list_all_skills') return [];
        const value = await invoke(command, args);
        return isManagedCommandResult(value) ? value : { ok: true, value };
      },
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  // Managed skills are rows in the one library list and are acquired from a
  // surface that shares its state, so the section is the renderable unit.
  act(() => root.render(
    <I18nProvider>
      {options.review || options.loadReview ? <SkillReviewWindow /> : <SkillLibrary
        additionalSkillDirectories={[]}
        disabledSkills={options.disabledSkills ?? []}
        onDirectoriesChange={async (next) => next}
        onApplied={async () => undefined}
        onToggleSkill={options.onToggleSkill ?? (() => undefined)}
      />}
    </I18nProvider>,
  ));
  const rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function installDomGlobals(window: Window): void {
  for (const key of GLOBAL_KEYS) savedGlobals.push([key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document: window.document,
    window,
    Event: window.Event,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    Node: window.Node,
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

/**
 * Acquisition now lives behind the library's `+`, so these specs open it before
 * asserting on the catalog / URL surface.
 */
async function openAcquisition(rendered: Rendered): Promise<void> {
  const add = rendered.document.querySelector<HTMLButtonElement>('.inset-group-header-action button[aria-haspopup="menu"]');
  if (!add) throw new Error('Missing + control');
  await act(async () => {
    add.click();
    await Promise.resolve();
  });
  const entry = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Add Skill…'
    || button.textContent?.trim() === '添加 Skill…');
  if (!entry) throw new Error('Missing add-skill menu entry');
  await act(async () => {
    entry.click();
    await Promise.resolve();
  });
}

function buttons(document: Document): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')];
}

function managedFailure(code: ManagedSkillErrorCode, detail?: string): ManagedSkillCommandResult<never> {
  return { ok: false, error: { code, ...(detail ? { detail } : {}) } };
}

function isManagedCommandResult(value: unknown): value is ManagedSkillCommandResult<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}

function catalog(installed: boolean): ManagedSkillCatalogView {
  return {
    status: 'fresh',
    entries: [{
      id: 'demo-skill',
      name: 'demo-skill',
      description: 'Recommended demo skill.',
      repository: 'https://github.com/public/repo',
      subdirectory: 'skills/demo-skill',
      trackingRef: 'main',
      ...(installed ? { installedSkillId: 'demo-skill' } : {}),
    }],
  };
}

function discovery(
  candidateOverrides: Partial<ManagedSkillDiscoveryView['candidates'][number]> = {},
): ManagedSkillDiscoveryView {
  return {
    id: 'discovery',
    repository: 'https://github.com/public/repo',
    trackingRef: 'main',
    resolvedCommit: 'a'.repeat(40),
    recommended: true,
    selectionRequired: false,
    candidates: [{
      id: 'candidate',
      name: 'demo-skill',
      description: 'Recommended demo skill.',
      subdirectory: 'skills/demo-skill',
      compatibility: { status: 'unknown', appVersion: '0.1.0' },
      scripts: ['scripts/run.py'],
      skillBody: '---\nname: demo-skill\n---\n\nRead a PDF and summarize it.',
      ...candidateOverrides,
    }],
  };
}

function managedSkill(): ManagedSkillView {
  return {
    id: 'demo-skill',
    name: 'demo-skill',
    description: 'Recommended demo skill.',
    userInvocable: true,
    repository: 'https://github.com/public/repo',
    subdirectory: 'skills/demo-skill',
    trackingRef: 'main',
    recommended: true,
    revision: 'fixture-revision',
    status: 'installed',
    compatibility: { status: 'unknown', appVersion: '0.1.0' },
    active: {
      commit: 'a'.repeat(40),
      contentHash: 'c'.repeat(64),
      installedAt: 1,
      fileCount: 2,
      totalBytes: 100,
    },
    scripts: ['scripts/run.py'],
  };
}

async function clickText(rendered: Rendered, text: string): Promise<void> {
  const button = buttons(rendered.document).find((button) => button.textContent?.trim() === text);
  if (!button) throw new Error(`Missing ${text} button`);
  await act(async () => { button.click(); });
  await flush();
}
