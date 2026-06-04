import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LauncherInitialState, LauncherNodeMatch } from '../../core/launcher/commands';
import type { ExternalContext } from '../../core/launcher/context';
import { buildLauncherItems, deriveActiveIndex, primaryActionLabel, remediationForContext, rowKey, rowView, stepActiveKey } from './launcherModel';
import type { LauncherItem, LauncherItemAction } from './launcherModel';
import { iconForItem, LauncherInputIcon, LauncherRemediationIcon } from './launcherIcons';

// Raycast-style launcher: ONE always-focused input that is simultaneously a
// command filter, a live node search, AND a live capture draft (no "pick New
// Capture first" mode, no separate "Search notes" command). The result list
// (built purely in launcherModel) is a single flat list of uniform rows — capture
// rows first so the common path is hotkey → Enter, then matching nodes, then
// commands. A persistent action bar shows what Enter does. Every row has exactly
// one action today; secondary actions (Save to Inbox, Ask AI with source) and
// their ⌘K menu return with the follow-up plans (launcher-capture-destinations,
// launcher-ai-actions) — nothing ships as a disabled "coming soon" placeholder.
//
// Hard rule for this subtree: stay light — no ProseMirror/Shiki/markdown/editor.

/** Debounce (ms) before querying the document for inline node matches. */
const NODE_SEARCH_DEBOUNCE_MS = 120;

export function LauncherApp() {
  const inputRef = useRef<HTMLInputElement>(null);
  // Re-entrancy lock so a double Enter / Enter+click can't fire one action twice
  // (open two windows, double-navigate, double-capture).
  const runningRef = useRef(false);
  // The active row element, scrolled into view as keyboard selection moves.
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LauncherInitialState | null>(null);
  const [query, setQuery] = useState('');
  // Selection is tracked by row IDENTITY (key), not a raw index — an async list
  // change (context / node results arriving) then can't leave the highlight on a
  // different row than the user picked. activeIndex is DERIVED from it below.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ExternalContext | null>(null);
  // Inline node search results for the current query (fetched from main, debounced).
  const [nodes, setNodes] = useState<LauncherNodeMatch[]>([]);

  const reset = useCallback(() => {
    setQuery('');
    setActiveKey(null);
    setBusy(false);
    setError(null);
    setNodes([]);
    // A new open captures fresh context; drop the stale one until it arrives.
    setContext(null);
  }, []);

  useEffect(() => {
    const launcher = window.lin?.launcher;
    if (!launcher) return;
    void launcher.getInitialState().then(setState);
    const offShown = launcher.onShown(() => {
      reset();
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    const offContext = launcher.onContext((next) => setContext(next));
    return () => {
      offShown();
      offContext();
    };
  }, [reset]);

  // Inline node search: the input IS the search (no "Search notes" command). Query
  // the document (in main) as the user types, debounced; clear when the input is
  // empty so an idle launcher shows only capture + commands.
  useEffect(() => {
    const launcher = window.lin?.launcher;
    const q = query.trim();
    if (!launcher?.searchNodes || !q) {
      setNodes([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void launcher.searchNodes(q).then((matches) => {
        if (!cancelled) setNodes(matches);
      }).catch(() => {
        if (!cancelled) setNodes([]);
      });
    }, NODE_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // One flat list of uniform rows (no section headers) — the order IS the
  // navigable order, so keyboard selection matches what is shown on screen.
  const navItems = useMemo<LauncherItem[]>(
    () => buildLauncherItems({ query, context, commands: state?.commands ?? [], nodes }),
    [query, context, state, nodes],
  );

  // Typing returns selection to the top row (capture-first) and clears any error.
  useEffect(() => {
    setActiveKey(null);
    setError(null);
  }, [query]);

  // activeIndex is DERIVED from the selected row's identity: follow that row as the
  // list reorders, falling back to the top row when it's gone or nothing is picked.
  const activeIndex = useMemo(() => deriveActiveIndex(navItems, activeKey), [navItems, activeKey]);
  const activeItem = navItems[activeIndex];

  // Keep the keyboard-selected row visible. `block: 'nearest'` is a no-op when the
  // row is already on screen, so a hover-select of a visible row never scrolls.
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const finish = useCallback((result: { ok: boolean } | undefined, launcher: NonNullable<typeof window.lin>['launcher']) => {
    if (result?.ok) {
      reset();
      void launcher.hide();
    } else {
      setError('Save failed.');
    }
  }, [reset]);

  // Run a specific action of an item. Capture actions hit the launcher IPC; the
  // page note is the trimmed query (ratified: page + note). The runningRef lock
  // makes every branch single-shot (no double window-open / navigate / capture).
  const runAction = useCallback(async (item: LauncherItem | undefined, action: LauncherItemAction | undefined) => {
    const launcher = window.lin?.launcher;
    if (!launcher || !item || !action || !action.enabled || runningRef.current) return;
    runningRef.current = true;
    try {
      if (action.id === 'run-command') {
        if (item.kind !== 'command') return;
        const result = await launcher.executeCommand(item.command.id);
        if (result.hide) void launcher.hide();
        return;
      }
      if (action.id === 'open-node') {
        if (item.kind !== 'node') return;
        // Opens the node in the main window; main also hides the launcher.
        void launcher.openNode(item.nodeId);
        reset();
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (action.id === 'capture-page') {
          finish(await launcher.createContextCapture({ note: item.kind === 'capture-page' ? item.note : undefined }), launcher);
        } else if (action.id === 'capture-note' && item.kind === 'capture-note' && item.text) {
          finish(await launcher.createCapture({ title: item.text }), launcher);
        }
      } catch {
        setError('Save failed — restart the dev app (main process does not hot-reload).');
      } finally {
        setBusy(false);
      }
    } finally {
      runningRef.current = false;
    }
  }, [reset, finish]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void window.lin?.launcher?.hide();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveKey(stepActiveKey(navItems, activeIndex, 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveKey(stepActiveKey(navItems, activeIndex, -1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void runAction(activeItem, activeItem?.actions[0]);
      }
    },
    [activeItem, activeIndex, navItems, runAction],
  );

  const primaryLabel = busy ? 'Saving…' : error ?? primaryActionLabel(activeItem);
  // A quiet "saved, but here's how to capture more" hint when the active tab could
  // not be read at all (Automation denied) — the Lazy-style remediation prompt.
  const remediation = useMemo(() => remediationForContext(context), [context]);

  return (
    <div className="launcher" role="dialog" aria-label="Tenon Launcher" onKeyDown={onKeyDown}>
      <div className="launcher-inputrow">
        <LauncherInputIcon className="launcher-input-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          className="launcher-input"
          type="text"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Capture, search, or run a command…"
          aria-label="Launcher query"
          role="combobox"
          aria-expanded={navItems.length > 0}
          aria-controls="launcher-results"
          aria-autocomplete="list"
          aria-activedescendant={activeItem ? `launcher-row-${rowKey(activeItem)}` : undefined}
        />
      </div>

      {remediation ? (
        <div className={`launcher-remediation is-${remediation.kind}`} role="status">
          <LauncherRemediationIcon className="launcher-remediation-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
          <div className="launcher-remediation-text">
            <div className="launcher-remediation-title">{remediation.title}</div>
            <div className="launcher-remediation-detail">{remediation.detail}</div>
          </div>
        </div>
      ) : null}

      <div id="launcher-results" className="launcher-body" role="listbox" aria-label="Results">
        <div className="launcher-body-inner">
          {navItems.map((item, index) => (
            <LauncherRow
              key={rowKey(item)}
              item={item}
              active={index === activeIndex}
              rowRef={index === activeIndex ? activeRowRef : undefined}
              onHover={() => setActiveKey(rowKey(item))}
              onClick={() => void runAction(item, item.actions[0])}
            />
          ))}
          {navItems.length === 0 ? <div className="launcher-empty">Type to capture, search, or run a command.</div> : null}
        </div>
      </div>

      <div className="launcher-actionbar">
        {/* The primary hint doubles as a button (Raycast): click runs Enter.
            preventDefault on mousedown keeps the always-on input focused. */}
        <span className="launcher-actionbar-hints">
          {primaryLabel ? (
            <button
              type="button"
              className="launcher-actionbar-item launcher-actionbar-primary"
              disabled={busy || !(activeItem?.actions[0]?.enabled ?? false)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void runAction(activeItem, activeItem?.actions[0])}
            >
              {primaryLabel}
              <kbd className="launcher-kbd">↵</kbd>
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

// One uniform row shape for every result (Raycast-style): leading glyph, a clear
// title, a dimmed subtitle, and a right-aligned type label (Command / Node). The
// presentation comes from the pure `rowView` so it stays testable.
function LauncherRow(props: {
  item: LauncherItem;
  active: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  onHover: () => void;
  onClick: () => void;
}) {
  const { item, active, rowRef, onHover, onClick } = props;
  const { title, subtitle, typeLabel, enabled } = rowView(item);
  return (
    <div
      ref={rowRef}
      id={`launcher-row-${rowKey(item)}`}
      role="option"
      aria-selected={active}
      aria-disabled={!enabled}
      className={[
        'launcher-row',
        active ? 'is-active' : '',
        enabled ? '' : 'is-disabled',
      ].filter(Boolean).join(' ')}
      onMouseEnter={onHover}
      onClick={onClick}
    >
      <LauncherRowIcon item={item} />
      <span className="launcher-row-title">{title}</span>
      {subtitle ? <span className="launcher-row-subtitle">{subtitle}</span> : null}
      <span className="launcher-row-type">{typeLabel}</span>
    </div>
  );
}

// A node shows its own emoji icon when it has one, else a bullet (the outliner
// metaphor); every other row uses its fixed Lucide glyph.
function LauncherRowIcon({ item }: { item: LauncherItem }) {
  if (item.kind === 'node') {
    if (item.icon) return <span className="launcher-row-emoji" aria-hidden="true">{item.icon}</span>;
    return <span className="launcher-row-bullet" aria-hidden="true" />;
  }
  const Icon = iconForItem(item);
  return <Icon className="launcher-row-icon" size={16} strokeWidth={1.75} aria-hidden="true" />;
}
