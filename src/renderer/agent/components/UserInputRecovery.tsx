import { useState } from 'react';
import { userInputKey } from '../../../core/agent/userInput';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { recoveryText, type UserInputDraft } from '../store/userInputState';

export function UserInputRecovery({ drafts, canAdd, onAdd, onDiscard, onRetry }: {
  readonly drafts: readonly UserInputDraft[];
  readonly canAdd: boolean;
  readonly onAdd: (draft: UserInputDraft) => void;
  readonly onDiscard: (key: string) => void;
  readonly onRetry: () => void;
}) {
  const t = useT();
  const [copyError, setCopyError] = useState<string | null>(null);
  if (!drafts.length) return null;
  return <div className="thread-user-input-recoveries" aria-label={t.agent.thread.inputUnsent}>
    {drafts.map((draft) => {
      const key = userInputKey(draft.request);
      const text = recoveryText(draft);
      const reason = draft.outcome === 'timedOut' ? t.agent.thread.inputExpired
        : draft.outcome === 'skipped' ? t.agent.thread.inputSkippedRecovery
        : draft.outcome === 'cancelled' ? t.agent.thread.inputCancelled
        : draft.outcome === 'failed' ? t.agent.thread.inputFailed
        : draft.outcome === 'invalidated' ? t.agent.thread.inputInvalidated : t.agent.thread.inputUnknown;
      return <details className="thread-user-input-recovery" key={key}>
        <summary>{reason} {text ? t.agent.thread.inputReview : ''}</summary>
        {text ? <pre>{text}</pre> : null}
        <div className="thread-user-input-actions">
          {text ? <Button size="sm" onClick={() => {
            setCopyError(null);
            void navigator.clipboard.writeText(text).catch(() => setCopyError(key));
          }}>{t.agent.thread.inputCopy}</Button> : null}
          {text && canAdd ? <Button size="sm" onClick={() => onAdd(draft)}>{t.agent.thread.inputAddToMessage}</Button> : null}
          {draft.outcome === 'unknown' ? <Button size="sm" onClick={onRetry}>{t.agent.thread.inputRetry}</Button> : null}
          <Button size="sm" onClick={() => onDiscard(key)}>{t.agent.thread.inputDiscard}</Button>
        </div>
        {copyError === key ? <p role="alert">{t.agent.thread.inputCopyError}</p> : null}
      </details>;
    })}
  </div>;
}
