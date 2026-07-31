import { afterEach, describe, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

// providerIcon.ts loads vendored logos through Vite's import.meta.glob, which does
// not exist outside the bundler. The stub returns a marker SVG rather than
// undefined so the inline-SVG branch — the one production takes — is the branch
// this judge freezes, instead of the monogram fallback.
mock.module('../../src/renderer/ui/agent/providerIcon', () => ({
  providerIconSvg: (providerId: string) => `<svg data-fixture-logo="${providerId}"></svg>`,
}));
import type {
  AgentCapabilitySettingsView,
  AgentProviderSettingsView,
  ManagedSkillCatalogView,
  ManagedSkillView,
  SkillDefinition,
} from '../../src/renderer/api/types';
import type { SettingsCategoryTarget } from '../../src/core/settingsWindow';

// Imported dynamically, after the mock above: a static import would hoist above
// mock.module and pull in the real provider-icon module before it is stubbed.
async function loadSettingsView() {
  return (await import('../../src/renderer/ui/agent/AgentSettingsView')).AgentSettingsView;
}

/**
 * The frozen-surface judge for the settings page.
 *
 * It exists to make a refactor *provable*: it captures the rendered DOM of each
 * settings category before the page is decomposed into one component per
 * category, so the move that follows can be shown to be a move. If a snapshot
 * here shifts by a byte during that refactor, the refactor changed behaviour and
 * is not a pure move.
 *
 * Determinism is deliberate, not incidental — every input below is fixed:
 *   - the whole bridge is stubbed, so no real IPC or network is reachable;
 *   - no component in this tree formats a date or reads a clock (verified), so
 *     there is no relative-time drift;
 *   - the tree is rendered WITHOUT <I18nProvider>, which degrades to the English
 *     DEFAULT_MESSAGES by design, so a developer's locale cannot move the bytes;
 *   - no component in this tree calls useId, so extracting children cannot
 *     renumber React-generated ids.
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

const PROVIDER_SETTINGS: AgentProviderSettingsView = {
  activeProviderId: 'anthropic',
  providers: [
    { providerId: 'anthropic', enabled: true, hasApiKey: true },
    { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', enabled: false, hasApiKey: false },
  ],
  availableProviders: [
    {
      providerId: 'anthropic',
      authKind: 'api-key',
      hasEnvApiKey: false,
      envKeyNames: ['ANTHROPIC_API_KEY'],
      models: [
        {
          id: 'claude-opus-5',
          name: 'Claude Opus 5',
          reasoning: true,
          supportedThinkingLevels: ['low', 'medium', 'high'],
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
      ],
    },
    {
      providerId: 'openai',
      authKind: 'api-key',
      hasEnvApiKey: false,
      envKeyNames: ['OPENAI_API_KEY'],
      defaultBaseUrl: 'https://api.openai.com/v1',
      models: [],
    },
  ],
  agent: {
    additionalSkillDirectories: [],
    subagentTokenBudget: null,
    providerTimeoutMs: null,
    providerMaxRetries: null,
    providerMaxRetryDelayMs: null,
    providerCacheRetention: 'short',
    disabledSkills: ['project-lint'],
  },
  imageGeneration: {},
};

const CAPABILITY_SETTINGS: AgentCapabilitySettingsView = {
  blocks: ['rm -rf /', 'curl * | sh'],
  diagnostics: [],
};

/** One skill per non-managed source, so every row shape is frozen. */
function skill(overrides: Partial<SkillDefinition> & Pick<SkillDefinition, 'name' | 'source'>): SkillDefinition {
  return {
    rootDir: `/fixtures/${overrides.name}`,
    skillFile: `/fixtures/${overrides.name}/SKILL.md`,
    description: `Fixture skill ${overrides.name}.`,
    hasUserSpecifiedDescription: true,
    userInvocable: true,
    modelInvocable: true,
    ratified: true,
    allowedTools: [],
    argumentNames: [],
    execution: 'inline',
    contentLength: 128,
    body: '',
    ...overrides,
  };
}

const ALL_SKILLS: SkillDefinition[] = [
  skill({ name: 'skillify', source: 'built-in' }),
  skill({ name: 'user-notes', source: 'user', contentHash: 'a'.repeat(64), accepted: true }),
  skill({ name: 'project-lint', source: 'project', contentHash: 'b'.repeat(64), ratified: false }),
  skill({
    name: 'project-unratified',
    source: 'project',
    contentHash: 'c'.repeat(64),
    ratified: false,
    canUndoLastAgentEdit: true,
  }),
  skill({ name: 'pdf', source: 'managed', managedContentHash: 'd'.repeat(64) }),
];

const MANAGED_SKILLS: ManagedSkillView[] = [
  {
    id: 'managed-pdf',
    name: 'pdf',
    description: 'Create, inspect, extract, repair, render, OCR, redact, and verify PDF artifacts.',
    repository: 'https://github.com/relixiaobo/linlab-skills',
    subdirectory: 'pdf',
    trackingRef: 'main',
    recommended: true,
    enabled: true,
    status: 'enabled',
    compatibility: { status: 'compatible', appVersion: '0.1.0', declaredRange: '>=0.1.0 <1.0.0' },
    active: {
      commit: '0'.repeat(40),
      contentHash: 'd'.repeat(64),
      installedAt: 1_720_000_000_000,
      fileCount: 4,
      totalBytes: 2_048,
      version: '0.2.0',
    },
    scripts: [],
  },
];

const CATALOG: ManagedSkillCatalogView = {
  status: 'fresh',
  entries: [
    {
      id: 'pdf',
      name: 'pdf',
      description: 'Create, inspect, extract, repair, render, OCR, redact, and verify PDF artifacts.',
      repository: 'https://github.com/relixiaobo/linlab-skills',
      subdirectory: 'pdf',
      trackingRef: 'main',
      compatibilityRange: '>=0.1.0 <1.0.0',
      installedSkillId: 'managed-pdf',
    },
    {
      id: 'spreadsheet',
      name: 'spreadsheet',
      description: 'Create, inspect, validate, and package spreadsheet workbooks.',
      repository: 'https://github.com/relixiaobo/linlab-skills',
      subdirectory: 'spreadsheet',
      trackingRef: 'main',
      compatibilityRange: '>=0.1.0 <1.0.0',
    },
  ],
  refreshedAt: 1_720_000_000_000,
};

/** Every channel the settings tree can reach, answered from fixed data. */
const INVOKE_RESULTS: Record<string, unknown> = {
  agent_get_provider_settings: PROVIDER_SETTINGS,
  agent_get_capability_settings: CAPABILITY_SETTINGS,
  agent_list_all_skills: ALL_SKILLS,
  agent_managed_skill_list: { ok: true, value: MANAGED_SKILLS },
  agent_managed_skill_catalog: { ok: true, value: CATALOG },
  agent_managed_skill_check_updates: { ok: true, value: MANAGED_SKILLS },
  memory_settings_get: {
    status: {
      featureMode: 'off',
      featureModeGeneration: 1,
      resetEpoch: 0,
      memoryVisibilityGeneration: 1,
      lastSuccessfulRunAt: null,
      lastError: null,
      pendingJobs: 0,
      strayTaggedNodeCount: 0,
    },
    thread: null,
  },
};

const CATEGORIES: SettingsCategoryTarget[] = ['general', 'providers', 'security', 'skills'];

describe('settings page DOM', () => {
  for (const category of CATEGORIES) {
    test(`renders the ${category} category byte-stably`, async () => {
      const rendered = await renderCategory(category);
      const root = rendered.document.querySelector('.settings-window');
      if (!root) throw new Error('Missing .settings-window');
      expect(formatMarkup(root.outerHTML)).toMatchSnapshot();
    });
  }
});

async function renderCategory(category: SettingsCategoryTarget): Promise<Rendered> {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  installDomGlobals(window);
  Object.assign(window, {
    lin: {
      initialLanguage: 'en',
      invoke: async (name: string) => {
        if (!(name in INVOKE_RESULTS)) throw new Error(`Unstubbed settings channel: ${name}`);
        return INVOKE_RESULTS[name];
      },
      getTheme: async () => 'system',
      setTheme: async () => undefined,
      getNotificationPrefs: async () => ({ osNotificationsEnabled: false }),
      setNotificationPrefs: async () => undefined,
      // Subscriptions return their unsubscribe, as the real bridge does.
      onSettingsNavigate: () => () => undefined,
      onSettingsChanged: () => () => undefined,
      onLanguageChanged: () => () => undefined,
    },
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing root container');
  const root = createRoot(container);
  const AgentSettingsView = await loadSettingsView();

  // Mount, then drain the load effects so the snapshot captures the settled page
  // rather than its loading skeleton.
  await act(async () => {
    root.render(
      <AgentSettingsView
        initialTarget={{ category }}
        onApplied={async () => undefined}
        onClose={() => undefined}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });

  const rendered = { cleanup: () => act(() => root.unmount()), document };
  mounted.push(rendered);
  return rendered;
}

/**
 * One tag per line, indented by depth. The judge is read by a human comparing two
 * revisions, so a line-oriented shape is what makes a diff legible.
 */
function formatMarkup(html: string): string {
  const tokens = html.replace(/></g, '>\n<').split('\n');
  let depth = 0;
  return tokens
    .map((token) => {
      if (/^<\//.test(token)) depth -= 1;
      const line = `${'  '.repeat(Math.max(depth, 0))}${token}`;
      if (/^<[^/!]/.test(token) && !/\/>$/.test(token) && !/<\/[a-z]/i.test(token)) depth += 1;
      return line;
    })
    .join('\n');
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
