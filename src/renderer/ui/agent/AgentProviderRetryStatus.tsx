import type { AgentProviderRetryStatus as ProviderRetryStatus } from '../../agent/runtime';
import { useT } from '../../i18n/I18nProvider';
import { ICON_SIZE, LoaderIcon } from '../icons';

export function AgentProviderRetryStatus({ status }: { status: ProviderRetryStatus }) {
  const t = useT();
  return (
    <div className="agent-provider-retry-status" role="status" aria-atomic="true" aria-live="polite">
      <LoaderIcon aria-hidden className="agent-provider-retry-spinner" size={ICON_SIZE.tiny} />
      <span>{t.agent.chat.reconnecting({ attempt: status.attempt, maxRetries: status.maxRetries })}</span>
    </div>
  );
}
