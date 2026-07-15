import { memo, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { InsetGroup, InsetRow } from './SettingsInsetList';

interface WebsiteDataSettingsGroupProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}

export const WebsiteDataSettingsGroup = memo(function WebsiteDataSettingsGroup({
  onError,
  onNotice,
}: WebsiteDataSettingsGroupProps) {
  const labels = useT().settings.general;
  const [busy, setBusy] = useState(false);

  async function clearWebsiteData(): Promise<void> {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.clearUrlPreviewData?.();
      if (!result || (result.status === 'failed' && result.error === 'unavailable')) {
        onError(labels.websiteDataUnavailable);
      } else if (result.status === 'failed') {
        onError(labels.websiteDataClearFailed);
      } else if (result.status === 'cleared') {
        onNotice(labels.websiteDataClearedNotice);
      }
    } catch {
      onError(labels.websiteDataClearFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <InsetGroup ariaLabel={labels.websiteDataGroup} label={labels.websiteDataGroup}>
      <InsetRow
        label={labels.websiteDataLabel}
        sublabel={labels.websiteDataSublabel}
        trailing={(
          <Button disabled={busy} onClick={() => void clearWebsiteData()} variant="secondary">
            {busy ? labels.websiteDataClearing : labels.websiteDataClearAction}
          </Button>
        )}
        wrap
      />
    </InsetGroup>
  );
});
