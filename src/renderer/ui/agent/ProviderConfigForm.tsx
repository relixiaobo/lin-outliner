import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, CopyIcon, HideIcon, ICON_SIZE, LoaderIcon, OpenIcon, PasswordIcon, ShowIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ErrorState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
import { isLocalBaseUrl } from '../../../core/localEndpoint';

// The draft committed by Save. `apiKey` empty means "leave the saved key
// unchanged"; a non-empty value replaces it. A provider is a CONNECTION only —
// credentials + endpoint. The model/effort that runs is chosen on the agent
// profile (built-in assistant default or a user/project agent), never here.
export interface ProviderConfigDraft {
  providerId: string;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderConfigValidation {
  success: boolean;
  message: string;
}

interface AuthNote {
  note: string;
  docsUrl?: string;
  docsLabel?: string;
}

interface ProviderConfigFormProps {
  mode: 'configure' | 'custom';
  providerName: string;
  description: string;
  avatar: ReactNode;
  defaultBaseUrl?: string;
  baseUrlPlaceholder: string;
  initial: { providerId: string; baseUrl: string };
  hasCredential: boolean;
  hasStoredKey: boolean;
  isActive: boolean;
  /** Managed-credential providers (e.g. AWS Bedrock) show a note instead of a key field. */
  authNote?: AuthNote;
  docsUrl?: string;
  titleId: string;
  onValidate: (draft: ProviderConfigDraft) => Promise<ProviderConfigValidation>;
  onSubmit: (draft: ProviderConfigDraft) => Promise<void>;
  onLoadStoredApiKey?: () => Promise<string | undefined>;
  onSetActive?: () => void;
  onRemoveProvider?: () => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
}

type FormStatus = 'idle' | 'validating' | 'success' | 'error' | 'saving';

// The per-provider connection form. Rendered as the whole content of the native
// provider-config window (a modal child of Settings — the macOS idiom where a list
// row opens a real dialog, not an in-renderer overlay). It proves a CONNECTION:
// credentials, optional base URL, and a Test connection probe. The model/effort
// that runs is chosen on the agent profile, never here. Custom providers enter a
// provider id (no catalog to default from). Selection / focus stay neutral (B3/B4);
// Save is a single neutral-strong primary, never a system-blue accent (B4);
// validation uses status colour only (B4).
export function ProviderConfigForm({
  mode,
  providerName,
  description,
  avatar,
  defaultBaseUrl,
  baseUrlPlaceholder,
  initial,
  hasCredential,
  hasStoredKey,
  isActive,
  authNote,
  docsUrl,
  titleId,
  onValidate,
  onSubmit,
  onLoadStoredApiKey,
  onSetActive,
  onRemoveProvider,
  onOpenExternal,
  onClose,
}: ProviderConfigFormProps) {
  const t = useT();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const validationToken = useRef(0);
  const isCustom = mode === 'custom';

  const [providerId, setProviderId] = useState(initial.providerId);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [storedApiKey, setStoredApiKey] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<FormStatus>('idle');
  const [keyLoading, setKeyLoading] = useState(false);
  const [message, setMessage] = useState('');

  // The window owns focus, so autofocus the first field on mount (the Dialog used
  // to do this for the old in-renderer sheet).
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const validating = status === 'validating';
  const saving = status === 'saving';
  const busy = validating || saving || keyLoading;

  const trimmedProviderId = providerId.trim();
  const showKeyField = !authNote;
  const draft: ProviderConfigDraft = {
    providerId: isCustom ? trimmedProviderId : initial.providerId,
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
  };
  // A managed provider (authNote) persists a row with nothing to fill in; an
  // api-key / custom provider needs credentials unless the base URL is a local
  // endpoint. A keyless remote proxy has no way to authenticate, so we block
  // saving one rather than persist an unusable connection (startup reconcile
  // keeps any baseUrl row it finds — it does not prune keyless-remote).
  const hasConnection = Boolean(draft.apiKey) || hasCredential || isLocalBaseUrl(draft.baseUrl);
  const canSave = Boolean(draft.providerId)
    && (authNote ? true : hasConnection)
    && !busy;
  const canValidate = Boolean(draft.providerId) && !busy;
  const showingStoredKey = reveal && !apiKey && storedApiKey !== null;
  const apiKeyDisplayValue = apiKey || (showingStoredKey ? storedApiKey : '');

  function clearResult() {
    validationToken.current += 1;
    if (status !== 'idle' && status !== 'saving') {
      setStatus('idle');
      setMessage('');
    }
  }

  async function loadStoredApiKey(): Promise<string | null> {
    if (storedApiKey !== null) return storedApiKey;
    if (!hasStoredKey || !onLoadStoredApiKey) return null;
    setKeyLoading(true);
    try {
      const key = await onLoadStoredApiKey();
      if (!key) throw new Error(t.providerConfig.savedKeyUnavailable);
      setStoredApiKey(key);
      return key;
    } catch (caught) {
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setKeyLoading(false);
    }
  }

  async function toggleReveal() {
    if (!reveal && hasStoredKey && !apiKey) {
      const key = await loadStoredApiKey();
      if (!key) return;
    }
    setReveal((current) => !current);
  }

  async function copyApiKey() {
    const key = apiKey.trim() || (await loadStoredApiKey());
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setStatus('success');
      setMessage(t.providerConfig.keyCopied);
    } catch (caught) {
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function runValidate() {
    if (!canValidate) return;
    const token = ++validationToken.current;
    setStatus('validating');
    setMessage('');
    try {
      const result = await onValidate(draft);
      if (validationToken.current !== token) return; // cancelled or superseded
      setStatus(result.success ? 'success' : 'error');
      setMessage(result.message);
    } catch (caught) {
      if (validationToken.current !== token) return;
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function cancelValidate() {
    validationToken.current += 1;
    setStatus('idle');
    setMessage('');
  }

  async function runSave() {
    if (!canSave) return;
    validationToken.current += 1;
    setStatus('saving');
    setMessage('');
    try {
      await onSubmit(draft);
      onClose();
    } catch (caught) {
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <>
      <header className="settings-sheet-head">
        <span aria-hidden="true" className="settings-sheet-avatar">{avatar}</span>
        <div className="settings-sheet-head-text">
          <h2 className="settings-sheet-title" id={titleId}>
            {providerName}
            {isActive ? <span className="settings-chip">{t.providerConfig.activeChip}</span> : null}
          </h2>
          <p className="settings-sheet-subtitle">{description}</p>
        </div>
      </header>

      <div className="settings-sheet-body">
        {authNote ? (
          <div className="settings-sheet-note">
            <p>{authNote.note}</p>
            {authNote.docsUrl ? (
              <button
                className="agent-settings-doc-link"
                onClick={() => onOpenExternal(authNote.docsUrl as string)}
                type="button"
              >
                <span>{authNote.docsLabel ?? t.providerConfig.learnMore}</span>
                <OpenIcon size={ICON_SIZE.tiny} />
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="inset-card" role="group">
          {isCustom ? (
            <label className="settings-sheet-row">
              <span className="settings-sheet-row-label">{t.providerConfig.providerIdLabel}</span>
              <Input
                className="settings-sheet-row-input"
                label={t.providerConfig.providerIdLabel}
                onChange={(event) => { setProviderId(event.target.value.trim()); clearResult(); }}
                placeholder={t.providerConfig.providerIdPlaceholder}
                ref={firstFieldRef}
                value={providerId}
                variant="bare"
              />
            </label>
          ) : null}
          {showKeyField ? (
            <div className="settings-sheet-row">
              <div className="settings-sheet-key">
                <PasswordIcon size={ICON_SIZE.menu} />
                <Input
                  className="settings-sheet-row-input"
                  label={t.providerConfig.apiKeyLabel}
                  onChange={(event) => { setApiKey(event.target.value); clearResult(); }}
                  placeholder={hasStoredKey ? t.providerConfig.apiKeySavedPlaceholder : t.providerConfig.apiKeyPlaceholder}
                  readOnly={showingStoredKey}
                  ref={isCustom ? undefined : firstFieldRef}
                  type={reveal ? 'text' : 'password'}
                  value={apiKeyDisplayValue}
                  variant="bare"
                />
                {apiKey || hasStoredKey ? (
                  <button
                    aria-label={t.providerConfig.copyKey}
                    className="settings-sheet-reveal"
                    disabled={busy}
                    onClick={() => void copyApiKey()}
                    type="button"
                  >
                    {keyLoading ? <LoaderIcon size={ICON_SIZE.menu} /> : <CopyIcon size={ICON_SIZE.menu} />}
                  </button>
                ) : null}
                <button
                  aria-label={reveal ? t.providerConfig.hideKey : t.providerConfig.showKey}
                  aria-pressed={reveal}
                  className="settings-sheet-reveal"
                  disabled={busy}
                  onClick={() => void toggleReveal()}
                  type="button"
                >
                  {reveal ? <HideIcon size={ICON_SIZE.menu} /> : <ShowIcon size={ICON_SIZE.menu} />}
                </button>
              </div>
            </div>
          ) : null}
          <label className="settings-sheet-row">
            <span className="settings-sheet-row-label">{t.providerConfig.baseUrlLabel}</span>
            <Input
              className="settings-sheet-row-input"
              label={t.providerConfig.baseUrlLabel}
              onChange={(event) => { setBaseUrl(event.target.value); clearResult(); }}
              placeholder={defaultBaseUrl || baseUrlPlaceholder}
              value={baseUrl}
              variant="bare"
            />
          </label>
        </div>
        {!authNote && !hasCredential && docsUrl ? (
          <button className="agent-settings-doc-link settings-sheet-getkey" onClick={() => onOpenExternal(docsUrl)} type="button">
            <span>{t.providerConfig.getApiKey}</span>
            <OpenIcon size={ICON_SIZE.tiny} />
          </button>
        ) : null}

        {validating ? (
          <div className="settings-sheet-result" role="status">
            <LoaderIcon className="settings-sheet-spinner" size={ICON_SIZE.menu} />
            <span className="settings-sheet-result-text">{t.providerConfig.validating}</span>
            <Button onClick={cancelValidate} size="sm" variant="ghost">{t.providerConfig.cancel}</Button>
          </div>
        ) : status === 'success' ? (
          <div className="settings-sheet-result is-success" role="status">
            <span className="settings-sheet-result-text">
              <CheckIcon size={ICON_SIZE.menu} aria-hidden />
              <span>{message || t.providerConfig.connectionSuccessful}</span>
            </span>
          </div>
        ) : status !== 'idle' && status !== 'saving' ? (
          <ErrorState
            className="settings-sheet-result"
            message={message || t.providerConfig.validationFailed}
            size="inline"
          />
        ) : null}
      </div>

      <div className="settings-sheet-actions">
        <div className="settings-sheet-actions-left">
          {onRemoveProvider ? (
            <Button disabled={busy} onClick={onRemoveProvider} variant="danger">
              {t.providerConfig.removeProvider}
            </Button>
          ) : null}
          {onSetActive && !isActive ? (
            <Button disabled={busy} onClick={onSetActive} variant="secondary">
              {t.providerConfig.setActive}
            </Button>
          ) : null}
        </div>
        <div className="settings-sheet-actions-right">
          <Button disabled={saving} onClick={onClose} variant="ghost">
            {t.providerConfig.cancel}
          </Button>
          <Button disabled={!canValidate} onClick={runValidate} variant="secondary">
            {validating ? t.providerConfig.validating : t.providerConfig.validate}
          </Button>
          <Button disabled={!canSave} onClick={runSave} variant="primary">
            {saving ? t.providerConfig.saving : t.providerConfig.save}
          </Button>
        </div>
      </div>
    </>
  );
}
