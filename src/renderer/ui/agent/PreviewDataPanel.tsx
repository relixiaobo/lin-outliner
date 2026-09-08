import { useEffect, useRef, useState } from 'react';
import type { DataOperationView, PreviewDataStatus } from '../../../core/previewOperations';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { RefreshIcon } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { formatBytes } from '../preview/previewFormatting';

export function PreviewDataPanel() {
  const t = useT();
  const labels = t.settings.general;
  const [status, setStatus] = useState<PreviewDataStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const live = useRef(false);
  const clearing = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    live.current = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      const bridge = window.lin;
      if (!bridge?.previewOperation) {
        setReadFailed(true);
        return;
      }
      void bridge
        .previewOperation('data_inspect', { request: {} })
        .then((result) => {
          if (live.current && current === generation && 'translations' in result) {
            setStatus(result);
            setReadFailed(false);
          }
        })
        .catch(() => {
          if (live.current && current === generation) setReadFailed(true);
        });
    };
    refreshRef.current = refresh;
    refresh();
    const unsubscribe = window.lin?.onPreviewDataChanged?.(refresh);
    return () => {
      live.current = false;
      generation++;
      unsubscribe?.();
    };
  }, [labels.translationDataUnavailable]);

  const latestOperation = status?.operations.at(-1);
  useEffect(() => {
    if (!latestOperation || latestOperation.scope === 'content') return;
    if (latestOperation.state === 'cleared' || latestOperation.state === 'failed')
      showOutcome(latestOperation);
    else setFeedback(null);
  }, [latestOperation?.operationId, latestOperation?.state, latestOperation?.liveDisplays, labels]);

  function showOutcome(result: DataOperationView) {
    const cleared = result.state === 'cleared';
    const text =
      result.scope === 'translations'
        ? cleared
          ? labels.translationDataClearedNotice
          : labels.translationDataClearFailed
        : cleared
          ? labels.websiteDataClearedNotice
          : labels.websiteDataClearFailed;
    setFeedback({
      text: result.liveDisplays === 'reload_failed' ? labels.websiteDataReloadFailed : text,
      error: !cleared || result.liveDisplays === 'reload_failed',
    });
  }

  async function clear(scope: 'translations' | 'websites') {
    if (clearing.current || !window.lin?.previewOperation) return;
    clearing.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = (await window.lin.previewOperation('data_manage', {
        request: { scope },
      })) as DataOperationView;
      if (!live.current || result.state === 'canceled') return;
      showOutcome(result);
    } catch {
      if (live.current)
        setFeedback({
          text:
            scope === 'translations'
              ? labels.translationDataClearFailed
              : labels.websiteDataClearFailed,
          error: true,
        });
    } finally {
      clearing.current = false;
      if (live.current) {
        setBusy(false);
        refreshRef.current();
      }
    }
  }
  const working =
    busy ||
    status?.operations.some(
      (operation) => operation.state === 'confirming' || operation.state === 'running',
    );
  const entries = status
    ? Object.values(status.translations.entries).reduce((sum, count) => sum + count, 0)
    : null;
  return (
    <section className="agent-settings-section" aria-label={t.settings.preview.sectionAriaLabel}>
      <InsetGroup
        label={labels.translationDataGroup}
        id="translation"
        ariaLabel={labels.translationDataGroup}
        footnote={labels.translationDataClearConfirmDetail}
      >
        <InsetRow
          label={labels.translationDataLabel}
          sublabel={
            entries === null
              ? labels.translationDataSublabel
              : labels.translationDataUsage({ entries, size: formatBytes(status!.translations.logicalBytes) })
          }
          trailing={
            <Button
              disabled={!status || working}
              onClick={() => void clear('translations')}
              variant="secondary"
            >
              {working ? labels.translationDataClearing : labels.translationDataClearAction}
            </Button>
          }
          wrap
        />
      </InsetGroup>
      <InsetGroup label={labels.websiteDataGroup} id="websites" ariaLabel={labels.websiteDataGroup} footnote={labels.websiteDataClearConfirmDetail}>
        <InsetRow
          label={labels.websiteDataLabel}
          sublabel={
            status?.websites.cacheBytes == null
              ? labels.websiteDataSublabel
              : labels.websiteDataUsage({
                  size: formatBytes(status.websites.cacheBytes),
                  previews: status.websites.activeGuests,
                })
          }
          trailing={
            <Button
              disabled={!status?.websites.available || working}
              onClick={() => void clear('websites')}
              variant="secondary"
            >
              {working ? labels.websiteDataClearing : labels.websiteDataClearAction}
            </Button>
          }
          wrap
        />
      </InsetGroup>
      {feedback ? <p role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p> : null}
      {readFailed ? (
        <div role="alert">
          {labels.translationDataUnavailable}
          <IconButton
            icon={RefreshIcon}
            label={labels.previewDataRetry}
            onClick={() => refreshRef.current()}
          />
        </div>
      ) : null}
    </section>
  );
}
