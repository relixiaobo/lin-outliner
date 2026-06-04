import type { LauncherCommandView, LauncherNodeMatch } from '../../core/launcher/commands';
import type { ExternalContext } from '../../core/launcher/context';

// Pure derivation of the launcher's result list from (query, context, nodes,
// commands). This is the heart of the Raycast-style model: ONE always-focused
// input that is simultaneously a command filter, a live node search, AND a live
// capture draft — no "pick New Capture first" mode, no separate "Search notes"
// command (typing matches nodes inline; Enter on a match opens it). Every result
// renders as ONE uniform command row (icon · title · subtitle · type), built by
// `rowView` below. Kept pure + dependency-free so the interaction logic is
// unit-tested without a DOM; the component maps action ids to IPC calls.
//
// Plan: docs/plans/lazy-like-global-launcher.md.

/**
 * An action runnable from a row. Every row currently has exactly one action
 * (`actions[0]`, what Enter runs); the array shape is kept for when secondary
 * actions return (Save to Inbox, Ask AI with source — see the follow-up plans).
 * There are no disabled/"coming soon" actions: an action exists only if it works.
 */
export interface LauncherItemAction {
  /** Stable behavior id the component maps to an IPC call. */
  id: 'capture-page' | 'capture-note' | 'open-node' | 'run-command';
  label: string;
  enabled: boolean;
}

/** A navigable row. Capture/node rows are synthesized from the input; commands are static. */
export type LauncherItem =
  | {
    kind: 'capture-page';
    /** The page/source title (single line). */
    title: string;
    /** Where it's captured from, e.g. a hostname. */
    subtitle: string;
    /** Typed annotation attached to the page capture (the trimmed query), if any. */
    note?: string;
    actions: LauncherItemAction[];
  }
  | {
    kind: 'capture-note';
    /** The standalone note text (the trimmed query). */
    text: string;
    actions: LauncherItemAction[];
  }
  | {
    kind: 'node';
    /** The matched document node id (opened in the main window on Enter). */
    nodeId: string;
    /** The node's text (single line). */
    title: string;
    /** Where it lives — the parent node's text, for disambiguation. */
    subtitle?: string;
    /** The node's own emoji icon, when it has one (else the row shows a bullet). */
    icon?: string;
    actions: LauncherItemAction[];
  }
  | { kind: 'command'; command: LauncherCommandView; actions: LauncherItemAction[] };

/** Commands whose title/subtitle match the query (all when the query is empty). */
export function filterCommands(commands: readonly LauncherCommandView[], query: string): LauncherCommandView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  return commands.filter(
    (c) => c.title.toLowerCase().includes(q) || (c.subtitle?.toLowerCase().includes(q) ?? false),
  );
}

/**
 * Build the ordered result list. Capture rows come first (capture-first intent),
 * so the common path is hotkey → Enter. With a page context, typing annotates the
 * page (the typed text nests under the captured node as a child bullet; previewed
 * in the row subtitle), with a separate row to instead make the text its own new
 * node. Without a page context, typed text becomes a new node. Then matching nodes
 * (search results — opened on Enter), then commands; both are filtered/queried by
 * the same input. The whole list is flat (no section headers).
 */
export function buildLauncherItems(args: {
  query: string;
  context: ExternalContext | null;
  commands: readonly LauncherCommandView[];
  nodes?: readonly LauncherNodeMatch[];
}): LauncherItem[] {
  const { query, context, commands, nodes = [] } = args;
  const note = query.trim();
  const items: LauncherItem[] = [];
  const source = context?.source;

  if (source) {
    const where = context?.browser?.hostname ?? context?.app.name ?? 'current page';
    // Provider-aware framing: a video reads as "Capture video …". The subtitle is
    // just where it's from — the player position is deliberately not shown.
    const isVideo = source.kind === 'video';
    const noun = isVideo ? 'video' : 'page';
    items.push({
      kind: 'capture-page',
      title: source.title,
      subtitle: where,
      note: note || undefined,
      actions: [{ id: 'capture-page', label: `Capture ${noun} to Today`, enabled: true }],
    });
    if (note) {
      items.push({
        kind: 'capture-note',
        text: note,
        actions: [{ id: 'capture-note', label: 'New node in Today', enabled: true }],
      });
    }
  } else if (note) {
    items.push({
      kind: 'capture-note',
      text: note,
      actions: [{ id: 'capture-note', label: 'New node in Today', enabled: true }],
    });
  }

  // Matching document nodes (the input IS the search — no separate command). Each
  // opens in the main window on Enter.
  for (const match of nodes) {
    items.push({
      kind: 'node',
      nodeId: match.nodeId,
      title: match.title,
      subtitle: match.subtitle,
      icon: match.icon,
      actions: [{ id: 'open-node', label: 'Open', enabled: true }],
    });
  }

  for (const command of filterCommands(commands, query)) {
    items.push({
      kind: 'command',
      command,
      actions: [{ id: 'run-command', label: command.title, enabled: true }],
    });
  }
  return items;
}

/**
 * The uniform per-row display (Raycast-style: one row shape for every result).
 * `typeLabel` is the right-aligned category — `Command` (capture rows are commands
 * too, alongside Open main window etc.) or `Node` (open a matched document node).
 */
export interface LauncherRowView {
  title: string;
  subtitle?: string;
  typeLabel: string;
  enabled: boolean;
}

/** Quote a single-line snippet for a subtitle (already single-line upstream). */
function quoted(text: string): string {
  return `“${text}”`;
}

/**
 * Map a result item to its uniform row display. The capture-page row reads as a
 * clear "Capture" command (the page + any comment is the subtitle, NOT the headline
 * — the old design used the page title as the headline, which read like a search
 * result, not a command). The capture-note row reads as "New node" (it creates a
 * node from the typed text). Node matches keep the node text as the headline with
 * its parent as subtitle. Commands pass through (all are runnable — no disabled
 * "coming soon" state).
 */
export function rowView(item: LauncherItem): LauncherRowView {
  if (item.kind === 'capture-page') {
    const where = item.subtitle;
    const subtitle = item.note ? `+ ${quoted(item.note)} · ${where}` : `${item.title} · ${where}`;
    return { title: 'Capture', subtitle, typeLabel: 'Command', enabled: true };
  }
  if (item.kind === 'capture-note') {
    return { title: 'New node', subtitle: quoted(item.text), typeLabel: 'Command', enabled: true };
  }
  if (item.kind === 'node') {
    return { title: item.title, subtitle: item.subtitle, typeLabel: 'Node', enabled: true };
  }
  const { command } = item;
  return { title: command.title, subtitle: command.subtitle, typeLabel: 'Command', enabled: true };
}

/** A short, human label for what Enter will do on the active row (for the action bar). */
export function primaryActionLabel(item: LauncherItem | undefined): string | null {
  return item?.actions[0]?.label ?? null;
}

/**
 * A stable identity per row — used as BOTH the React key and the selection key.
 * At most one capture-page / capture-note row exists per list, so the kind alone
 * is a stable id; commands and nodes key on their own id.
 */
export function rowKey(item: LauncherItem): string {
  if (item.kind === 'command') return `cmd:${item.command.id}`;
  if (item.kind === 'node') return `node:${item.nodeId}`;
  return item.kind;
}

/**
 * The index of the row matching `activeKey`, or 0 (the top row) when nothing is
 * selected or the selected row is gone. Selection is tracked by identity, not a
 * raw index, so an async list change can't leave the highlight on the wrong row.
 */
export function deriveActiveIndex(items: readonly LauncherItem[], activeKey: string | null): number {
  if (activeKey) {
    const found = items.findIndex((it) => rowKey(it) === activeKey);
    if (found >= 0) return found;
  }
  return 0;
}

/**
 * The selection key after stepping `delta` rows from `currentIndex` (clamped to
 * the list bounds), or null when the list is empty. Drives ArrowUp/ArrowDown.
 */
export function stepActiveKey(items: readonly LauncherItem[], currentIndex: number, delta: number): string | null {
  if (items.length === 0) return null;
  const next = Math.min(Math.max(currentIndex + delta, 0), items.length - 1);
  return rowKey(items[next]!);
}

/**
 * A capture-degraded-but-saved hint with the fix the user can act on. Surfaced as
 * a quiet banner so a partial capture (link only) explains how to unlock the full
 * one — the equivalent of Lazy's "noJXA" prompt. Capture still succeeds regardless.
 */
export interface LauncherRemediation {
  kind: 'automation';
  title: string;
  detail: string;
}

/**
 * Derive the single relevant remediation from a captured context's warnings, or
 * null when capture was clean. Keyed on warning codes (not free text) so it stays
 * stable. Basic-info capture has one actionable failure: it couldn't read the
 * active tab at all (no AX, no Automation) → guide the user to grant Automation.
 * (The in-page-script toggle / multi-window / multi-instance hints went away with
 * the in-page extraction path; rich capture returns via the browser extension —
 * docs/plans/browser-extension-integration.md.)
 */
export function remediationForContext(context: ExternalContext | null): LauncherRemediation | null {
  if (!context) return null;
  const codes = new Set(context.warnings.map((w) => w.code));
  const browser = context.browser?.name ?? context.app.name ?? 'your browser';

  // Couldn't read the active tab at all → Automation access is denied.
  if (codes.has('browser-tab-unavailable')) {
    return {
      kind: 'automation',
      title: `Can’t read ${browser}`,
      detail: `Allow Tenon to control ${browser} in System Settings → Privacy & Security → Automation, then reopen.`,
    };
  }
  return null;
}

/**
 * Render an Electron accelerator (e.g. `CommandOrControl+Shift+Space`) as macOS
 * key symbols (`⌘⇧␣`) for the action bar. Unknown tokens pass through verbatim so
 * a non-mac accelerator still reads sensibly.
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
    space: '␣',
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
