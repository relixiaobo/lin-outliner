import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentModelOption,
  AgentPermissionMode,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
  AgentDefinition,
  SkillDefinition,
} from '../../api/types';
import { api } from '../../api/client';
import { AddIcon, CloseIcon, HideIcon, ICON_SIZE, OpenIcon, PasswordIcon, SearchIcon, ShowIcon, TrashIcon, WarningIcon } from '../icons';
import { providerIconUrl } from './providerIcon';
import { ButtonControl } from '../primitives/ButtonControl';
import { Dialog } from '../primitives/Dialog';
import { FormField } from '../primitives/FormField';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { TextInputControl } from '../primitives/TextInputControl';

interface AgentSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => Promise<void>;
  restoreFocus?: () => HTMLElement | null;
  sessionId?: string;
}

type SettingsCategory = 'providers' | 'skills' | 'agents';

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
  { id: 'skills', label: 'Skills', hint: 'Extension Capabilities' },
  { id: 'agents', label: 'Agent Profiles', hint: 'Persona Definitions' },
];

const PREFERRED_PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter'];
const REASONING_LABELS: Record<AgentReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function AgentSettingsDialog({ open, onApplied, onClose, restoreFocus, sessionId }: AgentSettingsDialogProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [providerQuery, setProviderQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [modelSearchOpen, setModelSearchOpen] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>('providers');
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
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string; statusCode?: number } | null>(null);

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

  useEffect(() => {
    if (!open) {
      beginRequest();
      setSaving(false);
      return;
    }
    const requestId = beginRequest();
    setLoading(true);
    setError(null);
    setNotice(null);
    setCategory('providers');
    setCreatingCustom(false);
    setProviderQuery('');
    setModelQuery('');
    setModelSearchOpen(false);
    setTestResult(null);

    void api.agentGetProviderSettings()
      .then((next) => {
        if (!isCurrentRequest(requestId)) return;
        setSettings(next);
        setDraft(resolveInitialDraft(next));
        setApiKey('');
      })
      .catch((caught) => {
        if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (isCurrentRequest(requestId)) setLoading(false);
      });
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [category, open]);

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
  const hasPendingApiKey = apiKey.trim().length > 0;
  const hasSavedCredential = providerHasCredential(configuredProvider, selectedCatalog);
  const canChooseModels = (hasSavedCredential || hasPendingApiKey) && Boolean(draft.providerId);
  const catalogModels = selectedCatalog?.models ?? [];
  const selectedModels = canChooseModels ? catalogModels : [];
  const selectedModel = selectedModels.find((model) => model.id === draft.modelId);
  const selectedReasoningLevels: AgentReasoningLevel[] = selectedModel?.supportedThinkingLevels.length
    ? selectedModel.supportedThinkingLevels
    : ['off'];
  const hasAnyKey = hasSavedCredential || hasPendingApiKey;
  const keyStatus = configuredProvider?.hasApiKey
    ? 'Saved key'
    : configuredProvider?.hasEnvApiKey || selectedCatalog?.hasEnvApiKey ? 'Environment key' : hasPendingApiKey ? 'Unsaved key' : 'No key yet';

  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draft.providerId, providerCatalog) : [],
    [draft.providerId, providerCatalog, settings],
  );
  const activeRowProviderId = creatingCustom ? '' : draft.providerId;
  const visibleProviderChoices = useMemo(() => {
    const query = providerQuery.trim().toLowerCase();
    if (!query) return providerChoices;
    return providerChoices.filter((choice) =>
      formatProviderName(choice.providerId).toLowerCase().includes(query)
      || choice.providerId.toLowerCase().includes(query));
  }, [providerChoices, providerQuery]);
  const selectedChoice = providerChoices.find((choice) => choice.providerId === activeRowProviderId);
  const showDetail = creatingCustom || Boolean(draft.providerId);
  const detailName = creatingCustom
    ? 'Custom provider'
    : draft.providerId ? formatProviderName(draft.providerId) : '';
  const detailDescription = showConnectionFields
    ? 'Connect any OpenAI-compatible endpoint.'
    : providerDescription(selectedCatalog);
  const authInfo = showConnectionFields ? undefined : PROVIDER_AUTH[draft.providerId];
  const docsUrl = showConnectionFields ? undefined : PROVIDER_DOCS_URL[draft.providerId];
  
  const baseUrlPlaceholder = selectedCatalog?.defaultBaseUrl ?? 'https://api.example.com/v1';
  const showModelList = !creatingCustom && catalogModels.length > 0;
  const showModelSearch = catalogModels.length > 1;
  const visibleModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (!query) return catalogModels;
    return catalogModels.filter((model) =>
      model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query));
  }, [catalogModels, modelQuery]);

  const selectedAgent = allAgents.find((a) => a.name === selectedAgentName) || allAgents[0];

  if (!open) return null;

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
    setRevealKey(false);
    setModelQuery('');
    setModelSearchOpen(false);
    setNotice(null);
    setError(null);
    setTestResult(null);
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
    setRevealKey(false);
    setModelQuery('');
    setModelSearchOpen(false);
    setNotice(null);
    setError(null);
    setTestResult(null);
  }

  async function testConnection() {
    const providerId = draft.providerId.trim();
    if (!providerId) return;
    setTestingConnection(true);
    setTestResult(null);
    try {
      const res = await api.agentTestProviderConnection({
        providerId,
        modelId: draft.modelId || selectedCatalog?.models[0]?.id || getFallbackModelId(providerId),
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });
      setTestResult(res);
    } catch (caught) {
      setTestResult({
        success: false,
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setTestingConnection(false);
    }
  }

  async function makeActive() {
    const providerId = draft.providerId.trim();
    if (!providerId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (apiKey.trim()) {
        await api.agentSetProviderApiKey(providerId, apiKey.trim());
        setApiKey('');
      }
      let next = await api.agentUpsertProviderConfig({
        providerId,
        modelId: draft.modelId || selectedCatalog?.models[0]?.id || '',
        baseUrl: draft.baseUrl.trim() || null,
        enabled: true,
      });
      next = await api.agentSetActiveProvider(providerId);
      setSettings(next);
      setDraft(resolveDraftForProvider(next, providerId));
      setNotice('Provider set as active');
      await onApplied();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim() || selectedCatalog?.models[0]?.id || '';

    // Only validate modelId if a providerId is actively selected/provided.
    if (providerId && !modelId) {
      setError('model is required');
      setCategory('providers');
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

      next = await api.agentGetProviderSettings();
      if (isCurrentRequest(requestId)) {
        setSettings(next);
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

  async function removeApiKey() {
    const providerId = draft.providerId.trim();
    if (!providerId) return;
    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.agentDeleteProviderApiKey(providerId);
      const next = await api.agentGetProviderSettings();
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        setDraft(resolveDraftForProvider(next, providerId));
        setNotice('Key removed');
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest(requestId)) setSaving(false);
    }
  }

  async function removeProvider() {
    const providerId = draft.providerId.trim();
    if (!providerId || !configuredProvider) return;
    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.agentDeleteProviderConfig(providerId);
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        setDraft(resolveInitialDraft(next));
        setCreatingCustom(false);
        setApiKey('');
        setNotice('Provider removed');
      }
      await onApplied();
    } catch (caught) {
      if (isCurrentRequest(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (isCurrentRequest(requestId)) setSaving(false);
    }
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

  const baseUrlField = (
    <FormField className="agent-settings-field agent-settings-field-wide" label="Base URL">
      <TextInputControl
        label="Base URL"
        onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
        placeholder={baseUrlPlaceholder}
        value={draft.baseUrl}
      />
      <span className="agent-settings-field-meta">Optional. Leave empty to use the default endpoint.</span>
    </FormField>
  );

  return (
    <Dialog
      backdropClassName="agent-settings-backdrop"
      labelledBy="agent-settings-title"
      onBackdropMouseDown={onClose}
      onEscapeKeyDown={onClose}
      restoreFocus={restoreFocus}
      surfaceClassName="agent-settings-dialog settings-dialog"
    >
      <header className="agent-settings-header">
        <h2 id="agent-settings-title">Settings</h2>
        <ButtonControl className="agent-settings-close" onClick={onClose}>
          Close
        </ButtonControl>
      </header>

      {loading ? (
        <div className="agent-settings-empty">Loading...</div>
      ) : (
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_CATEGORIES.map((item) => (
              <button
                aria-current={category === item.id ? 'page' : undefined}
                className={`settings-nav-item ${category === item.id ? 'is-active' : ''}`}
                key={item.id}
                onClick={() => setCategory(item.id)}
                type="button"
              >
                <span className="settings-nav-label">{item.label}</span>
                <span className="settings-nav-hint">{item.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {category === 'providers' ? (
              <section className="agent-settings-section settings-providers-section" aria-label="Providers">
                <div className="settings-providers">
                  <div className="settings-provider-aside">
                    <div className="settings-provider-search-row">
                      <div className="settings-provider-search">
                        <SearchIcon size={ICON_SIZE.menu} />
                        <TextInputControl
                          label="Search providers"
                          onChange={(event) => setProviderQuery(event.target.value)}
                          placeholder="Search providers…"
                          value={providerQuery}
                        />
                      </div>
                      <button
                        aria-current={creatingCustom ? 'true' : undefined}
                        aria-label="Custom provider"
                        className={`settings-provider-add ${creatingCustom ? 'is-active' : ''}`}
                        onClick={startCustomProvider}
                        title="Add a custom OpenAI-compatible provider"
                        type="button"
                      >
                        <AddIcon size={ICON_SIZE.menu} />
                      </button>
                    </div>
                    <div className="settings-provider-list" role="list" aria-label="Available providers">
                      {visibleProviderChoices.length === 0 ? (
                        <p className="settings-provider-list-empty">No providers match “{providerQuery.trim()}”.</p>
                      ) : null}
                      {visibleProviderChoices.map((provider) => {
                        const selected = provider.providerId === activeRowProviderId;
                        const enabledOn = provider.hasCredential;
                        const dotState = provider.active ? 'is-on' : enabledOn ? 'is-configured' : '';
                        return (
                          <button
                            aria-current={selected ? 'true' : undefined}
                            aria-label={`${formatProviderName(provider.providerId)}, ${providerStatusLabel(provider)}`}
                            className={`settings-provider-row ${selected ? 'is-selected' : ''}`}
                            key={provider.providerId}
                            onClick={() => selectProvider(provider.providerId)}
                            type="button"
                          >
                            <ProviderAvatar providerId={provider.providerId} />
                            <span className="settings-provider-name">{formatProviderName(provider.providerId)}</span>
                            {dotState ? (
                              <span className={`settings-provider-dot ${dotState}`} aria-hidden="true" />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="settings-provider-detail">
                    {showDetail ? (
                      <>
                        <div className="settings-provider-detail-header">
                          <div className="settings-provider-detail-id">
                            {creatingCustom ? (
                              <span className="settings-provider-avatar is-large" aria-hidden="true">+</span>
                            ) : (
                              <ProviderAvatar providerId={draft.providerId} large />
                            )}
                            <div className="settings-provider-detail-text">
                              <div className="settings-provider-detail-name">
                                {detailName}
                                {selectedChoice?.active ? (
                                  <span className="settings-provider-badge is-active">Active</span>
                                ) : hasSavedCredential ? (
                                  <span className="settings-provider-badge">Configured</span>
                                ) : null}
                              </div>
                              <span className="settings-provider-detail-desc">{detailDescription}</span>
                            </div>
                          </div>
                          {!selectedChoice?.active && hasAnyKey ? (
                            <ButtonControl
                              className="agent-settings-primary"
                              disabled={saving}
                              onClick={makeActive}
                            >
                              Set as Active
                            </ButtonControl>
                          ) : null}
                        </div>

                        {authInfo ? (
                          <div className="settings-provider-note">
                            <p>{authInfo.note}</p>
                            {authInfo.docsUrl ? (
                              <button
                                className="agent-settings-doc-link"
                                onClick={() => void api.openExternalUrl(authInfo.docsUrl as string)}
                                type="button"
                              >
                                <span>{authInfo.docsLabel ?? 'Learn more'}</span>
                                <OpenIcon size={ICON_SIZE.tiny} />
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <>
                            <div className="agent-settings-grid">
                              {showConnectionFields ? (
                                <FormField className="agent-settings-field agent-settings-field-wide" label="Provider ID">
                                  <TextInputControl
                                    label="Provider ID"
                                    onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value.trim() }))}
                                    placeholder="my-provider"
                                    value={draft.providerId}
                                  />
                                </FormField>
                              ) : null}

                              <FormField as="div" className="agent-settings-field agent-settings-field-wide" label="API key">
                                <div className="agent-settings-key-row">
                                  <PasswordIcon size={ICON_SIZE.menu} />
                                  <TextInputControl
                                    label="API key"
                                    onChange={(event) => setApiKey(event.target.value)}
                                    placeholder={hasAnyKey ? 'Configured (Encrypted)' : 'Paste API key'}
                                    type={revealKey ? 'text' : 'password'}
                                    value={apiKey}
                                  />
                                  <div className="agent-settings-key-actions">
                                    <button
                                      aria-label={revealKey ? 'Hide key' : 'Show key'}
                                      aria-pressed={revealKey}
                                      className="agent-settings-key-reveal"
                                      onClick={() => setRevealKey((current) => !current)}
                                      type="button"
                                    >
                                      {revealKey ? <HideIcon size={ICON_SIZE.menu} /> : <ShowIcon size={ICON_SIZE.menu} />}
                                    </button>
                                    {hasSavedCredential && (
                                      <button
                                        aria-label="Remove key"
                                        className="agent-settings-key-remove"
                                        disabled={saving}
                                        onClick={removeApiKey}
                                        type="button"
                                        title="Remove key"
                                      >
                                        <TrashIcon size={ICON_SIZE.menu} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                                <div className="agent-settings-key-meta">
                                  <span className="agent-settings-field-meta">{keyStatus}</span>
                                  {!hasSavedCredential && docsUrl ? (
                                    <button
                                      className="agent-settings-doc-link"
                                      onClick={() => void api.openExternalUrl(docsUrl)}
                                      type="button"
                                    >
                                      <span>Get API key</span>
                                      <OpenIcon size={ICON_SIZE.tiny} />
                                    </button>
                                  ) : null}
                                </div>
                              </FormField>
                            </div>

                            <details className="settings-url-details">
                              <summary className="settings-url-summary">Advanced Settings</summary>
                              <div className="settings-url-content">
                                {baseUrlField}
                              </div>
                            </details>
                          </>
                        )}

                        {canChooseModels ? (
                          <div className="settings-provider-model-section">
                            <h4 className="settings-detail-subheading">Model & Reasoning</h4>
                            <div className="agent-settings-grid">
                              <FormField className="agent-settings-field" label="Model">
                                {selectedModels.length > 0 ? (
                                  <SelectControl
                                    label="Model"
                                    onChange={(event) => {
                                      const modelId = event.target.value;
                                      const model = selectedModels.find((candidate) => candidate.id === modelId);
                                      const supportedLevels = (model?.supportedThinkingLevels.length
                                        ? model.supportedThinkingLevels
                                        : ['off']) as AgentReasoningLevel[];
                                      setDraft((current) => ({
                                        ...current,
                                        modelId,
                                        reasoningLevel: coerceReasoningLevel(current.reasoningLevel, supportedLevels),
                                      }));
                                    }}
                                    value={selectedModel ? draft.modelId : ''}
                                  >
                                    {selectedModel ? null : <option value="">Select a model…</option>}
                                    {selectedModels.map((model) => (
                                      <option key={model.id} value={model.id}>{model.name}</option>
                                    ))}
                                  </SelectControl>
                                ) : (
                                  <TextInputControl
                                    label="Model"
                                    onChange={(event) => setDraft((current) => ({ ...current, modelId: event.target.value }))}
                                    placeholder="Model ID"
                                    value={draft.modelId}
                                  />
                                )}
                              </FormField>

                              <FormField className="agent-settings-field" label="Reasoning">
                                <SelectControl
                                  label="Reasoning"
                                  onChange={(event) => {
                                    setDraft((current) => ({
                                      ...current,
                                      reasoningLevel: event.target.value as AgentReasoningLevel,
                                    }));
                                  }}
                                  value={coerceReasoningLevel(draft.reasoningLevel, selectedReasoningLevels)}
                                >
                                  {selectedReasoningLevels.map((reasoningLevel) => (
                                    <option key={reasoningLevel} value={reasoningLevel}>
                                      {REASONING_LABELS[reasoningLevel]}
                                    </option>
                                  ))}
                                </SelectControl>
                              </FormField>
                            </div>
                          </div>
                        ) : null}

                        <div className="connection-test-section">
                          <div className="connection-test-row">
                            <ButtonControl
                              className="agent-settings-secondary"
                              disabled={testingConnection || !draft.providerId}
                              onClick={testConnection}
                            >
                              {testingConnection ? 'Testing...' : 'Test Connection'}
                            </ButtonControl>
                          </div>
                          {testResult && (
                            <div className={`connection-test-feedback ${testResult.success ? 'is-success' : 'is-error'}`}>
                              {testResult.success ? (
                                <span className="feedback-text">✓ Connection Successful</span>
                              ) : (
                                <div className="feedback-error-container">
                                  <span className="feedback-text">✗ Connection Failed</span>
                                  <p className="feedback-diagnostic">{testResult.message}</p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="settings-provider-empty">Select a provider to connect.</div>
                    )}
                  </div>
                </div>
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
                            <button
                              className={`settings-agent-item-row ${isSelected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}`}
                              key={agent.name}
                              onClick={() => setSelectedAgentName(agent.name)}
                              type="button"
                            >
                              <span className="agent-item-switch" onClick={(e) => e.stopPropagation()}>
                                <SwitchControl
                                  checked={!disabled}
                                  onCheckedChange={() => toggleAgent(agent.name)}
                                  label={`Toggle ${agent.name}`}
                                >
                                  <SwitchMark checked={!disabled} />
                                </SwitchControl>
                              </span>
                              <span className="agent-item-content">
                                <span className="agent-item-name">{agent.name}</span>
                                <span className="agent-item-desc">{agent.description}</span>
                              </span>
                            </button>
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

            <footer className="agent-settings-footer">
              {category === 'providers' ? (
                <ButtonControl
                  className="agent-settings-danger"
                  disabled={saving || !configuredProvider}
                  onClick={removeProvider}
                  title="Remove provider"
                >
                  <TrashIcon size={ICON_SIZE.menu} />
                  <span>Remove provider</span>
                </ButtonControl>
              ) : <span />}
              <div className="agent-settings-footer-actions">
                <ButtonControl className="agent-settings-secondary" onClick={onClose}>
                  Cancel
                </ButtonControl>
                <ButtonControl className="agent-settings-primary" disabled={saving} onClick={save}>
                  {saving ? 'Saving...' : 'Save'}
                </ButtonControl>
              </div>
            </footer>
          </div>
        </div>
      )}
    </Dialog>
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

function defaultReasoningLevel(model: AgentModelOption | undefined): AgentReasoningLevel {
  const supportedLevels = model?.supportedThinkingLevels ?? ['off'];
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
}

function coerceReasoningLevel(
  reasoningLevel: AgentReasoningLevel,
  supportedLevels: AgentReasoningLevel[],
): AgentReasoningLevel {
  if (supportedLevels.includes(reasoningLevel)) return reasoningLevel;
  if (supportedLevels.includes('off')) return 'off';
  return supportedLevels[0] ?? 'off';
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
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
  const url = providerIconUrl(providerId);
  const className = `settings-provider-avatar${large ? ' is-large' : ''}${url ? ' has-logo' : ''}`;
  return (
    <span className={className} aria-hidden="true">
      {url ? <img className="settings-provider-logo" src={url} alt="" /> : providerInitial(providerId)}
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
