import { useCallback, useEffect, useId, useState } from 'react';
import type { DataLifecycleRequest, DataLifecycleState } from '../../core/dataLifecycle';
import { useI18n } from '../i18n/I18nProvider';
import { Button } from './primitives/Button';
import { SelectControl } from './primitives/SelectControl';

export function DataRecoveryPanel({ active = true, statusOnly = false }: { readonly active?: boolean; readonly statusOnly?: boolean }) {
  const { t: messages, locale } = useI18n();
  const t = messages.startup.dataRecovery;
  const titleId = useId();
  const [state, setState] = useState<DataLifecycleState | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useCallback((next: DataLifecycleState) => {
    setState((previous) => previous && previous.revision > next.revision ? previous : next);
  }, []);

  useEffect(() => {
    if (!active) return;
    const api = window.lin?.dataLifecycle;
    if (!api) { setError(t.unavailable); return; }
    let mounted = true;
    const off = api.onChanged((next) => { if (mounted) { accept(next); setError(null); } });
    void api.request({ action: statusOnly ? 'status' : 'inspect' }).then((response) => {
      if (mounted) accept(response.state);
    }, (caught) => { if (mounted) setError(String(caught)); });
    return () => { mounted = false; off(); };
  }, [active, accept, t.unavailable, statusOnly]);

  const run = async (request: DataLifecycleRequest) => {
    if (busy || !window.lin?.dataLifecycle) return;
    setBusy(true); setError(null);
    try { accept((await window.lin.dataLifecycle.request(request)).state); }
    catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  const running = busy || !state || !['ready', 'recoveryRequired'].includes(state.phase);
  const selected = state?.backups.find((backup) => backup.id === selectedId) ?? state?.backups[0];
  const formatDate = (time: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);

  return <section className="data-recovery-panel" aria-labelledby={titleId}>
    <h2 id={titleId}>{t.title}</h2>
    <p>{t.description}</p>
    <p role="status" aria-live="polite">{busy ? t.working : t.phase[state?.phase ?? 'inspecting']}
      {state?.progress ? ` ${state.progress.completed} / ${state.progress.total}` : ''}
    </p>
    {state?.issues.length ? <ul>{state.issues.map((issue) => <li key={`${issue.domain}:${issue.storeId}`}>{issue.message}</li>)}</ul> : null}
    {state?.automaticExecutionPaused ? <div className="data-recovery-paused">
      <strong>{t.paused}</strong><p>{t.pausedDetail}</p>
      <Button disabled={running || !state.restoredGeneration} onClick={() => void run({ action: 'resume-execution', generation: state.restoredGeneration!, revision: state.revision })}>{t.resume}</Button>
    </div> : null}
    {!statusOnly && (state?.backups.length ? <>
      <SelectControl label={t.backups} variant="boxed" value={selected?.id ?? ''} disabled={running} onChange={(event) => setSelectedId(event.target.value)}>
        {state.backups.map((backup) => <option key={backup.id} value={backup.id}>
          {formatDate(backup.createdAt)} · {backup.applicationVersion}{backup.purpose === 'retention' ? ` · ${t.retained}` : ''}{backup.verified ? '' : ` · ${t.invalid}`}
        </option>)}
      </SelectControl>
      {selected ? <p>{t.details({ files: selected.fileCount, megabytes: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(selected.bytes / 1024 / 1024) })}</p> : null}
      {selected?.purpose === 'retention' ? <p>{t.retainedDetail}</p> : null}
    </> : <p>{t.empty}</p>)}
    {!statusOnly ? <div className="data-recovery-actions">
      <Button disabled={running || state?.phase !== 'ready' || !!state.operationId} onClick={() => void run({ action: 'backup' })}>{t.backup}</Button>
      <Button disabled={running || !selected?.verified || selected.purpose !== 'backup'} onClick={() => selected && state && void run({ action: 'restore', backupId: selected.id, revision: state.revision })}>{t.restore}</Button>
      {selected ? <Button disabled={busy} onClick={() => void run({ action: 'reveal', backupId: selected.id })}>{t.reveal}</Button> : null}
      <Button disabled={running} onClick={() => void run({ action: 'inspect' })}>{t.refresh}</Button>
      {state?.phase === 'recoveryRequired' ? <Button disabled={running} onClick={() => void run({ action: 'retry' })}>{t.retry}</Button> : null}
      {state && (state.phase === 'ready' || state.issues.some((issue) => issue.storeId === 'agent-history' && issue.reason !== 'future-version')) ? <Button disabled={running || !!state.operationId} onClick={() => void run({ action: 'repair-history', revision: state.revision })}>{t.repair}</Button> : null}
      {state?.canCancelOperation && state.operationId ? <Button disabled={busy} onClick={() => void run({ action: 'cancel', operationId: state.operationId!, revision: state.revision })}>{t.cancelOperation}</Button> : null}
      <Button disabled={busy} onClick={() => void run({ action: 'export-diagnostics' })}>{t.exportDiagnostics}</Button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
