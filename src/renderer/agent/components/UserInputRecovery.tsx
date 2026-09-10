import { useT } from '../../i18n/I18nProvider';
import { recoveryText, type UserInputDraft } from '../store/userInputState';

/** A passive local note beside the question that owns it. Never a composer action. */
export function UserInputRecovery({ draft }: { readonly draft: UserInputDraft }) {
  const t = useT();
  const text = recoveryText(draft);
  if (draft.outcome === 'pending' || !text) return null;
  const reason = draft.outcome === 'timedOut' ? t.agent.thread.inputExpired
    : draft.outcome === 'skipped' ? t.agent.thread.inputRetainedDraft
    : draft.outcome === 'cancelled' ? t.agent.thread.inputCancelled
    : draft.outcome === 'failed' ? t.agent.thread.inputFailed
    : draft.outcome === 'invalidated' ? t.agent.thread.inputInvalidated : t.agent.thread.inputUnknown;
  const label = draft.outcome === 'unknown' || draft.outcome === 'invalidated'
    ? t.agent.thread.inputSavedDraft : t.agent.thread.inputNotSubmitted;
  return <details className="thread-user-input-recovery" data-user-input-item={draft.request.itemId}>
    <summary>
      <span>{draft.request.questions[0]?.question}</span>
      <span className="thread-user-input-recovery-label">{label}</span>
    </summary>
    <p>{reason}</p>
    <pre>{text}</pre>
  </details>;
}
