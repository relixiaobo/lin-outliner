import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatHotkey, type LauncherInitialState } from '../../core/launcher/commands';
import type { LauncherRemediation } from '../../core/launcher/remediation';
import type {
  InvocationOpened,
  InvocationRef,
  ObjectRef,
  RequestId,
  SurfaceItemPresentation,
} from '../../core/actions/types';
import {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remediation, setRemediation] = useState<LauncherRemediation | null>(null);
  const latestRequestRef = useRef<string | null>(null);

  const invocationRef: InvocationRef | null = opening?.invocationRef ?? null;
  const openSeq = opening?.openSeq ?? null;

  const reset = useCallback(() => {
    setQuery('');
    setExplicitRef(null);
    setBusy(false);
    setError(null);
    setRemediation(null);
  }, []);

  useEffect(() => {
    const bridge = launcherBridge();
    if (!bridge?.launcher) return;
    void bridge.launcher.getInitialState().then(setState);
    const offShown = bridge.launcher.onShown(() => {
      reset();
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    // Main pushes the opening it created for this summon. Its empty-query
    // generation is already READY, so the panel paints furnished — the stable
    // objects are legal subjects before the first keystroke.
    const offOpened = bridge.actions.onOpened((next) => {
      setOpening(next);
      setResults(next.resultItems);
    });
    const offRemediation = bridge.launcher.onRemediation((next) => setRemediation(next));
    return () => {
      offShown();
      offOpened();
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
      });
    }, query ? OBJECT_QUERY_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [invocationRef, openSeq, query]);

  useEffect(() => {
    setError(null);
  }, [query]);

  const items = useMemo(
    () => navigableItems({ fixedItems: opening?.fixedItems ?? [], resultItems: results }),
    [opening, results],
  );
  const activeRef = useMemo(
    () => resolveActiveRef({ items, explicitRef }),
    [items, explicitRef],
  );
  const activeItem = items.find((item) => item.object.objectRef === activeRef);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeRef]);

  /**
   * Run an action by NAMING it. Nothing about the effect is decided here: main
   * re-evaluates the tuple against the latest projection and executes the plan.
   */
  const runPrimary = useCallback(async (item: SurfaceItemPresentation | undefined) => {
    const actions = launcherBridge()?.actions;
    const primary = item?.primaryAction;
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
        void launcherBridge()?.launcher.hide();
        return;
      }
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

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // While an IME composition is active, Enter/arrows/Escape belong to the
      // IME — committing a pinyin candidate must not fire the active row.
      if (isImeComposingEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (invocationRef) {
          void launcherBridge()?.actions.event({ kind: 'abandoned', invocationRef });
        }
        void launcherBridge()?.launcher.hide();
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
        void runPrimary(activeItem);
      }
    },
    [activeItem, activeRef, invocationRef, items, runPrimary],
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

      <div id="launcher-results" className="launcher-body" role="listbox" aria-label={t.launcher.resultsAriaLabel}>
        <div className="launcher-body-inner">
          {items.map((item) => (
            <LauncherRow
              key={rowKey(item)}
              item={item}
              active={item.object.objectRef === activeRef}
              rowRef={item.object.objectRef === activeRef ? activeRowRef : undefined}
              onHover={() => setExplicitRef(item.object.objectRef)}
              onClick={() => void runPrimary(item)}
            />
          ))}
        </div>
      </div>

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
  onHover: () => void;
  onClick: () => void;
}) {
  const { locale } = useI18n();
  const { item, active, rowRef, onHover, onClick } = props;
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
    </div>
  );
}

function LauncherRowIcon({ item }: { item: SurfaceItemPresentation }) {
  const { object } = item;
  if (object.kind === 'node' && object.name.source === 'literal') {
    return <span className="launcher-row-bullet" aria-hidden="true" />;
  }
  const Icon = iconForObject(object);
  return <Icon className="launcher-row-icon" size={16} strokeWidth={1.75} aria-hidden="true" />;
}
