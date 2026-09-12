import { LoaderIcon, QuitIcon, RefreshIcon } from './icons';
import { useT } from '../i18n/I18nProvider';
import { SelectControl } from './primitives/SelectControl';
import { Button } from './primitives/Button';
import { useId, useState } from 'react';
import type { StartupIssue, StartupIssueAction } from '../../core/startup';
import { ThreadRecoveryPanel } from './ThreadRecoveryPanel';

export function StartupFailure(props: {
  readonly failure: { readonly step: string; readonly message: string };
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onQuit: () => void;
  readonly issue?: StartupIssue;
  readonly issues?: readonly StartupIssue[];
  readonly threads?: readonly import('../../core/startup').StartupThreadAvailability[];
  readonly onContinue?: () => void;
  readonly actionError?: string | null;
}) {
  const t = useT().startup;
  const titleId = useId();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const issues = props.issues ?? (props.issue ? [props.issue] : []);
  const issue = issues.find((entry) => entry.id === selectedId) ?? props.issue ?? issues[0];
  const failure = issue ? { step: issue.operation, message: issue.message } : props.failure;
  const dependents = issue?.threadId ? props.threads?.filter((entry) => entry.sourceThreadId === issue.threadId && entry.threadId !== issue.threadId) ?? [] : [];

  const runIssueAction = async (action: StartupIssueAction) => {
    if (!issue) return;
    try {
      await window.lin?.startup?.issueAction(issue.id, action);
      setFeedback(action === 'copy-details' ? t.copied : null);
    } catch (error) {
      setFeedback(String(error));
    }
  };
  const title = issue?.threadId ? t.threadFailed : failure.step === 'outline-documents' ? t.documentFailed
    : failure.step === 'agent' ? t.agentFailed
      : failure.step === 'provider-configuration' || failure.step === 'configuration-observation' ? t.providersFailed
        : failure.step === 'personal-ranking' ? t.rankingFailed : t.failed;
  return (
    <section className="startup-failure" role="alert" aria-labelledby={titleId}>
      {issues.length > 1 ? <SelectControl label={t.issues} variant="boxed" value={issue?.id} onChange={(event) => { setSelectedId(event.target.value); setFeedback(null); }}>
          {issues.map((entry) => <option key={entry.id} value={entry.id}>{entry.threadId ? `${t.threadFailed} · ${entry.threadId}` : entry.domain === 'outline' ? t.documentFailed : entry.domain === 'agent' ? t.agentFailed : entry.domain === 'configuration' ? t.providersFailed : t.failed}</option>)}
      </SelectControl> : null}
      <h1 id={titleId}>{title}</h1>
      <p>{failure.message}</p>
      {issue?.format ? <p>{t.storedFormat}: {issue.format.found} · {t.expectedFormat}: {issue.format.expected}</p> : null}
      {issue?.threadId ? <>
        <p>{t.quarantined}: <code>{issue.threadId}</code></p>
        {dependents.length ? <p>{t.dependentThreads}: {dependents.map((entry) => entry.threadId).join(', ')}</p> : null}
        <p>{t.quarantineHelp}</p>
      </> : null}
      {props.onContinue ? <p>{t.notesAvailable}</p> : null}
      {issue?.recovery ? <ThreadRecoveryPanel key={issue.id} recoveryId={issue.id} /> : null}
      <div className="startup-failure-actions">
        {props.onContinue ? <Button onClick={props.onContinue}>{t.continue}</Button> : null}
        {issue?.retryable !== false ? <Button onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? <LoaderIcon size="toolbar" /> : <RefreshIcon size="toolbar" />}
          {props.retrying ? t.retrying : t.retry}
        </Button> : null}
        {issue?.actions.map((action) => <Button key={action} onClick={() => void runIssueAction(action)}>
          {action === 'copy-details' ? t.copyDetails : t.openSource}
        </Button>)}
        <Button onClick={props.onQuit}>
          <QuitIcon size="toolbar" />{t.quit}
        </Button>
      </div>
      {props.actionError || feedback ? <p role="status">{props.actionError ?? feedback}</p> : null}
    </section>
  );
}
