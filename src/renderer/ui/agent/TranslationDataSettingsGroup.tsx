import { memo, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface TranslationDataSettingsGroupProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}

export const TranslationDataSettingsGroup = memo(function TranslationDataSettingsGroup({
  onError,
  onNotice,
}: TranslationDataSettingsGroupProps) {
  const labels = useT().settings.general;
  const [busy, setBusy] = useState(false);

  async function clearSavedTranslations(): Promise<void> {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.clearPreviewTranslationCache?.();
      if (!result || (result.status === 'failed' && result.error === 'unavailable')) {
        onError(labels.translationDataUnavailable);
      } else if (result.status === 'failed') {
        onError(labels.translationDataClearFailed);
      } else if (result.status === 'cleared') {
        onNotice(labels.translationDataClearedNotice);
      }
    } catch {
      onError(labels.translationDataClearFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <InsetGroup ariaLabel={labels.translationDataGroup} label={labels.translationDataGroup}>
      <InsetRow
        label={labels.translationDataLabel}
        sublabel={labels.translationDataSublabel}
        trailing={(
          <Button disabled={busy} onClick={() => void clearSavedTranslations()} variant="secondary">
            {busy ? labels.translationDataClearing : labels.translationDataClearAction}
          </Button>
        )}
        wrap
      />
    </InsetGroup>
  );
});
