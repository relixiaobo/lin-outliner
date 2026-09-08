import { useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { InsetGroup, InsetRow } from '../agent/SettingsInsetList';
import { ManagerFeedback } from './ManagerFeedback';
export function DiagnosticsManager() {
  const t = useT();
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<null | 'reveal' | 'export'>(null);
  const [error, onError] = useState<string | null>(null);
  const [notice, onNotice] = useState<string | null>(null);
  async function revealDiagnosticsLog() {
    setDiagnosticsBusy('reveal');
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.revealDiagnosticsLog?.();
      if (!result) {
        onError(t.settings.general.diagnosticsUnavailable);
      } else if (!result.ok) {
        onError(result.error ?? t.settings.general.diagnosticsRevealFailed);
      } else {
        onNotice(t.settings.general.diagnosticsRevealedNotice);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function exportDiagnostics() {
    setDiagnosticsBusy('export');
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.exportDiagnostics?.();
      if (!result) {
        onError(t.settings.general.diagnosticsUnavailable);
      } else if (result.canceled) {
        return;
      } else if (!result.ok) {
        onError(result.error ?? t.settings.general.diagnosticsExportFailed);
      } else {
        onNotice(t.settings.general.diagnosticsExportedNotice);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
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
    <ManagerFeedback error={error} notice={notice} />
  </>;
}
