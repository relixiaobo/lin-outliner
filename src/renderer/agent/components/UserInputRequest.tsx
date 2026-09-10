import { useEffect, useRef, useState } from 'react';
import type { RequestUserInputAnswer, RequestUserInputRequest as Request } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { ChevronLeftIcon, CloseIcon } from '../../ui/icons';
import { activeInputAnswers, recoveryText, type UserInputDraft } from '../store/userInputState';

type DraftChange = Partial<Pick<UserInputDraft, 'answers' | 'step' | 'view'>>;

interface UserInputRequestProps {
  readonly request: Request;
  readonly draft: UserInputDraft;
  readonly disabled?: boolean;
  readonly onDraftChange: (update: DraftChange) => void;
  readonly onExpired: () => void;
  readonly onSubmit: (answers: readonly RequestUserInputAnswer[], intent: 'answer' | 'continue') => Promise<void>;
  readonly onDismiss: () => void;
  readonly onAdd: () => void;
}

/** Own the ticking display separately so it never rerenders the answer editor each second. */
export function UserInputDeadline({ request, onExpired }: { request: Request; onExpired: () => void }) {
  const t = useT();
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.ceil((request.deadlineAt - Date.now()) / 1000)));
  const expiredRef = useRef(onExpired);
  expiredRef.current = onExpired;
  useEffect(() => {
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((request.deadlineAt - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) { clearInterval(timer); expiredRef.current(); }
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [request.deadlineAt]);
  return <span className="thread-user-input-countdown" aria-live="off" title={t.agent.thread.inputDeadlineHint}>
    {t.agent.thread.inputRemaining({ seconds: remaining })}
  </span>;
}

export function UserInputRequest({ request, draft, disabled = false, onDraftChange, onExpired, onSubmit, onDismiss, onAdd }: UserInputRequestProps) {
  const t = useT();
  const [expired, setExpired] = useState(() => Date.now() >= request.deadlineAt);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const pending = draft.outcome === 'pending';
  const blocked = !pending || expired || disabled || submitting;
  const answers = activeInputAnswers(draft);
  const count = answers.filter((answer) => !answer.skipped).length;
  const step = Math.min(draft.step, request.questions.length - 1);
  const question = request.questions[step]!;
  const selected = draft.answers[question.id];
  const activeAnswer = answers.find((answer) => answer.questionId === question.id);
  const last = step === request.questions.length - 1;

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    stepRef.current?.focus();
  }, [draft.step]);

  function move(step: number) {
    focusNext.current = true;
    onDraftChange({ step: Math.max(0, Math.min(request.questions.length - 1, step)) });
  }
  function skip() {
    const nextDraft = { ...draft, answers: { ...draft.answers,
      [question.id]: { ...selected, skipped: true as const, selection: 'skip' as const } } };
    focusNext.current = !last;
    onDraftChange({ answers: nextDraft.answers, step: last ? step : step + 1 });
    if (last) void submit(activeInputAnswers(nextDraft));
  }
  async function submit(submittedAnswers = answers) {
    if (blocked || submittingRef.current || Date.now() >= request.deadlineAt) { onExpired(); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try { await onSubmit(submittedAnswers, submittedAnswers.some((answer) => !answer.skipped) ? 'answer' : 'continue'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }
  const reason = draft.outcome === 'timedOut' ? t.agent.thread.inputExpired
    : draft.outcome === 'cancelled' ? t.agent.thread.inputCancelled
    : draft.outcome === 'failed' ? t.agent.thread.inputFailed
    : draft.outcome === 'invalidated' ? t.agent.thread.inputInvalidated
    : !pending ? t.agent.thread.inputUnknown : t.agent.thread.inputRestoring;

  return <form className="thread-user-input" aria-label={pending ? t.agent.thread.inputNeeded : t.agent.thread.inputSavedDraft}
    onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onDismiss(); }
    }}>
    <div className="thread-user-input-heading">
      <div className="thread-user-input-nav">
        <IconButton icon={ChevronLeftIcon} label={t.agent.thread.inputBack} disabled={step === 0 || submitting}
          onClick={() => move(step - 1)} />
        <span className="thread-user-input-title">{pending
          ? t.agent.thread.inputProgress({ current: step + 1, total: request.questions.length })
          : t.agent.thread.inputSavedDraft}</span>
      </div>
      {pending ? <UserInputDeadline request={request} onExpired={() => { setExpired(true); onExpired(); }} /> : null}
      <IconButton icon={CloseIcon} label={t.agent.thread.inputClose} disabled={submitting} onClick={onDismiss} />
    </div>
    {/* Keep this editor subtree mounted when the Host settles; only its sending authority changes. */}
    <div className="thread-user-input-step" key={question.id} ref={stepRef} tabIndex={-1}>
      <div className="thread-user-input-prompt">{question.question}</div>
      <fieldset hidden={!pending || expired}>
        <legend className="sr-only">{question.question}</legend>
        <div className="thread-user-input-options">
          {question.options.map((option) => <label key={option.label}>
            <input type="radio" name={question.id} checked={activeAnswer?.optionLabel === option.label} disabled={submitting}
              onChange={() => onDraftChange({ answers: { ...draft.answers, [question.id]: {
                ...selected, optionLabel: option.label, skipped: undefined, selection: 'option',
              } } })} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
        </div>
      </fieldset>
      <label className="thread-user-input-text-label">
        <span>{t.agent.thread.inputWriteAnswer}</span>
        <textarea className="thread-user-input-other" aria-label={t.agent.thread.inputWriteAnswer} rows={2}
          readOnly={submitting && pending} value={selected?.otherText ?? ''} placeholder={t.agent.thread.otherPlaceholder}
          onChange={(event) => onDraftChange({ answers: { ...draft.answers, [question.id]: {
            ...selected, otherText: event.target.value, skipped: undefined, selection: 'text',
          } } })} />
      </label>
      {pending && activeAnswer?.skipped && selected?.skipped ? <span className="thread-user-input-countdown">{t.agent.thread.inputUnanswered}</span> : null}
    </div>
    {!pending || expired ? <p className="thread-user-input-countdown" role="status">{reason}</p> : null}
    {error ? <p className="thread-inline-error" role="alert">{error}</p> : null}
    {pending && !expired ? <>
      <div className="thread-user-input-actions thread-user-input-footer">
        <Button size="sm" variant="ghost" disabled={blocked} onClick={skip}>
          {last ? t.agent.thread.inputSkipAndSubmit : t.agent.thread.inputSkip}
        </Button>
        <Button size="sm" variant="primary" disabled={blocked || (last && !count)}
          onClick={() => { if (last) void submit(); else move(step + 1); }}>
          {last ? t.agent.thread.inputSendAnswers : t.agent.thread.inputNext}
        </Button>
      </div>
    </> : <div className="thread-user-input-actions">
      {!pending && recoveryText(draft) ? <Button size="sm" variant="primary" disabled={draft.addedToMessage} onClick={onAdd}>
        {draft.addedToMessage ? t.agent.thread.inputInMessage : t.agent.thread.inputAddToMessage}
      </Button> : <Button size="sm" onClick={onExpired}>{t.agent.thread.inputRetry}</Button>}
      <Button size="sm" onClick={onDismiss}>{t.agent.thread.inputReturnToMessage}</Button>
    </div>}
  </form>;
}
