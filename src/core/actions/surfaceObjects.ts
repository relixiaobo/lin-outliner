// The object providers behind the command surface's main list.
//
// D6: a main-list row is a pickable THING — node, selection, external page,
// draft or app surface. A registry action is never a main-list row, and a
// destination is never fused into a row title: the row is *Today* and its
// primary action is *Open*. There is deliberately no `command` arm; the legacy
// `LauncherCommandView` rows were app surfaces written as compound phrases.

import { SUPPORTED_LOCALES, type Locale } from '../locale';
import { objectName } from './names';
import type { AppSurface } from './bindings';
import type {
  LocalizedNames,
  NodeObject,
  NodeObjectRef,
  ObjectRef,
  SurfaceObject,
  SystemNodeKey,
} from './types';

export type RefMinter = () => ObjectRef;

/**
 * The stable empty-query list, in order (D6 rule 5). This is what furnishes a
 * first open: real content, not onboarding chrome.
 */
export const SYSTEM_NODE_KEYS: readonly SystemNodeKey[] = [
  'today',
  'library',
  'schema',
  'savedSearches',
  'trash',
];

export const APP_SURFACES: readonly AppSurface[] = ['mainWindow', 'settings'];

export function systemNodeObject(key: SystemNodeKey, mintRef: RefMinter): NodeObject {
  const ref: NodeObjectRef = { by: 'system', key };
  return { kind: 'node', objectRef: mintRef(), row: ref, content: ref, canonicalSurface: ref };
}

export function appSurfaceObject(surface: AppSurface, mintRef: RefMinter): SurfaceObject {
  return { kind: 'appSurface', objectRef: mintRef(), surface };
}

export function nodePurposeDraft(text: string, mintRef: RefMinter): SurfaceObject {
  return { kind: 'draft', objectRef: mintRef(), purpose: 'node', text };
}

const SYSTEM_OBJECT_NAMES: Record<SystemNodeKey, LocalizedNames> = {
  today: objectName('today'),
  library: objectName('library'),
  schema: objectName('schema'),
  savedSearches: objectName('savedSearches'),
  trash: objectName('trash'),
};

const APP_SURFACE_NAMES: Record<AppSurface, LocalizedNames> = {
  mainWindow: objectName('mainWindow'),
  settings: objectName('settings'),
};

const LOCALES: readonly Locale[] = SUPPORTED_LOCALES.map((entry) => entry.code);

/**
 * Match a stable object by name in EVERY locale at once, regardless of the
 * active UI language: this user thinks in English names and runs a Chinese
 * interface, and a surface that only matched the active locale would swallow
 * half of what they type (D8).
 */
function matchesInAnyLocale(names: LocalizedNames, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return LOCALES.some((locale) => names[locale]?.toLowerCase().includes(normalizedQuery));
}

/**
 * The system-node and app-surface objects a query admits. Node search results
 * are ranked by the retrieval kernel and provided separately; these are the
 * app's own objects, which the kernel does not index.
 */
export function stableObjectsFor(params: {
  query: string;
  mintRef: RefMinter;
}): SurfaceObject[] {
  const normalized = params.query.trim().toLowerCase();
  const objects: SurfaceObject[] = [];
  for (const key of SYSTEM_NODE_KEYS) {
    if (!matchesInAnyLocale(SYSTEM_OBJECT_NAMES[key], normalized)) continue;
    objects.push(systemNodeObject(key, params.mintRef));
  }
  for (const surface of APP_SURFACES) {
    if (!matchesInAnyLocale(APP_SURFACE_NAMES[surface], normalized)) continue;
    objects.push(appSurfaceObject(surface, params.mintRef));
  }
  return objects;
}

/**
 * D6's ordering rule, stated once so both the empty-query list and every later
 * generation obey it:
 *
 * 2. a non-empty query searches node, system-node and app-surface objects in
 *    ONE ranked list;
 * 3. when at least one object matches, only those matched objects are returned
 *    — a draft never competes with them for the default Enter action;
 * 4. only when nothing matches does main synthesize exactly one node-purpose
 *    draft whose literal title is the entered text.
 */
export function orderedResultObjects(params: {
  query: string;
  nodeObjects: readonly SurfaceObject[];
  mintRef: RefMinter;
}): SurfaceObject[] {
  const query = params.query.trim();
  const stable = stableObjectsFor({ query, mintRef: params.mintRef });
  // Ranked node hits lead; the app's own objects follow in their fixed order.
  const matched = [...params.nodeObjects, ...stable];
  if (matched.length > 0) return matched;
  return query ? [nodePurposeDraft(query, params.mintRef)] : [];
}
