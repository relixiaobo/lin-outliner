import { useId, useRef, useState } from 'react';
import { HideIcon, ICON_SIZE, LoaderIcon, OpenIcon, PasswordIcon, ShowIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { Dialog } from '../primitives/Dialog';
import { FormField } from '../primitives/FormField';
import { TextInputControl } from '../primitives/TextInputControl';

// The credential modes the sheet can host. Only `apiKey` is implemented today;
// the sheet is the single focused host that `agent-oauth-providers.md` will plug
// OAuth sign-in and AWS/Vertex managed credentials into later — an API key is one
// mode, not the only one. Keep the body switched on `mode` so adding a mode is a
// new branch, not a new component.
export type CredentialMode = 'apiKey';

export interface CredentialValidation {
  success: boolean;
  message: string;
}

interface SettingsCredentialSheetProps {
  providerName: string;
  mode?: CredentialMode;
  hasSavedKey: boolean;
  docsUrl?: string;
  onValidate: (apiKey: string) => Promise<CredentialValidation>;
  onSave: (apiKey: string) => Promise<void>;
  onOpenDocs?: () => void;
  onClose: () => void;
  restoreFocus?: () => HTMLElement | null;
}

type SheetStatus = 'idle' | 'validating' | 'success' | 'error' | 'saving';

// Focused credential SHEET (D-FORM): the atomic add/replace-key → validate moment,
// lifted out of the inline detail. Built on the shared Dialog (focus trap, Escape,
// backdrop dismissal) and the dialog elevation tier (level-2, B10) — not a bespoke
// shadow. Validation is ASYNC and NON-BLOCKING: the sheet stays interactive while a
// test runs, shows a pending row, and can be cancelled (a request-id guard drops a
// stale/cancelled result so it never lands after the user moved on).
export function SettingsCredentialSheet({
  providerName,
  mode = 'apiKey',
  hasSavedKey,
  docsUrl,
  onValidate,
  onSave,
  onOpenDocs,
  onClose,
  restoreFocus,
}: SettingsCredentialSheetProps) {
  const titleId = useId();
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const validationToken = useRef(0);
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<SheetStatus>('idle');
  const [message, setMessage] = useState('');

  const trimmedKey = apiKey.trim();
  const validating = status === 'validating';
  const saving = status === 'saving';
  const busy = validating || saving;

  function resetResult() {
    // A keystroke invalidates any in-flight validation and clears the last result.
    validationToken.current += 1;
    if (status !== 'idle') {
      setStatus('idle');
      setMessage('');
    }
  }

  async function runValidate() {
    if (!trimmedKey || busy) return;
    const token = ++validationToken.current;
    setStatus('validating');
    setMessage('');
    try {
      const result = await onValidate(trimmedKey);
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
    // Drop the in-flight result (the IPC call itself can't be aborted, but the UI
    // unblocks immediately) and return to idle.
    validationToken.current += 1;
    setStatus('idle');
    setMessage('');
  }

  async function runSave() {
    if (!trimmedKey || busy) return;
    validationToken.current += 1;
    setStatus('saving');
    setMessage('');
    try {
      await onSave(trimmedKey);
      onClose();
    } catch (caught) {
      setStatus('error');
      setMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <Dialog
      backdropClassName="settings-sheet-backdrop"
      initialFocus={() => keyInputRef.current}
      labelledBy={titleId}
      onBackdropMouseDown={busy ? undefined : onClose}
      onEscapeKeyDown={busy ? undefined : onClose}
      restoreFocus={restoreFocus}
      surfaceClassName="settings-credential-sheet"
    >
      <h2 className="settings-sheet-title" id={titleId}>{hasSavedKey ? 'Replace API key' : 'Add API key'}</h2>
      <p className="settings-sheet-subtitle">{providerName}</p>

      {mode === 'apiKey' ? (
        <FormField as="div" className="settings-sheet-field" label="API key">
          <div className="settings-sheet-key-row">
            <PasswordIcon size={ICON_SIZE.menu} />
            <TextInputControl
              label="API key"
              onChange={(event) => { setApiKey(event.target.value); resetResult(); }}
              placeholder={hasSavedKey ? 'Paste a new key to replace the saved one' : 'Paste API key'}
              ref={keyInputRef}
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
          {docsUrl ? (
            <button className="agent-settings-doc-link" onClick={onOpenDocs} type="button">
              <span>Get API key</span>
              <OpenIcon size={ICON_SIZE.tiny} />
            </button>
          ) : null}
        </FormField>
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
            <span className="settings-sheet-result-text">✓ Connection successful</span>
          ) : (
            <span className="settings-sheet-result-text">✗ {message || 'Validation failed'}</span>
          )}
        </div>
      ) : null}

      <div className="settings-sheet-actions">
        <ButtonControl className="settings-sheet-secondary" disabled={saving} onClick={onClose}>
          Cancel
        </ButtonControl>
        <ButtonControl
          className="settings-sheet-secondary"
          disabled={!trimmedKey || busy}
          onClick={runValidate}
        >
          {validating ? 'Validating…' : 'Validate'}
        </ButtonControl>
        <ButtonControl
          className="settings-sheet-primary"
          disabled={!trimmedKey || busy}
          onClick={runSave}
        >
          {saving ? 'Saving…' : 'Save key'}
        </ButtonControl>
      </div>
    </Dialog>
  );
}
