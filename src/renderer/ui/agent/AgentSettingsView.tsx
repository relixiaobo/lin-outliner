import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AppIcon } from '../icons';
import type {
  AgentModelOption,
  AgentPermissionMode,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentDefinitionView,
  AgentAuthoringInput,
  AgentStorageLocation,
  AgentMemoryEntryView,
  AgentToolPermissionSettingsView,
  SkillDefinition,
} from '../../api/types';
import { api } from '../../api/client';
import {
  AddIcon,
  AgentIcon,
  BrainIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  CloseIcon,
  DatabaseIcon,
  ICON_SIZE,
  PasswordIcon,
  PencilIcon,
  SettingsIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';
import type { ThemeMode } from '../../../core/theme';
import { SUPPORTED_LOCALES, type Locale } from '../../../core/locale';
import { useI18n, useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { TextInputControl } from '../primitives/TextInputControl';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import {
  ProviderAvatar,
  formatProviderName,
  providerHasCredential,
  resolveUsableActiveProvider,
} from './providerCatalog';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import { defaultReasoningLevel } from './settingsReasoning';
import { AgentEditor } from './AgentEditor';

interface AgentSettingsViewProps {
  onClose: () => void;
  onApplied: () => Promise<void>;
  conversationId?: string;
}

type SettingsCategory = 'general' | 'providers' | 'permissions' | 'memory' | 'skills' | 'agents';
type SettingsRoute =
  | { type: 'category'; category: SettingsCategory }
  | { type: 'agent-detail'; agentId: string }
  | { type: 'agent-create' };

interface DraftConfig {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl: string;
  enabled: boolean;
  permissionMode: AgentPermissionMode;
  automaticSkillsEnabled: boolean;
  slashSkillsEnabled: boolean;
  compactEnabled: boolean;
  additionalSkillDirectoriesText: string;
  additionalAgentDirectoriesText: string;
  disabledSkills: string[];
  disabledAgents: string[];
}

interface ProviderChoice {
  providerId: string;
  configured: boolean;
  active: boolean;
  enabled: boolean;
  hasCredential: boolean;
}

interface ProviderRowHandlers {
  onConfigure: (id: string) => void;
  onActivate: (id: string) => void;
  onRemove: (id: string) => void;
  onMenuOpenChange: (id: string, open: boolean) => void;
}

// A single provider row in the inset grouped list — the macOS System Settings
// Wi-Fi idiom: the brand avatar is the identity, clicking the row opens the config
// sheet. There is no leading status column — "Connected" vs "Available" already
// carries that, so a per-row marker would be redundant. A trailing `⋯` appears
// ONLY when the row has more than one action; a single-action row (just
// "Configure", which is what clicking the row does) instead exposes a "Configure"
// button on the trailing edge — the macOS Wi-Fi "Connect" / "Details…" idiom —
// revealed on hover / focus. Memoized + fed stable handlers, so editing one
// provider's sheet never re-renders the list.
const SettingsProviderRow = memo(function SettingsProviderRow({
  provider,
  menuOpen,
  handlers,
}: {
  provider: ProviderChoice;
  menuOpen: boolean;
  handlers: ProviderRowHandlers;
}) {
  const t = useT();
  const name = formatProviderName(provider.providerId);
  const actions: RowMenuAction[] = [];
  if (provider.hasCredential && !provider.active) {
    actions.push({ label: t.settings.providers.setActive, onSelect: () => handlers.onActivate(provider.providerId) });
  }
  actions.push({ label: t.settings.providers.configureAction, onSelect: () => handlers.onConfigure(provider.providerId) });
  if (provider.configured) {
    actions.push({ label: t.settings.providers.removeProvider, danger: true, onSelect: () => handlers.onRemove(provider.providerId) });
  }
  return (
    <InsetRow
      ariaLabel={t.settings.providers.rowAriaLabel({ name, status: providerStatusLabel(provider, t) })}
      label={name}
      leading={<ProviderAvatar providerId={provider.providerId} />}
      onSelect={() => handlers.onConfigure(provider.providerId)}
      trailing={actions.length > 1 ? (
        <SettingsRowMenu
          actions={actions}
          ariaLabel={t.settings.providers.rowActionsAriaLabel({ name })}
          onOpenChange={(open) => handlers.onMenuOpenChange(provider.providerId, open)}
          open={menuOpen}
        />
      ) : (
        <button
          aria-label={t.settings.providers.configureNamed({ name })}
          className="settings-row-button settings-provider-configure"
          onClick={() => handlers.onConfigure(provider.providerId)}
          type="button"
        >
          {t.settings.providers.configure}
        </button>
      )}
    />
  );
});

const EMPTY_DRAFT: DraftConfig = {
  providerId: '',
  modelId: '',
  reasoningLevel: 'off',
  baseUrl: '',
  enabled: true,
  permissionMode: 'trusted',
  automaticSkillsEnabled: true,
  slashSkillsEnabled: true,
  compactEnabled: true,
  additionalSkillDirectoriesText: '',
  additionalAgentDirectoriesText: '',
  disabledSkills: [],
  disabledAgents: [],
};

// Theme segment values and category rail order; their visible labels + hints are
// localized at render (settings.general.theme* and settings.categories.*).
const THEME_VALUES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const SETTINGS_CATEGORY_IDS: readonly SettingsCategory[] = ['general', 'providers', 'permissions', 'memory', 'skills', 'agents'];
const SETTINGS_CATEGORY_ICONS = {
  general: SettingsIcon,
  providers: DatabaseIcon,
  permissions: PasswordIcon,
  memory: BrainIcon,
  skills: BrainIcon,
  agents: AgentIcon,
} satisfies Record<SettingsCategory, AppIcon>;

// The common permission rules: a stable `id` (the i18n key for label + description),
// the `ruleValue` engine string, and whether a global "always allow" is offered.
// Visible label/description come from t.settings.permissions.rules[id] at render.
type PermissionRuleId =
  | 'readOutsideArea'
  | 'readSensitivePaths'
  | 'fetchWeb'
  | 'deleteFiles'
  | 'runProjectScripts'
  | 'installDependencies'
  | 'publishGitRemotes'
  | 'deployPublish'
  | 'networkWrite'
  | 'spawnSubagents';

const COMMON_PERMISSION_RULES: Array<{
  id: PermissionRuleId;
  ruleValue: string;
  allowable: boolean;
}> = [
  { id: 'readOutsideArea', ruleValue: 'Action(file.read.outside_allowed_file_area)', allowable: true },
  { id: 'readSensitivePaths', ruleValue: 'Action(file.read.sensitive_local_path)', allowable: true },
  { id: 'fetchWeb', ruleValue: 'Action(web.fetch)', allowable: true },
  { id: 'deleteFiles', ruleValue: 'Action(file.delete.allowed_file_area)', allowable: true },
  { id: 'runProjectScripts', ruleValue: 'Action(shell.project_script)', allowable: true },
  { id: 'installDependencies', ruleValue: 'Action(shell.dependency_install)', allowable: true },
  { id: 'publishGitRemotes', ruleValue: 'Action(git.publish_remote)', allowable: true },
  { id: 'deployPublish', ruleValue: 'Action(deploy.publish_remote)', allowable: true },
  { id: 'networkWrite', ruleValue: 'Action(shell.network_write)', allowable: true },
  { id: 'spawnSubagents', ruleValue: 'Action(agent.subagent.spawn)', allowable: false },
];

const PREFERRED_PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter'];

function routeCategory(route: SettingsRoute): SettingsCategory {
  return route.type === 'category' ? route.category : 'agents';
}

function routesEqual(left: SettingsRoute, right: SettingsRoute): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'category') {
    return left.category === (right as Extract<SettingsRoute, { type: 'category' }>).category;
  }
  if (left.type === 'agent-detail') {
    return left.agentId === (right as Extract<SettingsRoute, { type: 'agent-detail' }>).agentId;
  }
  return true;
}

export function AgentSettingsView({ onApplied, onClose, conversationId }: AgentSettingsViewProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<AgentToolPermissionSettingsView | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<AgentToolPermissionSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  // Route navigation history, so the window can offer macOS System Settings'
  // back / forward (‹ ›) chrome. Top-level categories and drill-down pages share
  // the same stack; Agent Profiles details are a child route, not flat content on
  // the category page.
  const [nav, setNav] = useState<{ stack: SettingsRoute[]; index: number }>({
    stack: [{ type: 'category', category: 'providers' }],
    index: 0,
  });
  const route = nav.stack[nav.index];
  const category = routeCategory(route);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const [allSkills, setAllSkills] = useState<SkillDefinition[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Skill trust actions (accept / revoke / undo) round-trip through main and return
  // the refreshed skill list; one shared busy flag keeps the row controls quiet
  // while a mutation is in flight.
  const [skillTrustBusy, setSkillTrustBusy] = useState(false);
  const [allAgents, setAllAgents] = useState<AgentDefinitionView[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<AgentDefinitionView | null>(null);
  const [memoryEntries, setMemoryEntries] = useState<AgentMemoryEntryView[]>([]);
  const [loadingMemory, setLoadingMemory] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryDraftFact, setMemoryDraftFact] = useState('');
  const [memorySavingId, setMemorySavingId] = useState<string | null>(null);
  // The per-row ⋯ actions menu (only one open at a time, keyed by providerId). The
  // per-provider config opens in its own native window, not an in-renderer sheet.
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  // App-level appearance preference (General pane). Independent of the provider/
  // permission save flow: it applies immediately across all windows via the main
  // process (nativeTheme.themeSource) and persists, so there is no Save step.
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  // Opt-in OS-notification preference (General pane). Self-contained like the theme:
  // applies immediately, persisted by main, no Save step. Default off.
  const [osNotificationsEnabled, setOsNotificationsEnabled] = useState(false);
  // Display language: the picker reads/writes the shared i18n context (seeded before
  // first paint, broadcast across windows), so it applies instantly like the theme.
  const { locale, t, setLocale } = useI18n();
  const routeAgent = route.type === 'agent-detail'
    ? allAgents.find((agent) => agent.agentId === route.agentId) ?? null
    : null;
  const categoryLabel = route.type === 'agent-detail'
    ? (routeAgent?.displayName || routeAgent?.name || t.settings.categories.agents.label)
    : route.type === 'agent-create'
      ? t.settings.agents.createTitle
      : t.settings.categories[category].label;
  const themeOptions = useMemo(() => {
    const g = t.settings.general;
    const labels: Record<ThemeMode, string> = { system: g.themeSystem, light: g.themeLight, dark: g.themeDark };
    return THEME_VALUES.map((value) => ({ value, label: labels[value] }));
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  // Load the current appearance preference once so the General pane's segmented
  // control reflects the active theme. Best-effort: if the bridge is unavailable
  // (e.g. a non-Electron dev host) the control stays on its 'system' default.
  useEffect(() => {
    let active = true;
    void window.lin?.getTheme?.()
      .then((mode) => {
        if (active) setThemeMode(mode);
      })
      .catch(() => { /* keep the default */ });
    return () => { active = false; };
  }, []);

  // Apply a theme pick optimistically (instant, no Save) and persist it via main.
  function changeTheme(mode: ThemeMode) {
    setThemeMode(mode);
    void window.lin?.setTheme?.(mode);
  }

  // Load the persisted OS-notification opt-in once. Best-effort like the theme load.
  useEffect(() => {
    let active = true;
    void window.lin?.getNotificationPrefs?.()
      .then((prefs) => {
        if (active) setOsNotificationsEnabled(prefs.osNotificationsEnabled);
      })
      .catch(() => { /* keep the default (off) */ });
    return () => { active = false; };
  }, []);

  function changeOsNotifications(enabled: boolean) {
    setOsNotificationsEnabled(enabled);
    void window.lin?.setNotificationPrefs?.({ osNotificationsEnabled: enabled });
  }

  function beginRequest() {
    requestRef.current += 1;
    return requestRef.current;
  }

  function isCurrentRequest(requestId: number) {
    return mountedRef.current && requestId === requestRef.current;
  }

  // Navigate to a route, recording history for back / forward. Re-selecting the
  // current route is a no-op (no duplicate history entry).
  function navigateRoute(next: SettingsRoute) {
    setNav((current) => {
      if (routesEqual(current.stack[current.index], next)) return current;
      const stack = [...current.stack.slice(0, current.index + 1), next];
      return { stack, index: stack.length - 1 };
    });
  }

  function navigateCategory(next: SettingsCategory) {
    navigateRoute({ type: 'category', category: next });
  }

  function navigateAgentDetail(agentId: string) {
    navigateRoute({ type: 'agent-detail', agentId });
  }

  function navigateAgentCreate() {
    navigateRoute({ type: 'agent-create' });
  }

  function goBack() {
    setNav((current) => (current.index > 0 ? { ...current, index: current.index - 1 } : current));
  }

  function goForward() {
    setNav((current) =>
      current.index < current.stack.length - 1 ? { ...current, index: current.index + 1 } : current,
    );
  }

  useEffect(() => {
    const requestId = beginRequest();
    setLoading(true);
    setError(null);
    setNotice(null);
    setNav({ stack: [{ type: 'category', category: 'providers' }], index: 0 });
    setCreatingCustom(false);

    void Promise.all([
      api.agentGetProviderSettings(),
      api.agentGetToolPermissionSettings(),
    ])
      .then(([next, nextPermissions]) => {
        if (!isCurrentRequest(requestId)) return;
        setSettings(next);
        setPermissionSettings(nextPermissions);
        setPermissionDraft(nextPermissions);
        setDraft(resolveInitialDraft(next));
      })
      .catch((caught) => {
        if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentRequest(requestId)) setLoading(false);
      });
  }, []);

  // The per-provider config window commits in its own process surface and asks the
  // main process to broadcast a settings-changed; refetch so the list reflects the
  // new connection (active provider, "Connected" grouping) without a manual reopen.
  useEffect(() => {
    const off = window.lin?.onSettingsChanged?.(() => {
      const requestId = beginRequest();
      void api.agentGetProviderSettings()
        .then((next) => {
          if (!isCurrentRequest(requestId)) return;
          setSettings(next);
          setDraft(resolveInitialDraft(next));
        })
        .catch(() => { /* a refetch failure leaves the prior list in place */ });
    });
    return off;
  }, []);

  useEffect(() => {
    if (category === 'skills') {
      const id = beginRequest();
      setLoadingSkills(true);
      setError(null);
      setNotice(null);
      api.agentListAllSkills(conversationId || 'workspace')
        .then((skills) => {
          if (isCurrentRequest(id)) setAllSkills(skills);
        })
        .catch((caught) => {
          if (isCurrentRequest(id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest(id)) setLoadingSkills(false);
        });
    } else if (category === 'memory') {
      const id = beginRequest();
      setLoadingMemory(true);
      setError(null);
      setNotice(null);
      api.agentListMemory({ includeInvalidated: true, limit: 200 })
        .then((entries) => {
          if (isCurrentRequest(id)) setMemoryEntries(entries);
        })
        .catch((caught) => {
          if (isCurrentRequest(id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest(id)) setLoadingMemory(false);
        });
    } else if (category === 'agents') {
      const id = beginRequest();
      setLoadingAgents(true);
      setError(null);
      setNotice(null);
      // The editor's Skills toggle list needs the installed skills, so load both.
      void api.agentListAllSkills(conversationId || 'workspace')
        .then((skills) => { if (isCurrentRequest(id)) setAllSkills(skills); })
        .catch(() => { /* the editor degrades to no skill list */ });
      api.agentListAllDefinitions(conversationId || 'workspace')
        .then((agents) => {
          if (isCurrentRequest(id)) setAllAgents(agents);
        })
        .catch((caught) => {
          if (isCurrentRequest(id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest(id)) setLoadingAgents(false);
        });
    }
  }, [category]);

  const providerCatalog = useMemo(() => {
    const catalog = new Map<string, AgentProviderOption>();
    for (const provider of settings?.availableProviders ?? []) {
      catalog.set(provider.providerId, provider);
    }
    return catalog;
  }, [settings]);

  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draft.providerId, providerCatalog) : [],
    [draft.providerId, providerCatalog, settings],
  );
  // Grouped inset list: "Connected" = has a credential (key or env/managed),
  // "Available" = the rest. macOS System Settings groups this way.
  const connectedChoices = useMemo(
    () => providerChoices.filter((choice) => choice.hasCredential),
    [providerChoices],
  );
  const availableChoices = useMemo(
    () => providerChoices.filter((choice) => !choice.hasCredential),
    [providerChoices],
  );

  const selectedAgent = routeAgent;
  const permissionDiagnostics = permissionDraft?.diagnostics ?? permissionSettings?.diagnostics ?? [];
  const runtimeDraftDirty = settings ? hasRuntimeDraftChanged(draft, settings) : false;
  const permissionDraftDirty = permissionDraft !== permissionSettings;
  const showFooterActions = category === 'permissions'
    ? permissionDraftDirty
    : (category === 'skills' || category === 'agents') && runtimeDraftDirty;

  function permissionDecision(ruleValue: string): 'deny' | 'allow' | 'ask' {
    const permissions = permissionDraft?.permissions;
    if (permissions?.deny.includes(ruleValue)) return 'deny';
    if (permissions?.allow.includes(ruleValue)) return 'allow';
    return 'ask';
  }

  function setPermissionDecision(ruleValue: string, decision: 'allow' | 'ask') {
    setPermissionDraft((current) => {
      const base = current ?? { permissions: { allow: [], ask: [], deny: [] }, diagnostics: [] };
      const allow = removeRule(base.permissions.allow, ruleValue);
      const ask = removeRule(base.permissions.ask, ruleValue);
      const deny = [...base.permissions.deny];
      if (decision === 'allow') allow.push(ruleValue);
      else ask.push(ruleValue);
      return {
        ...base,
        permissions: {
          allow: uniqueStrings(allow),
          ask: uniqueStrings(ask),
          deny: uniqueStrings(deny),
        },
      };
    });
    setNotice(null);
    setError(null);
  }

  // Custom (OpenAI-compatible) providers are configured in the same native window,
  // in 'custom' mode (the window enters the provider id + model itself).
  function startCustomProvider() {
    void window.lin?.openProviderConfig?.({ providerId: '', mode: 'custom' });
  }

  // The footer Save persists ONLY what this pane owns — runtime (permissions /
  // skills / agents) settings. It never creates or edits a provider row: row
  // creation lives solely in the per-provider config window and the OAuth login
  // (provider-config-cleanup A1). Materializing a keyless row here for whatever
  // provider the draft happened to default to was the root of the "Add key" yet
  // "Remove provider" contradiction.
  async function save() {
    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.agentUpdateRuntimeSettings({
        permissionMode: draft.permissionMode,
        automaticSkillsEnabled: draft.automaticSkillsEnabled,
        slashSkillsEnabled: draft.slashSkillsEnabled,
        compactEnabled: draft.compactEnabled,
        additionalSkillDirectories: parseDirectoryListInput(draft.additionalSkillDirectoriesText),
        additionalAgentDirectories: parseDirectoryListInput(draft.additionalAgentDirectoriesText),
        disabledSkills: draft.disabledSkills,
        disabledAgents: draft.disabledAgents,
      });
      const nextPermissions = permissionDraft && permissionDraft !== permissionSettings
        ? await api.agentUpdateToolPermissionSettings(permissionDraft)
        : null;

      const next = await api.agentGetProviderSettings();
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        if (nextPermissions) {
          setPermissionSettings(nextPermissions);
          setPermissionDraft(nextPermissions);
        }
        setDraft(resolveInitialDraft(next));
        setCreatingCustom(false);
        setNotice(t.settings.footer.savedNotice);
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest(requestId)) setSaving(false);
    }
  }

  // Per-row ⋯ actions operate on an explicit providerId (independent of the draft
  // selection); they share one refetch/notice/error envelope.
  async function runProviderMutation(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        setDraft(resetToInitial ? resolveInitialDraft(next) : resolveDraftForProvider(next, draft.providerId));
        if (resetToInitial) setCreatingCustom(false);
        setNotice(successNotice);
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest(requestId)) setSaving(false);
    }
  }

  function activateProvider(providerId: string) {
    void runProviderMutation(() => api.agentSetActiveProvider(providerId), t.settings.providers.setActiveNotice);
  }

  function deleteProviderFor(providerId: string) {
    void runProviderMutation(() => api.agentDeleteProviderConfig(providerId), t.settings.providers.removedNotice, true);
  }

  const runSkillTrustAction = (action: () => Promise<SkillDefinition[]>) => {
    setSkillTrustBusy(true);
    setError(null);
    void action()
      .then((skills) => setAllSkills(skills))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSkillTrustBusy(false));
  };

  const isSkillDisabled = (skillName: string) => draft.disabledSkills.includes(skillName);
  const toggleSkill = (skillName: string) => {
    setDraft((current) => {
      const disabled = current.disabledSkills.includes(skillName)
        ? current.disabledSkills.filter((n) => n !== skillName)
        : [...current.disabledSkills, skillName];
      return { ...current, disabledSkills: disabled };
    });
  };

  const isAgentDisabled = (agentId: string) => draft.disabledAgents.includes(agentId);
  const toggleAgent = (agentId: string) => {
    setDraft((current) => {
      const disabled = current.disabledAgents.includes(agentId)
        ? current.disabledAgents.filter((id) => id !== agentId)
        : [...current.disabledAgents, agentId];
      return { ...current, disabledAgents: disabled };
    });
  };

  // Authoring mutations (user-driven). Each IPC returns the freshly reloaded list
  // (the registry hot-reloads on write), which we set directly; `findCreated`
  // diffs against the prior ids to navigate to a newly created / renamed agent.
  async function runAgentMutation(
    action: () => Promise<AgentDefinitionView[]>,
    successNotice: string,
    onSuccess?: (agents: AgentDefinitionView[], priorIds: Set<string>) => void,
  ) {
    const requestId = beginRequest();
    const priorIds = new Set(allAgents.map((agent) => agent.agentId));
    setAgentBusy(true);
    setError(null);
    setNotice(null);
    try {
      const agents = await action();
      if (isCurrentRequest(requestId)) {
        setAllAgents(agents);
        onSuccess?.(agents, priorIds);
        setNotice(successNotice);
      }
      // Broadcast settings-changed so the main window's chat composer refreshes its
      // subagent picker — a newly authored agent must be pickable (and a deleted one
      // gone) without a restart. Mirrors runProviderMutation.
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest(requestId)) setAgentBusy(false);
    }
  }

  function createAgent(input: AgentAuthoringInput, storage: AgentStorageLocation) {
    void runAgentMutation(
      () => api.agentCreateAgentDefinition(conversationId || 'workspace', input, storage),
      t.settings.agents.createdNotice,
      (agents, priorIds) => {
        const created = agents.find((agent) => !priorIds.has(agent.agentId));
        navigateRoute(created ? { type: 'agent-detail', agentId: created.agentId } : { type: 'category', category: 'agents' });
      },
    );
  }

  function updateAgent(agentId: string, input: AgentAuthoringInput) {
    void runAgentMutation(
      () => api.agentUpdateAgentDefinition(conversationId || 'workspace', agentId, input),
      t.settings.agents.savedAgentNotice,
      (agents, priorIds) => {
        // A rename changes the agentId (it folds in the name); re-point the route
        // to the surviving/new id so the editor stays on the same agent.
        if (!agents.some((agent) => agent.agentId === agentId)) {
          const next = agents.find((agent) => !priorIds.has(agent.agentId));
          navigateRoute(next ? { type: 'agent-detail', agentId: next.agentId } : { type: 'category', category: 'agents' });
        }
      },
    );
  }

  function requestDeleteAgent(agent: AgentDefinitionView) {
    setPendingDeleteAgent(agent);
  }

  function confirmDeleteAgent() {
    const agent = pendingDeleteAgent;
    setPendingDeleteAgent(null);
    if (!agent) return;
    void runAgentMutation(
      () => api.agentDeleteAgentDefinition(conversationId || 'workspace', agent.agentId),
      t.settings.agents.deletedNotice,
      () => navigateRoute({ type: 'category', category: 'agents' }),
    );
  }

  function duplicateAgent(agent: AgentDefinitionView) {
    const newName = `${agent.displayName || agent.name}-copy`;
    void runAgentMutation(
      () => api.agentDuplicateAgentDefinition(conversationId || 'workspace', agent.agentId, newName, 'user'),
      t.settings.agents.duplicatedNotice,
      (agents, priorIds) => {
        const created = agents.find((a) => !priorIds.has(a.agentId));
        if (created) navigateRoute({ type: 'agent-detail', agentId: created.agentId });
      },
    );
  }

  function startEditMemory(entry: AgentMemoryEntryView) {
    if (entry.status !== 'active') return;
    setEditingMemoryId(entry.id);
    setMemoryDraftFact(entry.fact);
    setError(null);
    setNotice(null);
  }

  function cancelEditMemory() {
    setEditingMemoryId(null);
    setMemoryDraftFact('');
  }

  async function saveMemory(entry: AgentMemoryEntryView) {
    const fact = memoryDraftFact.trim();
    if (!fact) {
      setError(t.settings.memory.emptyFactError);
      return;
    }
    setMemorySavingId(entry.id);
    setError(null);
    setNotice(null);
    try {
      const updated = await api.agentUpdateMemory(entry.id, fact);
      if (!updated) {
        setError(t.settings.memory.notFoundError);
      } else {
        setMemoryEntries((current) => current.map((item) => item.id === updated.id ? updated : item));
        setEditingMemoryId(null);
        setMemoryDraftFact('');
        setNotice(t.settings.memory.updatedNotice);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMemorySavingId(null);
    }
  }

  async function forgetMemory(entry: AgentMemoryEntryView) {
    setMemorySavingId(entry.id);
    setError(null);
    setNotice(null);
    try {
      const forgotten = await api.agentForgetMemory(entry.id);
      if (!forgotten) {
        setError(t.settings.memory.notFoundError);
      } else {
        setMemoryEntries((current) => current.map((item) => item.id === forgotten.id ? forgotten : item));
        if (editingMemoryId === entry.id) cancelEditMemory();
        setNotice(t.settings.memory.forgottenNotice);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMemorySavingId(null);
    }
  }

  // Open the per-provider config in its OWN native window (a modal child of
  // settings — the macOS idiom), not an in-renderer overlay. Clicking a row or
  // "Configure…" asks the main process to open it; the window commits via IPC and
  // broadcasts a settings-changed, which refetches the list (see the effect below).
  function openProviderConfig(providerId: string) {
    void window.lin?.openProviderConfig?.({ providerId, mode: 'configure' });
  }

  // Stable per-row handlers via a latest-ref so the memoized provider rows keep a
  // constant identity and never re-render while another row's menu toggles. The ref
  // always points at the freshest closures (no stale reads).
  const rowHandlersImpl = { openProviderConfig, activateProvider, deleteProviderFor, setOpenRowMenu };
  const rowHandlersRef = useRef(rowHandlersImpl);
  rowHandlersRef.current = rowHandlersImpl;
  const rowHandlers = useMemo<ProviderRowHandlers>(() => ({
    onConfigure: (id) => rowHandlersRef.current.openProviderConfig(id),
    onActivate: (id) => rowHandlersRef.current.activateProvider(id),
    onRemove: (id) => rowHandlersRef.current.deleteProviderFor(id),
    onMenuOpenChange: (id, open) => rowHandlersRef.current.setOpenRowMenu(open ? id : null),
  }), []);

  const renderProviderRow = (provider: ProviderChoice) => (
    <SettingsProviderRow
      handlers={rowHandlers}
      key={provider.providerId}
      menuOpen={openRowMenu === provider.providerId}
      provider={provider}
    />
  );

  return (
    <main className="settings-window" aria-labelledby="settings-page-title">
      {/* Frameless window: this top strip is the drag region that stands in for the
          native title bar. The OS traffic lights overlay it; the rail title/nav and
          content controls all sit below --chrome-height, so none overlaps it. The
          back / forward arrows are no-drag DOM CHILDREN of the strip — the only
          reliable carve-out from a drag region on macOS — anchored over the content
          column, on the traffic-light centreline, like System Settings' toolbar. */}
      <div className="settings-drag-region">
        <div className="settings-toolbar">
          <div className="settings-history-nav">
            {/* The same chrome control as the main window's rail toggles
                (IconButton variant="chrome" + .rail-toggle): icon-only, colour
                deepens on hover. The Settings-only wrapper supplies the neutral
                capsule group, so individual arrows do not get bespoke boxes. */}
            <IconButton
              className="rail-toggle"
              disabled={!canGoBack}
              icon={ChevronLeftIcon}
              iconSize={ICON_SIZE.toolbar}
              label={t.settings.navigation.back}
              onClick={goBack}
              strokeWidth={1.7}
              variant="chrome"
            />
            <span className="settings-history-divider" aria-hidden="true" />
            <IconButton
              className="rail-toggle"
              disabled={!canGoForward}
              icon={ChevronRightIcon}
              iconSize={ICON_SIZE.toolbar}
              label={t.settings.navigation.forward}
              onClick={goForward}
              strokeWidth={1.7}
              variant="chrome"
            />
          </div>
          <h1 className="settings-toolbar-title" id="settings-page-title">{categoryLabel}</h1>
        </div>
      </div>
      {loading ? (
        <div className="agent-settings-empty">{t.settings.loading}</div>
      ) : (
        <div className="settings-layout">
          <aside className="settings-rail">
            <h2 className="settings-rail-title">{t.settings.railTitle}</h2>
            <nav className="settings-nav" aria-label={t.settings.categoriesAriaLabel}>
              {SETTINGS_CATEGORY_IDS.map((id) => {
                const cat = t.settings.categories[id];
                const CategoryIcon = SETTINGS_CATEGORY_ICONS[id];
                return (
                  <button
                    aria-current={category === id ? 'page' : undefined}
                    className={`settings-nav-item ${category === id ? 'is-active' : ''}`}
                    key={id}
                    onClick={() => navigateCategory(id)}
                    type="button"
                  >
                    <span className="settings-nav-icon" aria-hidden="true">
                      <CategoryIcon size={ICON_SIZE.menu} strokeWidth={1.75} />
                    </span>
                    <span className="settings-nav-copy">
                      <span className="settings-nav-label">{cat.label}</span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="settings-content">
            {category === 'general' ? (
              <section className="agent-settings-section settings-general-section" aria-label={t.settings.categories.general.label}>
                <InsetGroup ariaLabel={t.settings.general.appearanceGroup} label={t.settings.general.appearanceGroup}>
                  <InsetRow
                    label={t.settings.general.themeLabel}
                    sublabel={t.settings.general.themeSublabel}
                    trailing={(
                      <SegmentedControl
                        label={t.settings.general.themeLabel}
                        onChange={changeTheme}
                        options={themeOptions}
                        value={themeMode}
                      />
                    )}
                    wrap
                  />
                  <InsetRow
                    label={t.settings.general.languageLabel}
                    sublabel={t.settings.general.languageSublabel}
                    trailing={(
                      <SelectControl
                        label={t.settings.general.languageLabel}
                        onChange={(event) => setLocale(event.target.value as Locale)}
                        value={locale}
                        variant="popup"
                      >
                        {SUPPORTED_LOCALES.map((entry) => (
                          <option key={entry.code} value={entry.code}>{entry.nativeName}</option>
                        ))}
                      </SelectControl>
                    )}
                    wrap
                  />
                </InsetGroup>
                <InsetGroup
                  ariaLabel={t.settings.general.notificationsGroup}
                  label={t.settings.general.notificationsGroup}
                >
                  <InsetRow
                    label={t.settings.general.osNotificationsLabel}
                    sublabel={t.settings.general.osNotificationsSublabel}
                    trailing={(
                      <SwitchControl
                        checked={osNotificationsEnabled}
                        onCheckedChange={changeOsNotifications}
                        label={t.settings.general.osNotificationsLabel}
                      >
                        <SwitchMark checked={osNotificationsEnabled} />
                      </SwitchControl>
                    )}
                    wrap
                  />
                </InsetGroup>
              </section>
            ) : category === 'providers' ? (
              <section className="agent-settings-section settings-providers-section" aria-label={t.settings.categories.providers.label}>
                {/* Providers is the reference pane: flat base + grouped inset cards.
                    The other panes were migrated onto this idiom. */}
                {/* No "Providers" title — the selected rail category already names
                    the pane. Custom providers are added from the last row of the
                    Available list (no separate floating add control). */}
                <div className="settings-provider-groups">
                  {connectedChoices.length > 0 ? (
                    <InsetGroup ariaLabel={t.settings.providers.connectedAriaLabel} label={t.settings.providers.connectedGroup}>
                      {connectedChoices.map(renderProviderRow)}
                    </InsetGroup>
                  ) : null}
                  <InsetGroup ariaLabel={t.settings.providers.availableAriaLabel} label={t.settings.providers.availableGroup}>
                    {availableChoices.map(renderProviderRow)}
                    <InsetRow
                      ariaLabel={t.settings.providers.addCustom}
                      label={t.settings.providers.addCustom}
                      leading={(
                        <span className="settings-provider-add-leading" aria-hidden="true">
                          <AddIcon size={ICON_SIZE.menu} />
                        </span>
                      )}
                      onSelect={startCustomProvider}
                    />
                  </InsetGroup>
                </div>
              </section>
            ) : category === 'permissions' ? (
              <section className="agent-settings-section settings-permissions-section" aria-label={t.settings.permissions.sectionAriaLabel}>
                <InsetGroup ariaLabel={t.settings.permissions.commonActionsAriaLabel} label={t.settings.permissions.commonActionsGroup}>
                  {COMMON_PERMISSION_RULES.map((rule) => {
                    const decision = permissionDecision(rule.ruleValue);
                    const denied = decision === 'deny';
                    const ruleCopy = t.settings.permissions.rules[rule.id];
                    return (
                      <InsetRow
                        disabled={denied}
                        key={rule.ruleValue}
                        label={ruleCopy.label}
                        sublabel={ruleCopy.description}
                        trailing={(
                          <SelectControl
                            disabled={denied}
                            label={t.settings.permissions.decisionAriaLabel({ rule: ruleCopy.label })}
                            onChange={(event) => setPermissionDecision(rule.ruleValue, event.target.value as 'allow' | 'ask')}
                            value={denied ? 'deny' : decision}
                            variant="popup"
                          >
                            <option value="ask">{t.settings.permissions.askOption}</option>
                            {rule.allowable ? <option value="allow">{t.settings.permissions.allowOption}</option> : null}
                            {denied ? <option value="deny">{t.settings.permissions.deniedOption}</option> : null}
                          </SelectControl>
                        )}
                        wrap
                      />
                    );
                  })}
                </InsetGroup>

                {permissionDiagnostics.length > 0 ? (
                  <InsetGroup ariaLabel={t.settings.permissions.ignoredRulesAriaLabel} label={t.settings.permissions.ignoredRulesGroup}>
                    {permissionDiagnostics.map((diagnostic) => (
                      <InsetRow
                        disabled
                        key={`${diagnostic.decision}:${diagnostic.ruleValue}:${diagnostic.code}`}
                        label={(
                          <>
                            {diagnostic.ruleValue}
                            <span className="settings-chip">{diagnostic.code}</span>
                          </>
                        )}
                        sublabel={diagnostic.message}
                        wrap
                      />
                    ))}
                  </InsetGroup>
                ) : null}
              </section>
            ) : category === 'memory' ? (
              <section className="agent-settings-section settings-memory-section" aria-label={t.settings.memory.sectionAriaLabel}>
                {loadingMemory ? (
                  <div className="agent-settings-empty">{t.settings.memory.loading}</div>
                ) : memoryEntries.length === 0 ? (
                  <div className="agent-settings-empty">{t.settings.memory.empty}</div>
                ) : (
                  <InsetGroup ariaLabel={t.settings.memory.entriesAriaLabel} label={t.settings.memory.entriesGroup}>
                    {memoryEntries.map((entry) => {
                      const isEditing = editingMemoryId === entry.id;
                      const isSavingMemory = memorySavingId === entry.id;
                      const disabled = entry.status !== 'active';
                      return (
                        <InsetRow
                          disabled={disabled}
                          key={entry.id}
                          label={isEditing ? (
                            <textarea
                              aria-label={t.settings.memory.editFactLabel}
                              className="settings-memory-editor"
                              onChange={(event) => setMemoryDraftFact(event.target.value)}
                              rows={3}
                              value={memoryDraftFact}
                            />
                          ) : (
                            <span className="settings-memory-fact">{entry.fact}</span>
                          )}
                          sublabel={(
                            <span className="settings-memory-meta">
                              <span className="settings-chip">{memoryPoolLabel(entry, t)}</span>
                              <span className="settings-chip">{memoryStatusLabel(entry, t)}</span>
                              <span>{t.settings.memory.createdAt({ date: formatSettingsDate(entry.createdAt) })}</span>
                            </span>
                          )}
                          trailing={disabled ? undefined : isEditing ? (
                            <span className="settings-memory-actions">
                              <IconButton
                                disabled={isSavingMemory}
                                icon={CheckIcon}
                                iconSize={ICON_SIZE.menu}
                                label={t.settings.memory.saveEdit}
                                onClick={() => void saveMemory(entry)}
                                variant="panel"
                              />
                              <IconButton
                                disabled={isSavingMemory}
                                icon={CloseIcon}
                                iconSize={ICON_SIZE.menu}
                                label={t.settings.memory.cancelEdit}
                                onClick={cancelEditMemory}
                                variant="panel"
                              />
                            </span>
                          ) : (
                            <span className="settings-memory-actions">
                              <IconButton
                                disabled={isSavingMemory}
                                icon={PencilIcon}
                                iconSize={ICON_SIZE.menu}
                                label={t.settings.memory.editEntry}
                                onClick={() => startEditMemory(entry)}
                                variant="panel"
                              />
                              <IconButton
                                disabled={isSavingMemory}
                                icon={TrashIcon}
                                iconSize={ICON_SIZE.menu}
                                label={t.settings.memory.forgetEntry}
                                onClick={() => void forgetMemory(entry)}
                                variant="panel"
                              />
                            </span>
                          )}
                          wrap
                        />
                      );
                    })}
                  </InsetGroup>
                )}
              </section>
            ) : category === 'skills' ? (
              <section className="agent-settings-section settings-skills-section" aria-label={t.settings.skills.sectionAriaLabel}>
                <InsetGroup ariaLabel={t.settings.skills.behaviorRulesAriaLabel} label={t.settings.skills.behaviorRulesGroup}>
                  <InsetRow
                    label={t.settings.skills.automaticSkillsLabel}
                    sublabel={t.settings.skills.automaticSkillsSublabel}
                    trailing={(
                      <SwitchControl
                        checked={draft.automaticSkillsEnabled}
                        onCheckedChange={(automaticSkillsEnabled) => setDraft((current) => ({ ...current, automaticSkillsEnabled }))}
                        label={t.settings.skills.automaticSkillsLabel}
                      >
                        <SwitchMark checked={draft.automaticSkillsEnabled} />
                      </SwitchControl>
                    )}
                    wrap
                  />
                  <InsetRow
                    label={t.settings.skills.slashSkillsLabel}
                    sublabel={t.settings.skills.slashSkillsSublabel}
                    trailing={(
                      <SwitchControl
                        checked={draft.slashSkillsEnabled}
                        onCheckedChange={(slashSkillsEnabled) => setDraft((current) => ({ ...current, slashSkillsEnabled }))}
                        label={t.settings.skills.slashSkillsLabel}
                      >
                        <SwitchMark checked={draft.slashSkillsEnabled} />
                      </SwitchControl>
                    )}
                    wrap
                  />
                  <InsetRow
                    label={t.settings.skills.compactLabel}
                    sublabel={t.settings.skills.compactSublabel}
                    trailing={(
                      <SwitchControl
                        checked={draft.compactEnabled}
                        onCheckedChange={(compactEnabled) => setDraft((current) => ({ ...current, compactEnabled }))}
                        label={t.settings.skills.compactLabel}
                      >
                        <SwitchMark checked={draft.compactEnabled} />
                      </SwitchControl>
                    )}
                    wrap
                  />
                </InsetGroup>

                {loadingSkills ? (
                  <div className="agent-settings-empty">{t.settings.skills.loadingInstalled}</div>
                ) : allSkills.length === 0 ? (
                  <div className="agent-settings-empty">{t.settings.skills.noneInstalled}</div>
                ) : (
                  <InsetGroup ariaLabel={t.settings.skills.installedAriaLabel} label={t.settings.skills.installedGroup}>
                    {allSkills.map((skill) => {
                      const disabled = isSkillDisabled(skill.name);
                      // Trust state is derived in main: unratified rows are excluded
                      // from automatic model use until the user accepts these bytes.
                      const pending = !skill.ratified;
                      const trustActions: RowMenuAction[] = [];
                      if (skill.accepted) {
                        trustActions.push({
                          label: t.settings.skills.revokeAcceptance,
                          disabled: skillTrustBusy,
                          onSelect: () => runSkillTrustAction(() => api.agentRevokeSkillAcceptance(conversationId || 'workspace', skill.name)),
                        });
                      }
                      if (skill.canUndoLastAgentEdit) {
                        trustActions.push({
                          label: t.settings.skills.undoAgentEdit,
                          disabled: skillTrustBusy,
                          onSelect: () => runSkillTrustAction(() => api.agentUndoSkillAgentEdit(conversationId || 'workspace', skill.name)),
                        });
                      }
                      return (
                        <InsetRow
                          disabled={disabled}
                          key={skill.name}
                          label={(
                            <>
                              /{skill.displayName || skill.name}
                              <span className="settings-chip">{skill.source}</span>
                              {pending ? (
                                <span className="settings-chip">
                                  {skill.source === 'project'
                                    ? t.settings.skills.pendingWorkspaceChip
                                    : t.settings.skills.pendingChip}
                                </span>
                              ) : skill.accepted ? (
                                <span className="settings-chip">{t.settings.skills.acceptedChip}</span>
                              ) : null}
                            </>
                          )}
                          sublabel={skill.description}
                          trailing={(
                            <>
                              {pending ? (
                                <button
                                  aria-label={t.settings.skills.acceptSkill({ name: skill.name })}
                                  className="settings-row-button settings-skill-accept"
                                  disabled={skillTrustBusy}
                                  onClick={() => runSkillTrustAction(() => api.agentAcceptSkill(conversationId || 'workspace', skill.name, skill.contentHash ?? ''))}
                                  type="button"
                                >
                                  {t.settings.skills.acceptButton}
                                </button>
                              ) : null}
                              {trustActions.length > 0 ? (
                                <SettingsRowMenu
                                  actions={trustActions}
                                  ariaLabel={t.settings.skills.rowActionsAriaLabel({ name: skill.name })}
                                  onOpenChange={(open) => setOpenRowMenu(open ? `skill:${skill.name}` : null)}
                                  open={openRowMenu === `skill:${skill.name}`}
                                />
                              ) : null}
                              <SwitchControl
                                checked={!disabled}
                                onCheckedChange={() => toggleSkill(skill.name)}
                                label={t.settings.skills.toggleSkill({ name: skill.name })}
                              >
                                <SwitchMark checked={!disabled} />
                              </SwitchControl>
                            </>
                          )}
                          wrap
                        />
                      );
                    })}
                  </InsetGroup>
                )}
              </section>
            ) : route.type === 'agent-detail' ? (
              <section className="agent-settings-section settings-agents-section" aria-label={t.settings.agents.detailAriaLabel({ name: routeAgent?.name ?? '' })}>
                {loadingAgents ? (
                  <div className="agent-settings-empty">{t.settings.agents.loadingProfiles}</div>
                ) : selectedAgent ? (
                  <>
                    <InsetGroup ariaLabel={t.settings.agents.detailOptionsAriaLabel({ name: selectedAgent.name })}>
                      <InsetRow
                        label={t.settings.agents.enabledLabel}
                        sublabel={t.settings.agents.enabledSublabel}
                        trailing={(
                          <SwitchControl
                            checked={!isAgentDisabled(selectedAgent.agentId)}
                            onCheckedChange={() => toggleAgent(selectedAgent.agentId)}
                            label={t.settings.agents.toggleAgent({ name: selectedAgent.name })}
                          >
                            <SwitchMark checked={!isAgentDisabled(selectedAgent.agentId)} />
                          </SwitchControl>
                        )}
                        wrap
                      />
                    </InsetGroup>

                    <AgentEditor
                      key={selectedAgent.agentId}
                      agent={selectedAgent}
                      availableSkills={allSkills}
                      busy={agentBusy}
                      onCreate={createAgent}
                      onUpdate={updateAgent}
                      onDelete={requestDeleteAgent}
                      onDuplicate={duplicateAgent}
                    />
                  </>
                ) : (
                  <div className="agent-settings-empty">{t.settings.agents.profileNotFound}</div>
                )}
              </section>
            ) : route.type === 'agent-create' ? (
              <section className="agent-settings-section settings-agents-section" aria-label={t.settings.agents.createTitle}>
                <AgentEditor
                  key="agent-create-new"
                  agent={null}
                  availableSkills={allSkills}
                  busy={agentBusy}
                  onCreate={createAgent}
                  onUpdate={updateAgent}
                  onDelete={requestDeleteAgent}
                  onDuplicate={duplicateAgent}
                />
              </section>
            ) : (
              <section className="agent-settings-section settings-agents-section" aria-label={t.settings.agents.sectionAriaLabel}>
                {loadingAgents ? (
                  <div className="agent-settings-empty">{t.settings.agents.loadingProfiles}</div>
                ) : (
                  <>
                    <InsetGroup ariaLabel={t.settings.agents.profilesAriaLabel}>
                      <InsetRow
                        ariaLabel={t.settings.agents.newAgent}
                        leading={<AddIcon size={ICON_SIZE.rowGlyph} aria-hidden />}
                        label={t.settings.agents.newAgent}
                        onSelect={navigateAgentCreate}
                        trailing={<ChevronRightIcon className="settings-drilldown-chevron" size={ICON_SIZE.rowGlyph} aria-hidden />}
                      />
                      {allAgents.map((agent) => (
                        <InsetRow
                          ariaLabel={agent.name}
                          dimmed={isAgentDisabled(agent.agentId)}
                          key={agent.agentId}
                          label={(
                            <>
                              {agent.displayName || agent.name}
                              <span className="settings-chip">{agent.source}</span>
                            </>
                          )}
                          onSelect={() => navigateAgentDetail(agent.agentId)}
                          sublabel={agent.description}
                          trailing={<ChevronRightIcon className="settings-drilldown-chevron" size={ICON_SIZE.rowGlyph} aria-hidden />}
                        />
                      ))}
                    </InsetGroup>

                    <div className="inset-group">
                      <div className="inset-group-header">{t.settings.agents.directoriesGroup}</div>
                      <div className="inset-card" role="group">
                        <label className="settings-sheet-row settings-sheet-row-stack">
                          <span className="settings-sheet-row-label">{t.settings.agents.directoriesLabel}</span>
                          <TextInputControl
                            className="settings-sheet-row-input"
                            label={t.settings.agents.directoriesLabel}
                            onChange={(event) => setDraft((current) => ({ ...current, additionalAgentDirectoriesText: event.target.value }))}
                            placeholder={t.settings.agents.directoriesPlaceholder}
                            value={draft.additionalAgentDirectoriesText}
                          />
                        </label>
                      </div>
                      <p className="inset-group-footnote">{t.settings.agents.directoriesSublabel}</p>
                    </div>
                  </>
                )}
              </section>
            )}

            {error ? (
              <div className="agent-settings-alert" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? <div className="agent-settings-notice">{notice}</div> : null}

            {/* Providers commit per-provider through their own sheet (Cancel/Save)
                and the General pane applies instantly (no draft), like native
                Settings — so the global footer is only for the runtime/permission
                categories that batch a draft into one Save. */}
            {showFooterActions ? (
              <footer className="agent-settings-footer">
                <span />
                <div className="agent-settings-footer-actions">
                  <ButtonControl className="agent-settings-secondary" onClick={onClose}>
                    {t.settings.footer.cancel}
                  </ButtonControl>
                  <ButtonControl className="agent-settings-primary" disabled={saving} onClick={save}>
                    {saving ? t.settings.footer.saving : t.settings.footer.save}
                  </ButtonControl>
                </div>
              </footer>
            ) : null}
          </div>
        </div>
      )}
      {pendingDeleteAgent ? (
        <ConfirmDialog
          danger
          title={t.settings.agents.deleteAgent}
          message={t.settings.agents.deleteConfirm({ name: pendingDeleteAgent.displayName || pendingDeleteAgent.name })}
          confirmLabel={t.settings.agents.deleteAgent}
          onCancel={() => setPendingDeleteAgent(null)}
          onConfirm={confirmDeleteAgent}
        />
      ) : null}
    </main>
  );
}

function resolveInitialDraft(settings: AgentProviderSettingsView): DraftConfig {
  const active = resolveUsableActiveProvider(settings);
  const existing = active ?? settings.providers[0];
  if (existing) return providerToDraft(existing, settings);

  const preferredCatalog = PREFERRED_PROVIDER_ORDER
    .map((providerId) => settings.availableProviders.find((provider) => provider.providerId === providerId))
    .find(Boolean) ?? settings.availableProviders[0];
  return {
    providerId: preferredCatalog?.providerId ?? 'anthropic',
    modelId: preferredCatalog?.models[0]?.id ?? '',
    reasoningLevel: defaultReasoningLevel(preferredCatalog?.models[0]),
    baseUrl: '',
    enabled: true,
    disabledSkills: settings.agent.disabledSkills ?? [],
    disabledAgents: settings.agent.disabledAgents ?? [],
    ...runtimeSettingsToDraft(settings),
  };
}

function resolveDraftForProvider(settings: AgentProviderSettingsView, providerId: string): DraftConfig {
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  if (existing) return providerToDraft(existing, settings);
  return resolveInitialDraft(settings);
}

function buildProviderChoices(
  settings: AgentProviderSettingsView,
  draftProviderId: string,
  catalog: Map<string, AgentProviderOption>,
): ProviderChoice[] {
  const activeProviderId = resolveUsableActiveProvider(settings)?.providerId ?? '';
  const choices = new Map<string, ProviderChoice>();

  for (const provider of settings.providers) {
    const providerCatalog = catalog.get(provider.providerId);
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      configured: true,
      active: provider.providerId === activeProviderId,
      enabled: provider.enabled,
      hasCredential: providerHasCredential(provider, providerCatalog),
    });
  }

  for (const provider of settings.availableProviders) {
    if (choices.has(provider.providerId)) continue;
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      configured: false,
      active: provider.providerId === activeProviderId,
      enabled: true,
      hasCredential: Boolean(provider.hasEnvApiKey),
    });
  }

  if (draftProviderId && !choices.has(draftProviderId)) {
    choices.set(draftProviderId, {
      providerId: draftProviderId,
      configured: false,
      active: draftProviderId === activeProviderId,
      enabled: true,
      hasCredential: Boolean(catalog.get(draftProviderId)?.hasEnvApiKey),
    });
  }

  return [...choices.values()].sort(compareProviderChoices);
}

function compareProviderChoices(left: ProviderChoice, right: ProviderChoice): number {
  const leftReady = left.enabled && left.hasCredential;
  const rightReady = right.enabled && right.hasCredential;
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (leftReady !== rightReady) return leftReady ? -1 : 1;
  if (left.configured !== right.configured) return left.configured ? -1 : 1;
  const leftPreferred = preferredProviderIndex(left.providerId);
  const rightPreferred = preferredProviderIndex(right.providerId);
  if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
  return formatProviderName(left.providerId).localeCompare(formatProviderName(right.providerId), undefined, {
    sensitivity: 'base',
  });
}

// Module-level helper (can't call useT) — the component passes `t` in.
function providerStatusLabel(provider: ProviderChoice, t: Messages): string {
  const s = t.settings.providers.status;
  if (!provider.configured) return provider.hasCredential ? s.ready : s.addKey;
  if (!provider.enabled) return s.disabled;
  if (!provider.hasCredential) return s.needsKey;
  return provider.active ? s.active : s.ready;
}

function memoryStatusLabel(entry: AgentMemoryEntryView, t: Messages): string {
  return entry.status === 'active' ? t.settings.memory.activeStatus : t.settings.memory.invalidatedStatus;
}

// The list unions two pools (the assistant's self-model and the user's profile); label which pool
// each fact belongs to so an edited fact's subject is unambiguous.
function memoryPoolLabel(entry: AgentMemoryEntryView, t: Messages): string {
  return entry.principal.type === 'user' ? t.settings.memory.poolUserLabel : t.settings.memory.poolAgentLabel;
}

function formatSettingsDate(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function preferredProviderIndex(providerId: string): number {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(providerId);
  return index >= 0 ? index : PREFERRED_PROVIDER_ORDER.length;
}

function providerToDraft(provider: AgentProviderConfigView, settings: AgentProviderSettingsView): DraftConfig {
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    reasoningLevel: provider.reasoningLevel,
    baseUrl: provider.baseUrl ?? '',
    enabled: provider.enabled,
    disabledSkills: settings.agent.disabledSkills ?? [],
    disabledAgents: settings.agent.disabledAgents ?? [],
    ...runtimeSettingsToDraft(settings),
  };
}

function runtimeSettingsToDraft(settings: AgentProviderSettingsView): Pick<
  DraftConfig,
  'permissionMode' | 'automaticSkillsEnabled' | 'slashSkillsEnabled' | 'compactEnabled' | 'additionalSkillDirectoriesText' | 'additionalAgentDirectoriesText'
> {
  return {
    permissionMode: settings.agent.permissionMode,
    automaticSkillsEnabled: settings.agent.automaticSkillsEnabled,
    slashSkillsEnabled: settings.agent.slashSkillsEnabled,
    compactEnabled: settings.agent.compactEnabled,
    additionalSkillDirectoriesText: settings.agent.additionalSkillDirectories.join(', '),
    additionalAgentDirectoriesText: settings.agent.additionalAgentDirectories.join(', '),
  };
}

function hasRuntimeDraftChanged(draft: DraftConfig, settings: AgentProviderSettingsView): boolean {
  const runtime = runtimeSettingsToDraft(settings);
  return draft.permissionMode !== runtime.permissionMode
    || draft.automaticSkillsEnabled !== runtime.automaticSkillsEnabled
    || draft.slashSkillsEnabled !== runtime.slashSkillsEnabled
    || draft.compactEnabled !== runtime.compactEnabled
    || draft.additionalSkillDirectoriesText !== runtime.additionalSkillDirectoriesText
    || draft.additionalAgentDirectoriesText !== runtime.additionalAgentDirectoriesText
    || !sameStringSet(draft.disabledSkills, settings.agent.disabledSkills ?? [])
    || !sameStringSet(draft.disabledAgents, settings.agent.disabledAgents ?? []);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function parseDirectoryListInput(value: string): string[] {
  return [...new Set(value
    .split(/[,\n]/g)
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, 20);
}

function removeRule(rules: readonly string[], ruleValue: string): string[] {
  return rules.filter((rule) => rule !== ruleValue);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
