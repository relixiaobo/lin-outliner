import { useEffect, useRef, useState } from 'react';
import type { MemorySettingsView } from '../../../core/agent/memory';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import { formatDateTime } from '../formatting';
import { Button } from '../primitives/Button';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface MemorySettingsGroupProps {
  readonly onError: (message: string | null) => void;
  readonly onNotice: (message: string | null) => void;
}

export function MemorySettingsGroup({ onError, onNotice }: MemorySettingsGroupProps) {
  const { locale, t } = useI18n();
  const [settings, setSettings] = useState<MemorySettingsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const busyRef = useRef(false);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing || busyRef.current) return;
      refreshing = true;
      const generation = ++requestGenerationRef.current;
      try {
        const value = await api.memorySettings();
        if (active && generation === requestGenerationRef.current) setSettings(value);
      } catch (error) {
        if (active && generation === requestGenerationRef.current) onError(errorMessage(error));
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onError]);

  async function setEnabled(enabled: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onError(null);
    onNotice(null);
    const generation = ++requestGenerationRef.current;
    try {
      const value = await api.memorySetFeatureMode(enabled ? 'enabled' : 'disabled');
      if (generation === requestGenerationRef.current) {
        setSettings(value);
        onNotice(enabled ? t.settings.general.memoryEnabledNotice : t.settings.general.memoryDisabledNotice);
      }
    } catch (error) {
      if (generation === requestGenerationRef.current) onError(errorMessage(error));
    } finally {
      if (generation === requestGenerationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function reset() {
    if (busyRef.current) return;
    setConfirmingReset(false);
    busyRef.current = true;
    setBusy(true);
    onError(null);
    onNotice(null);
    const generation = ++requestGenerationRef.current;
    try {
      const value = await api.memoryReset();
      if (generation === requestGenerationRef.current) {
        setSettings(value);
        onNotice(t.settings.general.memoryResetNotice);
      }
    } catch (error) {
      if (generation === requestGenerationRef.current) onError(errorMessage(error));
    } finally {
      if (generation === requestGenerationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  async function openMemory() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onError(null);
    const generation = ++requestGenerationRef.current;
    try {
      const value = await api.memoryOpen();
      if (generation === requestGenerationRef.current) setSettings(value);
    } catch (error) {
      if (generation === requestGenerationRef.current) onError(errorMessage(error));
    } finally {
      if (generation === requestGenerationRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  const enabled = settings?.status.featureMode === 'enabled';
  const status = settings?.status;
  const workerStatusCopy = status?.lastError
    ? t.settings.general.memoryError({ error: status.lastError })
    : status?.pendingJobs
      ? t.settings.general.memoryPending({ count: status.pendingJobs })
      : status?.lastSuccessfulRunAt
        ? t.settings.general.memoryUpdated({
            date: formatDateTime(status.lastSuccessfulRunAt, locale, {
              dateStyle: 'medium',
              timeStyle: 'short',
            }),
          })
        : t.settings.general.memoryReady;
  const statusCopy = status && status.strayTaggedNodeCount > 0
    ? `${workerStatusCopy} ${t.settings.general.memoryStrayTaggedNodes({ count: status.strayTaggedNodeCount })}`
    : workerStatusCopy;

  return (
    <>
      <InsetGroup ariaLabel={t.settings.general.memoryGroup} label={t.settings.general.memoryGroup}>
        <InsetRow
          label={t.settings.general.memoryLabel}
          sublabel={t.settings.general.memorySublabel}
          trailing={(
            <SwitchControl
              checked={enabled}
              disabled={busy || !settings}
              label={t.settings.general.memoryLabel}
              onCheckedChange={(value) => void setEnabled(value)}
            >
              <SwitchMark checked={enabled} />
            </SwitchControl>
          )}
          wrap
        />
        <InsetRow
          label={t.settings.general.memoryStatusLabel}
          sublabel={statusCopy}
          trailing={(
            <Button disabled={busy} onClick={() => void openMemory()}>
              {t.settings.general.memoryOpenAction}
            </Button>
          )}
          wrap
        />
        <InsetRow
          label={t.settings.general.memoryResetLabel}
          sublabel={t.settings.general.memoryResetSublabel}
          trailing={(
            <Button disabled={busy} onClick={() => setConfirmingReset(true)} variant="danger">
              {t.settings.general.memoryResetAction}
            </Button>
          )}
          wrap
        />
      </InsetGroup>
      {confirmingReset ? (
        <ConfirmDialog
          cancelLabel={t.dialog.cancel}
          confirmLabel={t.settings.general.memoryResetAction}
          danger
          message={t.settings.general.memoryResetConfirmMessage}
          onCancel={() => setConfirmingReset(false)}
          onConfirm={() => void reset()}
          title={t.settings.general.memoryResetConfirmTitle}
        />
      ) : null}
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
