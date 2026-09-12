import { useEffect, useState } from 'react';
import { automationStore, canStopScheduledRun, useAutomationStore } from './automationStore';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../../ui/primitives/Button';

/** The same run-level action in history and conversations; Task stop is separate. */
export function ScheduledRunStop({ runId, active, watch = false }: { runId: string; active: boolean; watch?: boolean }) {
  const t = useT().agent.automations.work;
  const snapshot = useAutomationStore(active);
  const result = snapshot.runResults.get(runId);
  const operation = snapshot.runOperations.get(runId);
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !watch) return;
    let live = true;
    const lease = automationStore.watchRun(runId);
    void lease.ready.then(() => { if (live) setReadError(null); }).catch((error) => { if (live) setReadError(String(error)); });
    return () => { live = false; lease.release(); };
  }, [active, runId, watch]);
  const stopping = result?.state === 'stopping';
  return <div className="scheduled-run-control" aria-live="polite">
    {canStopScheduledRun(result) || stopping ? <Button size="sm" disabled={!active || stopping || operation?.pending} aria-busy={operation?.pending || undefined}
      onClick={() => { void automationStore.stopRun(runId).catch(() => undefined); }}>{stopping ? t.results.stopping : t.stop}</Button> : null}
    {operation?.error || readError ? <p role="alert" className="scheduled-setting-note">{operation?.error ?? readError}</p> : null}
  </div>;
}
