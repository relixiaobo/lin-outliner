import { useEffect, useRef, useState } from 'react';
import type { MemoryResetView } from '../../../core/agent/memoryOperations';
import { api } from '../../api/client';
import { useMemoryView } from '../../agent/useMemoryView';
import { useI18n } from '../../i18n/I18nProvider';
import { formatDateTime } from '../formatting';
import { Button } from '../primitives/Button';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';

export function MemorySettingsGroup() {
  const { locale, t } = useI18n();
  const { view, error: readError, refresh } = useMemoryView();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reset, setReset] = useState<MemoryResetView | null>(null);
  const [desiredEnabled, setDesiredEnabled] = useState<boolean | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = view?.status.featureMode === 'enabled';
  const pendingReset = reset?.state === 'prepared' || reset?.state === 'unknown';

  useEffect(() => {
    if (desiredEnabled === null || desiredEnabled !== enabled) return;
    setNotice(enabled ? t.settings.general.memoryEnabledNotice : t.settings.general.memoryDisabledNotice);
    setDesiredEnabled(null);
  }, [desiredEnabled, enabled, t.settings.general.memoryEnabledNotice, t.settings.general.memoryDisabledNotice]);

  useEffect(() => {
    if (!reset || !pendingReset) return;
    let active = true;
    void api.memoryInspect({ operation: 'reset', operationId: reset.operationId }).then((result) => {
      if (active && result.operation === 'reset') setReset(result.reset);
    }).catch(() => { /* Retain unresolved evidence until a later owner notification. */ });
    return () => { active = false; };
  }, [view, reset?.operationId, pendingReset]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    setDesiredEnabled(null);
    setReset((current) => current?.state === 'prepared' || current?.state === 'unknown' ? current : null);
    try { await action(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); refresh(); }
    }
  }

  const status = view?.status;
  const workerStatus = !status ? t.common.loading : status.lastError
    ? t.settings.general.memoryError({ error: status.lastError })
    : status.pendingJobs ? t.settings.general.memoryPending({ count: status.pendingJobs })
      : status.lastSuccessfulRunAt ? t.settings.general.memoryUpdated({ date: formatDateTime(status.lastSuccessfulRunAt, locale, { dateStyle: 'medium', timeStyle: 'short' }) })
        : t.settings.general.memoryReady;
  const statusCopy = status && status.strayTaggedNodeCount > 0
    ? `${workerStatus} ${t.settings.general.memoryStrayTaggedNodes({ count: status.strayTaggedNodeCount })}` : workerStatus;
  const resetCopy = reset ? {
    finalized: t.settings.general.memoryResetNotice, prepared: t.settings.general.memoryResetPending,
    conflicted: t.settings.general.memoryResetConflicted, unknown: t.settings.general.memoryResetUnknown,
  }[reset.state] : null;
  const preferenceCopy = desiredEnabled === null ? null : t.settings.general.memoryPreferenceSaved;

  return <>
    <InsetGroup ariaLabel={t.settings.general.memoryGroup} label={t.settings.general.memoryGroup}>
      <InsetRow label={t.settings.general.memoryLabel} sublabel={t.settings.general.memorySublabel} trailing={
        <SwitchControl checked={enabled} disabled={busy || !view} label={t.settings.general.memoryLabel}
          onCheckedChange={(value) => void run(async () => {
            await api.memorySetEnabled(value);
            if (mounted.current) setDesiredEnabled(value);
          })}><SwitchMark checked={enabled} /></SwitchControl>
      } wrap />
      <InsetRow label={t.settings.general.memoryStatusLabel} sublabel={statusCopy} trailing={
        <Button disabled={busy || !view} onClick={() => void run(async () => {
          const result = await api.memoryManage({ operation: 'open' });
          if (mounted.current && result.operation === 'open' && result.navigation !== 'opened') setNotice(t.settings.general.memoryNavigationUnavailable);
        })}>{t.settings.general.memoryOpenAction}</Button>
      } wrap />
      <InsetRow label={t.settings.general.memoryResetLabel} sublabel={t.settings.general.memoryResetSublabel} trailing={
        <Button disabled={busy || !view || pendingReset} variant="danger" onClick={() => void run(async () => {
          const result = await api.memoryManage({ operation: 'reset' });
          if (mounted.current && result.operation === 'reset') setReset(result.reset);
        })}>{t.settings.general.memoryResetAction}</Button>
      } wrap />
    </InsetGroup>
    {error || readError ? <div className="agent-settings-error" role="alert">{error ?? readError}</div> : null}
    {notice || resetCopy || preferenceCopy ? <div className="agent-settings-notice" role="status">{notice ?? resetCopy ?? preferenceCopy}</div> : null}
  </>;
}
