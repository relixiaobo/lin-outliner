// Pure derivation for the command surface's rows.
//
// Every row is an OBJECT (`SurfaceItemPresentation`) main resolved for this
// opening; what Enter does lives in the action bar, never in a compound row
// title. The old `LauncherItem` union — with its `kind: 'command'` arm and its
// *Capture page to Today* / *New node in Today* labels — is gone: those were an
// app surface and a draft with their verb fused into the noun.
//
// Kept dependency-free so the interaction logic is unit-tested without a DOM.

import { nameFor } from '../../core/actions/names';
import type {
  ActionPresentation,
  ObjectPresentation,
  ObjectRef,
  PresentedName,
  SurfaceItemPresentation,
} from '../../core/actions/types';
import type { Locale } from '../../core/locale';

/** The uniform per-row display: one row shape for every object. */
export interface ObjectRowView {
  title: string;
  subtitle?: string;
  /** Right-aligned category — the object's KIND, not its activation. */
  typeLabel: string;
}

export function presentedText(name: PresentedName, locale: Locale): string {
  return name.source === 'literal' ? name.value : nameFor(name.values, locale);
}

export function objectRowView(object: ObjectPresentation, locale: Locale): ObjectRowView {
  return {
    title: presentedText(object.name, locale),
    ...(object.subtitle ? { subtitle: presentedText(object.subtitle, locale) } : {}),
    typeLabel: nameFor(object.typeLabel, locale),
  };
}

/**
 * What the action bar says Enter will do. It is the VERB for the active object
 * — never the row's title, which is what made the shipped bar restate the row.
 * Null when the object has no safe blind-Enter action, in which case the bar
 * shows only the actions control.
 */
export function primaryActionLabel(
  item: SurfaceItemPresentation | undefined,
  locale: Locale,
): string | null {
  const primary: ActionPresentation | undefined = item?.primaryAction;
  return primary ? nameFor(primary.names, locale) : null;
}

/**
 * The navigable sequence: the ambient chip (when one is attached) then the
 * current result generation. Activity is tracked by `ObjectRef`, which is
 * generation-scoped — so a late result set cannot leave the highlight on a row
 * that no longer exists, and a replayed ref cannot address the old one.
 */
export function navigableItems(params: {
  fixedItems: readonly SurfaceItemPresentation[];
  resultItems: readonly SurfaceItemPresentation[];
}): SurfaceItemPresentation[] {
  return [...params.fixedItems, ...params.resultItems];
}

export function indexOfRef(
  items: readonly SurfaceItemPresentation[],
  ref: ObjectRef | null,
): number {
  if (!ref) return -1;
  return items.findIndex((item) => item.object.objectRef === ref);
}

/**
 * D6's fixed default activity, with no learned component:
 *
 * - a chip present before an explicit choice -> the chip is active;
 * - a chip that RESOLVES LATE becomes active only while activity is still
 *   implicit — typing alone is payload admission, not result selection, but
 *   `ArrowDown` / a click / an open subpanel is an explicit choice the late
 *   chip must not steal;
 * - no chip -> the first current-generation result is active;
 * - an explicitly chosen row survives while it is still in the generation.
 *
 * Returns the ref to render as active, or null when there is nothing to act on.
 */
export function resolveActiveRef(params: {
  items: readonly SurfaceItemPresentation[];
  explicitRef: ObjectRef | null;
}): ObjectRef | null {
  const explicitIndex = indexOfRef(params.items, params.explicitRef);
  if (explicitIndex >= 0) return params.explicitRef;
  return params.items[0]?.object.objectRef ?? null;
}

/** The ref after stepping `delta` rows, clamped; null when the list is empty. */
export function stepActiveRef(
  items: readonly SurfaceItemPresentation[],
  currentRef: ObjectRef | null,
  delta: number,
): ObjectRef | null {
  if (items.length === 0) return null;
  const current = Math.max(indexOfRef(items, currentRef), 0);
  const next = Math.min(Math.max(current + delta, 0), items.length - 1);
  return items[next]!.object.objectRef;
}

/** Stable React key. The ref is already generation-scoped and unique. */
export function rowKey(item: SurfaceItemPresentation): string {
  return item.object.objectRef;
}

/**
 * The searchable action list for the active object. Matches the family id, both
 * locale names and the locale-independent aliases at once, so a user who thinks
 * in English command names finds them in a Chinese interface (D8).
 */
export function filterActions(
  actions: readonly ActionPresentation[],
  query: string,
): ActionPresentation[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...actions];
  return actions.filter((action) => {
    if (action.actionId.toLowerCase().includes(normalized)) return true;
    if (action.aliases.some((alias) => alias.toLowerCase().includes(normalized))) return true;
    return Object.values(action.names).some((name) => name.toLowerCase().includes(normalized));
  });
}
