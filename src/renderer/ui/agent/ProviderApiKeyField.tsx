import { useEffect, useId, useState, type Ref } from 'react';
import { previewProviderApiKey, type ProviderApiKeyPreview } from '../../../core/providerApiKeyPreview';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, HideIcon, ICON_SIZE, OpenInBrowserIcon, ShowIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { ErrorState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';

interface ProviderApiKeyFieldProps {
  providerId: string;
  value: string;
  hasStoredKey: boolean;
  hasCredential: boolean;
  local: boolean;
  disabled: boolean;
  inputRef?: Ref<HTMLInputElement>;
  docsUrl?: string;
  onChange: (value: string) => void;
  onBusyChange: (busy: boolean) => void;
  onOpenExternal: (url: string) => Promise<unknown>;
}

export function ProviderApiKeyField({
  providerId, value, hasStoredKey, hasCredential, local, disabled, inputRef,
  docsUrl, onChange, onBusyChange, onOpenExternal,
}: ProviderApiKeyFieldProps) {
  const t = useT();
  const id = useId();
  const [savedPreview, setSavedPreview] = useState<ProviderApiKeyPreview>();
  const [storedKey, setStoredKey] = useState<string>();
  const [reveal, setReveal] = useState(false);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const preview = value ? previewProviderApiKey(value.trim()) : savedPreview;
  const showPreview = !reveal && preview && (!value || !focused);
  const hint = hasStoredKey ? t.providerConfig.savedKeyHint
    : local ? t.providerConfig.localKeyHint : hasCredential ? t.providerConfig.availableKeyHint : '';
  const hasCaption = Boolean(copied || hint || preview);

  useEffect(() => {
    if (!hasStoredKey) return;
    let active = true;
    // This request returns only the prefix, suffix, mask and count. Full key
    // reads belong exclusively to the Show and Copy actions below.
    api.agentGetProviderApiKey(providerId, 'preview').then(({ preview }) => {
      if (active) setSavedPreview(preview);
    }).catch(() => {
      // The saved credential still works even if its preview is unavailable.
      // Keep the truthful "Saved key" placeholder and allow replacement/reveal.
    });
    return () => { active = false; };
  }, [providerId, hasStoredKey]);

  async function readStoredKey() {
    if (storedKey !== undefined) return storedKey;
    if (!hasStoredKey) return undefined;
    setLoading(true);
    onBusyChange(true);
    try {
      const { apiKey } = await api.agentGetProviderApiKey(providerId, 'reveal');
      if (!apiKey) throw new Error(t.providerConfig.savedKeyUnavailable);
      setStoredKey(apiKey);
      setSavedPreview(previewProviderApiKey(apiKey));
      return apiKey;
    } finally {
      setLoading(false);
      onBusyChange(false);
    }
  }
  async function perform(action: () => Promise<unknown>) {
    setError('');
    setCopied(false);
    try { await action(); }
    catch (caught) { setError(String(caught instanceof Error ? caught.message : caught)); }
  }
  async function toggleReveal() {
    if (!reveal && !value) await readStoredKey();
    setReveal((previous) => !previous);
  }
  async function copy() {
    const key = value.trim() || await readStoredKey();
    if (!key) return;
    await navigator.clipboard.writeText(key);
    setCopied(true);
  }

  return (
    <div className="settings-sheet-field">
      <div className="settings-sheet-field-heading">
        <label htmlFor={id}>{t.providerConfig.apiKeyLabel}</label>
        {docsUrl ? <ButtonControl className="agent-settings-doc-link" onClick={() => void perform(() => onOpenExternal(docsUrl))}>
          {t.providerConfig.getApiKey}<OpenInBrowserIcon size={ICON_SIZE.tiny} />
        </ButtonControl> : null}
      </div>
      <div className="settings-sheet-key" data-preview={Boolean(showPreview)}>
        <Input id={id} ref={inputRef} label={t.providerConfig.apiKeyLabel}
          value={value || (reveal ? storedKey ?? '' : '')} type={reveal ? 'text' : 'password'}
          disabled={disabled || loading}
          placeholder={showPreview ? '' : hasStoredKey ? t.providerConfig.savedKeyPlaceholder : t.providerConfig.apiKeyPlaceholder}
          aria-describedby={hasCaption ? `${id}-hint ${id}-length` : undefined} autoComplete="off" autoCapitalize="none" spellCheck={false}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          onChange={(event) => {
            setError('');
            setCopied(false);
            // Clearing a revealed saved key returns to "keep saved key"; the
            // display mask itself never becomes a credential draft.
            if (!event.target.value) setReveal(false);
            onChange(event.target.value);
          }} />
        {showPreview ? <span className="settings-sheet-key-preview" aria-hidden="true">
          <span>{preview.prefix}</span><span className="settings-sheet-key-mask">{preview.mask}</span><span>{preview.suffix}</span>
        </span> : null}
        <span className="settings-sheet-key-controls">
          <ButtonControl className="settings-sheet-reveal" disabled={disabled || loading}
            aria-label={reveal ? t.providerConfig.hideKey : t.providerConfig.showKey}
            title={reveal ? t.providerConfig.hideKey : t.providerConfig.showKey} onClick={() => void perform(toggleReveal)}>
            {reveal ? <HideIcon size={ICON_SIZE.menu} /> : <ShowIcon size={ICON_SIZE.menu} />}
          </ButtonControl>
          <ButtonControl className="settings-sheet-reveal" disabled={disabled || loading || !(hasStoredKey || value.trim())}
            aria-label={t.providerConfig.copyKey} title={t.providerConfig.copyKey} onClick={() => void perform(copy)}>
            <CopyIcon size={ICON_SIZE.menu} />
          </ButtonControl>
        </span>
      </div>
      {hasCaption ? <div className="settings-sheet-key-caption settings-sheet-help">
        <span id={`${id}-hint`} role="status">{copied ? t.providerConfig.keyCopied : hint}</span>
        <span id={`${id}-length`}>{preview ? t.providerConfig.keyLength({ count: preview.length }) : ''}</span>
      </div> : null}
      {error ? <ErrorState message={error} size="inline" /> : null}
    </div>
  );
}
