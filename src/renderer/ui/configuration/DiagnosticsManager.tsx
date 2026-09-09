import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { InsetGroup, InsetRow } from '../agent/SettingsInsetList';
import { SettingsFeedback, type SettingsFeedbackState } from './SettingsFeedback';
export function DiagnosticsManager() {
  const t = useT();
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<null | 'reveal' | 'export'>(null);
  const [feedback, setFeedback] = useState<Record<string, SettingsFeedbackState>>({});
  function report(key: string, value: SettingsFeedbackState = {}) { setFeedback((current) => ({ ...current, [key]: value })); }
  async function revealDiagnosticsLog() {
    setDiagnosticsBusy('reveal');
    report('reveal');
    try {
      const result = await window.lin?.revealDiagnosticsLog?.();
      if (!result) {
        report('reveal', { error: t.settings.general.diagnosticsUnavailable });
      } else if (!result.ok) {
        report('reveal', { error: result.error ?? t.settings.general.diagnosticsRevealFailed });
      } else {
        report('reveal', { notice: t.settings.general.diagnosticsRevealedNotice });
      }
    } catch (caught) {
      report('reveal', { error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function exportDiagnostics() {
    setDiagnosticsBusy('export');
    report('export');
    try {
      const result = await window.lin?.exportDiagnostics?.();
      if (!result) {
        report('export', { error: t.settings.general.diagnosticsUnavailable });
      } else if (result.canceled) {
        return;
      } else if (!result.ok) {
        report('export', { error: result.error ?? t.settings.general.diagnosticsExportFailed });
      } else {
        report('export', { notice: t.settings.general.diagnosticsExportedNotice });
      }
    } catch (caught) {
      report('export', { error: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  return <>
      <InsetGroup
        ariaLabel={t.settings.general.diagnosticsGroup}
        label={t.settings.general.diagnosticsGroup}
      >
        <InsetRow
          feedback={<SettingsFeedback feedback={feedback.reveal} />}
          label={t.settings.general.revealDiagnosticsLabel}
          sublabel={t.settings.general.revealDiagnosticsSublabel}
          trailing={(
            <Button
              disabled={diagnosticsBusy !== null}
              onClick={() => void revealDiagnosticsLog()}
              variant="secondary"
            >
              {diagnosticsBusy === 'reveal' ? t.settings.general.diagnosticsWorking : t.settings.general.revealDiagnosticsAction}
            </Button>
          )}
          wrap
        />
        <InsetRow
          feedback={<SettingsFeedback feedback={feedback.export} />}
          label={t.settings.general.exportDiagnosticsLabel}
          sublabel={t.settings.general.exportDiagnosticsSublabel}
          trailing={(
            <Button
              disabled={diagnosticsBusy !== null}
              onClick={() => void exportDiagnostics()}
              variant="secondary"
            >
              {diagnosticsBusy === 'export' ? t.settings.general.diagnosticsWorking : t.settings.general.exportDiagnosticsAction}
            </Button>
          )}
          wrap
        />
      </InsetGroup>
  </>;
}
