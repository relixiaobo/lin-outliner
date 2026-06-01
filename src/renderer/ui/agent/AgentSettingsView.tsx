import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentModelOption,
  AgentPermissionMode,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentDefinition,
  AgentToolPermissionSettingsView,
  SkillDefinition,
} from '../../api/types';
import { api } from '../../api/client';
import { AddIcon, ChevronLeftIcon, ChevronRightIcon, ICON_SIZE, WarningIcon } from '../icons';
import { providerIconSvg } from './providerIcon';
import { ButtonControl } from '../primitives/ButtonControl';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SettingsProviderSheet, type ProviderSheetDraft } from './SettingsProviderSheet';
import { SettingsRowMenu, type RowMenuAction } from './SettingsRowMenu';
import { coerceReasoningLevel, defaultReasoningLevel } from './settingsReasoning';

interface AgentSettingsViewProps {
  onClose: () => void;
  onApplied: () => Promise<void>;
  sessionId?: string;
}

type SettingsCategory = 'providers' | 'permissions' | 'skills' | 'agents';

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
// "Configure", which is what clicking does) instead reveals a quiet "Configure"
// hint on hover so the row reads as actionable. Memoized + fed stable handlers, so
// editing one provider's sheet never re-renders the list.
const SettingsProviderRow = memo(function SettingsProviderRow({
  provider,
  menuOpen,
  handlers,
}: {
  provider: ProviderChoice;
  menuOpen: boolean;
  handlers: ProviderRowHandlers;
}) {
  const name = formatProviderName(provider.providerId);
  const actions: RowMenuAction[] = [];
  if (provider.hasCredential && !provider.active) {
    actions.push({ label: 'Set as Active', onSelect: () => handlers.onActivate(provider.providerId) });
  }
  actions.push({ label: 'Configure…', onSelect: () => handlers.onConfigure(provider.providerId) });
  if (provider.configured) {
    actions.push({ label: 'Remove provider', danger: true, onSelect: () => handlers.onRemove(provider.providerId) });
  }
  return (
    <InsetRow
      ariaLabel={`${name}, ${providerStatusLabel(provider)}`}
      label={name}
      leading={<ProviderAvatar providerId={provider.providerId} />}
      onSelect={() => handlers.onConfigure(provider.providerId)}
      trailing={actions.length > 1 ? (
        <SettingsRowMenu
          actions={actions}
          ariaLabel={`${name} actions`}
          onOpenChange={(open) => handlers.onMenuOpenChange(provider.providerId, open)}
          open={menuOpen}
        />
      ) : (
        <span className="settings-provider-hint" aria-hidden="true">Configure</span>
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
  disabledSkills: [],
  disabledAgents: [],
};

const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; label: string; hint: string }> = [
  { id: 'providers', label: 'Providers', hint: 'Connections & API keys' },
  { id: 'permissions', label: 'Permissions', hint: 'Tool Allow / Ask Rules' },
  { id: 'skills', label: 'Skills', hint: 'Extension Capabilities' },
  { id: 'agents', label: 'Agent Profiles', hint: 'Persona Definitions' },
];

const COMMON_PERMISSION_RULES: Array<{
  ruleValue: string;
  label: string;
  description: string;
  allowable: boolean;
}> = [
  {
    ruleValue: 'Action(file.read.outside_allowed_file_area)',
    label: 'Read outside allowed area',
    description: 'Local reads outside the configured file boundary.',
    allowable: true,
  },
  {
    ruleValue: 'Action(file.read.sensitive_local_path)',
    label: 'Read sensitive local paths',
    description: 'Credential-like paths such as SSH keys, env files, and package tokens.',
    allowable: true,
  },
  {
    ruleValue: 'Action(web.fetch)',
    label: 'Fetch web pages',
    description: 'Directly contact a URL and read its response.',
    allowable: true,
  },
  {
    ruleValue: 'Action(file.delete.allowed_file_area)',
    label: 'Delete local files',
    description: 'Remove files inside the allowed file area.',
    allowable: true,
  },
  {
    ruleValue: 'Action(shell.project_script)',
    label: 'Run project scripts',
    description: 'Execute local validation commands and package scripts.',
    allowable: true,
  },
  {
    ruleValue: 'Action(shell.dependency_install)',
    label: 'Install dependencies',
    description: 'Run package manager commands that change dependencies or lockfiles.',
    allowable: true,
  },
  {
    ruleValue: 'Action(git.publish_remote)',
    label: 'Publish to Git remotes',
    description: 'Push commits or mutate GitHub/Git remotes.',
    allowable: true,
  },
  {
    ruleValue: 'Action(deploy.publish_remote)',
    label: 'Deploy or publish',
    description: 'Publish packages, deployments, or remote environments.',
    allowable: true,
  },
  {
    ruleValue: 'Action(shell.network_write)',
    label: 'Network write commands',
    description: 'Shell commands that send data outward or mutate network services.',
    allowable: true,
  },
  {
    ruleValue: 'Action(agent.subagent.spawn)',
    label: 'Spawn subagents',
    description: 'Start another agent process. Global allow is intentionally unavailable.',
    allowable: false,
  },
];

const PREFERRED_PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter'];

export function AgentSettingsView({ onApplied, onClose, sessionId }: AgentSettingsViewProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<AgentToolPermissionSettingsView | null>(null);
  const [permissionDraft, setPermissionDraft] = useState<AgentToolPermissionSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  // Category navigation history, so the window can offer macOS System Settings'
  // back / forward (‹ ›) chrome: `stack` is the visited categories, `index` the
  // current position. Switching to a new category truncates any forward entries
  // and pushes; back / forward just move the index. `category` derives from it.
  const [nav, setNav] = useState<{ stack: SettingsCategory[]; index: number }>({
    stack: ['providers'],
    index: 0,
  });
  const category = nav.stack[nav.index];
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
  const [allAgents, setAllAgents] = useState<AgentDefinition[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [selectedAgentName, setSelectedAgentName] = useState<string>('general');
  // The per-provider config SHEET (opened by clicking a row or "Configure…") and
  // the per-row ⋯ actions menu (only one open at a time, keyed by providerId).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openRowMenu, setOpenRowMenu] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  function beginRequest() {
    requestRef.current += 1;
    return requestRef.current;
  }

  function isCurrentRequest(requestId: number) {
    return mountedRef.current && requestId === requestRef.current;
  }

  // Navigate to a category, recording history for back / forward. Re-selecting the
  // current category is a no-op (no duplicate history entry).
  function navigateCategory(next: SettingsCategory) {
    setNav((current) => {
      if (current.stack[current.index] === next) return current;
      const stack = [...current.stack.slice(0, current.index + 1), next];
      return { stack, index: stack.length - 1 };
    });
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
    setNav({ stack: ['providers'], index: 0 });
    setCreatingCustom(false);
    setSheetOpen(false);

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
        setApiKey('');
      })
      .catch((caught) => {
        if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentRequest(requestId)) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (category === 'skills') {
      const id = beginRequest();
      setLoadingSkills(true);
      setError(null);
      setNotice(null);
      api.agentListAllSkills(sessionId || 'workspace')
        .then((skills) => {
          if (isCurrentRequest(id)) setAllSkills(skills);
        })
        .catch((caught) => {
          if (isCurrentRequest(id)) setError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (isCurrentRequest(id)) setLoadingSkills(false);
        });
    } else if (category === 'agents') {
      const id = beginRequest();
      setLoadingAgents(true);
      setError(null);
      setNotice(null);
      api.agentListAllDefinitions(sessionId || 'workspace')
        .then((agents) => {
          if (isCurrentRequest(id)) {
            setAllAgents(agents);
            if (agents.length > 0 && !agents.some((a) => a.name === selectedAgentName)) {
              setSelectedAgentName(agents[0].name);
            }
          }
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

  const configuredProvider = settings?.providers.find((provider) => provider.providerId === draft.providerId);
  const selectedCatalog = providerCatalog.get(draft.providerId);
  const isCustomProvider = Boolean(draft.providerId) && !providerCatalog.has(draft.providerId);
  const showConnectionFields = creatingCustom || isCustomProvider;
  const hasSavedCredential = providerHasCredential(configuredProvider, selectedCatalog);
  const catalogModels = selectedCatalog?.models ?? [];
  // The active provider's draft model determines which reasoning levels the global
  // save() may coerce to (the provider sheet manages its own selection internally).
  const selectedModel = catalogModels.find((model) => model.id === draft.modelId);
  const selectedReasoningLevels: AgentReasoningLevel[] = selectedModel?.supportedThinkingLevels.length
    ? selectedModel.supportedThinkingLevels
    : ['off'];

  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draft.providerId, providerCatalog) : [],
    [draft.providerId, providerCatalog, settings],
  );
  const activeRowProviderId = creatingCustom ? '' : draft.providerId;
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
  const selectedChoice = providerChoices.find((choice) => choice.providerId === activeRowProviderId);
  const detailName = creatingCustom
    ? 'Custom provider'
    : draft.providerId ? formatProviderName(draft.providerId) : '';
  const detailDescription = showConnectionFields
    ? 'Connect any OpenAI-compatible endpoint.'
    : providerDescription(selectedCatalog);
  const authInfo = showConnectionFields ? undefined : PROVIDER_AUTH[draft.providerId];
  const docsUrl = showConnectionFields ? undefined : PROVIDER_DOCS_URL[draft.providerId];
  const baseUrlPlaceholder = selectedCatalog?.defaultBaseUrl ?? 'https://api.example.com/v1';

  const selectedAgent = allAgents.find((a) => a.name === selectedAgentName) || allAgents[0];
  const permissionDiagnostics = permissionDraft?.diagnostics ?? permissionSettings?.diagnostics ?? [];

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

  function selectProvider(providerId: string) {
    setCreatingCustom(false);
    const existing = settings?.providers.find((provider) => provider.providerId === providerId);
    const catalog = providerCatalog.get(providerId);
    setDraft((current) => ({
      ...current,
      providerId,
      modelId: existing?.modelId ?? catalog?.models[0]?.id ?? '',
      reasoningLevel: existing?.reasoningLevel ?? defaultReasoningLevel(catalog?.models[0]),
      baseUrl: existing?.baseUrl ?? '',
      enabled: existing?.enabled ?? true,
    }));
    setApiKey('');
    setNotice(null);
    setError(null);
  }

  function startCustomProvider() {
    setCreatingCustom(true);
    setDraft((current) => ({
      ...current,
      providerId: '',
      modelId: '',
      reasoningLevel: 'off',
      baseUrl: '',
      enabled: true,
    }));
    setApiKey('');
    setNotice(null);
    setError(null);
    setSheetOpen(true);
  }

  async function save() {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim() || selectedCatalog?.models[0]?.id || '';

    // Only validate modelId if a providerId is actively selected/provided.
    if (providerId && !modelId) {
      setError('model is required');
      navigateCategory('providers');
      return;
    }

    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (providerId) {
        await api.agentUpsertProviderConfig({
          providerId,
          modelId,
          reasoningLevel: coerceReasoningLevel(draft.reasoningLevel, selectedReasoningLevels),
          baseUrl: draft.baseUrl.trim() || null,
          enabled: true,
        });
        if (apiKey.trim()) {
          await api.agentSetProviderApiKey(providerId, apiKey.trim());
          setApiKey('');
        }
      }

      let next = await api.agentUpdateRuntimeSettings({
        permissionMode: draft.permissionMode,
        automaticSkillsEnabled: draft.automaticSkillsEnabled,
        slashSkillsEnabled: draft.slashSkillsEnabled,
        compactEnabled: draft.compactEnabled,
        additionalSkillDirectories: parseSkillDirectoryInput(draft.additionalSkillDirectoriesText),
        disabledSkills: draft.disabledSkills,
        disabledAgents: draft.disabledAgents,
      });
      const nextPermissions = permissionDraft && permissionDraft !== permissionSettings
        ? await api.agentUpdateToolPermissionSettings(permissionDraft)
        : null;

      next = await api.agentGetProviderSettings();
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        if (nextPermissions) {
          setPermissionSettings(nextPermissions);
          setPermissionDraft(nextPermissions);
        }
        if (providerId) {
          setDraft(resolveDraftForProvider(next, providerId));
        } else {
          setDraft(resolveInitialDraft(next));
        }
        setCreatingCustom(false);
        setApiKey('');
        setNotice('Saved');
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
    void runProviderMutation(() => api.agentSetActiveProvider(providerId), 'Provider set as active');
  }

  function deleteProviderFor(providerId: string) {
    void runProviderMutation(() => api.agentDeleteProviderConfig(providerId), 'Provider removed', true);
  }

  // The provider sheet owns its own pending/cancel UI; these just run the IPC.
  // Validate tests the (unsaved) draft connection without persisting anything.
  async function validateProviderDraft(sheet: ProviderSheetDraft): Promise<{ success: boolean; message: string }> {
    const providerId = sheet.providerId.trim();
    const existing = settings?.providers.find((provider) => provider.providerId === providerId);
    const catalog = providerCatalog.get(providerId);
    const result = await api.agentTestProviderConnection({
      providerId,
      modelId: sheet.modelId.trim() || existing?.modelId || catalog?.models[0]?.id || getFallbackModelId(providerId),
      baseUrl: sheet.baseUrl.trim() || undefined,
      apiKey: sheet.apiKey.trim() || undefined,
    });
    return { success: result.success, message: result.message };
  }

  // Save commits the connection (base URL + credential) and refetches. Model &
  // reasoning are not edited in the sheet (the composer owns them), so preserve the
  // existing values, defaulting a new provider to the catalog flagship.
  async function commitProviderConfig(sheet: ProviderSheetDraft): Promise<void> {
    const providerId = sheet.providerId.trim();
    if (!providerId) return;
    const requestId = beginRequest();
    setError(null);
    setNotice(null);
    const existing = settings?.providers.find((provider) => provider.providerId === providerId);
    const catalog = providerCatalog.get(providerId);
    const modelId = sheet.modelId.trim() || existing?.modelId || catalog?.models[0]?.id || '';
    const reasoningLevel = existing?.reasoningLevel ?? defaultReasoningLevel(catalog?.models[0]);
    await api.agentUpsertProviderConfig({
      providerId,
      modelId,
      reasoningLevel,
      baseUrl: sheet.baseUrl.trim() || null,
      enabled: true,
    });
    if (sheet.apiKey.trim()) {
      await api.agentSetProviderApiKey(providerId, sheet.apiKey.trim());
    }
    const next = await api.agentGetProviderSettings();
    if (isCurrentRequest(requestId)) {
      setSettings(next);
      setDraft(resolveDraftForProvider(next, providerId));
      setCreatingCustom(false);
      setNotice('Saved');
    }
    await onApplied();
  }

  const isSkillDisabled = (skillName: string) => draft.disabledSkills.includes(skillName);
  const toggleSkill = (skillName: string) => {
    setDraft((current) => {
      const disabled = current.disabledSkills.includes(skillName)
        ? current.disabledSkills.filter((n) => n !== skillName)
        : [...current.disabledSkills, skillName];
      return { ...current, disabledSkills: disabled };
    });
  };

  const isAgentDisabled = (agentName: string) => draft.disabledAgents.includes(agentName);
  const toggleAgent = (agentName: string) => {
    setDraft((current) => {
      const disabled = current.disabledAgents.includes(agentName)
        ? current.disabledAgents.filter((n) => n !== agentName)
        : [...current.disabledAgents, agentName];
      return { ...current, disabledAgents: disabled };
    });
  };

  // Open the config sheet for a provider (clicking a row or "Configure…").
  function openProviderSheet(providerId: string) {
    selectProvider(providerId);
    setSheetOpen(true);
  }

  // Stable per-row handlers via a latest-ref so the memoized provider rows keep a
  // constant identity and never re-render while a sheet is open or another row's
  // menu toggles. The ref always points at the freshest closures (no stale reads).
  const rowHandlersImpl = { openProviderSheet, activateProvider, deleteProviderFor, setOpenRowMenu };
  const rowHandlersRef = useRef(rowHandlersImpl);
  rowHandlersRef.current = rowHandlersImpl;
  const rowHandlers = useMemo<ProviderRowHandlers>(() => ({
    onConfigure: (id) => rowHandlersRef.current.openProviderSheet(id),
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
    <main className="settings-window" aria-labelledby="agent-settings-title">
      {/* Frameless window: this top strip is the drag region that stands in for the
          native title bar. The OS traffic lights overlay it; the rail title/nav and
          content controls all sit below --chrome-height, so none overlaps it. The
          back / forward arrows are no-drag DOM CHILDREN of the strip — the only
          reliable carve-out from a drag region on macOS — anchored over the content
          column, on the traffic-light centreline, like System Settings' toolbar. */}
      <div className="settings-drag-region">
        <div className="settings-history-nav">
          <button
            aria-label="Back"
            className="settings-history-arrow"
            disabled={!canGoBack}
            onClick={goBack}
            type="button"
          >
            <ChevronLeftIcon size={ICON_SIZE.toolbar} />
          </button>
          <button
            aria-label="Forward"
            className="settings-history-arrow"
            disabled={!canGoForward}
            onClick={goForward}
            type="button"
          >
            <ChevronRightIcon size={ICON_SIZE.toolbar} />
          </button>
        </div>
      </div>
      {loading ? (
        <div className="agent-settings-empty">Loading…</div>
      ) : (
        <div className="settings-layout">
          <aside className="settings-rail">
            <h2 className="settings-rail-title" id="agent-settings-title">Settings</h2>
            <nav className="settings-nav" aria-label="Settings categories">
              {SETTINGS_CATEGORIES.map((item) => (
                <button
                  aria-current={category === item.id ? 'page' : undefined}
                  className={`settings-nav-item ${category === item.id ? 'is-active' : ''}`}
                  key={item.id}
                  onClick={() => navigateCategory(item.id)}
                  type="button"
                >
                  <span className="settings-nav-label">{item.label}</span>
                  <span className="settings-nav-hint">{item.hint}</span>
                </button>
              ))}
            </nav>
          </aside>

          <div className="settings-content">
            {category === 'providers' ? (
              <section className="agent-settings-section settings-providers-section" aria-label="Providers">
                {/* No "Providers" title — the selected rail category already names
                    the pane. Custom providers are added from the last row of the
                    Available list (no separate floating add control). */}
                <div className="settings-provider-groups">
                  {connectedChoices.length > 0 ? (
                    <InsetGroup ariaLabel="Connected providers" label="Connected">
                      {connectedChoices.map(renderProviderRow)}
                    </InsetGroup>
                  ) : null}
                  <InsetGroup ariaLabel="Available providers" label="Available">
                    {availableChoices.map(renderProviderRow)}
                    <InsetRow
                      ariaLabel="Add custom provider"
                      label="Add custom provider"
                      leading={(
                        <span className="settings-provider-add-leading" aria-hidden="true">
                          <AddIcon size={ICON_SIZE.menu} />
                        </span>
                      )}
                      onSelect={startCustomProvider}
                    />
                  </InsetGroup>
                </div>

                {sheetOpen ? (
                  <SettingsProviderSheet
                    authNote={authInfo}
                    avatar={creatingCustom
                      ? <span className="settings-provider-avatar is-large" aria-hidden="true">+</span>
                      : <ProviderAvatar large providerId={draft.providerId} />}
                    baseUrlPlaceholder={baseUrlPlaceholder}
                    defaultBaseUrl={selectedCatalog?.defaultBaseUrl}
                    description={detailDescription}
                    docsUrl={docsUrl}
                    hasSavedKey={hasSavedCredential}
                    initial={{
                      providerId: draft.providerId,
                      modelId: draft.modelId,
                      baseUrl: draft.baseUrl,
                    }}
                    isActive={Boolean(selectedChoice?.active)}
                    mode={showConnectionFields ? 'custom' : 'configure'}
                    onClose={() => setSheetOpen(false)}
                    onOpenExternal={(url) => void api.openExternalUrl(url)}
                    onRemoveProvider={!creatingCustom && configuredProvider
                      ? () => { deleteProviderFor(draft.providerId); setSheetOpen(false); }
                      : undefined}
                    onSetActive={!creatingCustom && hasSavedCredential && !selectedChoice?.active
                      ? () => { activateProvider(draft.providerId); setSheetOpen(false); }
                      : undefined}
                    onSubmit={commitProviderConfig}
                    onValidate={validateProviderDraft}
                    providerName={detailName}
                  />
                ) : null}
              </section>
            ) : category === 'permissions' ? (
              <section className="agent-settings-section settings-permissions-section" aria-labelledby="settings-permissions-heading">
                <div className="settings-section-title-row">
                  <h3 id="settings-permissions-heading">Tool Permissions</h3>
                  <span className="settings-section-desc">Choose which common agent actions run automatically and which ask first.</span>
                </div>

                <div className="settings-skills-list-section">
                  <h4 className="settings-subheading">Common Actions</h4>
                  <div className="settings-skills-table">
                    {COMMON_PERMISSION_RULES.map((rule) => {
                      const decision = permissionDecision(rule.ruleValue);
                      const denied = decision === 'deny';
                      return (
                        <div className={`settings-skill-row ${denied ? 'is-disabled' : ''}`} key={rule.ruleValue}>
                          <div className="skill-row-info">
                            <div className="skill-row-title">
                              <span className="skill-name">{rule.label}</span>
                              <span className="skill-source-badge">{denied ? 'Deny in JSON' : decision === 'allow' ? 'Allow' : 'Ask'}</span>
                            </div>
                            <p className="skill-desc">{rule.description}</p>
                            <p className="skill-desc">{rule.ruleValue}</p>
                          </div>
                          <div className="agent-settings-field">
                            <SelectControl
                              disabled={denied}
                              label={`${rule.label} permission`}
                              onChange={(event) => setPermissionDecision(rule.ruleValue, event.target.value as 'allow' | 'ask')}
                              value={denied ? 'deny' : decision}
                            >
                              <option value="ask">Ask first</option>
                              {rule.allowable ? <option value="allow">Always allow</option> : null}
                              {denied ? <option value="deny">Denied in JSON</option> : null}
                            </SelectControl>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {permissionDiagnostics.length > 0 ? (
                  <div className="settings-skills-list-section">
                    <h4 className="settings-subheading">Ignored JSON Rules</h4>
                    <div className="settings-skills-table">
                      {permissionDiagnostics.map((diagnostic) => (
                        <div className="settings-skill-row is-disabled" key={`${diagnostic.decision}:${diagnostic.ruleValue}:${diagnostic.code}`}>
                          <div className="skill-row-info">
                            <div className="skill-row-title">
                              <span className="skill-name">{diagnostic.ruleValue}</span>
                              <span className="skill-source-badge">{diagnostic.code}</span>
                            </div>
                            <p className="skill-desc">{diagnostic.message}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>
            ) : category === 'skills' ? (
              <section className="agent-settings-section settings-skills-section" aria-labelledby="settings-skills-heading">
                <div className="settings-section-title-row">
                  <h3 id="settings-skills-heading">Skills & Behaviors</h3>
                  <span className="settings-section-desc">Manage installed capabilities and agent automation.</span>
                </div>
                
                <div className="settings-skills-behavior">
                  <h4 className="settings-subheading">Behavior Rules</h4>
                  <div className="agent-settings-behavior-switches">
                    <div className="behavior-switch-item">
                      <div className="behavior-switch-info">
                        <span className="behavior-switch-title">Automatic Skills</span>
                        <p className="behavior-switch-desc">Allow agent to autonomously invoke skills to solve tasks.</p>
                      </div>
                      <SwitchControl
                        checked={draft.automaticSkillsEnabled}
                        onCheckedChange={(automaticSkillsEnabled) => setDraft((current) => ({ ...current, automaticSkillsEnabled }))}
                        label="Automatic Skills"
                      >
                        <SwitchMark checked={draft.automaticSkillsEnabled} />
                      </SwitchControl>
                    </div>

                    <div className="behavior-switch-item">
                      <div className="behavior-switch-info">
                        <span className="behavior-switch-title">Slash Skills</span>
                        <p className="behavior-switch-desc">Enable users to directly invoke skills in chat via slash commands.</p>
                      </div>
                      <SwitchControl
                        checked={draft.slashSkillsEnabled}
                        onCheckedChange={(slashSkillsEnabled) => setDraft((current) => ({ ...current, slashSkillsEnabled }))}
                        label="Slash Skills"
                      >
                        <SwitchMark checked={draft.slashSkillsEnabled} />
                      </SwitchControl>
                    </div>

                    <div className="behavior-switch-item">
                      <div className="behavior-switch-info">
                        <span className="behavior-switch-title">Compact Command</span>
                        <p className="behavior-switch-desc">Enable automatic conversation context compaction when token budget runs low.</p>
                      </div>
                      <SwitchControl
                        checked={draft.compactEnabled}
                        onCheckedChange={(compactEnabled) => setDraft((current) => ({ ...current, compactEnabled }))}
                        label="Compact Command"
                      >
                        <SwitchMark checked={draft.compactEnabled} />
                      </SwitchControl>
                    </div>
                  </div>
                </div>

                <div className="settings-skills-list-section">
                  <h4 className="settings-subheading">Installed Capabilities</h4>
                  
                  {loadingSkills ? (
                    <div className="settings-loading-placeholder">Loading installed skills...</div>
                  ) : allSkills.length === 0 ? (
                    <div className="settings-empty-placeholder">No skills installed in ~/.agents/skills or .agents/skills.</div>
                  ) : (
                    <div className="settings-skills-table">
                      {allSkills.map((skill) => {
                        const disabled = isSkillDisabled(skill.name);
                        return (
                          <div className={`settings-skill-row ${disabled ? 'is-disabled' : ''}`} key={skill.name}>
                            <div className="skill-row-action">
                              <SwitchControl
                                checked={!disabled}
                                onCheckedChange={() => toggleSkill(skill.name)}
                                label={`Toggle ${skill.name}`}
                              >
                                <SwitchMark checked={!disabled} />
                              </SwitchControl>
                            </div>
                            <div className="skill-row-info">
                              <div className="skill-row-title">
                                <span className="skill-name">/{skill.displayName || skill.name}</span>
                                <span className="skill-source-badge">{skill.source}</span>
                              </div>
                              <p className="skill-desc">{skill.description}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <section className="agent-settings-section settings-agents-section" aria-labelledby="settings-agents-heading">
                <div className="settings-section-title-row">
                  <h3 id="settings-agents-heading">Agent Profiles</h3>
                  <span className="settings-section-desc">Manage system subagents and view their persona details.</span>
                </div>

                <div className="settings-agents-split">
                  <div className="settings-agents-aside">
                    {loadingAgents ? (
                      <div className="settings-loading-placeholder">Loading profiles...</div>
                    ) : allAgents.length === 0 ? (
                      <div className="settings-empty-placeholder">No agent definitions found.</div>
                    ) : (
                      <div className="settings-agents-list">
                        {allAgents.map((agent) => {
                          const disabled = isAgentDisabled(agent.name);
                          const isSelected = agent.name === selectedAgentName;
                          return (
                            <div
                              className={`settings-agent-item-row ${isSelected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}`}
                              key={agent.name}
                            >
                              <span className="agent-item-switch">
                                <SwitchControl
                                  checked={!disabled}
                                  onCheckedChange={() => toggleAgent(agent.name)}
                                  label={`Toggle ${agent.name}`}
                                >
                                  <SwitchMark checked={!disabled} />
                                </SwitchControl>
                              </span>
                              <button
                                className="agent-item-content"
                                onClick={() => setSelectedAgentName(agent.name)}
                                type="button"
                              >
                                <span className="agent-item-name">{agent.name}</span>
                                <span className="agent-item-desc">{agent.description}</span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="settings-agents-detail-panel">
                    {selectedAgent ? (
                      <div className="agent-profile-detail-card">
                        <div className="agent-profile-detail-header">
                          <div>
                            <h4 className="agent-profile-title">{selectedAgent.name}</h4>
                            <span className="agent-profile-source-label">Source: {selectedAgent.source}</span>
                          </div>
                        </div>

                        <div className="agent-profile-field">
                          <span className="agent-profile-field-label">Persona prompt (System instructions)</span>
                          <textarea
                            className="agent-profile-prompt-preview"
                            readOnly
                            value={selectedAgent.body || '(No instruction body)'}
                          />
                        </div>

                        <div className="agent-profile-specs">
                          <div className="spec-item">
                            <span className="spec-label">Model Override</span>
                            <span className="spec-value">{selectedAgent.model || 'Inherit parent'}</span>
                          </div>
                          <div className="spec-item">
                            <span className="spec-label">Thinking Level</span>
                            <span className="spec-value">{selectedAgent.effort || 'Default'}</span>
                          </div>
                          <div className="spec-item">
                            <span className="spec-label">Permission Mode</span>
                            <span className="spec-value">{selectedAgent.permissionMode || 'Restricted'}</span>
                          </div>
                          <div className="spec-item">
                            <span className="spec-label">Max Turns</span>
                            <span className="spec-value">{selectedAgent.maxTurns || 'Unlimited'}</span>
                          </div>
                        </div>

                        {selectedAgent.tools && selectedAgent.tools.length > 0 && (
                          <div className="agent-profile-field">
                            <span className="agent-profile-field-label">Enabled Tools</span>
                            <div className="agent-profile-tags-container">
                              {selectedAgent.tools.map((tool) => (
                                <span className="agent-profile-tag" key={tool}>{tool}</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="settings-agents-detail-empty">Select an agent profile to view details.</div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {error ? (
              <div className="agent-settings-alert" role="alert">
                <WarningIcon size={ICON_SIZE.menu} />
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? <div className="agent-settings-notice">{notice}</div> : null}

            {/* Providers commit per-provider through their own sheet (Cancel/Save),
                like native Settings — so the global footer is only for the
                runtime/permission categories. */}
            {category !== 'providers' ? (
              <footer className="agent-settings-footer">
                <span />
                <div className="agent-settings-footer-actions">
                  <ButtonControl className="agent-settings-secondary" onClick={onClose}>
                    Cancel
                  </ButtonControl>
                  <ButtonControl className="agent-settings-primary" disabled={saving} onClick={save}>
                    {saving ? 'Saving...' : 'Save'}
                  </ButtonControl>
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

function providerHasCredential(
  provider: AgentProviderConfigView | undefined,
  catalog: AgentProviderOption | undefined,
): boolean {
  return Boolean(provider?.hasApiKey || provider?.hasEnvApiKey || catalog?.hasEnvApiKey);
}

function resolveUsableActiveProvider(settings: AgentProviderSettingsView): AgentProviderConfigView | undefined {
  const isUsable = (provider: AgentProviderConfigView) => {
    const catalog = settings.availableProviders.find((candidate) => candidate.providerId === provider.providerId);
    return provider.enabled && providerHasCredential(provider, catalog);
  };
  return settings.activeProviderId
    ? settings.providers.find((provider) => provider.providerId === settings.activeProviderId && isUsable(provider))
      ?? settings.providers.find(isUsable)
    : settings.providers.find(isUsable);
}

function providerStatusLabel(provider: ProviderChoice): string {
  if (!provider.configured) return provider.hasCredential ? 'Ready' : 'Add key';
  if (!provider.enabled) return 'Disabled';
  if (!provider.hasCredential) return 'Needs key';
  return provider.active ? 'Active' : 'Ready';
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
  'permissionMode' | 'automaticSkillsEnabled' | 'slashSkillsEnabled' | 'compactEnabled' | 'additionalSkillDirectoriesText'
> {
  return {
    permissionMode: settings.agent.permissionMode,
    automaticSkillsEnabled: settings.agent.automaticSkillsEnabled,
    slashSkillsEnabled: settings.agent.slashSkillsEnabled,
    compactEnabled: settings.agent.compactEnabled,
    additionalSkillDirectoriesText: settings.agent.additionalSkillDirectories.join(', '),
  };
}

function parseSkillDirectoryInput(value: string): string[] {
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

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai-responses': 'Azure OpenAI',
  google: 'Google Gemini',
  'google-vertex': 'Google Vertex AI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  groq: 'Groq',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  'moonshotai-cn': 'Moonshot AI (CN)',
  zai: 'Z.AI',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  cerebras: 'Cerebras',
  minimax: 'MiniMax',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  'github-copilot': 'GitHub Copilot',
};

// Tokens that should keep a specific casing when a provider id falls through to
// the generic title-case path (e.g. `cloudflare-ai-gateway` -> Cloudflare AI Gateway).
const NAME_TOKEN_OVERRIDES: Record<string, string> = {
  ai: 'AI',
  openai: 'OpenAI',
  api: 'API',
  cn: 'CN',
  ams: 'AMS',
  sgp: 'SGP',
  gpt: 'GPT',
  github: 'GitHub',
};

// Where to mint an API key, for the providers we can link directly. Omitted
// providers simply drop the helper link.
const PROVIDER_DOCS_URL: Record<string, string> = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/app/apikey',
  openrouter: 'https://openrouter.ai/keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
};

// Providers pi-ai authenticates with something other than a pasteable API key.
// Until the OAuth sign-in flow lands (docs/plans/agent-oauth-providers.md), we
// at least stop showing a misleading "Paste key" field for them.
interface ProviderAuthInfo {
  kind: 'oauth' | 'managed';
  note: string;
  docsUrl?: string;
  docsLabel?: string;
}

const PROVIDER_AUTH: Record<string, ProviderAuthInfo> = {
  'github-copilot': {
    kind: 'oauth',
    note: 'GitHub Copilot signs in with your GitHub account — there is no API key to paste. Sign-in support is coming soon.',
    docsUrl: 'https://github.com/features/copilot',
    docsLabel: 'About GitHub Copilot',
  },
  'openai-codex': {
    kind: 'oauth',
    note: 'Codex uses your ChatGPT sign-in rather than an API key. Sign-in support is coming soon.',
  },
  'amazon-bedrock': {
    kind: 'managed',
    note: 'Bedrock uses your AWS credentials (a named profile, IAM role, or AWS_* environment variables) — there is no API key to paste here.',
    docsUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
    docsLabel: 'AWS credential setup',
  },
  'google-vertex': {
    kind: 'managed',
    note: 'Vertex AI uses Google Cloud Application Default Credentials (run `gcloud auth application-default login`) — there is no API key to paste here.',
    docsUrl: 'https://cloud.google.com/docs/authentication/provide-credentials-adc',
    docsLabel: 'Set up ADC',
  },
};

function formatProviderName(providerId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[providerId];
  if (known) return known;
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => NAME_TOKEN_OVERRIDES[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || providerId;
}

function providerInitial(providerId: string): string {
  return (formatProviderName(providerId).trim()[0] ?? '?').toUpperCase();
}

function ProviderAvatar({ providerId, large }: { providerId: string; large?: boolean }) {
  const svg = providerIconSvg(providerId);
  const className = `settings-provider-avatar${large ? ' is-large' : ''}${svg ? ' has-logo' : ''}`;
  return (
    <span className={className} aria-hidden="true">
      {svg ? (
        // Trusted, build-time vendored brand SVGs (no remote/user input) — inlined
        // so `currentColor` marks follow the theme.
        <span className="settings-provider-logo" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : providerInitial(providerId)}
    </span>
  );
}

function providerDescription(catalog: AgentProviderOption | undefined): string {
  if (!catalog || catalog.models.length === 0) return 'Connect any OpenAI-compatible endpoint.';
  const names = catalog.models.slice(0, 3).map((model) => model.name.replace(/\s*\(latest\)/i, ''));
  const suffix = catalog.models.length > names.length ? ', and more' : '';
  return `Includes ${names.join(', ')}${suffix}.`;
}

function getFallbackModelId(providerId: string): string {
  const lower = providerId.toLowerCase();
  if (lower.includes('anthropic') || lower.includes('claude')) {
    return 'claude-3-5-sonnet-latest';
  }
  if (lower.includes('google') || lower.includes('gemini')) {
    return 'gemini-2.5-flash';
  }
  return 'gpt-4o';
}
