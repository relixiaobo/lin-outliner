import { useEffect, useMemo, useState } from 'react';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentProviderOption,
  AgentProviderSettingsView,
  AgentReasoningLevel,
} from '../../api/types';
import { api } from '../../api/client';
import { ICON_SIZE, PasswordIcon, TrashIcon, WarningIcon } from '../icons';

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    void api.agentGetProviderSettings()
      .then((next) => {
        if (cancelled) return;
        setSettings(next);
        setDraft(resolveInitialDraft(next));
        setApiKey('');
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
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
      setSettings(next);
      setDraft(resolveDraftForProvider(next, providerId));
      setApiKey('');
      setNotice('Saved');
      await onApplied();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function removeApiKey() {
    const providerId = draft.providerId.trim();
    if (!providerId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.agentDeleteProviderApiKey(providerId);
      const next = await api.agentGetProviderSettings();
      setSettings(next);
      setDraft(resolveDraftForProvider(next, providerId));
      setNotice('Key removed');
      await onApplied();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function removeProvider() {
    const providerId = draft.providerId.trim();
    if (!providerId || !configuredProvider) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.agentDeleteProviderConfig(providerId);
      setSettings(next);
      setDraft(resolveInitialDraft(next));
      setApiKey('');
      setNotice('Provider removed');
      await onApplied();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      aria-modal="true"
      className="agent-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
    >
      <section className="agent-settings-dialog">
        <header className="agent-settings-header">
          <div>
            <h2>Agent settings</h2>
            <p>{draft.providerId && draft.modelId ? `${draft.providerId}/${draft.modelId}` : 'No model configured'}</p>
          </div>
          <button className="agent-settings-close" onClick={onClose} type="button">
            Close
          </button>
        </header>

        {loading ? (
          <div className="agent-settings-empty">Loading...</div>
        ) : (
          <>
            <div className="agent-settings-provider-list">
              {settings?.providers.map((provider) => (
                <button
                  className={`agent-settings-provider-pill ${provider.providerId === draft.providerId ? 'is-active' : ''}`}
                  key={provider.providerId}
                  onClick={() => updateProvider(provider.providerId)}
                  type="button"
                >
                  <span>{provider.providerId}</span>
                  <small>{provider.modelId}</small>
                </button>
              ))}
            </div>

            <label className="agent-settings-field">
              <span>Provider</span>
              <input
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
            </label>

            <label className="agent-settings-field">
              <span>Model</span>
              <input
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
            </label>

            <label className="agent-settings-field">
              <span>Reasoning</span>
              <select
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
              </select>
            </label>

            <label className="agent-settings-field">
              <span>Base URL</span>
              <input
                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="Optional OpenAI-compatible endpoint"
                value={draft.baseUrl}
              />
            </label>

            <label className="agent-settings-field">
              <span>API key</span>
              <div className="agent-settings-key-row">
                <PasswordIcon size={ICON_SIZE.menu} />
                <input
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={hasAnyKey ? 'Configured' : 'Paste key'}
                  type="password"
                  value={apiKey}
                />
              </div>
            </label>

            <div className="agent-settings-row">
              <label className="agent-settings-checkbox">
                <input
                  checked={draft.enabled}
                  onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                  type="checkbox"
                />
                <span>Enabled</span>
              </label>
              {selectedModel ? (
                <span className="agent-settings-model-meta">
                  {formatTokens(selectedModel.contextWindow)} context
                </span>
              ) : null}
            </div>

            {error ? (
              <div className="agent-settings-alert" role="alert">
                <WarningIcon size={14} />
                <span>{error}</span>
              </div>
            ) : null}
            {notice ? <div className="agent-settings-notice">{notice}</div> : null}

            <footer className="agent-settings-footer">
              <button
                className="agent-settings-danger"
                disabled={saving || !configuredProvider}
                onClick={removeProvider}
                title="Remove provider"
                type="button"
              >
                <TrashIcon size={ICON_SIZE.menu} />
                <span>Remove</span>
              </button>
              <button
                className="agent-settings-secondary"
                disabled={saving || !configuredProvider?.hasApiKey}
                onClick={removeApiKey}
                type="button"
              >
                Remove key
              </button>
              <button className="agent-settings-secondary" onClick={onClose} type="button">
                Cancel
              </button>
              <button className="agent-settings-primary" disabled={saving} onClick={save} type="button">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
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
