import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AppIcon } from '../icons';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentSafetyMode,
  AgentDefinitionView,
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
  LoaderIcon,
  PasswordIcon,
  PencilIcon,
  SettingsIcon,
  SkillIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';
import type { ThemeMode } from '../../../core/theme';
import { SUPPORTED_LOCALES, type Locale } from '../../../core/locale';
import type { SettingsCategoryTarget, SettingsOpenTarget } from '../../../core/settingsWindow';
import {
  effectiveActionDecision,
  explicitActionDecision,
  safetyModeDefaultActionDecision,
  type GlobalToolPermissionDecision,
} from '../../../core/agentPermissionModel';
import { useI18n, useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { Button } from '../primitives/Button';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
import { Input } from '../primitives/Input';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import {
  ProviderAvatar,
  formatProviderName,
  providerHasCredential,
  resolveUsableActiveProvider,
} from './providerCatalog';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import { defaultReasoningLevel } from './settingsReasoning';
import {
  COMMON_PERMISSION_RULES,
  buildPermissionExceptionRows,
  permissionDecisionLabel,
  permissionRuleCopy,
  permissionSettingsWithDecision,
  permissionSettingsWithoutRule,
  safetyModeLabel,
} from './permissionSettingsModel';

interface AgentSettingsViewProps {
  onClose: () => void;
  onApplied: () => Promise<void>;
  conversationId?: string;
  initialTarget?: SettingsOpenTarget;
}

type SettingsCategory = SettingsCategoryTarget;
type SettingsRoute = { type: 'category'; category: SettingsCategory };
type RequestScope = 'settings' | 'section' | 'mutation';

interface DraftConfig {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl: string;
  enabled: boolean;
  safetyMode: AgentSafetyMode;
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
        <Button
          aria-label={t.settings.providers.configureNamed({ name })}
          className="settings-provider-configure"
          onClick={() => handlers.onConfigure(provider.providerId)}
          size="sm"
          variant="secondary"
        >
          {t.settings.providers.configure}
        </Button>
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
  safetyMode: 'balanced',
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
  skills: SkillIcon,
  agents: AgentIcon,
} satisfies Record<SettingsCategory, AppIcon>;

const PREFERRED_PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter'];
const EMPTY_PERMISSION_RULES: AgentToolPermissionSettingsView['permissions'] = { allow: [], ask: [], deny: [] };

function routeFromOpenTarget(target: SettingsOpenTarget | undefined): SettingsRoute {
  if (target?.agentCreate || target?.agentId?.trim()) return { type: 'category', category: 'agents' };
  if (target?.category) return { type: 'category', category: target.category };
  return { type: 'category', category: 'providers' };
}

function navFromOpenTarget(target: SettingsOpenTarget | undefined): { stack: SettingsRoute[]; index: number } {
  return { stack: [routeFromOpenTarget(target)], index: 0 };
}

function routeCategory(route: SettingsRoute): SettingsCategory {
  return route.category;
}

function routesEqual(left: SettingsRoute, right: SettingsRoute): boolean {
  return left.category === right.category;
}

export function AgentSettingsView({ onApplied, onClose, conversationId, initialTarget }: AgentSettingsViewProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<AgentToolPermissionSettingsView | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<AgentToolPermissionSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  // Route navigation history, so the window can offer macOS System Settings'
  // back / forward (‹ ›) chrome. Top-level categories and drill-down pages share
  // the same stack; Agent Profiles details are a child route, not flat content on
  // the category page.
  const [nav, setNav] = useState<{ stack: SettingsRoute[]; index: number }>({
    stack: [routeFromOpenTarget(initialTarget)],
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
  const settingsRequestRef = useRef(0);
  const sectionRequestRef = useRef(0);
  const mutationRequestRef = useRef(0);

  const [allSkills, setAllSkills] = useState<SkillDefinition[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Skill trust actions (accept / revoke / undo) round-trip through main and return
  // the refreshed skill list; one shared busy flag keeps the row controls quiet
  // while a mutation is in flight.
  const [skillTrustBusy, setSkillTrustBusy] = useState(false);
  const [allAgents, setAllAgents] = useState<AgentDefinitionView[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
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
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<null | 'reveal' | 'export'>(null);
  // Display language: the picker reads/writes the shared i18n context (seeded before
  // first paint, broadcast across windows), so it applies instantly like the theme.
  const { locale, t, setLocale } = useI18n();
  const categoryLabel = t.settings.categories[category].label;
  const themeOptions = useMemo(() => {
    const g = t.settings.general;
    const labels: Record<ThemeMode, string> = { system: g.themeSystem, light: g.themeLight, dark: g.themeDark };
    return THEME_VALUES.map((value) => ({ value, label: labels[value] }));
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settingsRequestRef.current += 1;
      sectionRequestRef.current += 1;
      mutationRequestRef.current += 1;
    };
  }, []);

  useEffect(() => window.lin?.onSettingsNavigate?.((target) => {
    setNav(navFromOpenTarget(target));
    setCreatingCustom(false);
    setOpenRowMenu(null);
    setError(null);
    setNotice(null);
    openAgentTarget(target);
  }), []);

  useEffect(() => {
    openAgentTarget(initialTarget);
  }, [initialTarget]);

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

  async function revealDiagnosticsLog() {
    setDiagnosticsBusy('reveal');
    setError(null);
    setNotice(null);
    try {
      const result = await window.lin?.revealDiagnosticsLog?.();
      if (!result) {
        setError(t.settings.general.diagnosticsUnavailable);
      } else if (!result.ok) {
        setError(result.error ?? t.settings.general.diagnosticsRevealFailed);
      } else {
        setNotice(t.settings.general.diagnosticsRevealedNotice);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function exportDiagnostics() {
    setDiagnosticsBusy('export');
    setError(null);
    setNotice(null);
    try {
      const result = await window.lin?.exportDiagnostics?.();
      if (!result) {
        setError(t.settings.general.diagnosticsUnavailable);
      } else if (result.canceled) {
        return;
      } else if (!result.ok) {
        setError(result.error ?? t.settings.general.diagnosticsExportFailed);
      } else {
        setNotice(t.settings.general.diagnosticsExportedNotice);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  function requestRefFor(scope: RequestScope) {
    if (scope === 'settings') return settingsRequestRef;
    if (scope === 'section') return sectionRequestRef;
    return mutationRequestRef;
  }

  function beginRequest(scope: RequestScope) {
    const ref = requestRefFor(scope);
    ref.current += 1;
    return ref.current;
  }

  function isCurrentRequest(scope: RequestScope, requestId: number) {
    return mountedRef.current && requestId === requestRefFor(scope).current;
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

  function openAgentConfig(agentId: string) {
    void window.lin?.openAgentConfig?.({ agentId, mode: 'configure' });
  }

  function openAgentCreate() {
    void window.lin?.openAgentConfig?.({ mode: 'create' });
  }

  function openAgentTarget(target: SettingsOpenTarget | undefined) {
    if (target?.agentCreate) {
      openAgentCreate();
      return;
    }
    const agentId = target?.agentId?.trim();
    if (agentId) openAgentConfig(agentId);
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
    const requestId = beginRequest('settings');
    setLoading(true);
    setError(null);
    setNotice(null);
    setNav(navFromOpenTarget(initialTarget));
    setCreatingCustom(false);

    void Promise.all([
      api.agentGetProviderSettings(),
      api.agentGetToolPermissionSettings(),
    ])
      .then(([next, nextPermissions]) => {
        if (!isCurrentRequest('settings', requestId)) return;
        setSettings(next);
        setPermissionSettings(nextPermissions);
        setPermissionDraft(nextPermissions);
        setDraft(resolveInitialDraft(next));
      })
      .catch((caught) => {
        if (isCurrentRequest('settings', requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentRequest('settings', requestId)) setLoading(false);
      });
  }, []);

  // The per-provider config window commits in its own process surface and asks the
  // main process to broadcast a settings-changed; refetch so the list reflects the
  // new connection (active provider, "Connected" grouping) without a manual reopen.
  useEffect(() => {
    const off = window.lin?.onSettingsChanged?.(() => {
      const requestId = beginRequest('settings');
      void api.agentGetProviderSettings()
        .then((next) => {
          if (!isCurrentRequest('settings', requestId)) return;
          setSettings(next);
          setDraft(resolveInitialDraft(next));
        })
        .catch(() => { /* a refetch failure leaves the prior list in place */ });
    });
    return off;
  }, []);

  useEffect(() => {
    if (category === 'permissions' || category === 'skills') {
      const id = beginRequest('section');
      setLoadingSkills(true);
      setError(null);
      setNotice(null);
      api.agentListAllSkills(conversationId || 'workspace')
        .then((skills) => {
          if (isCurrentRequest('section', id)) setAllSkills(skills);
        })
        .catch((caught) => {
          if (isCurrentRequest('section', id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest('section', id)) setLoadingSkills(false);
        });
    } else if (category === 'memory') {
      const id = beginRequest('section');
      setLoadingMemory(true);
      setError(null);
      setNotice(null);
      api.agentListMemory({ includeInvalidated: true, limit: 200 })
        .then((entries) => {
          if (isCurrentRequest('section', id)) setMemoryEntries(entries);
        })
        .catch((caught) => {
          if (isCurrentRequest('section', id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest('section', id)) setLoadingMemory(false);
        });
    } else if (category === 'agents') {
      const id = beginRequest('section');
      setLoadingAgents(true);
      setError(null);
      setNotice(null);
      // The editor's Skills toggle list needs the installed skills, so load both.
      void api.agentListAllSkills(conversationId || 'workspace')
        .then((skills) => { if (isCurrentRequest('section', id)) setAllSkills(skills); })
        .catch(() => { /* the editor degrades to no skill list */ });
      api.agentListAllDefinitions(conversationId || 'workspace')
        .then((agents) => {
          if (isCurrentRequest('section', id)) setAllAgents(agents);
        })
        .catch((caught) => {
          if (isCurrentRequest('section', id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest('section', id)) setLoadingAgents(false);
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

  const permissionDiagnostics = permissionDraft?.diagnostics ?? permissionSettings?.diagnostics ?? [];
  const permissionRules = permissionDraft?.permissions ?? EMPTY_PERMISSION_RULES;
  const permissionExceptions = buildPermissionExceptionRows(permissionRules, draft.safetyMode);
  const permissionModeLabel = safetyModeLabel(draft.safetyMode, t);
  const permissionCustomCount = permissionExceptions.length;
  const acceptedSkillTrustGrants = allSkills.filter((skill) => skill.accepted);
  const runtimeDraftDirty = settings ? hasRuntimeDraftChanged(draft, settings) : false;
  const permissionDraftDirty = permissionDraft !== permissionSettings;
  const showFooterActions = category === 'permissions'
    ? permissionDraftDirty || runtimeDraftDirty
    : (category === 'skills' || category === 'agents') && runtimeDraftDirty;

  function setPermissionDecision(ruleValue: string, decision: GlobalToolPermissionDecision | 'default') {
    setPermissionDraft((current) => {
      const base = current ?? emptyPermissionSettings();
      return permissionSettingsWithDecision(base, ruleValue, decision, draft.safetyMode);
    });
    setNotice(null);
    setError(null);
  }

  function revertPermissionException(ruleValue: string) {
    setPermissionDraft((current) => permissionSettingsWithoutRule(current ?? emptyPermissionSettings(), ruleValue));
    setNotice(null);
    setError(null);
  }

  function resetPermissionExceptions() {
    setPermissionDraft((current) => ({
      ...(current ?? emptyPermissionSettings()),
      permissions: { allow: [], ask: [], deny: [] },
    }));
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
    const requestId = beginRequest('mutation');
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.agentUpdateRuntimeSettings({
        safetyMode: draft.safetyMode,
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
      if (isCurrentRequest('mutation', requestId)) {
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
      if (isCurrentRequest('mutation', requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest('mutation', requestId)) setSaving(false);
    }
  }

  // Per-row ⋯ actions operate on an explicit providerId (independent of the draft
  // selection); they share one refetch/notice/error envelope.
  async function runProviderMutation(
    action: () => Promise<AgentProviderSettingsView>,
    successNotice: string,
    resetToInitial = false,
  ) {
    const requestId = beginRequest('mutation');
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (isCurrentRequest('mutation', requestId)) {
        setSettings(next);
        setDraft(resetToInitial ? resolveInitialDraft(next) : resolveDraftForProvider(next, draft.providerId));
        if (resetToInitial) setCreatingCustom(false);
        setNotice(successNotice);
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest('mutation', requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest('mutation', requestId)) setSaving(false);
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
        <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" title={t.settings.loading} />
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
                <InsetGroup
                  ariaLabel={t.settings.general.diagnosticsGroup}
                  label={t.settings.general.diagnosticsGroup}
                >
                  <InsetRow
                    label={t.settings.general.revealDiagnosticsLabel}
                    sublabel={t.settings.general.revealDiagnosticsSublabel}
                    trailing={(
                      <Button
                        disabled={diagnosticsBusy !== null}
                        onClick={() => void revealDiagnosticsLog()}
                        variant="secondary"
                      >
                        {diagnosticsBusy === 'reveal' ? t.settings.general.diagnosticsWorking : t.settings.general.revealDiagnosticsAction}
                      </Button>
                    )}
                    wrap
                  />
                  <InsetRow
                    label={t.settings.general.exportDiagnosticsLabel}
                    sublabel={t.settings.general.exportDiagnosticsSublabel}
                    trailing={(
                      <Button
                        disabled={diagnosticsBusy !== null}
                        onClick={() => void exportDiagnostics()}
                        variant="secondary"
                      >
                        {diagnosticsBusy === 'export' ? t.settings.general.diagnosticsWorking : t.settings.general.exportDiagnosticsAction}
                      </Button>
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
                <InsetGroup
                  ariaLabel={t.settings.permissions.trustLevelAriaLabel}
                  footnote={t.settings.permissions.hardBlockNote}
                  label={t.settings.permissions.trustLevelGroup}
                >
                  <InsetRow
                    className="settings-permission-mode-row"
                    label={permissionCustomCount > 0 ? (
                      <>
                        {t.settings.permissions.customModeLabel}
                        <span className="settings-chip">{t.settings.permissions.basedOnMode({ mode: permissionModeLabel })}</span>
                        <span className="settings-chip">{t.settings.permissions.changedCount({ count: permissionCustomCount })}</span>
                      </>
                    ) : permissionModeLabel}
                    sublabel={t.settings.permissions.trustLevelSublabel}
                    trailing={(
                      <div className="settings-permission-mode-controls">
                        <SegmentedControl<AgentSafetyMode>
                          label={t.settings.permissions.trustLevelLabel}
                          onChange={(value) => {
                            setDraft((current) => ({ ...current, safetyMode: value }));
                            setNotice(null);
                            setError(null);
                          }}
                          options={[
                            { value: 'ask_first', label: t.settings.permissions.askFirstMode },
                            { value: 'balanced', label: t.settings.permissions.balancedMode },
                            { value: 'full_access', label: t.settings.permissions.fullAccessMode },
                          ]}
                          value={draft.safetyMode}
                        />
                        {permissionCustomCount > 0 ? (
                          <Button
                            onClick={resetPermissionExceptions}
                            size="sm"
                            variant="ghost"
                          >
                            {t.settings.permissions.resetToMode({ mode: permissionModeLabel })}
                          </Button>
                        ) : null}
                      </div>
                    )}
                    wrap
                  />
                </InsetGroup>

                <InsetGroup
                  ariaLabel={t.settings.permissions.exceptionsAriaLabel({ mode: permissionModeLabel })}
                  label={t.settings.permissions.exceptionsGroup({ mode: permissionModeLabel })}
                >
                  {permissionExceptions.length > 0 ? permissionExceptions.map((exception) => {
                    const ruleCopy = permissionRuleCopy(exception.ruleValue, t);
                    return (
                      <InsetRow
                        key={`${exception.decision}:${exception.ruleValue}`}
                        label={(
                          <>
                            {ruleCopy.label}
                            <span className="settings-chip">{permissionDecisionLabel(exception.decision, t)}</span>
                            <span className="settings-chip">{t.settings.permissions.modifiedChip}</span>
                            {exception.kind === 'raw' ? <span className="settings-chip">{t.settings.permissions.advancedRuleChip}</span> : null}
                          </>
                        )}
                        sublabel={(
                          <>
                            <span>{ruleCopy.description}</span>
                            <span className="inset-row-code">{exception.ruleValue}</span>
                          </>
                        )}
                        trailing={(
                          <Button
                            onClick={() => revertPermissionException(exception.ruleValue)}
                            size="sm"
                            variant="ghost"
                          >
                            {t.settings.permissions.revertException}
                          </Button>
                        )}
                        wrap
                      />
                    );
                  }) : (
                    <InsetRow disabled label={t.settings.permissions.noExceptions} />
                  )}
                </InsetGroup>

                <details className="settings-permission-add">
                  <summary>{t.settings.permissions.addExceptionSummary}</summary>
                  <InsetGroup ariaLabel={t.settings.permissions.commonActionsAriaLabel} label={t.settings.permissions.commonActionsGroup}>
                    {COMMON_PERMISSION_RULES.map((rule) => {
                      const decision = effectiveActionDecision(rule.actionKind, draft.safetyMode, permissionRules);
                      const defaultDecision = safetyModeDefaultActionDecision(rule.actionKind, draft.safetyMode);
                      const explicitDecision = explicitActionDecision(rule.actionKind, permissionRules);
                      const modified = explicitDecision !== null && explicitDecision !== defaultDecision;
                      const ruleCopy = t.settings.permissions.rules[rule.id];
                      return (
                        <InsetRow
                          key={rule.ruleValue}
                          label={(
                            <>
                              {ruleCopy.label}
                              <span className="settings-chip">{permissionDecisionLabel(decision, t)}</span>
                              {modified ? <span className="settings-chip">{t.settings.permissions.modifiedChip}</span> : null}
                            </>
                          )}
                          sublabel={ruleCopy.description}
                          trailing={(
                            <SelectControl
                              label={t.settings.permissions.decisionAriaLabel({ rule: ruleCopy.label })}
                              onChange={(event) => setPermissionDecision(rule.ruleValue, event.target.value as GlobalToolPermissionDecision | 'default')}
                              value={modified ? decision : 'default'}
                              variant="popup"
                            >
                              <option value="default">
                                {t.settings.permissions.followModeOption({
                                  mode: permissionModeLabel,
                                  decision: permissionDecisionLabel(defaultDecision, t),
                                })}
                              </option>
                              <option value="ask">{t.settings.permissions.askOption}</option>
                              {rule.allowable ? <option value="allow">{t.settings.permissions.allowOption}</option> : null}
                              <option value="deny">{t.settings.permissions.denyOption}</option>
                            </SelectControl>
                          )}
                          wrap
                        />
                      );
                    })}
                  </InsetGroup>
                </details>

                {acceptedSkillTrustGrants.length > 0 ? (
                  <InsetGroup ariaLabel={t.settings.permissions.acceptedSkillsAriaLabel} label={t.settings.permissions.acceptedSkillsGroup}>
                    {acceptedSkillTrustGrants.map((skill) => (
                      <InsetRow
                        key={`skill:${skill.name}:${skill.contentHash ?? ''}`}
                        label={`/${skill.displayName || skill.name}`}
                        sublabel={t.settings.permissions.skillGrantSublabel}
                        trailing={(
                          <Button
                            disabled={skillTrustBusy}
                            onClick={() => runSkillTrustAction(() => api.agentRevokeSkillAcceptance(conversationId || 'workspace', skill.name))}
                            size="sm"
                            variant="ghost"
                          >
                            {t.settings.permissions.revokeGrant}
                          </Button>
                        )}
                        wrap
                      />
                    ))}
                  </InsetGroup>
                ) : null}

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
                  <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.memory.loading} />
                ) : memoryEntries.length === 0 ? (
                  <EmptyState className="agent-settings-empty" size="inline" title={t.settings.memory.empty} />
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
                  <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.skills.loadingInstalled} />
                ) : allSkills.length === 0 ? (
                  <EmptyState className="agent-settings-empty" size="inline" title={t.settings.skills.noneInstalled} />
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
                                <Button
                                  aria-label={t.settings.skills.acceptSkill({ name: skill.name })}
                                  className="settings-skill-accept"
                                  disabled={skillTrustBusy}
                                  onClick={() => runSkillTrustAction(() => api.agentAcceptSkill(conversationId || 'workspace', skill.name, skill.contentHash ?? ''))}
                                  size="sm"
                                  variant="secondary"
                                >
                                  {t.settings.skills.acceptButton}
                                </Button>
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
            ) : (
              <section className="agent-settings-section settings-agents-section" aria-label={t.settings.agents.sectionAriaLabel}>
                {loadingAgents ? (
                  <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.agents.loadingProfiles} />
                ) : (
                  <>
                    <InsetGroup ariaLabel={t.settings.agents.profilesAriaLabel}>
                      <InsetRow
                        ariaLabel={t.settings.agents.newAgent}
                        leading={<AddIcon size={ICON_SIZE.rowGlyph} aria-hidden />}
                        label={t.settings.agents.newAgent}
                        onSelect={openAgentCreate}
                      />
                      {allAgents.map((agent) => {
                        const label = agent.displayName || agent.name;
                        return (
                          <InsetRow
                            ariaLabel={label}
                            dimmed={agent.source !== 'built-in' && isAgentDisabled(agent.agentId)}
                            key={agent.agentId}
                            label={(
                              <>
                                {label}
                                <span className="settings-chip">{agent.source}</span>
                              </>
                            )}
                            onSelect={() => openAgentConfig(agent.agentId)}
                            sublabel={agent.description}
                            trailing={agent.source === 'built-in' ? null : (
                              <SwitchControl
                                checked={!isAgentDisabled(agent.agentId)}
                                onCheckedChange={() => toggleAgent(agent.agentId)}
                                label={t.settings.agents.toggleAgent({ name: agent.name })}
                              >
                                <SwitchMark checked={!isAgentDisabled(agent.agentId)} />
                              </SwitchControl>
                            )}
                          />
                        );
                      })}
                    </InsetGroup>

                    <div className="inset-group">
                      <div className="inset-group-header">{t.settings.agents.directoriesGroup}</div>
                      <div className="inset-card" role="group">
                        <label className="settings-sheet-row settings-sheet-row-stack">
                          <span className="settings-sheet-row-label">{t.settings.agents.directoriesLabel}</span>
                          <Input
                            className="settings-sheet-row-input"
                            label={t.settings.agents.directoriesLabel}
                            onChange={(event) => setDraft((current) => ({ ...current, additionalAgentDirectoriesText: event.target.value }))}
                            placeholder={t.settings.agents.directoriesPlaceholder}
                            value={draft.additionalAgentDirectoriesText}
                            variant="bare"
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
                  <Button onClick={onClose} variant="ghost">
                    {t.settings.footer.cancel}
                  </Button>
                  <Button disabled={saving} onClick={save} variant="primary">
                    {saving ? t.settings.footer.saving : t.settings.footer.save}
                  </Button>
                </div>
              </footer>
            ) : null}
          </div>
        </div>
      )}
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
  'safetyMode' | 'automaticSkillsEnabled' | 'slashSkillsEnabled' | 'compactEnabled' | 'additionalSkillDirectoriesText' | 'additionalAgentDirectoriesText'
> {
  return {
    safetyMode: settings.agent.safetyMode ?? 'balanced',
    automaticSkillsEnabled: settings.agent.automaticSkillsEnabled,
    slashSkillsEnabled: settings.agent.slashSkillsEnabled,
    compactEnabled: settings.agent.compactEnabled,
    additionalSkillDirectoriesText: settings.agent.additionalSkillDirectories.join(', '),
    additionalAgentDirectoriesText: settings.agent.additionalAgentDirectories.join(', '),
  };
}

function hasRuntimeDraftChanged(draft: DraftConfig, settings: AgentProviderSettingsView): boolean {
  const runtime = runtimeSettingsToDraft(settings);
  return draft.safetyMode !== (runtime.safetyMode ?? 'balanced')
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

function emptyPermissionSettings(): AgentToolPermissionSettingsView {
  return { permissions: { allow: [], ask: [], deny: [] }, diagnostics: [] };
}
