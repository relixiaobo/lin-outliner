import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nameFor } from '../../core/actions/names';
import { formatHotkey, type LauncherInitialState } from '../../core/launcher/commands';
import type { LauncherRemediation } from '../../core/launcher/remediation';
import type {
  ActionPresentation,
  InvocationOpened,
  InvocationRef,
  ObjectRef,
  RequestId,
  SurfaceItemPresentation,
} from '../../core/actions/types';
import {
  filterActions,
  indexOfRef,
  navigableItems,
  objectRowView,
  primaryActionLabel,
  resolveActiveRef,
  rowKey,
  stepActiveRef,
} from './launcherModel';
import { iconForObject, LauncherInputIcon, LauncherRemediationIcon } from './launcherIcons';
import { useI18n, useT } from '../i18n/I18nProvider';
import { APP_NAME } from '../../core/brand';
import { Button } from '../ui/primitives/Button';
import { Input } from '../ui/primitives/Input';
import { isImeComposingEvent } from '../ui/interactions/imeKeyboard';
import { launcherBridge } from './bridge';

// The searchable OBJECT view of the action registry. One always-focused input
// searches objects — nodes, the app's own surfaces, and a no-match draft — while
// the action bar names what Enter does for the active one. A registry action is
// never a row here, and no row fuses a destination into its title (D6/D8).
//
// The invocation is created by MAIN, synchronously, for each summon: this
// renderer never opens one, and every action it runs is NAMED
// (action id + invocation ref + subject ref + typed arguments) and re-evaluated
// in main before anything happens.
//
// Hard rule for this subtree: stay light — no ProseMirror/Shiki/markdown/editor.

/** Debounce (ms) before asking main for the next object generation. */
const OBJECT_QUERY_DEBOUNCE_MS = 120;

export function LauncherApp() {
  const t = useT();
  const { locale } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  // Re-entrancy lock so a double Enter / Enter+click can't fire one action twice.
  const runningRef = useRef(false);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LauncherInitialState | null>(null);
  const [opening, setOpening] = useState<InvocationOpened | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<readonly SurfaceItemPresentation[]>([]);
  // Activity is tracked by generation-scoped ref, not an index: a late result
  // set then cannot leave the highlight on a row that no longer exists.
  const [explicitRef, setExplicitRef] = useState<ObjectRef | null>(null);
  // The query the CURRENT results were resolved for. Enter must never run a
  // generation older than the typed text: the shipped launcher built its
  // capture/draft row synchronously, so acting early meant "run what is
  // showing", and here it would mean "run what is stale".
  const [resultsQuery, setResultsQuery] = useState('');
  // Enter pressed while the list was stale: run it the moment the matching
  // generation lands, so the keystroke is never silently dropped either.
  const [pendingEnter, setPendingEnter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<LauncherRemediation | null>(null);
  const [fixedItems, setFixedItems] = useState<readonly SurfaceItemPresentation[]>([]);
  // The `Actions ⌘K` panel for the active object, and its own query.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionQuery, setActionQuery] = useState('');
  const [activeActionIndex, setActiveActionIndex] = useState(0);
  const latestRequestRef = useRef<string | null>(null);
  // Ambient revision guard: only a matching opening with a STRICTLY NEWER
  // revision may change the chip, so a delayed push cannot resurrect one the
  // user removed or that was already replaced.
  const ambientRevisionRef = useRef(-1);

  const invocationRef: InvocationRef | null = opening?.invocationRef ?? null;
  const openSeq = opening?.openSeq ?? null;

  const reset = useCallback(() => {
    setQuery('');
    setExplicitRef(null);
    setBusy(false);
    setError(null);
    setRemediation(null);
    setFixedItems([]);
    setActionsOpen(false);
    setActionQuery('');
    setPendingEnter(false);
    ambientRevisionRef.current = -1;
    // The results and the opening they belong to go too. Leaving them rendered
    // the PREVIOUS summon's rows against an invocation main has since released,
    // so clicking one was a guaranteed error rather than merely stale.
    setOpening(null);
    setResults([]);
    setResultsQuery('');
  }, []);

  useEffect(() => {
    const bridge = launcherBridge();
    // A missing bridge means the preload did not load. Render the empty panel
    // rather than throwing: a blank window teaches the user nothing.
    if (!bridge?.launcher) return;
    void bridge.launcher.getInitialState?.().then(setState);
    const offShown = bridge.launcher.onShown?.(() => {
      reset();
      inputRef.current?.focus();
      inputRef.current?.select();
    }) ?? (() => undefined);
    // Main pushes the opening it created for this summon. Its empty-query
    // generation is already READY, so the panel paints furnished — the stable
    // objects are legal subjects before the first keystroke.
    const offOpened = bridge.actions?.onOpened?.((next) => {
      setOpening(next);
      setResults(next.resultItems);
      setResultsQuery('');
      setFixedItems(next.fixedItems);
      ambientRevisionRef.current = next.ambient?.revision ?? -1;
    }) ?? (() => undefined);
    // Main pushes the authoritative replacement presentation; the renderer never
    // constructs a chip, and applies only a strictly newer revision.
    const offAmbient = bridge.actions?.onAmbientChanged?.((change) => {
      if (change.status !== 'updated') return;
      if (change.revision <= ambientRevisionRef.current) return;
      ambientRevisionRef.current = change.revision;
      setFixedItems(change.fixedItems);
    }) ?? (() => undefined);
    const offRemediation = bridge.launcher.onRemediation?.((next) => setRemediation(next))
      ?? (() => undefined);
    return () => {
      offShown();
      offOpened();
      offAmbient();
      offRemediation();
    };
  }, [reset]);

  // Each input change asks main for the next generation. Accepting the request
  // removes the previous one immediately, so the list can never render or submit
  // a stale row; a late response is dropped by request identity.
  useEffect(() => {
    const actions = launcherBridge()?.actions;
    if (!actions || !invocationRef || openSeq === null) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const requestId = `${openSeq}:${query}:${Math.random()}` as RequestId;
      latestRequestRef.current = requestId;
      void actions.queryObjects({ invocationRef, openSeq, requestId, query }).then((result) => {
        if (cancelled || latestRequestRef.current !== requestId) return;
        if (!result || result.status !== 'ready') return;
        setResults(result.resultItems);
        setResultsQuery(query);
      });
    }, query ? OBJECT_QUERY_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [invocationRef, openSeq, query]);

  useEffect(() => {
    setError(null);
    setPendingEnter(false);
  }, [query]);

  // Typing is PAYLOAD admission, not result selection — so it does not count as
  // an explicit choice and a late chip may still take activity. Opening the
  // actions panel does count, which is why it is not cleared here.

  const items = useMemo(
    () => navigableItems({ fixedItems, resultItems: results }),
    [fixedItems, results],
  );
  /** True while the debounce/round trip means the list predates the input. */
  const resultsStale = resultsQuery !== query;

  useEffect(() => { setActiveActionIndex(0); }, [actionQuery]);
  const activeRef = useMemo(
    () => resolveActiveRef({ items, explicitRef }),
    [items, explicitRef],
  );
  const activeItem = items.find((item) => item.object.objectRef === activeRef);
  const panelActions = useMemo(
    () => (activeItem ? filterActions(activeItem.actions, actionQuery) : []),
    [activeItem, actionQuery],
  );

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeRef]);

  useEffect(() => {
    if (!pendingEnter || resultsStale) return;
    setPendingEnter(false);
    void runPrimary(items.find((item) => item.object.objectRef === activeRef));
    // `runPrimary` is stable enough for this one-shot flush; re-running on every
    // identity change would fire it twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, resultsStale]);

  /**
   * Run an action by NAMING it. Nothing about the effect is decided here: main
   * re-evaluates the tuple against the latest projection and executes the plan.
   */
  const runAction = useCallback(async (primary: ActionPresentation | undefined) => {
    const actions = launcherBridge()?.actions;
    if (!actions || !invocationRef || !primary || runningRef.current) return;
    if (primary.evaluation.status !== 'applicable') return;
    runningRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.request({
        actionId: primary.actionId,
        invocationRef,
        subjectRef: primary.subjectRef,
        arguments: primary.binding.state === 'ready' ? primary.binding.arguments : {},
      } as never);
      if (result?.status === 'completed') {
        reset();
        void launcherBridge()?.launcher.hide?.();
        return;
      }
      // A deliberate cancel is not a failure — say nothing and stay put.
      if (result?.status === 'cancelled') return;
      // Anything else is a failure the user must see: the panel stays open and
      // the status zone says so, rather than closing as if it had worked.
      setError(t.launcher.error.saveFailed);
    } catch (caught) {
      console.error('[launcher] action failed', caught);
      setError(t.launcher.error.saveFailed);
    } finally {
      setBusy(false);
      runningRef.current = false;
    }
  }, [invocationRef, reset, t]);

  /**
   * The panel's filter input is `autoFocus`ed, so closing it must hand focus
   * BACK — otherwise it falls to `document.body`, the keydown handler on the
   * `.launcher` div stops seeing anything, and the whole surface goes dead.
   */
  const closeActionsPanel = useCallback(() => {
    setActionsOpen(false);
    setActionQuery('');
    inputRef.current?.focus();
  }, []);

  const openActionsPanel = useCallback(() => {
    setActionsOpen(true);
    setActionQuery('');
    setActiveActionIndex(0);
  }, []);

  const runPrimary = useCallback(
    (item: SurfaceItemPresentation | undefined) => runAction(item?.primaryAction),
    [runAction],
  );

  /** Drop one context object and keep searching; membership changes in MAIN. */
  const removeObject = useCallback(async (objectRef: ObjectRef) => {
    const actions = launcherBridge()?.actions;
    if (!actions || !invocationRef) return;
    const result = await actions.event({ kind: 'objectRemoved', invocationRef, objectRef });
    if (result?.status !== 'updated') return;
    // Adopt MAIN's revision. Bumping a local counter fabricated a value main
    // never issued, and the guard's whole job is to compare against main's.
    if (result.opening.ambient) ambientRevisionRef.current = result.opening.ambient.revision;
    setFixedItems(result.opening.fixedItems);
    setExplicitRef(null);
  }, [invocationRef]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // While an IME composition is active, Enter/arrows/Escape belong to the
      // IME — committing a pinyin candidate must not fire the active row.
      if (isImeComposingEvent(event)) return;
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        // The global ⌘K summon retires; the keystroke is RELOCATED to "show this
        // object's actions" inside the surface (D6).
        event.preventDefault();
        if (!activeItem) return;
        if (actionsOpen) closeActionsPanel();
        else openActionsPanel();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape precedence: subpanel -> active result -> launcher.
        if (actionsOpen) {
          closeActionsPanel();
          return;
        }
        if (explicitRef && fixedItems.length > 0) {
          setExplicitRef(null);
          return;
        }
        if (invocationRef) {
          void launcherBridge()?.actions?.event?.({ kind: 'abandoned', invocationRef });
        }
        void launcherBridge()?.launcher.hide?.();
        return;
      }
      if (actionsOpen) {
        // The panel is keyboard-first too: arrows move, Enter runs. Returning
        // early here made every action it exposes mouse-only.
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActiveActionIndex((index) => {
            const next = index + (event.key === 'ArrowDown' ? 1 : -1);
            return Math.min(Math.max(next, 0), Math.max(panelActions.length - 1, 0));
          });
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const action = panelActions[activeActionIndex];
          if (action) void runAction(action);
        }
        return;
      }
      if (event.key === 'ArrowUp' && explicitRef && indexOfRef(items, explicitRef) === 0) {
        // ArrowUp from the first row returns to the chip without clearing input.
        event.preventDefault();
        setExplicitRef(null);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setExplicitRef(stepActiveRef(items, activeRef, 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setExplicitRef(stepActiveRef(items, activeRef, -1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        // A stale list means the user has typed since these rows were resolved.
        // Running now would fire the PREVIOUS generation's primary — the empty
        // query's Today row, or a capture with an empty note. Flush instead.
        if (resultsStale) {
          setPendingEnter(true);
          return;
        }
        void runPrimary(activeItem);
      }
    },
    [
      actionsOpen, activeActionIndex, activeItem, activeRef, closeActionsPanel,
      explicitRef, fixedItems, invocationRef, items, openActionsPanel,
      panelActions, resultsStale, runAction, runPrimary,
    ],
  );

  const primaryLabel = primaryActionLabel(activeItem, locale);
  const statusText = error ?? (busy ? t.launcher.saving : null);
  const hotkey = formatHotkey(state?.hotkey ?? null);

  return (
    <div className="launcher" role="dialog" aria-label={t.launcher.rootAriaLabel({ app: APP_NAME })} onKeyDown={onKeyDown}>
      <div className="launcher-inputrow">
        <LauncherInputIcon className="launcher-input-icon" size={18} strokeWidth={1.75} aria-hidden="true" />
        <Input
          ref={inputRef}
          className="launcher-input"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t.launcher.placeholder}
          label={t.launcher.queryAriaLabel}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="launcher-results"
          aria-autocomplete="list"
          aria-activedescendant={activeItem ? `launcher-row-${rowKey(activeItem)}` : undefined}
          variant="bare"
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

      {actionsOpen && activeItem ? (
        <div className="launcher-body" role="listbox" aria-label={t.launcher.actionsAriaLabel}>
          <div className="launcher-body-inner">
            <Input
              className="launcher-actions-search"
              label={t.launcher.actionsAriaLabel}
              value={actionQuery}
              placeholder={t.launcher.actionsPlaceholder}
              autoFocus
              onChange={(event) => setActionQuery(event.target.value)}
              variant="bare"
            />
            {panelActions.map((action, index) => (
              <div
                key={`${action.actionId}:${nameFor(action.names, locale)}`}
                role="option"
                aria-selected={index === activeActionIndex}
                className={index === activeActionIndex ? 'launcher-row is-active' : 'launcher-row'}
                onMouseEnter={() => setActiveActionIndex(index)}
                aria-disabled={action.evaluation.status !== 'applicable'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void runAction(action)}
              >
                <span className="launcher-row-title">{nameFor(action.names, locale)}</span>
                {/* A rejected action is SHOWN WITH ITS REASON — a reason teaches
                    the rule, a disappearance teaches distrust (D7). */}
                {action.evaluation.status === 'rejected' ? (
                  <span className="launcher-row-subtitle">
                    {nameFor(action.evaluation.reason.names, locale)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div id="launcher-results" className="launcher-body" role="listbox" aria-label={t.launcher.resultsAriaLabel}>
          <div className="launcher-body-inner">
            {items.map((item) => (
              <LauncherRow
                key={rowKey(item)}
                item={item}
                active={item.object.objectRef === activeRef}
                rowRef={item.object.objectRef === activeRef ? activeRowRef : undefined}
                removable={fixedItems.some((fixed) => fixed.object.objectRef === item.object.objectRef)}
                onRemove={() => void removeObject(item.object.objectRef)}
                onHover={() => setExplicitRef(item.object.objectRef)}
                onClick={() => void runPrimary(item)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Two zones (D6a): identity/status left, the hint cluster right. */}
      <div className="launcher-actionbar">
        {/* The live region wraps the STATUS ONLY — the branding is permanent
            content, not an update to announce. */}
        <span className="launcher-actionbar-status">
          {statusText ? null : (
            <>
              <span className="launcher-actionbar-mark">{APP_NAME}</span>
              {hotkey ? <span className="launcher-actionbar-hotkey">{hotkey}</span> : null}
            </>
          )}
          <span
            className={error ? 'launcher-actionbar-error' : 'launcher-actionbar-busy'}
            role="status"
          >
            {statusText}
          </span>
        </span>
        <span className="launcher-actionbar-hints">
          {primaryLabel ? (
            <Button
              className="launcher-actionbar-item launcher-actionbar-primary"
              disabled={busy}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void runPrimary(activeItem)}
              size="sm"
              variant="ghost"
            >
              {primaryLabel}
              <kbd className="launcher-kbd">↵</kbd>
            </Button>
          ) : null}
          {/* Always present when there is an object to act on: the surface has
              to say the actions exist, and teach the keystroke that shows them. */}
          {activeItem ? (
            <Button
              className="launcher-actionbar-item launcher-actionbar-actions"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => (actionsOpen ? closeActionsPanel() : openActionsPanel())}
              size="sm"
              variant="ghost"
            >
              {t.launcher.actionsLabel}
              <kbd className="launcher-kbd">⌘K</kbd>
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

// One uniform row shape for every object: leading glyph, title, dimmed subtitle,
// right-aligned TYPE label. The type label classifies the noun (Node, Page, App,
// New node) — it never states the activation.
function LauncherRow(props: {
  item: SurfaceItemPresentation;
  active: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  /** Fixed objects (the ambient chip) can be dropped; results cannot. */
  removable?: boolean;
  onRemove?: () => void;
  onHover: () => void;
  onClick: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { item, active, rowRef, removable, onRemove, onHover, onClick } = props;
  const { title, subtitle, typeLabel } = objectRowView(item.object, locale);
  return (
    <div
      ref={rowRef}
      id={`launcher-row-${rowKey(item)}`}
      role="option"
      aria-selected={active}
      className={['launcher-row', active ? 'is-active' : ''].filter(Boolean).join(' ')}
      onMouseEnter={onHover}
      // A row click never blurs the always-focused input.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <LauncherRowIcon item={item} />
      <span className="launcher-row-title">{title}</span>
      {subtitle ? <span className="launcher-row-subtitle">{subtitle}</span> : null}
      <span className="launcher-row-type">{typeLabel}</span>
      {removable ? (
        <button
          type="button"
          className="launcher-row-remove"
          aria-label={t.launcher.removeContext}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { event.stopPropagation(); onRemove?.(); }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function LauncherRowIcon({ item }: { item: SurfaceItemPresentation }) {
  const { object } = item;
  // A node's icon is DATA, not a fixed glyph: show the node's own emoji when it
  // has one, and the outliner bullet otherwise.
  if (object.emoji) {
    return <span className="launcher-row-emoji" aria-hidden="true">{object.emoji}</span>;
  }
  if (object.kind === 'node' && object.name.source === 'literal') {
    return <span className="launcher-row-bullet" aria-hidden="true" />;
  }
  const Icon = iconForObject(object);
  return <Icon className="launcher-row-icon" size={16} strokeWidth={1.75} aria-hidden="true" />;
}
