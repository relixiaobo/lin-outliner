// View-layer icon mapping for launcher rows. Uses lucide-react, matching the app's
// shared icon set (src/renderer/ui/icons.ts), so the launcher reads as the same
// product. Kept OUT of the pure launcherModel so the model stays DOM/dependency-free.
//
// Capture rows always use ONE uniform capture glyph (it's the same "Capture"
// command regardless of what's being captured — page, video, note, …); the row
// title/subtitle carry the specifics. A live frontmost-app icon (extracted in main
// and pushed over IPC as a local PNG — never a remote fetch, the launcher renderer
// is locked down) is a possible follow-up.

import { AppWindow, CirclePlus, Globe, Search, Settings, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LauncherCommandId } from '../../core/launcher/commands';
import type { LauncherItem } from './launcherModel';

const COMMAND_ICONS: Record<LauncherCommandId, LucideIcon> = {
  'open-main': AppWindow,
  'open-settings': Settings,
};

/**
 * The leading Lucide glyph for a row. Node rows are NOT handled here — they render
 * their own emoji icon or a bullet directly (see LauncherRow), since a node's icon
 * is data (emoji), not a fixed glyph.
 */
export function iconForItem(item: LauncherItem): LucideIcon {
  if (item.kind === 'capture-page' || item.kind === 'capture-note') return CirclePlus;
  if (item.kind === 'command') return COMMAND_ICONS[item.command.id] ?? Globe;
  return Globe; // node rows render their own icon/bullet, not this
}

/** The leading glyph shown in the input row. */
export { Search as LauncherInputIcon };

/** The glyph for the capture-degraded remediation banner. */
export { TriangleAlert as LauncherRemediationIcon };
