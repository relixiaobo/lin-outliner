import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentModelOption, AgentReasoningLevel } from '../../api/types';
import { HideIcon, ICON_SIZE, LoaderIcon, OpenIcon, PasswordIcon, ShowIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { Dialog } from '../primitives/Dialog';
import { SelectControl } from '../primitives/SelectControl';
import { TextInputControl } from '../primitives/TextInputControl';
import { REASONING_LABELS, coerceReasoningLevel } from './settingsReasoning';

// The draft committed by the sheet's Save. `apiKey` empty means "leave the saved
// key unchanged"; a non-empty value replaces it.
export interface ProviderSheetDraft {
  providerId: string;
  modelId: string;
  reasoningLevel: AgentReasoningLevel;
  baseUrl: string;
  apiKey: string;
}

export interface ProviderSheetValidation {
  success: boolean;
  message: string;
}

interface AuthNote {
  note: string;
  docsUrl?: string;
  docsLabel?: string;
}

interface SettingsProviderSheetProps {
  mode: 'configure' | 'custom';
  providerName: string;
  description: string;
  avatar: ReactNode;
  models: AgentModelOption[];
  defaultBaseUrl?: string;
  baseUrlPlaceholder: string;
  initial: { providerId: string; modelId: string; reasoningLevel: AgentReasoningLevel; baseUrl: string };
  hasSavedKey: boolean;
  isActive: boolean;
  /** Managed-credential providers (e.g. AWS Bedrock) show a note instead of a key field. */
  authNote?: AuthNote;
  docsUrl?: string;
  onValidate: (draft: ProviderSheetDraft) => Promise<ProviderSheetValidation>;
  onSubmit: (draft: ProviderSheetDraft) => Promise<void>;
  onSetActive?: () => void;
  onRemoveProvider?: () => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
  restoreFocus?: () => HTMLElement | null;
}

type SheetStatus = 'idle' | 'validating' | 'success' | 'error' | 'saving';

// The per-provider configuration SHEET. Clicking a provider in the inset list (or
// "Configure" in its row menu) opens this focused sheet — the macOS System
// Settings idiom where a list row pushes its detail into an overlay rather than a
// permanent side pane. It hosts the whole provider config: credential (API key /
// managed note / base URL), model & reasoning, an async + cancellable validate,
// and its own Cancel / Save. Built on the shared Dialog at the dialog elevation
// tier (level-2, B10). Selection / focus stay neutral (B3/B4); the Save action is
// a single neutral-strong primary, never a system-blue accent (B4); validation
// status uses status colour for status only (B4).
export function SettingsProviderSheet({
  mode,
  providerName,
  description,
  avatar,
  models,
  defaultBaseUrl,
  baseUrlPlaceholder,
  initial,
  hasSavedKey,
  isActive,
  authNote,
  docsUrl,
  onValidate,
  onSubmit,
  onSetActive,
  onRemoveProvider,
  onOpenExternal,
  onClose,
  restoreFocus,
}: SettingsProviderSheetProps) {
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const validationToken = useRef(0);
  const isCustom = mode === 'custom';

  const [providerId, setProviderId] = useState(initial.providerId);
  const [modelId, setModelId] = useState(initial.modelId);
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>(initial.reasoningLevel);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [status, setStatus] = useState<SheetStatus>('idle');
  const [message, setMessage] = useState('');

  const validating = status === 'validating';
  const saving = status === 'saving';
  const busy = validating || saving;

  const selectedModel = useMemo(() => models.find((model) => model.id === modelId), [models, modelId]);
  const reasoningLevels: AgentReasoningLevel[] = selectedModel?.supportedThinkingLevels.length
    ? selectedModel.supportedThinkingLevels
    : ['off'];

  const trimmedProviderId = providerId.trim();
  // Managed-credential providers carry no key; custom and catalog key providers do.
  const showKeyField = !authNote;
  const draft: ProviderSheetDraft = {
    providerId: isCustom ? trimmedProviderId : initial.providerId,
    modelId: modelId.trim(),
    reasoningLevel: coerceReasoningLevel(reasoningLevel, reasoningLevels),
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
  };
  const canSave = Boolean(draft.providerId) && Boolean(draft.modelId) && !busy;
  const canValidate = Boolean(draft.providerId) && !busy && (showKeyField ? true : true);

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
    <Dialog
      backdropClassName="settings-sheet-backdrop"
      initialFocus={() => firstFieldRef.current}
      labelledBy={titleId}
      onBackdropMouseDown={busy ? undefined : onClose}
      onEscapeKeyDown={busy ? undefined : onClose}
      restoreFocus={restoreFocus}
      surfaceClassName="settings-provider-sheet"
    >
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
        {isCustom ? (
          <div className="inset-card" role="group">
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
          </div>
        ) : null}

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
        ) : showKeyField ? (
          <div className="inset-card" role="group">
            <div className="settings-sheet-row">
              <span className="settings-sheet-row-label">API key</span>
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
            {!hasSavedKey && docsUrl ? (
              <div className="settings-sheet-row is-footnote">
                <button className="agent-settings-doc-link" onClick={() => onOpenExternal(docsUrl)} type="button">
                  <span>Get API key</span>
                  <OpenIcon size={ICON_SIZE.tiny} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {models.length > 0 || isCustom ? (
          <div className="inset-card" role="group">
            <label className="settings-sheet-row">
              <span className="settings-sheet-row-label">Model</span>
              {models.length > 0 ? (
                <SelectControl
                  className="settings-sheet-row-input"
                  label="Model"
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const model = models.find((candidate) => candidate.id === nextId);
                    const levels = (model?.supportedThinkingLevels.length ? model.supportedThinkingLevels : ['off']) as AgentReasoningLevel[];
                    setModelId(nextId);
                    setReasoningLevel((current) => coerceReasoningLevel(current, levels));
                    clearResult();
                  }}
                  value={selectedModel ? modelId : ''}
                >
                  {selectedModel ? null : <option value="">Select a model…</option>}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.name}</option>
                  ))}
                </SelectControl>
              ) : (
                <TextInputControl
                  className="settings-sheet-row-input"
                  label="Model"
                  onChange={(event) => { setModelId(event.target.value); clearResult(); }}
                  placeholder="Model ID"
                  value={modelId}
                />
              )}
            </label>
            <label className="settings-sheet-row">
              <span className="settings-sheet-row-label">Reasoning</span>
              <SelectControl
                className="settings-sheet-row-input"
                label="Reasoning"
                onChange={(event) => setReasoningLevel(event.target.value as AgentReasoningLevel)}
                value={coerceReasoningLevel(reasoningLevel, reasoningLevels)}
              >
                {reasoningLevels.map((level) => (
                  <option key={level} value={level}>{REASONING_LABELS[level]}</option>
                ))}
              </SelectControl>
            </label>
          </div>
        ) : null}

        {showKeyField ? (
          <details
            className="settings-sheet-advanced"
            onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
            open={advancedOpen}
          >
            <summary className="settings-sheet-advanced-summary">Advanced</summary>
            <div className="inset-card" role="group">
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
          </details>
        ) : null}

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
    </Dialog>
  );
}
