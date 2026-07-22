import { useEffect, useMemo, useState } from 'react';
import type {
  RequestUserInputAnswer,
  RequestUserInputRequest as Request,
} from '../../../core/agent/protocol';
import { useT } from '../../i18n/I18nProvider';

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAnswers({});
    setSubmitting(false);
    setError(null);
  }, [request.itemId]);

  const complete = useMemo(() => request.questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer?.optionLabel || answer?.otherText?.trim());
  }), [answers, request.questions]);

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

  return (
    <section className="thread-user-input" aria-label={t.agent.thread.inputNeeded}>
      <h3>{t.agent.thread.inputNeeded}</h3>
      {request.questions.map((question) => {
        const selected = answers[question.id];
        const otherSelected = selected?.otherText !== undefined;
        return (
          <fieldset key={question.id}>
            <legend>
              <span>{question.header}</span>
              {question.question}
            </legend>
            <div className="thread-user-input-options">
              {question.options.map((option) => (
                <label key={option.label}>
                  <input
                    checked={selected?.optionLabel === option.label}
                    name={question.id}
                    onChange={() => setAnswers((current) => ({
                      ...current,
                      [question.id]: { optionLabel: option.label },
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
                  name={question.id}
                  onChange={() => setAnswers((current) => ({
                    ...current,
                    [question.id]: { otherText: '' },
                  }))}
                  type="radio"
                />
                <span>
                  <strong>{t.agent.thread.other}</strong>
                  <input
                    aria-label={t.agent.thread.other}
                    className="thread-user-input-other"
                    disabled={!otherSelected}
                    onChange={(event) => setAnswers((current) => ({
                      ...current,
                      [question.id]: { otherText: event.target.value },
                    }))}
                    placeholder={t.agent.thread.otherPlaceholder}
                    type="text"
                    value={selected?.otherText ?? ''}
                  />
                </span>
              </label>
            </div>
          </fieldset>
        );
      })}
      {error ? <p className="thread-inline-error" role="alert">{error}</p> : null}
      <button className="button button-primary" disabled={!complete || submitting} onClick={() => void submit()} type="button">
        {t.agent.thread.submitInput}
      </button>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
