import { useEffect, useRef, useState } from 'react';
import type { RequestUserInputAnswer, RequestUserInputRequest as Request } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { AnchoredActionMenu } from '../../ui/primitives/AnchoredActionMenu';
import { MoreIcon } from '../../ui/icons';
import { activeInputAnswers, recoveryText, type UserInputDraft } from '../store/userInputState';

type DraftChange = Partial<Pick<UserInputDraft, 'answers' | 'step' | 'view'>>;

export function UserInputMenu({ hasAnswers, disabled, onContinue, onChat, onStop }: {
  hasAnswers: boolean; disabled: boolean; onContinue: () => void; onChat?: () => void; onStop: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const select = (action: () => void) => () => { anchor.current?.focus(); action(); };
  return <>
    <IconButton ref={anchor} icon={MoreIcon} label={t.agent.thread.inputMore} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)} />
    {open ? <AnchoredActionMenu anchorRef={anchor} ariaLabel={t.agent.thread.inputMore} className="thread-action-menu"
      itemLabelClassName="thread-action-menu-label" onClose={() => setOpen(false)} actions={[
        ...(onChat ? [{ label: t.agent.thread.inputChat, onSelect: select(onChat), disabled }] : []),
        { label: hasAnswers ? t.agent.thread.inputContinue : t.agent.thread.inputContinueEmpty, onSelect: select(onContinue), disabled },
        { label: t.agent.thread.interrupt, onSelect: select(onStop) },
      ]} /> : null}
  </>;
}
interface UserInputRequestProps {
  readonly request: Request;
  readonly draft: UserInputDraft;
  readonly disabled?: boolean;
  readonly onDraftChange: (update: DraftChange) => void;
  readonly onExpired: () => void;
  readonly onSubmit: (answers: readonly RequestUserInputAnswer[], intent: 'answer' | 'continue') => Promise<void>;
  readonly onChat: () => void;
  readonly onAdd: () => void;
  readonly onStop: () => void;
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

export function UserInputRequest({ request, draft, disabled = false, onDraftChange, onExpired, onSubmit, onChat, onAdd, onStop }: UserInputRequestProps) {
  const t = useT();
  const [expired, setExpired] = useState(() => Date.now() >= request.deadlineAt);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const pending = draft.outcome === 'pending';
  const blocked = !pending || expired || disabled || submitting;
  const answers = activeInputAnswers(draft);
  const count = answers.filter((answer) => !answer.skipped).length;
  const review = draft.step >= request.questions.length;
  const question = request.questions[Math.min(draft.step, request.questions.length - 1)]!;
  const selected = draft.answers[question.id];
  const activeAnswer = answers.find((answer) => answer.questionId === question.id);
  const last = draft.step === request.questions.length - 1;
  const single = request.questions.length === 1;

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    (review ? reviewRef : stepRef).current?.focus();
  }, [draft.step]);

  function move(step: number) {
    focusNext.current = true;
    onDraftChange({ step: Math.max(0, Math.min(request.questions.length, step)) });
  }
  function skip() {
    focusNext.current = true;
    onDraftChange({ answers: { ...draft.answers, [question.id]: { ...selected, skipped: true, selection: 'skip' } }, step: draft.step + 1 });
  }
  async function submit(intent: 'answer' | 'continue') {
    if (blocked || submittingRef.current || Date.now() >= request.deadlineAt) { onExpired(); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try { await onSubmit(answers, intent); }
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
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); onChat(); }
    }}>
    <div className="thread-user-input-heading">
      {pending && !single && !review ? <nav className="thread-user-input-nav" aria-label={t.agent.thread.inputReview}
        title={t.agent.thread.inputAnsweredCount({ count, total: request.questions.length })}>
        {request.questions.map((item, index) => <button key={item.id} type="button" className="thread-user-input-tab"
          aria-current={draft.step === index ? 'step' : undefined} title={item.header} disabled={submitting} onClick={() => move(index)}>
          {item.header}
        </button>)}
      </nav> : <span className="thread-user-input-title">{!pending ? t.agent.thread.inputSavedDraft : review ? t.agent.thread.inputReview : t.agent.thread.inputNeeded}</span>}
      {pending ? <span className="sr-only">{t.agent.thread.inputAnsweredCount({ count, total: request.questions.length })}</span> : null}
      {pending ? <UserInputDeadline request={request} onExpired={() => { setExpired(true); onExpired(); }} /> : null}
    </div>
    {/* Keep this editor subtree mounted when the Host settles; only its sending authority changes. */}
    <div className="thread-user-input-step" key={question.id} ref={stepRef} tabIndex={-1} hidden={review}>
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
        <span className="sr-only">{t.agent.thread.inputWriteAnswer}</span>
        <textarea className="thread-user-input-other" aria-label={t.agent.thread.inputWriteAnswer} rows={2}
          readOnly={submitting && pending} value={selected?.otherText ?? ''} placeholder={t.agent.thread.inputWriteAnswer}
          onChange={(event) => onDraftChange({ answers: { ...draft.answers, [question.id]: {
            ...selected, otherText: event.target.value, skipped: undefined, selection: 'text',
          } } })} />
      </label>
      {pending && activeAnswer?.skipped && selected?.skipped ? <span className="thread-user-input-countdown">{t.agent.thread.inputUnanswered}</span> : null}
    </div>
    {review ? <div className="thread-user-input-review" ref={reviewRef} tabIndex={-1} aria-label={t.agent.thread.inputReview}>
      {request.questions.map((item, index) => <div key={item.id}>
        <button type="button" className="thread-user-input-tab" onClick={() => move(index)}>{item.question}</button>
        <p>{answers[index]?.optionLabel ?? answers[index]?.otherText ?? t.agent.thread.inputUnanswered}</p>
      </div>)}
    </div> : null}
    {!pending || expired ? <p className="thread-user-input-countdown" role="status">{reason}</p> : null}
    {error ? <p className="thread-inline-error" role="alert">{error}</p> : null}
    {pending && !expired ? <>
      <div className="thread-user-input-actions thread-user-input-footer">
        <UserInputMenu hasAnswers={count > 0} disabled={blocked} onContinue={() => void submit('continue')} onChat={onChat} onStop={onStop} />
        <div className="thread-user-input-primary-actions">
        {!review ? <Button size="sm" variant="ghost" disabled={submitting} onClick={skip}>{t.agent.thread.inputSkip}</Button> : null}
        {review || single ? <Button size="sm" variant="primary" disabled={blocked || (!review && single && !count)} onClick={() => void submit(count ? 'answer' : 'continue')}>
          {review && !count ? t.agent.thread.inputContinueEmpty : single ? t.agent.thread.inputSendAnswer : t.agent.thread.inputSendAnswers}
        </Button> : <Button size="sm" variant="primary" disabled={submitting} onClick={() => move(draft.step + 1)}>
          {last ? t.agent.thread.inputReview : t.agent.thread.inputNext}
        </Button>}
        </div>
      </div>
    </> : <div className="thread-user-input-actions">
      {!pending && recoveryText(draft) ? <Button size="sm" variant="primary" disabled={draft.addedToMessage} onClick={onAdd}>
        {draft.addedToMessage ? t.agent.thread.inputInMessage : t.agent.thread.inputAddToMessage}
      </Button> : <Button size="sm" onClick={onExpired}>{t.agent.thread.inputRetry}</Button>}
      <Button size="sm" onClick={onChat}>{t.agent.thread.inputReturnToMessage}</Button>
      {pending ? <Button size="sm" onClick={onStop}>{t.agent.thread.interrupt}</Button> : null}
    </div>}
  </form>;
}
