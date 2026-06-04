// Launcher command registry (serializable views) + the always-available static
// default commands. Pure and dependency-free so it can be shared across
// processes and unit-tested. Query ranking, parameter/destination pickers, and
// context-aware commands arrive in later phases
// (docs/plans/lazy-like-global-launcher.md). The renderer renders these views
// and invokes by `id`; functions never cross IPC.

/** Main → launcher-renderer event: the window was just shown (refocus input). */
export const LAUNCHER_SHOWN_CHANNEL = 'launcher:shown';

/**
 * Main → launcher-renderer event: the captured external context for this open
 * (what app/page the user was looking at). Arrives shortly AFTER the window is
 * shown — the launcher paints first and folds this in. Payload is an
 * `ExternalContext` (src/core/launcher/context.ts).
 */
export const LAUNCHER_CONTEXT_CHANNEL = 'launcher:context';

/**
 * Main → MAIN-renderer event: jump to a node id (payload: string). Sent when the
 * user opens an inline node search result from the launcher; the main window
 * navigates its active panel to the node and focuses it.
 */
export const LAUNCHER_NAVIGATE_TO_NODE_CHANNEL = 'lin:launcher-navigate-to-node';

/**
 * Serializable command shown in the launcher list and invoked by `id`. Every
 * command in the list is runnable — there is no disabled "coming soon" state. A
 * feature appears here only once it actually works; until then it lives in a
 * follow-up plan (launcher-ai-actions, launcher-capture-destinations), not as a
 * greyed-out placeholder.
 */
export interface LauncherCommandView {
  id: LauncherCommandId;
  title: string;
  subtitle?: string;
}

export type LauncherCommandId =
  | 'open-main'
  | 'open-settings';

/**
 * A document node surfaced as an inline launcher search result. The launcher
 * renderer can't read the document (separate, locked-down process), so main
 * enriches each `search_nodes` hit into this serializable view; Enter opens the
 * node in the main window. There is intentionally no "Search notes" command — the
 * input itself searches nodes.
 */
export interface LauncherNodeMatch {
  nodeId: string;
  /** The node's text, single line. */
  title: string;
  /** The parent node's text, for disambiguation. */
  subtitle?: string;
  /** The node's own emoji icon, when it has one; otherwise the row uses a bullet. */
  icon?: string;
}

/** Bootstrap payload the launcher renderer requests on open. */
export interface LauncherInitialState {
  commands: LauncherCommandView[];
  /** The accelerator that actually registered, or null if none did. */
  hotkey: string | null;
}

/** Result of invoking a launcher command from the renderer. */
export interface LauncherExecuteResult {
  /** Whether the launcher should hide after the command runs. */
  hide: boolean;
}

/** Result of a manual New Capture → Today save. */
export interface LauncherCreateCaptureResult {
  ok: boolean;
  /** The created capture node id, when ok. */
  nodeId?: string;
}

/**
 * The stable default command set, always present regardless of captured context.
 * Only commands that actually work ship here — no disabled placeholders. AI
 * actions, capture destinations (Inbox, picker), and navigation (Go to Today /
 * Library, Recent destinations) are deferred to follow-up plans and will be added
 * here as they land.
 */
export function getStaticLauncherCommands(): LauncherCommandView[] {
  // No explicit "New Capture" — the input itself is the capture draft (typing
  // offers a capture row directly). No "Search notes" either — typing searches
  // nodes inline (see LauncherNodeMatch). These are the remaining commands.
  return [
    { id: 'open-main', title: 'Open main window' },
    { id: 'open-settings', title: 'Open Settings' },
  ];
}
