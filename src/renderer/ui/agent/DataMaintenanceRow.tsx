import { memo, useState } from 'react';
import { Button } from '../primitives/Button';
import { InsetRow } from './SettingsInsetList';

/**
 * A row that clears something, confirmed natively by main and reporting through
 * the shared feedback surface.
 *
 * It replaces two components that were the same fifty-two lines twice, differing
 * only in their labels and which bridge call they made — and it is the shape any
 * future "clear X" row takes, so the third one does not become a third copy.
 *
 * `action` returns main's result: `cleared` is a success, `failed` with
 * `unavailable` means this window cannot do it at all, and a cancelled
 * confirmation resolves to neither and is deliberately silent — the user
 * declining is not an outcome that needs reporting back to them.
 */
type ClearResult = { status: string; error?: string } | undefined;

interface DataMaintenanceRowProps {
  label: string;
  sublabel: string;
  actionLabel: string;
  busyLabel: string;
  clearedNotice: string;
  failedMessage: string;
  unavailableMessage: string;
  action: () => Promise<ClearResult> | ClearResult;
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}

export const DataMaintenanceRow = memo(function DataMaintenanceRow({
  label,
  sublabel,
  actionLabel,
  busyLabel,
  clearedNotice,
  failedMessage,
  unavailableMessage,
  action,
  onError,
  onNotice,
}: DataMaintenanceRowProps) {
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    onError(null);
    onNotice(null);
    try {
      const result = await action();
      if (!result || (result.status === 'failed' && result.error === 'unavailable')) {
        onError(unavailableMessage);
      } else if (result.status === 'failed') {
        onError(failedMessage);
      } else if (result.status === 'cleared') {
        onNotice(clearedNotice);
      }
    } catch {
      onError(failedMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <InsetRow
      label={label}
      sublabel={sublabel}
      trailing={(
        <Button disabled={busy} onClick={() => void run()} variant="secondary">
          {busy ? busyLabel : actionLabel}
        </Button>
      )}
      wrap
    />
  );
});
