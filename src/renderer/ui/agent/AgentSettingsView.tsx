import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { AppIcon } from '../icons';
import type {
  AgentProviderCapabilityModelOption,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentCapabilitySettingsView,
  SkillDefinition,
} from '../../api/types';
import { api } from '../../api/client';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import {
  AddIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  ICON_SIZE,
  LoaderIcon,
  PasswordIcon,
  SettingsIcon,
  SkillIcon,
  WarningIcon,
} from '../icons';
import type { ThemeMode } from '../../../core/theme';
import { SUPPORTED_LOCALES, type Locale } from '../../../core/locale';
import type { SettingsCategoryTarget, SettingsOpenTarget } from '../../../core/settingsWindow';
import {
  LOCAL_GATEWAY_PROVIDER_REGISTRY,
  isLocalGatewayProviderId,
  isQuickEnableProviderId,
  isRefreshableLocalGatewayProviderId,
} from '../../../core/localGatewayProviders';
import { useI18n, useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { EmptyState } from '../primitives/FeedbackState';
import { IconButton } from '../primitives/IconButton';
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
import { WebsiteDataSettingsGroup } from './WebsiteDataSettingsGroup';
import { TranslationDataSettingsGroup } from './TranslationDataSettingsGroup';
import { ManagedSkillsSettings } from './ManagedSkillsSettings';
import {
  capabilitySettingsRemovalPatch,
} from './agentCapabilitySettings';

interface AgentSettingsViewProps {
  onClose: () => void;
  onApplied: () => Promise<void>;
  initialTarget?: SettingsOpenTarget;
}

type SettingsCategory = SettingsCategoryTarget;
type SettingsRoute = { type: 'category'; category: SettingsCategory };
type RequestScope = 'settings' | 'section' | 'mutation';
type CapabilityRuleListKind = 'blocks';
interface DraftConfig {
  providerId: string;
  baseUrl: string;
  enabled: boolean;
  disabledSkills: string[];
}

interface ProviderChoice {
  providerId: string;
  configured: boolean;
  active: boolean;
  enabled: boolean;
  hasCredential: boolean;
  detected?: boolean;
  connectionStatus?: AgentProviderOption['connectionStatus'];
  connectionStatusMessage?: string;
  quickEnable?: boolean;
  defaultBaseUrl?: string;
  canRefreshModels?: boolean;
}

interface ProviderRowHandlers {
  onConfigure: (id: string) => void;
  onActivate: (id: string) => void;
  onRefreshModels: (id: string) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
  onMenuOpenChange: (id: string, open: boolean) => void;
}

interface ImageModelChoice {
  value: string;
  label: string;
}

interface ImageModelGroup {
  providerId: string;
  label: string;
  models: ImageModelChoice[];
}

// A single provider row in the inset grouped list. Configured rows expose an
// enable switch plus details/removal actions. Unconfigured catalog rows usually
// open the config sheet, except detected external providers such as CC Switch:
// those are already configured by their own app, so the row is a direct enable
// switch that materializes Tenon's connection.
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
  const quickEnable = !provider.configured && provider.quickEnable;
  const actions: RowMenuAction[] = [];
  if (provider.configured && provider.enabled && provider.hasCredential && !provider.active) {
    actions.push({ label: t.settings.providers.setActive, onSelect: () => handlers.onActivate(provider.providerId) });
  }
  if (provider.canRefreshModels) {
    actions.push({ label: t.settings.providers.refreshModels, onSelect: () => handlers.onRefreshModels(provider.providerId) });
  }
  if (!quickEnable) {
    actions.push({ label: t.settings.providers.configureAction, onSelect: () => handlers.onConfigure(provider.providerId) });
  }
  if (provider.configured) {
    actions.push({ label: t.settings.providers.removeProvider, danger: true, onSelect: () => handlers.onRemove(provider.providerId) });
  }
  const trailing = provider.configured ? (
    <div className="settings-provider-row-actions">
      <SwitchControl
        checked={provider.enabled}
        label={t.settings.providers.enabledToggleNamed({ name })}
        onCheckedChange={(enabled) => handlers.onToggleEnabled(provider.providerId, enabled)}
      >
        <SwitchMark checked={provider.enabled} />
      </SwitchControl>
      <SettingsRowMenu
        actions={actions}
        ariaLabel={t.settings.providers.rowActionsAriaLabel({ name })}
        onOpenChange={(open) => handlers.onMenuOpenChange(provider.providerId, open)}
        open={menuOpen}
      />
    </div>
  ) : quickEnable ? (
    <SwitchControl
      checked={false}
      label={t.settings.providers.enabledToggleNamed({ name })}
      onCheckedChange={(enabled) => handlers.onToggleEnabled(provider.providerId, enabled)}
    >
      <SwitchMark checked={false} />
    </SwitchControl>
  ) : actions.length > 1 ? (
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
  );
  return (
    <InsetRow
      ariaLabel={t.settings.providers.rowAriaLabel({ name, status: providerStatusLabel(provider, t) })}
      dimmed={(provider.configured || quickEnable) && !provider.enabled}
      label={name}
      leading={<ProviderAvatar providerId={provider.providerId} />}
      onSelect={quickEnable
        ? () => handlers.onToggleEnabled(provider.providerId, true)
        : () => handlers.onConfigure(provider.providerId)}
      sublabel={provider.connectionStatusMessage ?? (!provider.configured && provider.detected ? t.settings.providers.detectedSublabel : undefined)}
      trailing={trailing}
    />
  );
});

const EMPTY_DRAFT: DraftConfig = {
  providerId: '',
  baseUrl: '',
  enabled: true,
  disabledSkills: [],
};

// Theme segment values and category rail order; their visible labels + hints are
// localized at render (settings.general.theme* and settings.categories.*).
const THEME_VALUES: readonly ThemeMode[] = ['system', 'light', 'dark'];
const SETTINGS_CATEGORY_IDS: readonly SettingsCategory[] = ['general', 'providers', 'security', 'skills'];
const SETTINGS_CATEGORY_ICONS = {
  general: SettingsIcon,
  providers: DatabaseIcon,
  security: PasswordIcon,
  skills: SkillIcon,
} satisfies Partial<Record<SettingsCategory, AppIcon>>;

const PREFERRED_PROVIDER_ORDER = [
  'anthropic',
  'openai',
  ...LOCAL_GATEWAY_PROVIDER_REGISTRY.map((provider) => provider.providerId),
  'google',
  'openrouter',
];

function routeFromOpenTarget(target: SettingsOpenTarget | undefined): SettingsRoute {
  if (target?.category && SETTINGS_CATEGORY_IDS.includes(target.category)) {
    return { type: 'category', category: target.category };
  }
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

export function AgentSettingsView({ onApplied, onClose, initialTarget }: AgentSettingsViewProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [capabilitySettings, setCapabilitySettings] = useState<AgentCapabilitySettingsView | null>(null);
  const [capabilityDraft, setCapabilityDraft] = useState<AgentCapabilitySettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  // Route navigation history for macOS System Settings-style back/forward chrome.
  const [nav, setNav] = useState<{ stack: SettingsRoute[]; index: number }>({
    stack: [routeFromOpenTarget(initialTarget)],
    index: 0,
  });
  const route = nav.stack[nav.index];
  const category = routeCategory(route);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [loading, setLoading] = useState(true);
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
  // The per-row ⋯ actions menu (only one open at a time, keyed by providerId). The
  // per-provider config opens in its own native window, not an in-renderer sheet.
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);
  // App-level appearance preference (General pane). Independent of the provider/
  // capability save flow: it applies immediately across all windows via the main
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
  }), []);

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
      api.agentGetCapabilitySettings(),
    ])
      .then(([next, nextCapabilities]) => {
        if (!isCurrentRequest('settings', requestId)) return;
        setSettings(next);
        setCapabilitySettings(nextCapabilities);
        setCapabilityDraft(nextCapabilities);
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
  // new configured provider row without a manual reopen.
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
    if (category === 'skills') {
      const id = beginRequest('section');
      setLoadingSkills(true);
      setError(null);
      setNotice(null);
      api.agentListAllSkills()
        .then((skills) => {
          if (isCurrentRequest('section', id)) setAllSkills(skills);
        })
        .catch((caught) => {
          if (isCurrentRequest('section', id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest('section', id)) setLoadingSkills(false);
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
  // Grouped inset list: "Configured" = a provider row Tenon owns or an external
  // provider already configured by its own app; "Add Providers" = catalog
  // rows that still need Tenon's config window.
  const configuredChoices = useMemo(
    () => providerChoices.filter((choice) => choice.configured || choice.quickEnable),
    [providerChoices],
  );
  const availableChoices = useMemo(
    () => providerChoices.filter((choice) => !choice.configured && !choice.quickEnable),
    [providerChoices],
  );
  const imageModelMenu = useMemo(
    () => settings ? buildImageModelMenu(settings, providerCatalog) : { groups: [], defaultUnavailable: false },
    [providerCatalog, settings],
  );

  const capabilityBlocks = capabilityDraft?.blocks ?? capabilitySettings?.blocks ?? [];
  const runtimeDraftDirty = settings ? hasRuntimeDraftChanged(draft, settings) : false;
  const capabilityPatch = capabilitySettings && capabilityDraft
    ? capabilitySettingsRemovalPatch(capabilitySettings, capabilityDraft)
    : null;
  const capabilityDraftDirty = Boolean(
    capabilityPatch
    && capabilityPatch.removeBlocks.length > 0,
  );
  const showFooterActions = category === 'security'
    ? capabilityDraftDirty || runtimeDraftDirty
    : category === 'skills' && runtimeDraftDirty;

  // Custom (OpenAI-compatible) providers are configured in the same native window,
  // in 'custom' mode (the window enters the provider id + model itself).
  function startCustomProvider() {
    void window.lin?.openProviderConfig?.({ providerId: '', mode: 'custom' });
  }

  function removeCapabilityRule(kind: CapabilityRuleListKind, rule: string) {
    const base = capabilityDraft ?? capabilitySettings ?? emptyCapabilitySettings();
    setCapabilityDraft({
      ...base,
      [kind]: base[kind].filter((candidate) => candidate !== rule),
    });
  }

  function renderCapabilityRuleRows(
    rules: readonly string[],
    kind: CapabilityRuleListKind,
    emptyLabel: string,
    actionLabel: string,
  ) {
    if (rules.length === 0) return <InsetRow disabled label={emptyLabel} />;
    return rules.map((rule) => (
      <InsetRow
        key={rule}
        label={capabilityRuleLabel(rule, t)}
        sublabel={<span className="inset-row-code">{rule}</span>}
        trailing={(
          <Button
            onClick={() => removeCapabilityRule(kind, rule)}
            size="sm"
            variant="ghost"
          >
            {actionLabel}
          </Button>
        )}
        wrap
      />
    ));
  }

  // The footer Save persists only skill runtime settings and explicit blocks.
  // It never creates or edits a provider row: row
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
        disabledSkills: draft.disabledSkills,
      });
      const nextCapabilities = capabilityDraftDirty && capabilityPatch
        ? await api.agentApplyCapabilitySettingsPatch(capabilityPatch)
        : await api.agentGetCapabilitySettings();

      const next = await api.agentGetProviderSettings();
      if (isCurrentRequest('mutation', requestId)) {
        setSettings(next);
        setCapabilitySettings(nextCapabilities);
        setCapabilityDraft(nextCapabilities);
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

  function refreshProviderModels(providerId: string) {
    void runProviderMutation(() => api.agentRefreshProviderModels(providerId), t.settings.providers.modelsRefreshedNotice);
  }

  function changeDefaultImageModel(defaultModel: string) {
    void runProviderMutation(
      () => api.agentUpdateImageGenerationSettings({ defaultModel: defaultModel || null }),
      t.settings.providers.defaultImageModelSavedNotice,
    );
  }

  function toggleProviderEnabled(providerId: string, enabled: boolean) {
    const provider = settings?.providers.find((candidate) => candidate.providerId === providerId);
    const catalogEntry = providerCatalog.get(providerId);
    if (!provider && !enabled) return;
    if (!provider && !catalogEntry?.defaultBaseUrl) {
      void window.lin?.openProviderConfig?.({ providerId, mode: 'configure' });
      return;
    }
    const notice = enabled ? t.settings.providers.enabledNotice : t.settings.providers.disabledNotice;
    void runProviderMutation(
      () => api.agentUpsertProviderConfig({
        providerId,
        baseUrl: provider?.baseUrl ?? catalogEntry?.defaultBaseUrl ?? null,
        enabled,
      }),
      notice,
    );
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
  const rowHandlersImpl = { openProviderConfig, activateProvider, refreshProviderModels, toggleProviderEnabled, deleteProviderFor, setOpenRowMenu };
  const rowHandlersRef = useRef(rowHandlersImpl);
  rowHandlersRef.current = rowHandlersImpl;
  const rowHandlers = useMemo<ProviderRowHandlers>(() => ({
    onConfigure: (id) => rowHandlersRef.current.openProviderConfig(id),
    onActivate: (id) => rowHandlersRef.current.activateProvider(id),
    onRefreshModels: (id) => rowHandlersRef.current.refreshProviderModels(id),
    onToggleEnabled: (id, enabled) => rowHandlersRef.current.toggleProviderEnabled(id, enabled),
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
      <div className="settings-layout">
        <aside className="settings-rail">
          <h2 className="settings-rail-title">{t.settings.railTitle}</h2>
          <nav className="settings-nav" aria-label={t.settings.categoriesAriaLabel}>
            {SETTINGS_CATEGORY_IDS.map((id) => {
              const cat = t.settings.categories[id];
              const CategoryIcon = SETTINGS_CATEGORY_ICONS[id]!;
              return (
                <ButtonControl
                  aria-current={category === id ? 'page' : undefined}
                  className={`settings-nav-item ${category === id ? 'is-active' : ''}`}
                  key={id}
                  onClick={() => navigateCategory(id)}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    <CategoryIcon size={ICON_SIZE.menu} strokeWidth={1.75} />
                  </span>
                  <span className="settings-nav-copy">
                    <span className="settings-nav-label">{cat.label}</span>
                  </span>
                </ButtonControl>
              );
            })}
          </nav>
        </aside>

        <div className="settings-content" aria-busy={loading ? 'true' : undefined}>
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
                <WebsiteDataSettingsGroup onError={setError} onNotice={setNotice} />
                <TranslationDataSettingsGroup onError={setError} onNotice={setNotice} />
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
                    add-provider list (no separate floating add control). */}
                <div className="settings-provider-groups">
                  <InsetGroup
                    ariaLabel={t.settings.providers.imageGenerationAriaLabel}
                    label={t.settings.providers.imageGenerationGroup}
                  >
                    <InsetRow
                      label={t.settings.providers.defaultImageModelLabel}
                      sublabel={imageModelMenu.defaultUnavailable
                        ? t.settings.providers.defaultImageModelUnavailable
                        : t.settings.providers.defaultImageModelSublabel}
                      trailing={(
                        <SelectControl
                          className="settings-image-model-select"
                          disabled={saving}
                          label={t.settings.providers.defaultImageModelLabel}
                          onChange={(event) => changeDefaultImageModel(event.target.value)}
                          value={settings?.imageGeneration.defaultModel ?? ''}
                          variant="popup"
                        >
                          <option value="">{t.settings.providers.imageModelAuto}</option>
                          {imageModelMenu.defaultUnavailable && settings?.imageGeneration.defaultModel ? (
                            <option value={settings.imageGeneration.defaultModel}>
                              {t.settings.providers.imageModelUnavailableOption({ model: settings.imageGeneration.defaultModel })}
                            </option>
                          ) : null}
                          {imageModelMenu.groups.map((group) => (
                            <optgroup key={group.providerId} label={group.label}>
                              {group.models.map((model) => (
                                <option key={model.value} value={model.value}>{model.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </SelectControl>
                      )}
                      wrap
                    />
                  </InsetGroup>
                  {configuredChoices.length > 0 ? (
                    <InsetGroup ariaLabel={t.settings.providers.connectedAriaLabel} label={t.settings.providers.connectedGroup}>
                      {configuredChoices.map(renderProviderRow)}
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
            ) : category === 'security' ? (
              <section className="agent-settings-section settings-security-section" aria-label={t.settings.security.sectionAriaLabel}>
                <InsetGroup ariaLabel={t.settings.security.accessAriaLabel} label={t.settings.security.accessGroup}>
                  <InsetRow
                    label={t.settings.security.accessModeLabel}
                    sublabel={t.settings.security.fullAccessSublabel}
                    trailing={t.settings.security.fullAccessLabel}
                    wrap
                  />
                </InsetGroup>

                <InsetGroup ariaLabel={t.settings.security.blocksAriaLabel} label={t.settings.security.blocksGroup}>
                  {renderCapabilityRuleRows(
                    capabilityBlocks,
                    'blocks',
                    t.settings.security.noBlocks,
                    t.settings.security.removeRule,
                  )}
                </InsetGroup>

                <InsetGroup
                  ariaLabel={t.settings.security.systemBoundaryAriaLabel}
                  footnote={t.settings.security.fullAccessBoundaryNote}
                  label={t.settings.security.systemBoundaryGroup}
                >
                  <InsetRow
                    className="settings-system-boundary-row"
                    label={t.settings.security.fullAccessBoundaryLabel}
                    sublabel={t.settings.security.fullAccessBoundarySublabel}
                    wrap
                  />
                </InsetGroup>
              </section>
            ) : (
              <section className="agent-settings-section settings-skills-section" aria-label={t.settings.skills.sectionAriaLabel}>
                <ManagedSkillsSettings onApplied={onApplied} />

                {loadingSkills ? (
                  <EmptyState className="agent-settings-empty" icon={LoaderIcon} loading role="status" size="inline" title={t.settings.skills.loadingInstalled} />
                ) : allSkills.filter((skill) => skill.source !== 'managed').length === 0 ? (
                  <EmptyState className="agent-settings-empty" size="inline" title={t.settings.skills.noneInstalled} />
                ) : (
                  <InsetGroup ariaLabel={t.settings.skills.installedAriaLabel} label={t.settings.skills.installedGroup}>
                    {allSkills.filter((skill) => skill.source !== 'managed').map((skill) => {
                      const disabled = isSkillDisabled(skill.name);
                      // Trust state is derived in main. Mutable skills are model-usable
                      // by default; acceptedHash is only a retained management fact.
                      const pending = !skill.ratified;
                      const trustActions: RowMenuAction[] = [];
                      if (skill.accepted) {
                        trustActions.push({
                          label: t.settings.skills.revokeAcceptance,
                          disabled: skillTrustBusy,
                          onSelect: () => runSkillTrustAction(() => api.agentRevokeSkillAcceptance(skill.name)),
                        });
                      }
                      if (skill.canUndoLastAgentEdit) {
                        trustActions.push({
                          label: t.settings.skills.undoAgentEdit,
                          disabled: skillTrustBusy,
                          onSelect: () => runSkillTrustAction(() => api.agentUndoSkillAgentEdit(skill.name)),
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
                                  onClick={() => runSkillTrustAction(() => api.agentAcceptSkill(skill.name, skill.contentHash ?? ''))}
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
                Settings — so the global footer is only for runtime/capability
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
    baseUrl: '',
    enabled: true,
    disabledSkills: settings.agent.disabledSkills ?? [],
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
      detected: providerCatalog?.detected,
      connectionStatus: providerCatalog?.connectionStatus,
      connectionStatusMessage: providerCatalog?.connectionStatusMessage,
      defaultBaseUrl: providerCatalog?.defaultBaseUrl,
      canRefreshModels: isRefreshableLocalGatewayProviderId(provider.providerId) && provider.enabled,
    });
  }

  for (const provider of settings.availableProviders) {
    if (choices.has(provider.providerId)) continue;
    const quickEnable = isQuickEnableProviderId(provider.providerId) && Boolean(provider.detected && provider.defaultBaseUrl && provider.credentialed);
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      configured: false,
      active: provider.providerId === activeProviderId,
      enabled: !quickEnable,
      hasCredential: providerHasCredential(undefined, provider),
      detected: provider.detected,
      connectionStatus: provider.connectionStatus,
      connectionStatusMessage: provider.connectionStatusMessage,
      quickEnable,
      defaultBaseUrl: provider.defaultBaseUrl,
    });
  }

  if (draftProviderId && !choices.has(draftProviderId)) {
    const providerCatalog = catalog.get(draftProviderId);
    const quickEnable = isQuickEnableProviderId(draftProviderId) && Boolean(providerCatalog?.detected && providerCatalog.defaultBaseUrl && providerCatalog.credentialed);
    choices.set(draftProviderId, {
      providerId: draftProviderId,
      configured: false,
      active: draftProviderId === activeProviderId,
      enabled: !quickEnable,
      hasCredential: providerHasCredential(undefined, providerCatalog),
      detected: providerCatalog?.detected,
      connectionStatus: providerCatalog?.connectionStatus,
      connectionStatusMessage: providerCatalog?.connectionStatusMessage,
      quickEnable,
      defaultBaseUrl: providerCatalog?.defaultBaseUrl,
    });
  }

  return [...choices.values()].sort(compareProviderChoices);
}

function buildImageModelMenu(
  settings: AgentProviderSettingsView,
  catalog: Map<string, AgentProviderOption>,
): { groups: ImageModelGroup[]; defaultUnavailable: boolean } {
  const groups: ImageModelGroup[] = [];
  const values = new Set<string>();
  for (const provider of settings.providers) {
    if (!provider.enabled) continue;
    const providerOption = catalog.get(provider.providerId);
    if (!providerHasCredential(provider, providerOption)) continue;
    const models = imageGenerationModelsForProvider(providerOption)
      .map((model) => {
        const value = composeProviderQualifiedModel(model.providerId || provider.providerId, model.id);
        values.add(value);
        return {
          value,
          label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
        };
      });
    if (models.length > 0) {
      groups.push({
        providerId: provider.providerId,
        label: formatProviderName(provider.providerId),
        models,
      });
    }
  }
  const defaultModel = settings.imageGeneration.defaultModel ?? '';
  return {
    groups,
    defaultUnavailable: Boolean(defaultModel && !values.has(defaultModel)),
  };
}

function imageGenerationModelsForProvider(provider: AgentProviderOption | undefined): AgentProviderCapabilityModelOption[] {
  return provider?.capabilities?.find((capability) => capability.kind === 'image_generation')?.models ?? [];
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
  if (provider.connectionStatus === 'proxy-required') return s.proxyRequired;
  if (provider.connectionStatus === 'unsupported') return s.unsupported;
  if (provider.connectionStatus === 'not-detected') return s.notDetected;
  if (!provider.configured && provider.detected) return s.detected;
  if (!provider.configured) return provider.hasCredential ? s.ready : s.addKey;
  if (!provider.enabled) return s.disabled;
  if (isLocalGatewayProviderId(provider.providerId) && !provider.hasCredential) return s.unavailable;
  if (!provider.hasCredential) return s.needsKey;
  return provider.active ? s.active : s.ready;
}

function capabilityRuleLabel(rule: string, t: Messages): string {
  if (rule.startsWith('Command(')) return t.settings.security.commandBlockLabel;
  if (rule.startsWith('Action(')) return t.settings.security.actionBlockLabel;
  return t.settings.security.unknownBlockLabel;
}

function emptyCapabilitySettings(): AgentCapabilitySettingsView {
  return { blocks: [], diagnostics: [] };
}

function preferredProviderIndex(providerId: string): number {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(providerId);
  return index >= 0 ? index : PREFERRED_PROVIDER_ORDER.length;
}

function providerToDraft(provider: AgentProviderConfigView, settings: AgentProviderSettingsView): DraftConfig {
  return {
    providerId: provider.providerId,
    baseUrl: provider.baseUrl ?? '',
    enabled: provider.enabled,
    disabledSkills: settings.agent.disabledSkills ?? [],
  };
}

function hasRuntimeDraftChanged(draft: DraftConfig, settings: AgentProviderSettingsView): boolean {
  return !sameStringSet(draft.disabledSkills, settings.agent.disabledSkills ?? []);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}
