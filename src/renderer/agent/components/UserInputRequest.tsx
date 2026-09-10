import { useEffect, useRef, useState } from 'react';
import type { RequestUserInputAnswer, RequestUserInputRequest as Request } from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons';
import { activeInputAnswers, type UserInputDraft } from '../store/userInputState';

type DraftChange = Partial<Pick<UserInputDraft, 'answers' | 'step'>>;

interface UserInputRequestProps {
  readonly request: Request;
  readonly draft: UserInputDraft;
  readonly disabled?: boolean;
  readonly onDraftChange: (update: DraftChange) => void;
  readonly onExpired: () => void;
  readonly onSubmit: (answers: readonly RequestUserInputAnswer[], intent: 'answer' | 'continue') => Promise<void>;
  readonly onEditingFinished: () => void;
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

export function UserInputRequest({ request, draft, disabled = false, onDraftChange, onExpired, onSubmit, onEditingFinished }: UserInputRequestProps) {
  const t = useT();
  const [expired, setExpired] = useState(() => Date.now() >= request.deadlineAt);
  const [submissionIntent, setSubmissionIntent] = useState<'answer' | 'continue' | null>(null);
  const submitting = submissionIntent !== null;
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const focusOther = useRef(false);
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
  const otherSelected = selected?.selection === 'text';

  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    stepRef.current?.focus();
  }, [draft.step]);

  useEffect(() => {
    if (!focusOther.current) return;
    focusOther.current = false;
    otherRef.current?.focus();
  }, [otherSelected]);

  function move(step: number) {
    focusNext.current = true;
    onDraftChange({ step: Math.max(0, Math.min(request.questions.length - 1, step)) });
  }
  function skipAll() {
    void submit(request.questions.map((entry) => ({ questionId: entry.id, skipped: true })));
  }
  async function submit(submittedAnswers = answers) {
    if (blocked || submittingRef.current) return;
    if (Date.now() >= request.deadlineAt) { onExpired(); return; }
    const intent = submittedAnswers.some((answer) => !answer.skipped) ? 'answer' : 'continue';
    submittingRef.current = true;
    setSubmissionIntent(intent);
    setError(null);
    try { await onSubmit(submittedAnswers, intent); }
    catch { setError(intent === 'answer' ? t.agent.thread.inputSubmitError : t.agent.thread.inputSkipError); }
    finally { submittingRef.current = false; setSubmissionIntent(null); }
  }
  const reason = draft.outcome === 'timedOut' ? t.agent.thread.inputExpired
    : draft.outcome === 'skipped' ? t.agent.thread.inputRetainedDraft
    : draft.outcome === 'cancelled' ? t.agent.thread.inputCancelled
    : draft.outcome === 'failed' ? t.agent.thread.inputFailed
    : draft.outcome === 'invalidated' ? t.agent.thread.inputInvalidated
    : !pending ? t.agent.thread.inputUnknown : t.agent.thread.inputCheckingStatus;

  return <form className="thread-user-input" aria-busy={submitting} aria-label={pending ? t.agent.thread.inputNeeded : t.agent.thread.inputSavedDraft}
    onBlur={(event) => {
      if (!pending && !event.currentTarget.contains(event.relatedTarget)) onEditingFinished();
    }}
    onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
        event.stopPropagation();
        if (!pending) onEditingFinished();
      }
    }}>
    <div className="thread-user-input-heading">
      <nav className="thread-user-input-nav" aria-label={t.agent.thread.inputNavigation}>
        <IconButton icon={ChevronLeftIcon} label={t.agent.thread.inputBack} disabled={step === 0 || !pending || expired || submitting}
          onClick={() => move(step - 1)} />
        <span className="thread-user-input-position" aria-live="polite">
          <span aria-hidden="true">{step + 1} / {request.questions.length}</span>
          <span className="sr-only">{t.agent.thread.inputProgress({ current: step + 1, total: request.questions.length })}</span>
        </span>
        <IconButton icon={ChevronRightIcon} label={t.agent.thread.inputNext} disabled={last || !pending || expired || submitting}
          onClick={() => move(step + 1)} />
      </nav>
    </div>
    {/* Keep this editor subtree mounted when the Host settles; only its sending authority changes. */}
    <div className="thread-user-input-step" key={question.id} ref={stepRef} tabIndex={-1}>
      <div className="thread-user-input-prompt">{question.question}</div>
      {!pending ? <span className="thread-user-input-title">{t.agent.thread.inputSavedDraft}</span> : null}
      <fieldset>
        <legend className="sr-only">{question.question}</legend>
        <div className="thread-user-input-options">
          {question.options.map((option) => <label className="thread-user-input-option" key={option.label}>
            <input type="radio" name={question.id} checked={activeAnswer?.optionLabel === option.label} disabled={!pending || expired || submitting}
              onChange={() => onDraftChange({ answers: { ...draft.answers, [question.id]: {
                ...selected, optionLabel: option.label, skipped: undefined, selection: 'option',
              } } })} />
            <span><strong>{option.label}</strong><small>{option.description}</small></span>
          </label>)}
          <div className="thread-user-input-custom">
            <label className="thread-user-input-option">
              <input type="radio" name={question.id} checked={otherSelected} disabled={!pending || expired || submitting}
                onChange={() => {
                  focusOther.current = true;
                  onDraftChange({ answers: { ...draft.answers, [question.id]: {
                    ...selected, skipped: undefined, selection: 'text',
                  } } });
                }} />
              <span><strong>{t.agent.thread.other}</strong></span>
            </label>
            <div className="thread-user-input-custom-editor" hidden={!otherSelected}>
              <textarea ref={otherRef} className="thread-user-input-other" aria-label={t.agent.thread.inputWriteAnswer} rows={3}
                readOnly={submitting && pending} value={selected?.otherText ?? ''} placeholder={t.agent.thread.otherPlaceholder}
                onChange={(event) => onDraftChange({ answers: { ...draft.answers, [question.id]: {
                  ...selected, otherText: event.target.value, skipped: undefined, selection: 'text',
                } } })} />
            </div>
          </div>
        </div>
      </fieldset>
      {!pending || expired ? <p className="thread-user-input-countdown" role="status">{reason}</p> : null}
      {error ? <p className="thread-inline-error" role="alert">{error}</p> : null}
    </div>
    {pending && !expired ? <div className="thread-user-input-actions thread-user-input-footer">
      <UserInputDeadline request={request} onExpired={() => { setExpired(true); onExpired(); }} />
      <div className="thread-user-input-submit-actions">
        <Button size="sm" variant="ghost" disabled={blocked} title={t.agent.thread.inputSkipAllHint} onClick={skipAll}>
          {submissionIntent === 'continue' ? t.agent.thread.inputSkipping : t.agent.thread.inputSkipAll}
        </Button>
        <Button size="sm" variant="primary" disabled={blocked || !count} title={t.agent.thread.inputSendAnswersHint} onClick={() => void submit()}>
          {submissionIntent === 'answer' ? t.agent.thread.inputSubmitting : t.agent.thread.inputSendAnswers}
        </Button>
      </div>
    </div> : null}
  </form>;
}
