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
import { ManagedSkillsSettings } from '../../src/renderer/ui/agent/ManagedSkillsSettings';

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

describe('ManagedSkillsSettings', () => {
  test('keeps catalog failure separate from the installed empty state', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') {
        return { status: 'unavailable', entries: [], error: { code: 'github_unavailable' } } satisfies ManagedSkillCatalogView;
      }
      if (command === 'agent_managed_skill_list') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();

    expect(rendered.document.body.textContent).toContain('Catalog unavailable');
    expect(rendered.document.body.textContent).toContain('GitHub is unavailable');
    expect(rendered.document.body.textContent).toContain('No managed skills installed.');
    expect(rendered.document.body.textContent).toContain('Public repository or skill URL');
  });

  test('reviews a recommended pinned commit, installs disabled, and enables separately', async () => {
    let installed = false;
    let enabled = false;
    const calls: string[] = [];
    const rendered = renderComponent(async (command) => {
      calls.push(command);
      if (command === 'agent_managed_skill_catalog') return catalog(installed);
      if (command === 'agent_managed_skill_list') return installed ? [managedSkill(enabled)] : [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_managed_skill_install') {
        installed = true;
        return managedSkill(false);
      }
      if (command === 'agent_managed_skill_set_enabled') {
        enabled = true;
        return managedSkill(true);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();

    const catalogInstall = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Install');
    if (!catalogInstall) throw new Error('Missing catalog install button');
    await act(async () => {
      catalogInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.document.body.textContent).toContain('Install demo-skill');
    expect(rendered.document.body.textContent).toContain('aaaaaaaaaaaa');
    expect(rendered.document.body.textContent).toContain('scripts/run.py');
    expect(rendered.document.body.textContent).toContain('Recommended');

    const reviewInstall = buttons(rendered.document).filter((button) => button.textContent?.trim() === 'Install').at(-1);
    if (!reviewInstall) throw new Error('Missing reviewed install button');
    await act(async () => {
      reviewInstall.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.document.body.textContent).toContain('Disabled');
    expect(rendered.document.body.textContent).toContain('demo-skill installed disabled');

    const enableSwitch = rendered.document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enable demo-skill"]');
    if (!enableSwitch) throw new Error('Missing managed skill enable switch');
    expect(enableSwitch.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      enableSwitch.click();
      await Promise.resolve();
    });
    expect(calls).toContain('agent_managed_skill_set_enabled');
    expect(rendered.document.querySelector('[role="switch"][aria-label="Enable demo-skill"]')?.getAttribute('aria-checked')).toBe('true');
  });

  test('renders update-available, modified, recommended, and unverified states without collapsing rows', async () => {
    const update = { ...managedSkill(true), status: 'update-available' as const, updateCommit: 'b'.repeat(40) };
    const modified = {
      ...managedSkill(true),
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

    expect(rendered.document.body.textContent).toContain('Update available');
    expect(rendered.document.body.textContent).toContain('Modified');
    expect(rendered.document.body.textContent).toContain('Recommended');
    expect(rendered.document.body.textContent).toContain('Unverified');
    expect(rendered.document.querySelectorAll('.inset-row')).toHaveLength(5);
  });

  test('shows install validation failures inside the active review dialog', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_managed_skill_install') return managedFailure('executable_file', 'scripts/run.py');
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();

    const catalogInstall = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Install');
    if (!catalogInstall) throw new Error('Missing catalog install button');
    await act(async () => {
      catalogInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const reviewInstall = buttons(rendered.document).filter((button) => button.textContent?.trim() === 'Install').at(-1);
    if (!reviewInstall) throw new Error('Missing reviewed install button');
    await act(async () => {
      reviewInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const dialogAlert = rendered.document.querySelector('.managed-skill-dialog [role="alert"]');
    expect(dialogAlert?.textContent).toContain('Executable support files are not allowed. (scripts/run.py)');
  });

  test('localizes managed skill command errors in Simplified Chinese', async () => {
    const rendered = renderComponent(async (command) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') return discovery();
      if (command === 'agent_managed_skill_install') return managedFailure('github_not_found');
      throw new Error(`Unexpected command: ${command}`);
    }, 'zh-Hans');
    await flush();

    const catalogInstall = buttons(rendered.document).find((button) => button.textContent?.trim() === '安装');
    if (!catalogInstall) throw new Error('Missing localized catalog install button');
    await act(async () => {
      catalogInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const reviewInstall = buttons(rendered.document).filter((button) => button.textContent?.trim() === '安装').at(-1);
    if (!reviewInstall) throw new Error('Missing localized reviewed install button');
    await act(async () => {
      reviewInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = rendered.document.body.textContent ?? '';
    expect(text).toContain('未找到对应的 GitHub 仓库、引用或技能路径。');
    expect(text).not.toContain('GitHub resource was not found');
  });

  test('requires an explicit candidate choice for a multi-skill repository', async () => {
    let installedCandidateId: string | undefined;
    const rendered = renderComponent(async (command, args) => {
      if (command === 'agent_managed_skill_catalog') return catalog(false);
      if (command === 'agent_managed_skill_list') return [];
      if (command === 'agent_managed_skill_discover') {
        const base = discovery();
        return {
          ...base,
          selectionRequired: true,
          candidates: [
            { ...base.candidates[0]!, id: 'alpha', name: 'alpha-skill', subdirectory: 'skills/alpha' },
            { ...base.candidates[0]!, id: 'beta', name: 'beta-skill', subdirectory: 'skills/beta' },
          ],
        } satisfies ManagedSkillDiscoveryView;
      }
      if (command === 'agent_managed_skill_install') {
        installedCandidateId = String(args?.candidateId);
        return managedSkill(false);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    await flush();

    const catalogInstall = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Install');
    if (!catalogInstall) throw new Error('Missing catalog install button');
    await act(async () => {
      catalogInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.document.body.textContent).toContain('Select a skill');
    expect(rendered.document.body.textContent).toContain('alpha-skill');
    expect(rendered.document.body.textContent).toContain('beta-skill');

    const beta = buttons(rendered.document).find((button) => button.textContent?.includes('beta-skill'));
    if (!beta) throw new Error('Missing beta candidate');
    await act(async () => { beta.click(); });
    const continueButton = buttons(rendered.document).find((button) => button.textContent?.trim() === 'Continue');
    if (!continueButton) throw new Error('Missing continue button');
    await act(async () => { continueButton.click(); });
    expect(rendered.document.body.textContent).toContain('Install beta-skill');

    const reviewInstall = buttons(rendered.document).filter((button) => button.textContent?.trim() === 'Install').at(-1);
    if (!reviewInstall) throw new Error('Missing reviewed install button');
    await act(async () => {
      reviewInstall.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(installedCandidateId).toBe('beta');
  });
});

function renderComponent(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  locale: Locale = 'en',
): Rendered {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    lin: {
      initialLanguage: locale,
      invoke: async (command: string, args?: Record<string, unknown>) => {
        const value = await invoke(command, args);
        return isManagedCommandResult(value) ? value : { ok: true, value };
      },
    },
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  act(() => root.render(
    <I18nProvider>
      <ManagedSkillsSettings onApplied={async () => undefined} />
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

function discovery(): ManagedSkillDiscoveryView {
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
    }],
  };
}

function managedSkill(enabled: boolean): ManagedSkillView {
  return {
    id: 'demo-skill',
    name: 'demo-skill',
    description: 'Recommended demo skill.',
    repository: 'https://github.com/public/repo',
    subdirectory: 'skills/demo-skill',
    trackingRef: 'main',
    recommended: true,
    enabled,
    status: enabled ? 'enabled' : 'installed-disabled',
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
