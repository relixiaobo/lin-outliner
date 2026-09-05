import { LoaderIcon, QuitIcon, RefreshIcon } from './icons';
import { useT } from '../i18n/I18nProvider';
import { Button } from './primitives/Button';

export function StartupFailure(props: {
  readonly failure: { readonly step: string; readonly message: string };
  readonly retrying: boolean;
  readonly onRetry: () => void;
  readonly onQuit: () => void;
}) {
  const t = useT().startup;
  const title = props.failure.step === 'outline-documents' ? t.documentFailed
    : props.failure.step === 'agent' ? t.agentFailed
      : props.failure.step === 'provider-configuration' ? t.providersFailed
        : props.failure.step === 'personal-ranking' ? t.rankingFailed : t.failed;
  return (
    <section className="startup-failure" role="alert" aria-labelledby="startup-failure-title">
      <h1 id="startup-failure-title">{title}</h1>
      <p>{props.failure.message}</p>
      <div className="startup-failure-actions">
        <Button onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? <LoaderIcon size="toolbar" /> : <RefreshIcon size="toolbar" />}
          {props.retrying ? t.retrying : t.retry}
        </Button>
        <Button onClick={props.onQuit}>
          <QuitIcon size="toolbar" />{t.quit}
        </Button>
      </div>
    </section>
  );
}
