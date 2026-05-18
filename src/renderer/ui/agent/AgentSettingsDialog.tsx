import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
} from '../../api/types';
import { api } from '../../api/client';
import { ICON_SIZE, PasswordIcon, TrashIcon, WarningIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { CheckboxMark } from '../primitives/CheckboxMark';
import { Dialog } from '../primitives/Dialog';
import { FormField } from '../primitives/FormField';
import { SelectControl } from '../primitives/SelectControl';
import { TextInputControl } from '../primitives/TextInputControl';

interface AgentSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onApplied: () => Promise<void>;
}

interface DraftConfig {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl: string;
  enabled: boolean;
}

interface ProviderChoice {
  providerId: string;
  modelId: string;
  configured: boolean;
  active: boolean;
}

const EMPTY_DRAFT: DraftConfig = {
  providerId: '',
  modelId: '',
  reasoningLevel: 'off',
  baseUrl: '',
  enabled: true,
};

const PREFERRED_PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'openrouter'];
const REASONING_LABELS: Record<AgentReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
};

export function AgentSettingsDialog({ open, onApplied, onClose }: AgentSettingsDialogProps) {
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [draft, setDraft] = useState<DraftConfig>(EMPTY_DRAFT);
  const [apiKey, setApiKey] = useState('');
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
  const selectedModels = selectedCatalog?.models ?? [];
  const selectedModel = selectedModels.find((model) => model.id === draft.modelId);
  const selectedReasoningLevels: AgentReasoningLevel[] = selectedModel?.supportedThinkingLevels.length
    ? selectedModel.supportedThinkingLevels
    : ['off'];
  const hasAnyKey = Boolean(configuredProvider?.hasApiKey || configuredProvider?.hasEnvApiKey || selectedCatalog?.hasEnvApiKey);
  const keyStatus = configuredProvider?.hasApiKey
    ? 'Saved key'
    : configuredProvider?.hasEnvApiKey || selectedCatalog?.hasEnvApiKey ? 'Environment key' : 'No key';
  const modelContext = selectedModel?.contextWindow ? `${formatTokens(selectedModel.contextWindow)} context` : 'Custom model';
  const providerChoices = useMemo(
    () => settings ? buildProviderChoices(settings, draft.providerId) : [],
    [draft.providerId, settings],
  );

  if (!open) return null;

  function updateProvider(providerId: string) {
    const existing = settings?.providers.find((provider) => provider.providerId === providerId);
    const catalog = providerCatalog.get(providerId);
    setDraft({
      providerId,
      modelId: existing?.modelId ?? catalog?.models[0]?.id ?? '',
      reasoningLevel: existing?.reasoningLevel ?? defaultReasoningLevel(catalog?.models[0]),
      baseUrl: existing?.baseUrl ?? '',
      enabled: existing?.enabled ?? true,
    });
    setApiKey('');
    setNotice(null);
    setError(null);
  }

  async function save() {
    const providerId = draft.providerId.trim();
    const modelId = draft.modelId.trim();
    if (!providerId) {
      setError('provider is required');
      return;
    }
    if (!modelId) {
      setError('model is required');
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
      next = await api.agentSetActiveProvider(providerId);
      if (apiKey.trim()) {
        await api.agentSetProviderApiKey(providerId, apiKey.trim());
        next = await api.agentGetProviderSettings();
      }
      if (isCurrentRequest(requestId)) {
        setSettings(next);
        setDraft(resolveDraftForProvider(next, providerId));
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

  return (
    <Dialog
      backdropClassName="agent-settings-backdrop"
      labelledBy="agent-settings-title"
      onBackdropMouseDown={onClose}
      onEscapeKeyDown={onClose}
      surfaceClassName="agent-settings-dialog"
    >
      <header className="agent-settings-header">
        <div>
          <h2 id="agent-settings-title">Agent settings</h2>
          <p>{draft.providerId && draft.modelId ? `${draft.providerId}/${draft.modelId}` : 'No model configured'}</p>
        </div>
        <ButtonControl className="agent-settings-close" onClick={onClose}>
          Close
        </ButtonControl>
      </header>

      {loading ? (
        <div className="agent-settings-empty">Loading...</div>
      ) : (
        <div className="agent-settings-body">
          <section className="agent-settings-section" aria-labelledby="agent-settings-provider-heading">
            <div className="agent-settings-section-header">
              <h3 id="agent-settings-provider-heading">Provider</h3>
            </div>
            <div className="agent-settings-provider-list">
              {providerChoices.map((provider) => (
                <ButtonControl
                  className={`agent-settings-provider-pill ${provider.providerId === draft.providerId ? 'is-active' : ''}`}
                  key={provider.providerId}
                  onClick={() => updateProvider(provider.providerId)}
                >
                  <span className="agent-settings-provider-title">
                    {formatProviderName(provider.providerId)}
                    <span className={provider.active ? 'agent-settings-provider-state is-active' : 'agent-settings-provider-state'}>
                      {provider.active ? 'Active' : provider.configured ? 'Configured' : 'Available'}
                    </span>
                  </span>
                  <small>{provider.modelId || 'No model'}</small>
                </ButtonControl>
              ))}
            </div>
          </section>

          <section className="agent-settings-section" aria-labelledby="agent-settings-connection-heading">
            <div className="agent-settings-section-header">
              <h3 id="agent-settings-connection-heading">Connection</h3>
              <span>{keyStatus}</span>
            </div>
            <div className="agent-settings-grid">
              <FormField className="agent-settings-field" label="Provider ID">
                <TextInputControl
                  label="Provider ID"
                  list="agent-provider-options"
                  onChange={(event) => updateProvider(event.target.value)}
                  placeholder="anthropic"
                  value={draft.providerId}
                />
                <datalist id="agent-provider-options">
                  {settings?.availableProviders.map((provider) => (
                    <option key={provider.providerId} value={provider.providerId} />
                  ))}
                </datalist>
              </FormField>
              <FormField className="agent-settings-field" label="Base URL">
                <TextInputControl
                  label="Base URL"
                  onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  placeholder="Optional OpenAI-compatible endpoint"
                  value={draft.baseUrl}
                />
              </FormField>

              <FormField as="div" className="agent-settings-field agent-settings-field-wide" label="API key">
                <div className="agent-settings-key-line">
                  <div className="agent-settings-key-row">
                    <PasswordIcon size={ICON_SIZE.menu} />
                    <TextInputControl
                      label="API key"
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder={hasAnyKey ? 'Configured' : 'Paste key'}
                      type="password"
                      value={apiKey}
                    />
                  </div>
                  <ButtonControl
                    className="agent-settings-secondary"
                    disabled={saving || !configuredProvider?.hasApiKey}
                    onClick={removeApiKey}
                  >
                    Remove key
                  </ButtonControl>
                </div>
                <span className="agent-settings-field-meta">{keyStatus}</span>
              </FormField>

              <div className="agent-settings-row agent-settings-field-wide">
                <label className="agent-settings-checkbox">
                  <input
                    checked={draft.enabled}
                    onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                    type="checkbox"
                  />
                  <CheckboxMark checked={draft.enabled} />
                  <span>Enabled</span>
                </label>
              </div>
            </div>
          </section>

          <section className="agent-settings-section" aria-labelledby="agent-settings-model-heading">
            <div className="agent-settings-section-header">
              <h3 id="agent-settings-model-heading">Model behavior</h3>
              <span>{modelContext}</span>
            </div>
            <div className="agent-settings-grid">
              <FormField className="agent-settings-field agent-settings-field-wide" label="Model ID">
                <TextInputControl
                  label="Model ID"
                  list="agent-model-options"
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
                  placeholder="model id"
                  value={draft.modelId}
                />
                <datalist id="agent-model-options">
                  {selectedModels.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </datalist>
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
          </section>

          {error ? (
            <div className="agent-settings-alert" role="alert">
              <WarningIcon size={14} />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? <div className="agent-settings-notice">{notice}</div> : null}

          <footer className="agent-settings-footer">
            <ButtonControl
              className="agent-settings-danger"
              disabled={saving || !configuredProvider}
              onClick={removeProvider}
              title="Remove provider"
            >
              <TrashIcon size={ICON_SIZE.menu} />
              <span>Remove provider</span>
            </ButtonControl>
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
      )}
    </Dialog>
  );
}

function resolveInitialDraft(settings: AgentProviderSettingsView): DraftConfig {
  const activeProviderId = settings.activeProviderId;
  const active = activeProviderId
    ? settings.providers.find((provider) => provider.providerId === activeProviderId)
    : undefined;
  const existing = active ?? settings.providers[0];
  if (existing) return providerToDraft(existing);

  const preferredCatalog = PREFERRED_PROVIDER_ORDER
    .map((providerId) => settings.availableProviders.find((provider) => provider.providerId === providerId))
    .find(Boolean) ?? settings.availableProviders[0];
  return {
    providerId: preferredCatalog?.providerId ?? 'anthropic',
    modelId: preferredCatalog?.models[0]?.id ?? '',
    reasoningLevel: defaultReasoningLevel(preferredCatalog?.models[0]),
    baseUrl: '',
    enabled: true,
  };
}

function resolveDraftForProvider(settings: AgentProviderSettingsView, providerId: string): DraftConfig {
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  if (existing) return providerToDraft(existing);
  return resolveInitialDraft(settings);
}

function buildProviderChoices(settings: AgentProviderSettingsView, draftProviderId: string): ProviderChoice[] {
  const activeProviderId = settings.activeProviderId
    ?? settings.providers.find((provider) => provider.enabled)?.providerId
    ?? settings.providers[0]?.providerId
    ?? '';
  const choices = new Map<string, ProviderChoice>();

  for (const catalog of settings.availableProviders) {
    const configured = settings.providers.find((provider) => provider.providerId === catalog.providerId);
    choices.set(catalog.providerId, {
      providerId: catalog.providerId,
      modelId: configured?.modelId ?? catalog.models[0]?.id ?? '',
      configured: Boolean(configured),
      active: catalog.providerId === activeProviderId,
    });
  }

  for (const provider of settings.providers) {
    choices.set(provider.providerId, {
      providerId: provider.providerId,
      modelId: provider.modelId,
      configured: true,
      active: provider.providerId === activeProviderId,
    });
  }

  if (draftProviderId && !choices.has(draftProviderId)) {
    choices.set(draftProviderId, {
      providerId: draftProviderId,
      modelId: '',
      configured: false,
      active: draftProviderId === activeProviderId,
    });
  }

  return [...choices.values()].sort(compareProviderChoices);
}

function compareProviderChoices(left: ProviderChoice, right: ProviderChoice): number {
  if (left.active !== right.active) return left.active ? -1 : 1;
  if (left.configured !== right.configured) return left.configured ? -1 : 1;
  const leftPreferred = preferredProviderIndex(left.providerId);
  const rightPreferred = preferredProviderIndex(right.providerId);
  if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
  return formatProviderName(left.providerId).localeCompare(formatProviderName(right.providerId), undefined, {
    sensitivity: 'base',
  });
}

function preferredProviderIndex(providerId: string): number {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(providerId);
  return index >= 0 ? index : PREFERRED_PROVIDER_ORDER.length;
}

function providerToDraft(provider: AgentProviderConfigView): DraftConfig {
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    reasoningLevel: provider.reasoningLevel,
    baseUrl: provider.baseUrl ?? '',
    enabled: provider.enabled,
  };
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

function formatProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || providerId;
}
