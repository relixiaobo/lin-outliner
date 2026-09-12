import { SettingsFeedback, type SettingsFeedbackState } from '../configuration/SettingsFeedback';
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

export function MemoryManager() {
  const { locale, t } = useI18n();
  const { view, error: readError, refresh } = useMemoryView();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  function report(key: string, value: SettingsFeedbackState = {}) { setFeedback((current) => ({ ...current, [key]: value })); }
  const [reset, setReset] = useState<MemoryResetView | null>(null);
  const [desiredEnabled, setDesiredEnabled] = useState<boolean | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const enabled = view?.status.featureMode === 'enabled';
  const pendingReset = reset?.state === 'prepared' || reset?.state === 'unknown';

  useEffect(() => {
    if (desiredEnabled === null || desiredEnabled !== enabled) return;
    report('enabled');
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

  async function run(key: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    report(key);
    if (key === 'enabled') setDesiredEnabled(null);
    if (key === 'reset') setReset(null);
    try { await action(); }
    catch (caught) { if (mounted.current) report(key, { error: caught instanceof Error ? caught.message : String(caught) }); }
    finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); refresh(); }
    }
  }

  const status = view?.status;
  const workerStatus = !status ? t.common.loading : status.lastError
    ? t.settings.general.memoryError({ error: status.lastError })
    : status.pendingJobs ? t.settings.general.memoryPending({ count: status.pendingJobs })
      : !enabled ? t.settings.general.memoryPaused
        : status.lastSuccessfulRunAt ? t.settings.general.memoryUpdated({ date: formatDateTime(status.lastSuccessfulRunAt, locale, { dateStyle: 'medium', timeStyle: 'short' }) })
        : t.settings.general.memoryReady;
  const statusCopy = status && status.strayTaggedNodeCount > 0
    ? `${workerStatus} ${t.settings.general.memoryStrayTaggedNodes({ count: status.strayTaggedNodeCount })}` : workerStatus;
  const resetBase = reset ? {
    finalized: t.settings.general.memoryResetNotice, prepared: t.settings.general.memoryResetPending,
    conflicted: t.settings.general.memoryResetConflicted, unknown: t.settings.general.memoryResetUnknown,
  }[reset.state] : null;
  const resetCopy = reset?.profileState === 'removed' && reset.state !== 'finalized'
    ? `${resetBase} ${t.settings.general.memoryProfileResetPartial}` : resetBase;
  const preferenceCopy = desiredEnabled === null ? null : t.settings.general.memoryPreferenceSaved;

  return <>
    <InsetGroup ariaLabel={t.settings.general.memoryGroup} headerFeedback={<SettingsFeedback feedback={{ error: readError }} />}>
      <InsetRow feedback={<SettingsFeedback feedback={feedback.enabled?.error ? feedback.enabled : { notice: preferenceCopy }} />} label={t.settings.general.memoryLabel} sublabel={t.settings.general.memorySublabel} trailing={
        <SwitchControl checked={enabled} disabled={busy || !view} label={t.settings.general.memoryLabel}
          onCheckedChange={(value) => void run('enabled', async () => {
            await api.memorySetEnabled(value);
            if (mounted.current) setDesiredEnabled(value);
          })}><SwitchMark checked={enabled} /></SwitchControl>
      } wrap />
      <InsetRow feedback={<SettingsFeedback feedback={feedback.open} />} label={t.settings.general.memoryStatusLabel} sublabel={statusCopy} trailing={
        <Button disabled={busy || !view} onClick={() => void run('open', async () => {
          const result = await api.memoryManage({ operation: 'open' });
          if (mounted.current && result.operation === 'open' && result.navigation !== 'opened') report('open', { error: t.settings.general.memoryNavigationUnavailable });
        })}>{t.settings.general.memoryOpenAction}</Button>
      } wrap />
    </InsetGroup>
    <InsetGroup ariaLabel={t.settings.general.memoryResetLabel} className="memory-reset-section">
      <InsetRow feedback={<SettingsFeedback feedback={feedback.reset?.error ? feedback.reset : reset?.state === 'conflicted' || reset?.state === 'unknown' ? { error: resetCopy } : { notice: resetCopy }} />} label={t.settings.general.memoryResetLabel} sublabel={t.settings.general.memoryResetSublabel} trailing={
        <Button disabled={busy || !view || pendingReset} variant="danger" onClick={() => void run('reset', async () => {
          const result = await api.memoryManage({ operation: 'reset' });
          if (mounted.current && result.operation === 'reset') setReset(result.reset);
        })}>{t.settings.general.memoryResetAction}</Button>
      } wrap />
    </InsetGroup>
  </>;
}
