// Pure resolution of document search hits into serializable launcher node
// matches. The launcher renderer is locked down and can't read the document, so
// main resolves `search_nodes` hits into these views; kept pure + dependency-free
// here (no Electron / projection types) so it's unit-tested without a main process.

import type { LauncherNodeMatch } from './commands';

/** The minimal node fields the matcher needs (a subset of NodeProjection). */
export interface MatchableNode {
  id: string;
  /** The node's content text (may be multi-line; collapsed for display). */
  text: string;
  /** Parent id, for the disambiguating subtitle. */
  parentId?: string | null;
  icon?: string;
  /** Only `'emoji'` icons travel to the launcher (it can't load image assets). */
  iconKind?: string;
}

/** Collapse any run of whitespace/newlines into a single display line. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve ordered search-hit node ids into launcher matches. Each carries the
 * node's single-line text + its parent's text (disambiguation) + a renderable
 * emoji icon (image/generated icons fall back to a bullet in the launcher). Hits
 * whose node is missing from `nodes` are skipped; the top `limit` hits are
 * considered (matching the main-process bound — skipping happens after the slice,
 * so a missing top hit can yield fewer than `limit` results).
 */
export function resolveLauncherNodeMatches(
  hitIds: readonly string[],
  nodes: readonly MatchableNode[],
  limit: number,
): LauncherNodeMatch[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const matches: LauncherNodeMatch[] = [];
  for (const id of hitIds.slice(0, limit)) {
    const node = byId.get(id);
    if (!node) continue;
    const title = collapseWhitespace(node.text) || 'Untitled';
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const subtitle = parent ? collapseWhitespace(parent.text) || undefined : undefined;
    const icon = node.iconKind === 'emoji' && node.icon ? node.icon : undefined;
    matches.push({ nodeId: id, title, subtitle, icon });
  }
  return matches;
}
