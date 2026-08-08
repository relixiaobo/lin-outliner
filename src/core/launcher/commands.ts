// Launcher command registry (serializable views) + the always-available static
// default commands. Pure and dependency-free so it can be shared across
// processes and unit-tested. Query ranking, parameter/destination pickers, and
// context-aware commands arrive in later phases
// (docs/plans/lazy-like-global-launcher.md). The renderer renders these views
// and invokes by `id`; functions never cross IPC.

/** Main → launcher-renderer event: the window was just shown (refocus input). */
export const LAUNCHER_SHOWN_CHANNEL = 'launcher:shown';

/**
 * Marks the launcher window's preload role. Main passes it through
 * `webPreferences.additionalArguments`, so it is fixed before any page script
 * runs. One preload BUNDLE serves both windows — two rollup entries emit a
 * shared chunk a sandboxed preload cannot `require`.
 */
export const LAUNCHER_PRELOAD_ROLE_ARG = '--lin-preload-role=launcher';

/**
 * Main → launcher-renderer event: the capture-degraded remediation hint for this
 * open, or null when capture was clean. Main derives it from its own warnings —
 * the locked-down renderer never receives the raw `ExternalContext`.
 */
export const LAUNCHER_REMEDIATION_CHANNEL = 'launcher:remediation';

/**
 * Main → MAIN-renderer event: jump to a node id (payload: string). Sent when the
 * user opens an inline node search result from the launcher; the main window
 * navigates its active panel to the node and focuses it.
 */
export const LAUNCHER_NAVIGATE_TO_NODE_CHANNEL = 'lin:launcher-navigate-to-node';

/** Bootstrap payload the launcher renderer requests on open. */
export interface LauncherInitialState {
  /** The accelerator that actually registered, or null if none did. */
  hotkey: string | null;
}

/** Bootstrap payload the launcher renderer requests on open. */


/**
 * Render an Electron accelerator (e.g. `CommandOrControl+Shift+Space`) as macOS
 * key symbols (`⌘⇧Space`). Both the launcher footer (its identity zone teaches the
 * summon keystroke) and Settings → General render the registered accelerator
 * through this one formatter. Unknown tokens pass through verbatim so a non-mac
 * accelerator still reads sensibly.
 */
export function formatHotkey(accelerator: string | null): string | null {
  if (!accelerator) return null;
  const symbols: Record<string, string> = {
    commandorcontrol: '⌘',
    cmdorctrl: '⌘',
    command: '⌘',
    cmd: '⌘',
    control: '⌃',
    ctrl: '⌃',
    option: '⌥',
    alt: '⌥',
    shift: '⇧',
    // Spelled out, not `␣` (U+2423): that glyph renders as a bare underline at
    // meta size and reads as an underscore, which teaches the wrong key — and
    // teaching the key is the only reason these hints exist.
    space: 'Space',
    enter: '↵',
    return: '↵',
    escape: 'esc',
    tab: '⇥',
  };
  return accelerator
    .split('+')
    .map((part) => symbols[part.trim().toLowerCase()] ?? part.trim())
    .join('');
}
