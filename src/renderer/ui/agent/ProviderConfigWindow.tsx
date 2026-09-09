import { useEffect, useId, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { providerConfigParamsFromSearch } from '../../../core/settingsWindow';
import { localGatewayProviderDefinition } from '../../../core/localGatewayProviders';
import { useT } from '../../i18n/I18nProvider';
import { formatProviderName, oauthSignInInfo, providerAuthInfo, PROVIDER_DOCS_URL, ProviderAvatar, providerHasCredential } from './providerCatalog';
import { providerCheckedAtText } from './providerStatus';
import { OAUTH_API_KEY_FALLBACK } from './providerOAuthCapabilities';
import { ProviderConfigForm, type ProviderConfigDraft, type ProviderFormActivity } from './ProviderConfigForm';
import { ProviderOAuthForm } from './ProviderOAuthForm';
import { Button } from '../primitives/Button';
import { ErrorState } from '../primitives/FeedbackState';
import { AddIcon, ICON_SIZE } from '../icons';

export function ProviderConfigWindow() {
  const t = useT();
  const { providerId, mode } = providerConfigParamsFromSearch(window.location.search);
  const titleId = useId();
  const [settings, setSettings] = useState<AgentProviderSettingsView | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [activity, setActivity] = useState<ProviderFormActivity>('idle');
  const close = () => { void window.lin?.closeProviderConfig?.(); };
  const providerName = mode === 'custom' ? t.providerCatalog.customProvider : formatProviderName(providerId);

  useEffect(() => {
    let active = true;
    setError('');
    api.agentGetProviderSettings()
      .then((next) => { if (active) setSettings(next); })
      .catch((caught) => { if (active) setError(String(caught instanceof Error ? caught.message : caught)); });
    return () => { active = false; };
  }, [attempt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      // A committed credential/config write must finish before this window goes
      // away. Testing and browser sign-in may still be cancelled by closing.
      if (activity !== 'saving') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activity]);

  return (
    <main className="provider-config-window" aria-labelledby={titleId} aria-busy={!settings && !error}>
      <header className="settings-sheet-head">
        <span aria-hidden="true" className="settings-sheet-avatar">
          {mode === 'custom'
            ? <span className="settings-provider-avatar is-large"><AddIcon size={ICON_SIZE.panel} /></span>
            : <ProviderAvatar large providerId={providerId} />}
        </span>
        <div className="settings-sheet-head-text">
          <h2 className="settings-sheet-title" id={titleId}>{providerName}</h2>
          {mode === 'custom' ? <p className="settings-sheet-subtitle">{t.providerCatalog.openAiCompatible}</p> : null}
        </div>
      </header>
      {settings ? (
        <ProviderConnection settings={settings} onSettingsChange={setSettings} providerId={providerId}
          mode={mode} onClose={close} onActivityChange={setActivity} providerName={providerName} />
      ) : (
        <>
          <div className="settings-sheet-body provider-config-loading-body">
            {error ? <ErrorState message={error} /> : <p className="settings-sheet-help" role="status">{t.common.loading}</p>}
          </div>
          <div className="settings-sheet-actions">
            <Button onClick={close} variant="ghost">{t.providerConfig.cancel}</Button>
            {error ? <Button onClick={() => setAttempt((value) => value + 1)}>{t.providerConfig.retry}</Button> : null}
          </div>
        </>
      )}
    </main>
  );
}

function ProviderConnection({ settings, onSettingsChange, providerId, providerName, mode, onClose, onActivityChange }: {
  settings: AgentProviderSettingsView;
  onSettingsChange: (settings: AgentProviderSettingsView) => void;
  providerId: string;
  providerName: string;
  mode: 'configure' | 'custom';
  onClose: () => void;
  onActivityChange: (activity: ProviderFormActivity) => void;
}) {
  const t = useT();
  const catalog = settings.availableProviders.find((provider) => provider.providerId === providerId);
  const existing = settings.providers.find((provider) => provider.providerId === providerId);
  const hasStoredKey = Boolean(existing?.auth?.hasStoredKey ?? existing?.hasApiKey);
  const authKind = mode === 'custom' ? 'api-key' : (catalog?.authKind ?? existing?.auth?.authKind ?? 'api-key');
  const dualAuth = authKind === 'oauth' && OAUTH_API_KEY_FALLBACK.has(providerId);
  const hasApiKeyCredential = hasStoredKey || Boolean(existing?.hasEnvApiKey || catalog?.hasEnvApiKey);
  const [method, setMethod] = useState<'account' | 'key'>(authKind === 'oauth' && !(dualAuth && hasApiKeyCredential) ? 'account' : 'key');
  const [busy, setBusy] = useState(false);
  const [autoFocus, setAutoFocus] = useState(true);
  const localGateway = localGatewayProviderDefinition(providerId);
  const initialBaseUrl = existing?.baseUrl ?? (localGateway ? catalog?.defaultBaseUrl ?? '' : '');
  const [draft, setDraft] = useState<ProviderConfigDraft>({ providerId, baseUrl: initialBaseUrl, apiKey: '' });
  const oauthInfo = oauthSignInInfo(providerId, t);
  const authNote = mode === 'custom' ? undefined : providerAuthInfo(providerId, t);

  function activityChanged(activity: ProviderFormActivity) {
    setBusy(activity !== 'idle');
    onActivityChange(activity);
  }
  async function handleValidate(next: ProviderConfigDraft) {
    return api.agentTestProviderConnection({ providerId: next.providerId.trim(), baseUrl: next.baseUrl.trim(),
      ...(next.apiKey.trim() ? { apiKey: next.apiKey.trim() } : {}) });
  }
  async function handleSubmit(next: ProviderConfigDraft) {
    const pid = next.providerId.trim();
    // Credential first: the durable row must never precede its credential. The
    // explicit test is optional; the existing background probe follows Save.
    if (next.apiKey.trim()) await api.agentSetProviderApiKey(pid, next.apiKey.trim());
    await api.agentUpsertProviderConfig({ providerId: pid, baseUrl: next.baseUrl.trim() || null,
      enabled: existing?.enabled ?? true }, { probeConnection: true });
  }

  return (
    <>
      {dualAuth ? (
        <fieldset className="settings-sheet-auth-method" disabled={busy}>
          <legend>{t.providerConfig.authentication}</legend>
          <label><input type="radio" name="authentication" checked={method === 'account'}
            onChange={() => { setAutoFocus(false); setMethod('account'); }} />{t.providerConfig.account}</label>
          <label><input type="radio" name="authentication" checked={method === 'key'}
            onChange={() => { setAutoFocus(false); setMethod('key'); }} />{t.providerConfig.apiKeyLabel}</label>
        </fieldset>
      ) : null}
      {authKind === 'oauth' && method === 'account' ? (
        <ProviderOAuthForm connected={Boolean(existing?.auth?.oauth?.connected)}
          expiresAt={existing?.auth?.oauth?.expiresAt} docsLabel={oauthInfo?.docsLabel} docsUrl={oauthInfo?.docsUrl}
          providerId={providerId} providerName={providerName} signInHint={oauthInfo?.hint}
          onClose={onClose} onOpenExternal={api.openExternalUrl} onProviderChange={onSettingsChange}
          onActivityChange={onActivityChange} onBusyChange={setBusy} />
      ) : (
        <ProviderConfigForm mode={mode} autoFocus={autoFocus} draft={draft} onDraftChange={setDraft}
          initialBaseUrl={initialBaseUrl} reservedProviderIds={[...settings.providers, ...settings.availableProviders].map((provider) => provider.providerId)}
          hasExisting={Boolean(existing)} defaultBaseUrl={catalog?.defaultBaseUrl}
          requiresEndpoint={!authNote && (mode === 'custom' || !catalog || Boolean(localGateway))}
          allowEndpointOverride={providerId !== 'cc-switch'}
          previousCheck={existing?.connectionCheck ? {
            success: existing.connectionCheck.outcome === 'ok',
            message: existing.connectionCheck.message ?? (existing.connectionCheck.outcome === 'ok'
              ? t.providerConfig.connectionSuccessful : t.providerConfig.validationFailed),
            checkedAt: providerCheckedAtText(existing.connectionCheck.at, Date.now(), t),
          } : undefined}
          authNote={authNote} docsUrl={mode === 'custom' ? undefined : PROVIDER_DOCS_URL[providerId]}
          hasCredential={dualAuth ? hasApiKeyCredential : providerHasCredential(existing, catalog)} hasStoredKey={hasStoredKey}
          onClose={onClose} onOpenExternal={api.openExternalUrl} onActivityChange={activityChanged}
          onSubmit={handleSubmit} onValidate={handleValidate} />
      )}
    </>
  );
}
