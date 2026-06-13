import { useEffect, useId, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { providerConfigParamsFromSearch } from '../../../core/settingsWindow';
import { useT } from '../../i18n/I18nProvider';
import { defaultReasoningLevel } from './settingsReasoning';
import {
  formatProviderName,
  getFallbackModelId,
  OAUTH_API_KEY_FALLBACK,
  oauthSignInInfo,
  providerAuthInfo,
  PROVIDER_DOCS_URL,
  ProviderAvatar,
  providerDescription,
  providerHasCredential,
  resolveUsableActiveProvider,
} from './providerCatalog';
import { ProviderConfigForm, type ProviderConfigDraft } from './ProviderConfigForm';
import { ProviderOAuthForm } from './ProviderOAuthForm';
import { EmptyState, ErrorState } from '../primitives/FeedbackState';
import { LoaderIcon } from '../icons';

// Root rendered in the dedicated per-provider config window (?surface=provider-config),
// a modal child of the settings window. It fetches its own provider settings, derives
// the connection context for the target provider (from the URL query), and commits via
// the existing agent IPC — then tells the main process to broadcast a settings-changed
// so the settings list (and the main window) re-fetch. Closing is delegated to the
// main process (the window has no chrome of its own — it is a dialog).
export function ProviderConfigWindow() {
  const t = useT();
  const { providerId, mode } = providerConfigParamsFromSearch(window.location.search);
  const isCustom = mode === 'custom';
  const titleId = useId();
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Anthropic accepts both a sign-in and a console key; this escape hatch swaps the
  // OAuth surface for the standard key form within the session.
  const [useApiKey, setUseApiKey] = useState(false);

  useEffect(() => {
    let active = true;
    api.agentGetProviderSettings()
      .then((next) => { if (active) setSettings(next); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { active = false; };
  }, []);

  const close = () => { void window.lin?.closeProviderConfig?.(); };

  // Escape closes the dialog (mirrors the native Cancel), like every other overlay.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (error) {
    return (
      <main className="provider-config-window" aria-label={t.window.providerConfigTitle}>
        <ErrorState message={error} />
      </main>
    );
  }
  if (!settings) {
    return (
      <main className="provider-config-window" aria-label={t.window.providerConfigTitle}>
        <EmptyState icon={LoaderIcon} loading role="status" title={t.common.loading} />
      </main>
    );
  }

  const catalog = settings.availableProviders.find((provider) => provider.providerId === providerId);
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  const activeId = resolveUsableActiveProvider(settings)?.providerId ?? '';
  const isActive = Boolean(providerId) && providerId === activeId;
  const hasSavedKey = providerHasCredential(existing, catalog);
  const authNote = isCustom ? undefined : providerAuthInfo(providerId, t);
  const docsUrl = isCustom ? undefined : PROVIDER_DOCS_URL[providerId];
  // Auth class comes from main (`authKind`), falling back to the configured view's
  // descriptor for a provider with no catalog row. Custom providers are always api-key.
  const authKind = isCustom ? 'api-key' : (catalog?.authKind ?? existing?.auth?.authKind ?? 'api-key');
  const showOAuth = authKind === 'oauth' && !useApiKey;
  const oauthInfo = oauthSignInInfo(providerId, t);

  async function handleValidate(draft: ProviderConfigDraft) {
    const pid = draft.providerId.trim() || providerId;
    const result = await api.agentTestProviderConnection({
      providerId: pid,
      modelId: draft.modelId.trim() || existing?.modelId || catalog?.models[0]?.id || getFallbackModelId(pid),
      baseUrl: draft.baseUrl.trim() || undefined,
      apiKey: draft.apiKey.trim() || undefined,
    });
    return { success: result.success, message: result.message };
  }

  // Commit the connection plus the built-in assistant's global model/reasoning.
  // User/project agent model overrides live in Agent Profile settings instead.
  async function handleSubmit(draft: ProviderConfigDraft) {
    const pid = draft.providerId.trim() || providerId;
    if (!pid) return;
    const modelId = draft.modelId.trim() || existing?.modelId || catalog?.models[0]?.id || '';
    const model = catalog?.models.find((candidate) => candidate.id === modelId) ?? catalog?.models[0];
    const supportedLevels = model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : [draft.reasoningLevel];
    const reasoningLevel = supportedLevels.includes(draft.reasoningLevel)
      ? draft.reasoningLevel
      : defaultReasoningLevel(model);
    // Store the credential BEFORE creating the row, so a crash between the two
    // writes leaves no keyless orphan row (and the row is durably credentialed the
    // moment it exists). The Save button is gated on a credential or base URL
    // (ProviderConfigForm), so a keyless no-op row is never created here.
    if (draft.apiKey.trim()) {
      await api.agentSetProviderApiKey(pid, draft.apiKey.trim());
    }
    await api.agentUpsertProviderConfig({
      providerId: pid,
      modelId,
      reasoningLevel,
      baseUrl: draft.baseUrl.trim() || null,
      enabled: true,
    });
    await window.lin?.notifySettingsChanged?.();
  }

  async function runMutation(action: () => Promise<unknown>) {
    try {
      await action();
      await window.lin?.notifySettingsChanged?.();
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  if (showOAuth) {
    return (
      <main className="provider-config-window" aria-labelledby={titleId}>
        <ProviderOAuthForm
          avatar={<ProviderAvatar large providerId={providerId} />}
          connected={Boolean(existing?.auth?.oauth?.connected)}
          description={providerDescription(catalog, t)}
          docsLabel={oauthInfo?.docsLabel}
          docsUrl={oauthInfo?.docsUrl}
          expiresAt={existing?.auth?.oauth?.expiresAt}
          isActive={isActive}
          onClose={close}
          onOpenExternal={(url) => void api.openExternalUrl(url)}
          onSetActive={hasSavedKey && !isActive
            ? () => void runMutation(() => api.agentSetActiveProvider(providerId))
            : undefined}
          onSettingsChanged={(next) => { setSettings(next); void window.lin?.notifySettingsChanged?.(); }}
          onUseApiKey={OAUTH_API_KEY_FALLBACK.has(providerId) ? () => setUseApiKey(true) : undefined}
          providerId={providerId}
          providerName={formatProviderName(providerId)}
          signInHint={oauthInfo?.hint}
          titleId={titleId}
        />
      </main>
    );
  }

  return (
    <main className="provider-config-window" aria-labelledby={titleId}>
      <ProviderConfigForm
        authNote={authNote}
        avatar={isCustom
          ? <span className="settings-provider-avatar is-large" aria-hidden="true">+</span>
          : <ProviderAvatar large providerId={providerId} />}
        baseUrlPlaceholder={catalog?.defaultBaseUrl ?? 'https://api.example.com/v1'}
        defaultBaseUrl={catalog?.defaultBaseUrl}
        description={isCustom ? t.providerCatalog.openAiCompatible : providerDescription(catalog, t)}
        docsUrl={docsUrl}
        hasSavedKey={hasSavedKey}
        initial={{
          providerId,
          modelId: existing?.modelId ?? catalog?.models[0]?.id ?? '',
          reasoningLevel: existing?.reasoningLevel ?? defaultReasoningLevel(catalog?.models[0]),
          baseUrl: existing?.baseUrl ?? '',
        }}
        isActive={isActive}
        mode={mode}
        modelOptions={catalog?.models}
        onClose={close}
        onOpenExternal={(url) => void api.openExternalUrl(url)}
        onRemoveProvider={!isCustom && existing
          ? () => void runMutation(() => api.agentDeleteProviderConfig(providerId))
          : undefined}
        onSetActive={!isCustom && hasSavedKey && !isActive
          ? () => void runMutation(() => api.agentSetActiveProvider(providerId))
          : undefined}
        onSubmit={handleSubmit}
        onValidate={handleValidate}
        providerName={isCustom ? t.providerCatalog.customProvider : (providerId ? formatProviderName(providerId) : t.providerCatalog.customProvider)}
        titleId={titleId}
      />
    </main>
  );
}
