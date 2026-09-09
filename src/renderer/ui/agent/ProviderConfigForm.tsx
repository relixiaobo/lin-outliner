import { useEffect, useId, useRef, useState } from 'react';
import { CopyIcon, HideIcon, ICON_SIZE, LoaderIcon, OpenInBrowserIcon, ShowIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { ErrorState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
import { isLocalBaseUrl } from '../../../core/localEndpoint';

// Empty apiKey retains the saved credential. This draft belongs to the window so
// switching authentication methods does not discard an unfinished connection.
export interface ProviderConfigDraft {
  providerId: string;
  baseUrl: string;
  apiKey: string;
}
export interface ProviderConfigValidation {
  success: boolean;
  message: string;
}
export type ProviderFormActivity = 'idle' | 'testing' | 'saving';

interface ProviderConfigFormProps {
  mode: 'configure' | 'custom';
  autoFocus: boolean;
  draft: ProviderConfigDraft;
  onDraftChange: (draft: ProviderConfigDraft) => void;
  initialBaseUrl: string;
  reservedProviderIds: readonly string[];
  hasExisting: boolean;
  defaultBaseUrl?: string;
  requiresEndpoint: boolean;
  allowEndpointOverride: boolean;
  previousCheck?: ProviderConfigValidation & { checkedAt: string };
  hasCredential: boolean;
  hasStoredKey: boolean;
  authNote?: { note: string; docsUrl?: string; docsLabel?: string };
  docsUrl?: string;
  onValidate: (draft: ProviderConfigDraft) => Promise<ProviderConfigValidation>;
  onSubmit: (draft: ProviderConfigDraft) => Promise<void>;
  onLoadStoredApiKey?: () => Promise<string | undefined>;
  onActivityChange: (activity: ProviderFormActivity) => void;
  onOpenExternal: (url: string) => Promise<unknown>;
  onClose: () => void;
}

export function ProviderConfigForm({
  mode, autoFocus, draft, onDraftChange, initialBaseUrl, reservedProviderIds, hasExisting, defaultBaseUrl,
  requiresEndpoint, allowEndpointOverride, previousCheck, hasCredential, hasStoredKey, authNote, docsUrl,
  onValidate, onSubmit, onLoadStoredApiKey, onActivityChange, onOpenExternal, onClose,
}: ProviderConfigFormProps) {
  const t = useT();
  const ids = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const validationToken = useRef(0);
  const savingRef = useRef(false);
  const [activity, setActivity] = useState<ProviderFormActivity>('idle');
  const [result, setResult] = useState<ProviderConfigValidation | null>(null);
  const [saveError, setSaveError] = useState('');
  const [keyFeedback, setKeyFeedback] = useState<ProviderConfigValidation | null>(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [storedApiKey, setStoredApiKey] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(Boolean(draft.baseUrl && draft.baseUrl !== defaultBaseUrl));
  const saving = activity === 'saving';
  const testing = activity === 'testing';
  const isCustom = mode === 'custom';
  const endpoint = draft.baseUrl.trim();
  const duplicateId = isCustom && reservedProviderIds.includes(draft.providerId.trim());
  const hasEndpoint = !requiresEndpoint || Boolean(endpoint);
  let validEndpoint = !endpoint;
  try { validEndpoint = ['http:', 'https:'].includes(new URL(endpoint).protocol); } catch { /* Incomplete input stays editable. */ }
  const hasConnection = Boolean(authNote || draft.apiKey.trim() || hasCredential || isLocalBaseUrl(endpoint));
  const complete = Boolean(draft.providerId.trim()) && !duplicateId && hasEndpoint && validEndpoint && hasConnection;
  const dirty = !hasExisting || Boolean(draft.apiKey.trim()) || endpoint !== initialBaseUrl.trim();
  const canSave = complete && dirty && !saving && !keyLoading;
  const displayedResult = result ?? (!dirty && activity === 'idle' ? previousCheck : null);
  const showingStoredKey = reveal && !draft.apiKey && storedApiKey !== null;

  useEffect(() => {
    if (autoFocus) firstFieldRef.current?.focus();
    return () => { validationToken.current += 1; };
  }, [autoFocus]);

  function updateActivity(next: ProviderFormActivity) {
    setActivity(next);
    onActivityChange(next);
  }
  function updateDraft(patch: Partial<ProviderConfigDraft>) {
    validationToken.current += 1;
    if (testing) updateActivity('idle');
    setResult(null);
    setSaveError('');
    if ('apiKey' in patch) setKeyFeedback(null);
    onDraftChange({ ...draft, ...patch });
  }
  async function loadStoredApiKey() {
    if (storedApiKey !== null) return storedApiKey;
    if (!hasStoredKey || !onLoadStoredApiKey) return null;
    setKeyLoading(true);
    try {
      const key = await onLoadStoredApiKey();
      if (!key) throw new Error(t.providerConfig.savedKeyUnavailable);
      setStoredApiKey(key);
      return key;
    } catch (caught) {
      setKeyFeedback({ success: false, message: String(caught instanceof Error ? caught.message : caught) });
      return null;
    } finally { setKeyLoading(false); }
  }
  async function toggleReveal() {
    if (!reveal && hasStoredKey && !draft.apiKey && !await loadStoredApiKey()) return;
    setReveal((value) => !value);
  }
  async function copyApiKey() {
    const key = draft.apiKey.trim() || await loadStoredApiKey();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setKeyFeedback({ success: true, message: t.providerConfig.keyCopied });
    } catch (caught) {
      setKeyFeedback({ success: false, message: String(caught instanceof Error ? caught.message : caught) });
    }
  }
  async function openDocs(url: string) {
    try { await onOpenExternal(url); }
    catch (caught) { setKeyFeedback({ success: false, message: String(caught instanceof Error ? caught.message : caught) }); }
  }
  async function testConnection() {
    if (!complete || saving || testing) return;
    const token = ++validationToken.current;
    updateActivity('testing');
    setResult(null);
    try {
      const next = await onValidate(draft);
      if (token === validationToken.current) setResult(next);
    } catch (caught) {
      if (token === validationToken.current) setResult({ success: false, message: String(caught instanceof Error ? caught.message : caught) });
    } finally {
      if (token === validationToken.current) updateActivity('idle');
    }
  }
  async function save() {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    validationToken.current += 1;
    updateActivity('saving');
    setResult(null);
    setSaveError('');
    try {
      await onSubmit(draft);
      onClose();
    } catch (caught) {
      setSaveError(String(caught instanceof Error ? caught.message : caught));
    } finally {
      savingRef.current = false;
      updateActivity('idle');
    }
  }

  const endpointField = (
    <div className="settings-sheet-field">
      <label htmlFor={`${ids}-url`}>{t.providerConfig.baseUrlLabel}</label>
      <Input id={`${ids}-url`} label={t.providerConfig.baseUrlLabel} type="url"
        ref={authNote || requiresEndpoint && !isCustom ? firstFieldRef : undefined}
        value={draft.baseUrl} placeholder={defaultBaseUrl ?? 'https://api.example.com/v1'}
        disabled={saving} spellCheck={false} autoCapitalize="none" autoComplete="off"
        aria-describedby={`${ids}-url-hint`} aria-invalid={Boolean(endpoint && !validEndpoint)}
        onChange={(event) => updateDraft({ baseUrl: event.target.value })} />
      <p className="settings-sheet-help" id={`${ids}-url-hint`}>
        {endpoint && !validEndpoint ? t.providerConfig.invalidUrl
          : requiresEndpoint ? t.providerConfig.endpointRequired : t.providerConfig.endpointOptional}
      </p>
    </div>
  );

  return (
    <form className="settings-sheet-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="settings-sheet-body">
        {isCustom ? (
          <div className="settings-sheet-field">
            <label htmlFor={`${ids}-id`}>{t.providerConfig.providerIdLabel}</label>
            <Input id={`${ids}-id`} ref={firstFieldRef} label={t.providerConfig.providerIdLabel}
              value={draft.providerId} disabled={saving} autoComplete="off" spellCheck={false}
              aria-invalid={duplicateId} aria-describedby={`${ids}-id-hint`}
              placeholder={t.providerConfig.providerIdPlaceholder}
              onChange={(event) => updateDraft({ providerId: event.target.value })} />
            <p id={`${ids}-id-hint`} className="settings-sheet-help">{duplicateId ? t.providerConfig.duplicateId : t.providerConfig.providerIdHint}</p>
          </div>
        ) : null}
        {requiresEndpoint ? endpointField : null}
        {authNote ? (
          <div className="settings-sheet-note">
            <p>{authNote.note}</p>
            {authNote.docsUrl ? (
              <ButtonControl className="agent-settings-doc-link" onClick={() => void openDocs(authNote.docsUrl!)}>
                {authNote.docsLabel ?? t.providerConfig.learnMore}<OpenInBrowserIcon size={ICON_SIZE.tiny} />
              </ButtonControl>
            ) : null}
          </div>
        ) : (
          <div className="settings-sheet-field">
            <div className="settings-sheet-field-heading">
              <label htmlFor={`${ids}-key`}>{t.providerConfig.apiKeyLabel}</label>
              {docsUrl ? <ButtonControl className="agent-settings-doc-link" onClick={() => void openDocs(docsUrl)}>
                {t.providerConfig.getApiKey}<OpenInBrowserIcon size={ICON_SIZE.tiny} />
              </ButtonControl> : null}
            </div>
            <div className="settings-sheet-key">
              <Input id={`${ids}-key`} ref={!isCustom && !requiresEndpoint ? firstFieldRef : undefined}
                label={t.providerConfig.apiKeyLabel} value={draft.apiKey || (showingStoredKey ? storedApiKey : '')}
                type={reveal ? 'text' : 'password'} disabled={saving || keyLoading} readOnly={showingStoredKey}
                placeholder={hasStoredKey ? t.providerConfig.apiKeySavedPlaceholder : t.providerConfig.apiKeyPlaceholder}
                aria-describedby={`${ids}-key-hint`} autoComplete="off" autoCapitalize="none" spellCheck={false}
                onChange={(event) => updateDraft({ apiKey: event.target.value })} />
              <ButtonControl className="settings-sheet-reveal" disabled={saving || keyLoading}
                aria-label={reveal ? t.providerConfig.hideKey : t.providerConfig.showKey}
                title={reveal ? t.providerConfig.hideKey : t.providerConfig.showKey} onClick={() => void toggleReveal()}>
                {reveal ? <HideIcon size={ICON_SIZE.menu} /> : <ShowIcon size={ICON_SIZE.menu} />}
              </ButtonControl>
              {hasStoredKey || draft.apiKey ? (
                <ButtonControl className="settings-sheet-reveal" disabled={saving || keyLoading}
                  aria-label={t.providerConfig.copyKey} title={t.providerConfig.copyKey} onClick={() => void copyApiKey()}>
                  <CopyIcon size={ICON_SIZE.menu} />
                </ButtonControl>
              ) : null}
            </div>
            {showingStoredKey ? <Button className="settings-sheet-replace-key" size="sm" disabled={saving || keyLoading}
              onClick={() => { setReveal(false); document.getElementById(`${ids}-key`)?.focus(); }}>
              {t.providerConfig.replaceKey}
            </Button> : null}
            <p className="settings-sheet-help" id={`${ids}-key-hint`}>
              {hasStoredKey ? t.providerConfig.savedKeyHint : isLocalBaseUrl(endpoint) ? t.providerConfig.localKeyHint : hasCredential ? t.providerConfig.availableKeyHint : t.providerConfig.keyHint}
            </p>
          </div>
        )}
        {keyFeedback ? keyFeedback.success
          ? <p className="settings-sheet-help" role="status">{keyFeedback.message}</p>
          : <ErrorState message={keyFeedback.message} size="inline" /> : null}
        {allowEndpointOverride && !requiresEndpoint ? (
          <details className="settings-sheet-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
            <summary>{t.providerConfig.advanced}</summary>
            {endpointField}
          </details>
        ) : null}
        <section className="settings-sheet-test" aria-label={t.providerConfig.validate}>
          <div className="settings-sheet-test-action">
            <Button onClick={() => void testConnection()} disabled={!complete || saving || testing || keyLoading}>
              {testing ? <LoaderIcon className="settings-sheet-spinner" size={ICON_SIZE.menu} /> : null}
              {testing ? t.providerConfig.validating : t.providerConfig.validate}
            </Button>
            <p className="settings-sheet-help">{t.providerConfig.testHint}</p>
          </div>
          {displayedResult ? displayedResult.success
            ? <p className="settings-sheet-test-success" role="status">{displayedResult.message}</p>
            : <ErrorState message={displayedResult.message} size="inline" /> : null}
          {displayedResult === previousCheck && previousCheck ? <p className="settings-sheet-help">{previousCheck.checkedAt}</p> : null}
        </section>
      </div>
      <div className="settings-sheet-actions">
        {saveError ? <ErrorState className="settings-sheet-save-error" message={saveError} size="inline" /> : null}
        <div className="settings-sheet-actions-right">
          <Button disabled={saving} onClick={onClose} variant="ghost">{t.providerConfig.cancel}</Button>
          <Button type="submit" disabled={!canSave} variant="primary">{saving ? t.providerConfig.saving : t.providerConfig.save}</Button>
        </div>
      </div>
    </form>
  );
}
