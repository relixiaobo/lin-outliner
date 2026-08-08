// View-layer icon mapping for launcher rows. Uses lucide-react, matching the
// app's shared icon set (src/renderer/ui/icons.ts), so the launcher reads as the
// same product. Kept OUT of the pure model so that stays DOM/dependency-free.
//
// The registry names icons by `IconId` (it is core code and cannot hold
// components); this is the launcher tier's single id -> component map.

import {
  AppWindow,
  CheckSquare,
  CirclePlus,
  Copy,
  FileText,
  Globe,
  Hash,
  List,
  Pin,
  Search,
  Settings,
  Table,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IconId, ObjectPresentation } from '../../core/actions/types';

const ICONS: Partial<Record<IconId, LucideIcon>> = {
  checkbox: CheckSquare,
  copy: Copy,
  description: FileText,
  node: List,
  open: Globe,
  outline: List,
  pin: Pin,
  supertag: Hash,
  table: Table,
  trash: Trash2,
};

/**
 * The leading glyph for an object row. A node with its own emoji renders that
 * instead (see LauncherRow) — a node's icon is data, not a fixed glyph.
 */
export function iconForObject(object: ObjectPresentation): LucideIcon {
  if (object.kind === 'appSurface') {
    // The two app surfaces are distinguishable at a glance; the registry gives
    // them the same generic `open` id because it names actions, not windows.
    return object.name.source === 'localized' && object.name.values.en === 'Settings'
      ? Settings
      : AppWindow;
  }
  if (object.kind === 'draft') return CirclePlus;
  if (object.kind === 'externalPage') return CirclePlus;
  return ICONS[object.iconId] ?? Globe;
}

/** The leading glyph shown in the input row. */
export { Search as LauncherInputIcon };

/** The glyph for the capture-degraded remediation banner. */
export { TriangleAlert as LauncherRemediationIcon };
