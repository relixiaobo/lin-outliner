import { useEffect, useRef, useState } from 'react';
import type { ThreadRecoveryPreview, ThreadRecoveryRequest } from '../../core/threadRecovery';
import { useT } from '../i18n/I18nProvider';
import { Button } from './primitives/Button';

export function ThreadRecoveryPanel({ recoveryId }: { readonly recoveryId: string }) {
  const t = useT().startup.recovery;
  const [preview, setPreview] = useState<ThreadRecoveryPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const submitting = useRef(false);
  useEffect(() => () => { requestGeneration.current++; }, []);

  const run = async (request: ThreadRecoveryRequest) => {
    if (submitting.current) return;
    submitting.current = true;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setError(null);
    try {
      const api = window.lin?.startup;
      if (!api) throw new Error(t.failed);
      const result = await api.recovery(request);
      if (generation !== requestGeneration.current) return;
      setPreview(result.preview);
      if (result.cancelled) setError(t.cancelled);
    } catch (failure) {
      if (generation !== requestGeneration.current) return;
      setError(failure instanceof Error ? failure.message : t.failed);
      // A failure can follow a durable commit. Read the original operation so
      // the next action resumes it instead of creating another confirmation.
      try {
        const result = await window.lin?.startup.recovery({ recoveryId, action: 'inspect' });
        if (generation === requestGeneration.current && result) setPreview(result.preview);
      } catch { /* Keep the last verified preview and the visible failure. */ }
    } finally {
      submitting.current = false;
      if (generation === requestGeneration.current) setBusy(false);
    }
  };
  const operation = preview?.operation;
  const pending = operation && operation.phase !== 'complete' && operation.phase !== 'cancelled';
  return <div className="thread-recovery-panel" aria-busy={busy}>
    {!preview ? <Button disabled={busy} onClick={() => void run({ recoveryId, action: 'inspect' })}>
      {busy ? t.inspecting : t.inspect}
    </Button> : <>
      <p>{t.scope}</p>
      <ul>{preview.threads.map((thread) => <li key={thread.threadId}>{thread.name ?? thread.threadId}<br /><code>{thread.threadId}</code></li>)}</ul>
      <p>{t.resources}: {preview.resourceCount}</p>
      <p>{t.preserved}</p>
      <p>{t.retained}: <span className="thread-recovery-path">{operation?.retainedPath ?? preview.retainedRoot}</span></p>
      {preview.source ? <p>{preview.source === 'rollout' ? t.sourceRollout : t.sourceProjection}</p> : null}
      {preview.rebuildUnavailable ? <p>{preview.rebuildUnavailable}</p> : null}
      {preview.blockers.length ? <><p>{t.blocked}</p><ul>{preview.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></> : null}
      {operation ? <p role="status">{operation.error ?? t[operation.phase]}</p> : null}
      <div className="startup-failure-actions">
        {!operation ? <>
          <Button disabled={busy || preview.blockers.length > 0 || !preview.source}
            onClick={() => void run({ recoveryId, action: 'rebuild', revision: preview.revision })}>{t.rebuild}</Button>
          <Button disabled={busy || preview.blockers.length > 0 || !preview.threads.length}
            onClick={() => void run({ recoveryId, action: 'remove', revision: preview.revision })}>{t.remove}</Button>
          <Button disabled={busy} onClick={() => void run({ recoveryId, action: 'inspect' })}>{t.reinspect}</Button>
        </> : <>
          {pending ? <Button disabled={busy} onClick={() => void run({ recoveryId, action: 'resume', operationId: operation.id })}>{t.resume}</Button> : null}
          {operation.phase === 'retaining' ? <Button disabled={busy} onClick={() => void run({ recoveryId, action: 'reinspect', operationId: operation.id })}>{t.reinspect}</Button> : null}
          {operation.phase === 'complete' ? <Button disabled={busy}
            onClick={() => void run({ recoveryId, action: 'reveal', operationId: operation.id })}>{t.reveal}</Button> : null}
        </>}
      </div>
    </>}
    {error ? <p role="status">{error}</p> : null}
  </div>;
}
