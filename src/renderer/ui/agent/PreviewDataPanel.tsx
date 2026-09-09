import { SettingsFeedback, type SettingsFeedbackState } from '../configuration/SettingsFeedback';
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
  const [busy, setBusy] = useState<'translations' | 'websites' | null>(null);
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
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

  const latestTranslation = status?.operations.filter((operation) => operation.scope === 'translations').at(-1);
  const latestWebsite = status?.operations.filter((operation) => operation.scope === 'websites').at(-1);
  useEffect(() => { if (latestTranslation) showOutcome(latestTranslation); }, [latestTranslation?.operationId, latestTranslation?.state, latestTranslation?.liveDisplays, labels]);
  useEffect(() => { if (latestWebsite) showOutcome(latestWebsite); }, [latestWebsite?.operationId, latestWebsite?.state, latestWebsite?.liveDisplays, labels]);

  function report(scope: string, value: SettingsFeedbackState = {}) {
    setFeedback((current) => ({ ...current, [scope]: value }));
  }
  function showOutcome(result: DataOperationView) {
    if (result.scope === 'content') return;
    if (result.state !== 'cleared' && result.state !== 'failed') { report(result.scope); return; }
    const cleared = result.state === 'cleared';
    const text = result.liveDisplays === 'reload_failed' ? labels.websiteDataReloadFailed
      : result.scope === 'translations'
        ? cleared ? labels.translationDataClearedNotice : labels.translationDataClearFailed
        : cleared ? labels.websiteDataClearedNotice : labels.websiteDataClearFailed;
    report(result.scope, !cleared || result.liveDisplays === 'reload_failed' ? { error: text } : { notice: text });
  }

  async function clear(scope: 'translations' | 'websites') {
    if (clearing.current || !window.lin?.previewOperation) return;
    clearing.current = true;
    setBusy(scope);
    report(scope);
    try {
      const result = (await window.lin.previewOperation('data_manage', {
        request: { scope },
      })) as DataOperationView;
      if (!live.current || result.state === 'canceled') return;
      showOutcome(result);
    } catch {
      if (live.current)
        report(scope, { error: scope === 'translations' ? labels.translationDataClearFailed : labels.websiteDataClearFailed });
    } finally {
      clearing.current = false;
      if (live.current) {
        setBusy(null);
        refreshRef.current();
      }
    }
  }
  const workingFor = (scope: 'translations' | 'websites') => busy === scope || status?.operations.some(
    (operation) => operation.scope === scope && (operation.state === 'confirming' || operation.state === 'running'),
  );
  const working = workingFor('translations') || workingFor('websites');
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
          feedback={<SettingsFeedback feedback={feedback.translations} />}
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
              {workingFor('translations') ? labels.translationDataClearing : labels.translationDataClearAction}
            </Button>
          }
          wrap
        />
      </InsetGroup>
      <InsetGroup label={labels.websiteDataGroup} id="websites" ariaLabel={labels.websiteDataGroup} footnote={labels.websiteDataClearConfirmDetail}>
        <InsetRow
          feedback={<SettingsFeedback feedback={feedback.websites} />}
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
              {workingFor('websites') ? labels.websiteDataClearing : labels.websiteDataClearAction}
            </Button>
          }
          wrap
        />
      </InsetGroup>
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
