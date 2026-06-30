import type { AgentContextClearEntry } from '../../agent/runtime';
import { useT } from '../../i18n/I18nProvider';

export function AgentContextClearBoundary({
  entry: _entry,
}: {
  entry: AgentContextClearEntry;
}) {
  const t = useT();
  return (
    <section className="agent-compaction-boundary agent-context-clear-boundary" aria-label={t.agent.process.contextCleared}>
      <div className="agent-compaction-line" aria-hidden="true" />
      <div className="agent-compaction-controls">
        <div className="agent-compaction-toggle agent-context-clear-label" role="status">
          <span>{t.agent.process.contextCleared}</span>
        </div>
      </div>
      <div className="agent-compaction-line" aria-hidden="true" />
    </section>
  );
}
