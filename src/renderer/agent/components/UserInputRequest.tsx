import type { UserInputDraft } from '../store/userInputState';
import { useEffect, useRef, useState } from 'react';
import type {
  RequestUserInputAnswer,
  RequestUserInputRequest as Request,
} from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, ICON_SIZE } from '../../ui/icons';
import { Button } from '../../ui/primitives/Button';
import { IconButton } from '../../ui/primitives/IconButton';

interface UserInputRequestProps {
  readonly request: Request;
  readonly draft: UserInputDraft;
  readonly disabled?: boolean;
  readonly onDraftChange: (update: Partial<Pick<UserInputDraft, 'answers' | 'step'>>) => void;
  readonly onExpired: () => void;
  readonly onSubmit: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

export function UserInputRequest({ request, draft, disabled = false, onDraftChange, onExpired, onSubmit }: UserInputRequestProps) {
  const t = useT();
  const answers = draft.answers;
  const currentQuestionIndex = draft.step;
  const setAnswers = (update: (current: UserInputDraft['answers']) => UserInputDraft['answers']) => onDraftChange({ answers: update(answers) });
  const setCurrentQuestionIndex = (step: number) => onDraftChange({ step });
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusStepOnChangeRef = useRef(true);
  const questionStepRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSubmitting(false);
    setError(null);
  }, [request.itemId]);

  useEffect(() => {
    if (!focusStepOnChangeRef.current) return undefined;
    focusStepOnChangeRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const step = questionStepRef.current;
      const focusTarget = step?.querySelector<HTMLElement>('input:not(:disabled)');
      (focusTarget ?? step)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentQuestionIndex]);

  const blocked = disabled || submitting || remaining === 0;
  const questionCount = request.questions.length;
  const currentQuestion = request.questions[Math.min(currentQuestionIndex, questionCount - 1)];
  const selected = currentQuestion ? answers[currentQuestion.id] : undefined;
  const currentComplete = Boolean(selected?.skipped || selected?.optionLabel || selected?.otherText?.trim());
  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer?.skipped || answer?.optionLabel || answer?.otherText?.trim());
  });
  const isLastStep = currentQuestionIndex >= questionCount - 1;

  function moveToQuestion(index: number) {
    if (blocked) return;
    focusStepOnChangeRef.current = true;
    setCurrentQuestionIndex(Math.max(0, Math.min(questionCount - 1, index)));
  }

  async function submit(submittedAnswers = answers) {
    if (blocked || !request.questions.every((question) => {
      const answer = submittedAnswers[question.id];
      return answer?.skipped || answer?.optionLabel || answer?.otherText?.trim();
    })) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.questions.map((question) => ({
        questionId: question.id,
        ...(submittedAnswers[question.id]?.skipped ? { skipped: true as const } : submittedAnswers[question.id]),
      })));
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  }

  function skipCurrentQuestion() {
    if (!currentQuestion || blocked) return;
    const skippedAnswers = { ...answers, [currentQuestion.id]: { ...selected, skipped: true as const } };
    onDraftChange({ answers: skippedAnswers });
    if (isLastStep) void submit(skippedAnswers);
    else moveToQuestion(currentQuestionIndex + 1);
  }

  if (!currentQuestion) return null;

  const otherSelected = !selected?.skipped && selected?.otherText !== undefined;
  const progress = questionCount > 1
    ? t.agent.thread.inputProgress({ current: currentQuestionIndex + 1, total: questionCount })
    : null;

  return (
    <form
      aria-label={t.agent.thread.inputNeeded}
      className="thread-user-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (isLastStep) void submit();
        else if (currentComplete) moveToQuestion(currentQuestionIndex + 1);
      }}
    >
      <div className="thread-user-input-heading">
        <div className="thread-user-input-title">
          {t.agent.thread.inputNeeded}
          {progress ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{progress}</span>
            </>
          ) : null}
        </div>
        {currentQuestionIndex > 0 ? (
          <IconButton
            className="thread-user-input-back"
            disabled={blocked}
            icon={BackIcon}
            iconSize={ICON_SIZE.menu}
            label={t.agent.thread.inputBack}
            onClick={() => moveToQuestion(currentQuestionIndex - 1)}
          />
        ) : null}
      </div>
      <p className="thread-user-input-countdown" aria-live="off">{t.agent.thread.inputRemaining({ seconds: remaining })}</p>
      <div className="thread-user-input-step" key={currentQuestion.id} ref={questionStepRef} tabIndex={-1}>
        {currentQuestion.header ? <div className="thread-user-input-header">{currentQuestion.header}</div> : null}
        <div className="thread-user-input-prompt">{currentQuestion.question}</div>
        {selected?.skipped ? <p className="thread-user-input-countdown">{t.agent.thread.inputSkipped}</p> : null}
        <fieldset>
          <legend className="sr-only">{currentQuestion.question}</legend>
          <div className="thread-user-input-options">
            {currentQuestion.options.map((option) => (
              <label key={option.label}>
                <input
                  checked={!selected?.skipped && selected?.optionLabel === option.label}
                  disabled={blocked}
                  name={currentQuestion.id}
                  onChange={() => setAnswers((current) => ({
                    ...current,
                    [currentQuestion.id]: { optionLabel: option.label },
                  }))}
                  type="radio"
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            <label>
              <input
                checked={otherSelected}
                disabled={blocked}
                name={currentQuestion.id}
                onChange={(event) => {
                  const otherInput = event.currentTarget.closest('label')?.querySelector<HTMLInputElement>('.thread-user-input-other');
                  setAnswers((current) => ({
                    ...current,
                    [currentQuestion.id]: { otherText: selected?.otherText ?? '' },
                  }));
                  window.requestAnimationFrame(() => otherInput?.focus());
                }}
                type="radio"
              />
              <span>
                <strong>{t.agent.thread.other}</strong>
                <input
                  aria-label={t.agent.thread.other}
                  className="thread-user-input-other"
                  disabled={!otherSelected || blocked}
                  onChange={(event) => setAnswers((current) => ({
                    ...current,
                    [currentQuestion.id]: { otherText: event.target.value },
                  }))}
                  placeholder={t.agent.thread.otherPlaceholder}
                  type="text"
                  value={selected?.otherText ?? ''}
                />
              </span>
            </label>
          </div>
        </fieldset>
      </div>
      {error ? <p className="thread-inline-error" role="alert">{error}</p> : null}
      <div className="thread-user-input-actions">
        <Button disabled={blocked} size="sm" type="button" onClick={skipCurrentQuestion}>
          {isLastStep ? t.agent.thread.inputSkipAndSubmit : t.agent.thread.inputSkip}
        </Button>
        <Button disabled={!(isLastStep ? complete : currentComplete) || blocked} size="sm" type="submit" variant="primary">
          {isLastStep ? t.agent.thread.submitInput : t.agent.thread.inputNext}
        </Button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
