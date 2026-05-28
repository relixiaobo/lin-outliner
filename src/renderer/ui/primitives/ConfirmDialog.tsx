import { useId, useRef } from 'react';
import { ButtonControl } from './ButtonControl';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  restoreFocus?: () => HTMLElement | null;
}

// In-app replacement for window.confirm — a blocking browser dialog that both
// looks foreign and freezes the whole renderer. Built on the shared Dialog so it
// gets focus trapping, Escape-to-cancel, and backdrop dismissal. For destructive
// actions the Cancel button takes initial focus so a stray Enter cannot confirm.
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
  restoreFocus,
}: ConfirmDialogProps) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog
      backdropClassName="confirm-dialog-backdrop"
      labelledBy={titleId}
      surfaceClassName="confirm-dialog"
      initialFocus={() => (danger ? cancelRef.current : confirmRef.current)}
      onBackdropMouseDown={onCancel}
      onEscapeKeyDown={onCancel}
      restoreFocus={restoreFocus}
    >
      <h2 className="confirm-dialog-title" id={titleId}>{title}</h2>
      {message ? <p className="confirm-dialog-message">{message}</p> : null}
      <div className="confirm-dialog-actions">
        <ButtonControl ref={cancelRef} className="confirm-dialog-cancel" onClick={onCancel}>
          {cancelLabel}
        </ButtonControl>
        <ButtonControl
          ref={confirmRef}
          className={danger ? 'confirm-dialog-confirm is-danger' : 'confirm-dialog-confirm'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </ButtonControl>
      </div>
    </Dialog>
  );
}
