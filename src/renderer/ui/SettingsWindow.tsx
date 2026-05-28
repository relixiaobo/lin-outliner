import { AgentSettingsView } from './agent/AgentSettingsView';

// Root rendered in the dedicated settings BrowserWindow (?surface=settings). It
// closes itself through the main process and, after applying changes, asks the
// main process to notify the main window so its provider state stays in sync.
export function SettingsWindow() {
  return (
    <AgentSettingsView
      onClose={() => void window.lin?.closeSettings?.()}
      onApplied={async () => {
        await window.lin?.notifySettingsChanged?.();
      }}
    />
  );
}
