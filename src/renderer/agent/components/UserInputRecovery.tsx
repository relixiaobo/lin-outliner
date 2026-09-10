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
  const retained = drafts.filter((draft) => draft.outcome !== 'pending' && recoveryText(draft));
  if (!retained.length) return null;
  return <details className="thread-user-input-recoveries">
    <summary>{t.agent.thread.inputShelfCount({ count: retained.length })}</summary>
    {retained.map((draft) => {
      const key = userInputKey(draft.request);
      const text = recoveryText(draft);
      const reason = draft.outcome === 'timedOut' ? t.agent.thread.inputExpired
        : draft.outcome === 'skipped' ? t.agent.thread.inputRetainedDraft
        : draft.outcome === 'cancelled' ? t.agent.thread.inputCancelled
        : draft.outcome === 'failed' ? t.agent.thread.inputFailed
        : draft.outcome === 'invalidated' ? t.agent.thread.inputInvalidated : t.agent.thread.inputUnknown;
      return <details className="thread-user-input-recovery" key={key}>
        <summary>{draft.request.questions[0]?.question}</summary>
        <p>{reason}</p>
        <pre>{text}</pre>
        <div className="thread-user-input-actions">
          <Button size="sm" onClick={() => {
            setCopyError(null);
            void navigator.clipboard.writeText(text).catch(() => setCopyError(key));
          }}>{t.agent.thread.inputCopy}</Button>
          <Button size="sm" disabled={!canAdd || draft.addedToMessage} onClick={() => onAdd(draft)}>
            {draft.addedToMessage ? t.agent.thread.inputInMessage : t.agent.thread.inputAddToMessage}
          </Button>
          {draft.outcome === 'unknown' ? <Button size="sm" onClick={onRetry}>{t.agent.thread.inputCheckStatus}</Button> : null}
          <Button size="sm" onClick={() => onDiscard(key)}>{t.agent.thread.inputDiscard}</Button>
        </div>
        {copyError === key ? <p role="alert">{t.agent.thread.inputCopyError}</p> : null}
      </details>;
    })}
  </details>;
}
