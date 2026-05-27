import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentModelOption,
  AgentPermissionMode,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
} from '../../api/types';
import { api } from '../../api/client';
import { HideIcon, ICON_SIZE, OpenIcon, PasswordIcon, ShowIcon, TrashIcon, WarningIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxControl } from '../primitives/CheckboxControl';
import { Dialog } from '../primitives/Dialog';
import { FormField } from '../primitives/FormField';
import { SelectControl } from '../primitives/SelectControl';
import { TextInputControl } from '../primitives/TextInputControl';

interface AgentSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => Promise<void>;
  restoreFocus?: () => HTMLElement | null;
}

type SettingsCategory = 'providers' | 'agent';

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
};

const SETTINGS_CATEGORIES: Array<{ id: SettingsCategory; label: string; hint: string }> = [
  { id: 'providers', label: 'Providers', hint: 'Connections & API keys' },
  { id: 'agent', label: 'Agent', hint: 'Model, reasoning & behavior' },
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

export function AgentSettingsDialog({ open, onApplied, onClose, restoreFocus }: AgentSettingsDialogProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [category, setCategory] = useState<SettingsCategory>('providers');
  const [creatingCustom, setCreatingCustom] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

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
  const canChooseModels = draft.enabled && (hasSavedCredential || hasPendingApiKey) && Boolean(draft.providerId);
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
  const modelContext = canChooseModels
    ? selectedModel?.contextWindow ? `${formatTokens(selectedModel.contextWindow)} context` : 'Custom model'
    : 'Key required';
  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draft.providerId, providerCatalog) : [],
    [draft.providerId, providerCatalog, settings],
  );
  const activeRowProviderId = creatingCustom ? '' : draft.providerId;
  const selectedChoice = providerChoices.find((choice) => choice.providerId === activeRowProviderId);
  const showDetail = creatingCustom || Boolean(draft.providerId);
  const detailName = creatingCustom
    ? 'Custom provider'
    : draft.providerId ? formatProviderName(draft.providerId) : '';
  const detailBadge = creatingCustom ? 'New' : selectedChoice ? providerStatusLabel(selectedChoice) : '';
  const detailBadgeActive = Boolean(selectedChoice?.active && selectedChoice.enabled && selectedChoice.hasCredential);
  const detailDescription = showConnectionFields
    ? 'Connect any OpenAI-compatible endpoint.'
    : providerDescription(selectedCatalog);
  const docsUrl = showConnectionFields ? undefined : PROVIDER_DOCS_URL[draft.providerId];
  const baseUrlPlaceholder = selectedCatalog?.defaultBaseUrl ?? 'https://api.example.com/v1';

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
    setRevealKey(false);
    setNotice(null);
    setError(null);
  }

  async function save() {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim() || selectedCatalog?.models[0]?.id || '';
    if (!providerId) {
      setError('provider is required');
      setCategory('providers');
      return;
    }
    if (!modelId) {
      setError('model is required');
      setCategory('agent');
      return;
    }

    const requestId = beginRequest();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      let next = await api.agentUpsertProviderConfig({
        providerId,
        modelId,
        reasoningLevel: coerceReasoningLevel(draft.reasoningLevel, selectedReasoningLevels),
        baseUrl: draft.baseUrl.trim() || null,
        enabled: draft.enabled,
      });
      next = await api.agentUpdateRuntimeSettings({
        permissionMode: draft.permissionMode,
        automaticSkillsEnabled: draft.automaticSkillsEnabled,
        slashSkillsEnabled: draft.slashSkillsEnabled,
        compactEnabled: draft.compactEnabled,
        additionalSkillDirectories: parseSkillDirectoryInput(draft.additionalSkillDirectoriesText),
      });
      next = await api.agentSetActiveProvider(providerId);
      if (apiKey.trim()) {
        await api.agentSetProviderApiKey(providerId, apiKey.trim());
        next = await api.agentGetProviderSettings();
      }
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        setDraft(resolveDraftForProvider(next, providerId));
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

  const headerSummary = canChooseModels && draft.providerId && draft.modelId
    ? `${draft.modelId} · ${formatProviderName(draft.providerId)}`
    : draft.providerId
      ? `${formatProviderName(draft.providerId)} · add an API key`
      : 'No provider connected';

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
        <div>
          <h2 id="agent-settings-title">Settings</h2>
          <p>{headerSummary}</p>
        </div>
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
              <section className="agent-settings-section settings-providers-section" aria-labelledby="agent-settings-provider-heading">
                <div className="agent-settings-section-header">
                  <h3 id="agent-settings-provider-heading">Providers</h3>
                  <span>Where requests go and the key they use.</span>
                </div>

                <div className="settings-providers">
                  <div className="settings-provider-list" role="list" aria-label="Available providers">
                    {providerChoices.map((provider) => {
                      const selected = provider.providerId === activeRowProviderId;
                      const ready = provider.enabled && provider.hasCredential;
                      const dotState = provider.active && ready
                        ? 'is-active'
                        : ready ? 'is-ready' : provider.configured ? 'is-warn' : '';
                      return (
                        <button
                          aria-current={selected ? 'true' : undefined}
                          aria-label={`${formatProviderName(provider.providerId)}, ${providerStatusLabel(provider)}`}
                          className={`settings-provider-row ${selected ? 'is-selected' : ''}`}
                          key={provider.providerId}
                          onClick={() => selectProvider(provider.providerId)}
                          type="button"
                        >
                          <span className="settings-provider-avatar" aria-hidden="true">
                            {providerInitial(provider.providerId)}
                          </span>
                          <span className="settings-provider-name">{formatProviderName(provider.providerId)}</span>
                          <span className={`settings-provider-dot ${dotState}`} aria-hidden="true" />
                        </button>
                      );
                    })}
                    <button
                      aria-current={creatingCustom ? 'true' : undefined}
                      aria-label="Custom provider, OpenAI-compatible"
                      className={`settings-provider-row ${creatingCustom ? 'is-selected' : ''}`}
                      onClick={startCustomProvider}
                      type="button"
                    >
                      <span className="settings-provider-avatar" aria-hidden="true">+</span>
                      <span className="settings-provider-name">Custom</span>
                      <span className="settings-provider-dot" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="settings-provider-detail">
                    {showDetail ? (
                      <>
                        <div className="settings-provider-detail-header">
                          <div className="settings-provider-detail-id">
                            <span className="settings-provider-avatar is-large" aria-hidden="true">
                              {creatingCustom ? '+' : providerInitial(draft.providerId)}
                            </span>
                            <div className="settings-provider-detail-text">
                              <div className="settings-provider-detail-name">
                                {detailName}
                                {detailBadge ? (
                                  <span className={`settings-provider-badge ${detailBadgeActive ? 'is-active' : ''}`}>
                                    {detailBadge}
                                  </span>
                                ) : null}
                              </div>
                              <span className="settings-provider-detail-desc">{detailDescription}</span>
                            </div>
                          </div>
                          <CheckboxControl
                            checked={draft.enabled}
                            className="agent-settings-checkbox"
                            onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
                          >
                            <span>Enabled</span>
                          </CheckboxControl>
                        </div>

                        <div className="agent-settings-grid">
                          {showConnectionFields ? (
                            <FormField className="agent-settings-field" label="Provider ID">
                              <TextInputControl
                                label="Provider ID"
                                onChange={(event) => setDraft((current) => ({ ...current, providerId: event.target.value.trim() }))}
                                placeholder="my-provider"
                                value={draft.providerId}
                              />
                            </FormField>
                          ) : null}

                          <FormField
                            className={`agent-settings-field ${showConnectionFields ? '' : 'agent-settings-field-wide'}`}
                            label="Base URL"
                          >
                            <TextInputControl
                              label="Base URL"
                              onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                              placeholder={baseUrlPlaceholder}
                              value={draft.baseUrl}
                            />
                            <span className="agent-settings-field-meta">Leave empty to use the default endpoint.</span>
                          </FormField>

                          <FormField as="div" className="agent-settings-field agent-settings-field-wide" label="API key">
                            <div className="agent-settings-key-line">
                              <div className="agent-settings-key-row">
                                <PasswordIcon size={ICON_SIZE.menu} />
                                <TextInputControl
                                  label="API key"
                                  onChange={(event) => setApiKey(event.target.value)}
                                  placeholder={hasAnyKey ? 'Configured' : 'Paste key'}
                                  type={revealKey ? 'text' : 'password'}
                                  value={apiKey}
                                />
                                <button
                                  aria-label={revealKey ? 'Hide key' : 'Show key'}
                                  aria-pressed={revealKey}
                                  className="agent-settings-key-reveal"
                                  onClick={() => setRevealKey((current) => !current)}
                                  type="button"
                                >
                                  {revealKey
                                    ? <HideIcon size={ICON_SIZE.menu} />
                                    : <ShowIcon size={ICON_SIZE.menu} />}
                                </button>
                              </div>
                              <ButtonControl
                                className="agent-settings-secondary"
                                disabled={saving || !configuredProvider?.hasApiKey}
                                onClick={removeApiKey}
                              >
                                Remove key
                              </ButtonControl>
                            </div>
                            <div className="agent-settings-key-meta">
                              <span className="agent-settings-field-meta">{keyStatus}</span>
                              {docsUrl ? (
                                <button
                                  className="agent-settings-doc-link"
                                  onClick={() => void api.openExternalUrl(docsUrl)}
                                  type="button"
                                >
                                  <span>Get your {detailName} API key</span>
                                  <OpenIcon size={ICON_SIZE.tiny} />
                                </button>
                              ) : null}
                            </div>
                          </FormField>
                        </div>
                      </>
                    ) : (
                      <div className="settings-provider-empty">Select a provider to connect.</div>
                    )}
                  </div>
                </div>
              </section>
            ) : (
              <>
                <section className="agent-settings-section" aria-labelledby="agent-settings-model-heading">
                  <div className="agent-settings-section-header">
                    <h3 id="agent-settings-model-heading">Model</h3>
                    <span>{draft.providerId ? `${modelContext} · ${formatProviderName(draft.providerId)}` : modelContext}</span>
                  </div>
                  {canChooseModels ? (
                    <div className="agent-settings-grid">
                      <FormField className="agent-settings-field agent-settings-field-wide" label="Model">
                        {selectedModels.length > 0 ? (
                          <SelectControl
                            label="Model"
                            onChange={(event) => {
                              const modelId = event.target.value;
                              const model = selectedModels.find((candidate) => candidate.id === modelId);
                              const supportedLevels: AgentReasoningLevel[] = model?.supportedThinkingLevels.length
                                ? model.supportedThinkingLevels
                                : ['off'];
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
                            placeholder="model id"
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

                      <div className="agent-settings-model-stat">
                        <span>Context</span>
                        <strong>{modelContext}</strong>
                      </div>
                    </div>
                  ) : (
                    <div className="agent-settings-model-placeholder">
                      Add an API key in Providers before choosing a model.
                    </div>
                  )}
                </section>

                <section className="agent-settings-section" aria-labelledby="agent-settings-behavior-heading">
                  <div className="agent-settings-section-header">
                    <h3 id="agent-settings-behavior-heading">Behavior</h3>
                    <span>{draft.permissionMode === 'trusted' ? 'Trusted workspace' : 'Restricted tools'}</span>
                  </div>
                  <div className="agent-settings-grid">
                    <FormField className="agent-settings-field" label="Permission mode">
                      <SelectControl
                        label="Permission mode"
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          permissionMode: event.target.value === 'restricted' ? 'restricted' : 'trusted',
                        }))}
                        value={draft.permissionMode}
                      >
                        <option value="trusted">Trusted</option>
                        <option value="restricted">Restricted</option>
                      </SelectControl>
                    </FormField>

                    <FormField className="agent-settings-field agent-settings-field-wide" label="Additional skill directories">
                      <TextInputControl
                        label="Additional skill directories"
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          additionalSkillDirectoriesText: event.target.value,
                        }))}
                        placeholder="Optional paths, comma separated"
                        value={draft.additionalSkillDirectoriesText}
                      />
                      <span className="agent-settings-field-meta">
                        Default directories stay enabled: ~/.agents/skills and .agents/skills.
                      </span>
                    </FormField>

                    <div className="agent-settings-row agent-settings-field-wide">
                      <CheckboxControl
                        checked={draft.automaticSkillsEnabled}
                        className="agent-settings-checkbox"
                        onCheckedChange={(automaticSkillsEnabled) => setDraft((current) => ({ ...current, automaticSkillsEnabled }))}
                      >
                        <span>Automatic skills</span>
                      </CheckboxControl>
                      <CheckboxControl
                        checked={draft.slashSkillsEnabled}
                        className="agent-settings-checkbox"
                        onCheckedChange={(slashSkillsEnabled) => setDraft((current) => ({ ...current, slashSkillsEnabled }))}
                      >
                        <span>Slash skills</span>
                      </CheckboxControl>
                      <CheckboxControl
                        checked={draft.compactEnabled}
                        className="agent-settings-checkbox"
                        onCheckedChange={(compactEnabled) => setDraft((current) => ({ ...current, compactEnabled }))}
                      >
                        <span>Compact command</span>
                      </CheckboxControl>
                    </div>
                  </div>
                </section>
              </>
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
  google: 'Google Gemini',
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

function formatProviderName(providerId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[providerId];
  if (known) return known;
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || providerId;
}

function providerInitial(providerId: string): string {
  return (formatProviderName(providerId).trim()[0] ?? '?').toUpperCase();
}

function providerDescription(catalog: AgentProviderOption | undefined): string {
  if (!catalog || catalog.models.length === 0) return 'Connect any OpenAI-compatible endpoint.';
  const names = catalog.models.slice(0, 3).map((model) => model.name);
  const suffix = catalog.models.length > names.length ? ', and more' : '';
  return `Includes ${names.join(', ')}${suffix}.`;
}
