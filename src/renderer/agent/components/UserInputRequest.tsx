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
  readonly onSubmit: (answers: readonly RequestUserInputAnswer[]) => Promise<void>;
}

interface SelectedAnswer {
  readonly optionLabel?: string;
  readonly otherText?: string;
}

export function UserInputRequest({ request, onSubmit }: UserInputRequestProps) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, SelectedAnswer>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusStepOnChangeRef = useRef(false);
  const questionStepRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAnswers({});
    setCurrentQuestionIndex(0);
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

  const questionCount = request.questions.length;
  const currentQuestion = request.questions[Math.min(currentQuestionIndex, questionCount - 1)];
  const selected = currentQuestion ? answers[currentQuestion.id] : undefined;
  const currentComplete = Boolean(selected?.optionLabel || selected?.otherText?.trim());
  const complete = request.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer?.optionLabel || answer?.otherText?.trim());
  });
  const isLastStep = currentQuestionIndex >= questionCount - 1;

  function moveToQuestion(index: number) {
    if (submitting) return;
    focusStepOnChangeRef.current = true;
    setCurrentQuestionIndex(Math.max(0, Math.min(questionCount - 1, index)));
  }

  async function submit() {
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.questions.map((question) => ({
        questionId: question.id,
        ...answers[question.id],
      })));
    } catch (submitError) {
      setError(errorMessage(submitError));
      setSubmitting(false);
    }
  }

  if (!currentQuestion) return null;

  const otherSelected = selected?.otherText !== undefined;
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
            disabled={submitting}
            icon={BackIcon}
            iconSize={ICON_SIZE.menu}
            label={t.agent.thread.inputBack}
            onClick={() => moveToQuestion(currentQuestionIndex - 1)}
          />
        ) : null}
      </div>
      <div className="thread-user-input-step" key={currentQuestion.id} ref={questionStepRef} tabIndex={-1}>
        {currentQuestion.header ? <div className="thread-user-input-header">{currentQuestion.header}</div> : null}
        <div className="thread-user-input-prompt">{currentQuestion.question}</div>
        <fieldset>
          <legend className="sr-only">{currentQuestion.question}</legend>
          <div className="thread-user-input-options">
            {currentQuestion.options.map((option) => (
              <label key={option.label}>
                <input
                  checked={selected?.optionLabel === option.label}
                  disabled={submitting}
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
                disabled={submitting}
                name={currentQuestion.id}
                onChange={(event) => {
                  const otherInput = event.currentTarget.closest('label')?.querySelector<HTMLInputElement>('.thread-user-input-other');
                  setAnswers((current) => ({
                    ...current,
                    [currentQuestion.id]: { otherText: '' },
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
                  disabled={!otherSelected || submitting}
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
        <Button disabled={!(isLastStep ? complete : currentComplete) || submitting} size="sm" type="submit" variant="primary">
          {isLastStep ? t.agent.thread.submitInput : t.agent.thread.inputNext}
        </Button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
