import { useMemo } from 'react';
import { AgentSettingsView } from './agent/AgentSettingsView';
import { settingsOpenTargetFromSearch } from '../../core/settingsWindow';

// Root rendered in the dedicated settings BrowserWindow (?surface=settings). It
// closes itself through the main process and, after applying changes, asks the
// main process to notify the main window so its provider state stays in sync.
export function SettingsWindow() {
  const initialTarget = useMemo(() => settingsOpenTargetFromSearch(window.location.search), []);
  return (
    <AgentSettingsView
      initialTarget={initialTarget}
      onClose={() => void window.lin?.closeSettings?.()}
      onApplied={async () => {
        await window.lin?.notifySettingsChanged?.();
      }}
    />
  );
}
