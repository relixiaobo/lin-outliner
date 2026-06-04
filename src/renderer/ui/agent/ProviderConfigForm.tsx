import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HideIcon, ICON_SIZE, LoaderIcon, OpenIcon, PasswordIcon, ShowIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { TextInputControl } from '../primitives/TextInputControl';

// The draft committed by Save. `apiKey` empty means "leave the saved key
// unchanged"; a non-empty value replaces it. `modelId` is only entered for custom
// providers (a catalog provider's model is chosen in the composer, not here); the
// host supplies a sensible default on commit for catalog providers.
export interface ProviderConfigDraft {
  providerId: string;
  modelId: string;
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
  initial: { providerId: string; modelId: string; baseUrl: string };
  hasSavedKey: boolean;
  isActive: boolean;
  /** Managed-credential providers (e.g. AWS Bedrock) show a note instead of a key field. */
  authNote?: AuthNote;
  docsUrl?: string;
  titleId: string;
  onValidate: (draft: ProviderConfigDraft) => Promise<ProviderConfigValidation>;
  onSubmit: (draft: ProviderConfigDraft) => Promise<void>;
  onSetActive?: () => void;
  onRemoveProvider?: () => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
}

type FormStatus = 'idle' | 'validating' | 'success' | 'error' | 'saving';

// The per-provider connection form. Rendered as the whole content of the native
// provider-config window (a modal child of Settings — the macOS idiom where a list
// row opens a real dialog, not an in-renderer overlay). It hosts only the
// CONNECTION: the credential (API key / managed note) and the base URL, in a single
// inset card — model & reasoning are chosen in the composer, so it stays minimal.
// Custom providers also enter a provider id + model id (no catalog to default
// from). Selection / focus stay neutral (B3/B4); Save is a single neutral-strong
// primary, never a system-blue accent (B4); validation uses status colour only (B4).
export function ProviderConfigForm({
  mode,
  providerName,
  description,
  avatar,
  defaultBaseUrl,
  baseUrlPlaceholder,
  initial,
  hasSavedKey,
  isActive,
  authNote,
  docsUrl,
  titleId,
  onValidate,
  onSubmit,
  onSetActive,
  onRemoveProvider,
  onOpenExternal,
  onClose,
}: ProviderConfigFormProps) {
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const validationToken = useRef(0);
  const isCustom = mode === 'custom';

  const [providerId, setProviderId] = useState(initial.providerId);
  const [modelId, setModelId] = useState(initial.modelId);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<FormStatus>('idle');
  const [message, setMessage] = useState('');

  // The window owns focus, so autofocus the first field on mount (the Dialog used
  // to do this for the old in-renderer sheet).
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  const validating = status === 'validating';
  const saving = status === 'saving';
  const busy = validating || saving;

  const trimmedProviderId = providerId.trim();
  const showKeyField = !authNote;
  const draft: ProviderConfigDraft = {
    providerId: isCustom ? trimmedProviderId : initial.providerId,
    modelId: modelId.trim(),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
  };
  // A managed provider (authNote) persists a row with nothing to fill in; an
  // api-key / custom provider needs a credential or a base URL, or the saved row is
  // a keyless no-op the startup reconcile prunes — a confusing "saved, then gone".
  const hasConnection = Boolean(draft.apiKey) || hasSavedKey || Boolean(draft.baseUrl);
  const canSave = Boolean(draft.providerId)
    && (isCustom ? Boolean(draft.modelId) : true)
    && (authNote ? true : hasConnection)
    && !busy;
  const canValidate = Boolean(draft.providerId) && !busy;

  function clearResult() {
    validationToken.current += 1;
    if (status !== 'idle' && status !== 'saving') {
      setStatus('idle');
      setMessage('');
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
            {isActive ? <span className="settings-provider-badge is-active">Active</span> : null}
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
                <span>{authNote.docsLabel ?? 'Learn more'}</span>
                <OpenIcon size={ICON_SIZE.tiny} />
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="inset-card" role="group">
              {isCustom ? (
                <label className="settings-sheet-row">
                  <span className="settings-sheet-row-label">Provider ID</span>
                  <TextInputControl
                    className="settings-sheet-row-input"
                    label="Provider ID"
                    onChange={(event) => { setProviderId(event.target.value.trim()); clearResult(); }}
                    placeholder="my-provider"
                    ref={firstFieldRef}
                    value={providerId}
                  />
                </label>
              ) : null}
              {showKeyField ? (
                <div className="settings-sheet-row">
                  <div className="settings-sheet-key">
                    <PasswordIcon size={ICON_SIZE.menu} />
                    <TextInputControl
                      className="settings-sheet-row-input"
                      label="API key"
                      onChange={(event) => { setApiKey(event.target.value); clearResult(); }}
                      placeholder={hasSavedKey ? 'Saved (encrypted) — paste to replace' : 'Paste API key'}
                      ref={isCustom ? undefined : firstFieldRef}
                      type={reveal ? 'text' : 'password'}
                      value={apiKey}
                    />
                    <button
                      aria-label={reveal ? 'Hide key' : 'Show key'}
                      aria-pressed={reveal}
                      className="settings-sheet-reveal"
                      onClick={() => setReveal((current) => !current)}
                      type="button"
                    >
                      {reveal ? <HideIcon size={ICON_SIZE.menu} /> : <ShowIcon size={ICON_SIZE.menu} />}
                    </button>
                  </div>
                </div>
              ) : null}
              {isCustom ? (
                <label className="settings-sheet-row">
                  <span className="settings-sheet-row-label">Model</span>
                  <TextInputControl
                    className="settings-sheet-row-input"
                    label="Model"
                    onChange={(event) => { setModelId(event.target.value); clearResult(); }}
                    placeholder="Model ID"
                    value={modelId}
                  />
                </label>
              ) : null}
              <label className="settings-sheet-row">
                <span className="settings-sheet-row-label">Base URL</span>
                <TextInputControl
                  className="settings-sheet-row-input"
                  label="Base URL"
                  onChange={(event) => { setBaseUrl(event.target.value); clearResult(); }}
                  placeholder={defaultBaseUrl || baseUrlPlaceholder}
                  value={baseUrl}
                />
              </label>
            </div>
            {!hasSavedKey && docsUrl ? (
              <button className="agent-settings-doc-link settings-sheet-getkey" onClick={() => onOpenExternal(docsUrl)} type="button">
                <span>Get API key</span>
                <OpenIcon size={ICON_SIZE.tiny} />
              </button>
            ) : null}
          </>
        )}

        {status !== 'idle' && status !== 'saving' ? (
          <div className={`settings-sheet-result is-${status}`} role="status">
            {validating ? (
              <>
                <LoaderIcon className="settings-sheet-spinner" size={ICON_SIZE.menu} />
                <span className="settings-sheet-result-text">Validating…</span>
                <button className="settings-sheet-cancel-test" onClick={cancelValidate} type="button">Cancel</button>
              </>
            ) : status === 'success' ? (
              <span className="settings-sheet-result-text">✓ {message || 'Connection successful'}</span>
            ) : (
              <span className="settings-sheet-result-text">✗ {message || 'Validation failed'}</span>
            )}
          </div>
        ) : null}
      </div>

      <div className="settings-sheet-actions">
        <div className="settings-sheet-actions-left">
          {onRemoveProvider ? (
            <ButtonControl className="settings-sheet-danger" disabled={busy} onClick={onRemoveProvider}>
              Remove provider
            </ButtonControl>
          ) : null}
          {onSetActive && !isActive ? (
            <ButtonControl className="settings-sheet-secondary" disabled={busy} onClick={onSetActive}>
              Set as Active
            </ButtonControl>
          ) : null}
        </div>
        <div className="settings-sheet-actions-right">
          <ButtonControl className="settings-sheet-secondary" disabled={saving} onClick={onClose}>
            Cancel
          </ButtonControl>
          <ButtonControl className="settings-sheet-secondary" disabled={!canValidate} onClick={runValidate}>
            {validating ? 'Validating…' : 'Validate'}
          </ButtonControl>
          <ButtonControl className="settings-sheet-primary" disabled={!canSave} onClick={runSave}>
            {saving ? 'Saving…' : 'Save'}
          </ButtonControl>
        </div>
      </div>
    </>
  );
}
