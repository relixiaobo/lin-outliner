// The node context menu is an ANCHORED VIEW of the core action registry.
//
// Position selects the subject object, which is why this projection survives:
// you can never mistake which node a right-click menu acts on. Everything it
// renders is a resolved `ActionPresentation` main produced for that opening,
// and everything it runs is an `ActionRequest` naming an action id, an
// invocation ref, a subject ref and typed arguments — main re-evaluates and
// executes. See `docs/plans/unified-command-surface.md` D2.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACTION_FAMILY_NAMES, nameFor } from '../../../core/actions/names';
import { MENU_GROUP } from '../../../core/actions/registry';
import type {
  ActionPresentation,
  ActionRequestResult,
  ArgumentSlot,
  InvocationOpened,
  InvocationRef,
  ObjectPresentation,
  ObjectRef,
  RequestId,
} from '../../../core/actions/types';
import type { NodeId, NodeProjection } from '../../api/types';
import { useI18n, useT } from '../../i18n/I18nProvider';
import type { DocumentIndex, ToolbarDropdownSection } from '../../state/document';
import {
  applyActionFocus,
  candidateForEnter,
  registerActionStepHandlers,
  reportActionError,
  stageComposerObject,
} from '../interactions/actionSteps';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { ChevronRightIcon, CheckIcon, ICON_SIZE, MoveToIcon, SupertagIcon } from '../icons';
import { Button } from '../primitives/Button';
import { Input } from '../primitives/Input';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { useFlyoutOverlay } from '../primitives/useFlyoutOverlay';
import { useMenuKeyboard } from '../primitives/useMenuKeyboard';
import { resolveTagColor } from '../tags/tagColors';
import type { NavigateRootOptions } from '../shared';
import { actionIcon } from './actionIcons';

interface NodeContextMenuProps {
  x: number;
  y: number;
  node: NodeProjection;
  targetId: NodeId;
  visualRowId: NodeId;
  panelId: string;
  /** The pane root this row is being acted on from; `outdent` needs it. */
  selectionRootId: NodeId;
  viewToolbarVisibleInRow: boolean;
  openId: NodeId;
  selectedIds: Set<NodeId>;
  index: DocumentIndex;
  isPinned: boolean;
  isNodePinned: (nodeId: NodeId) => boolean;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onTogglePin: (nodeId: NodeId) => void;
  onEditDescription: () => void;
  onRevealViewToolbar: (visualRowId: NodeId, nodeId: NodeId) => void;
  onOpenViewSection: (nodeId: NodeId, section: ToolbarDropdownSection) => void;
  onClose: () => void;
}

type MenuMode =
  | { kind: 'main' }
  | { kind: 'parameter'; slot: ArgumentSlot; title: string; inputLabel: string; placeholder: string };

type ViewModeMenuState = 'closed' | 'pointer' | 'keyboard';

const CANDIDATE_DEBOUNCE_MS = 120;

export function NodeContextMenu(props: NodeContextMenuProps) {
  const t = useT();
  const { locale } = useI18n();
  const tc = t.outliner.contextMenu;
  const [opening, setOpening] = useState<InvocationOpened | null>(null);
  const [mode, setMode] = useState<MenuMode>({ kind: 'main' });
  const [viewModeMenuState, setViewModeMenuState] = useState<ViewModeMenuState>('closed');
  const [query, setQuery] = useState('');
  // The query the candidates were resolved FOR. Enter must never commit a list
  // that belongs to older text: the picker is debounced and answered over IPC,
  // so `candidates` lags what the user has typed by up to a round trip.
  const [candidates, setCandidates] = useState<{
    query: string;
    items: readonly ObjectPresentation[];
  }>({ query: '', items: [] });
  const invocationRef = useRef<InvocationRef | null>(null);
  const releaseHandlersRef = useRef<(() => void) | null>(null);
  const inFlightRef = useRef(0);
  const unmountedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const viewModeItemRef = useRef<HTMLButtonElement | null>(null);
  const viewModeMenuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(props.x, props.y), [props.x, props.y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    layoutKey: `${mode.kind}:${query.length}:${opening ? 1 : 0}`,
    maxHeight: 440,
    placement: 'bottom-start',
    width: mode.kind === 'main' ? 240 : 280,
  });
  const viewModeMenuOpen = viewModeMenuState !== 'closed';
  const viewModeMenuStyle = useFlyoutOverlay(
    viewModeMenuRef,
    viewModeItemRef,
    viewModeMenuOpen,
    180,
    `view-mode:${props.targetId}`,
    currentViewMode(props),
    'right',
  );
  const dismissIgnoreRefs = useMemo(() => [viewModeMenuRef], []);

  // The seed carries renderer FACTS only. Main validates the ids, derives each
  // node's row/content/canonical-surface facets plus the selection roots,
  // constructs the object set, and mints the ref and lifetime.
  const seed = useMemo(() => ({
    from: 'mainRenderer' as const,
    anchorNodeId: props.node.id,
    visualRowId: props.visualRowId,
    panelId: props.panelId,
    selectionRootId: props.selectionRootId,
    selectedIds: [...props.selectedIds],
    isPinned: props.isPinned,
    rowExpanded: props.viewToolbarVisibleInRow,
  }), [
    props.isPinned,
    props.node.id,
    props.panelId,
    props.selectedIds,
    props.selectionRootId,
    props.viewToolbarVisibleInRow,
    props.visualRowId,
  ]);

  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const closedRef = useRef(false);
  /** The menu closes when the action is chosen; the request settles later. */
  const closeOnce = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  };
  /** Release the step handlers once nothing can still route a step to them. */
  const releaseHandlersIfIdle = () => {
    if (!unmountedRef.current || inFlightRef.current > 0) return;
    releaseHandlersRef.current?.();
    releaseHandlersRef.current = null;
  };
  const handlersRef = useRef({
    isNodePinned: props.isNodePinned,
    onRoot: props.onRoot,
    onTogglePin: props.onTogglePin,
    onEditDescription: props.onEditDescription,
    onRevealViewToolbar: props.onRevealViewToolbar,
    onOpenViewSection: props.onOpenViewSection,
  });
  handlersRef.current = {
    isNodePinned: props.isNodePinned,
    onRoot: props.onRoot,
    onTogglePin: props.onTogglePin,
    onEditDescription: props.onEditDescription,
    onRevealViewToolbar: props.onRevealViewToolbar,
    onOpenViewSection: props.onOpenViewSection,
  };

  // Unmount ONLY. The seed effect below re-runs whenever the selection or pin
  // state changes while the menu is open, so its cleanup cannot stand in for
  // unmount — doing that tore the step handlers down mid-menu.
  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.lin?.actions?.open(seed).then((result) => {
      if (cancelled) return;
      if (!result) {
        // Main refused the opening (the anchored row is gone). Render nothing,
        // but tell the owner so its `contextMenu` state clears — otherwise the
        // surface is dead until the next right-click.
        closeOnce();
        return;
      }
      invocationRef.current = result.invocationRef;
      // The handlers outlive this component on purpose: the menu closes the
      // moment an action is chosen, while its plan is still crossing the seam.
      // They only push workspace UI state, so they stay valid after unmount.
      releaseHandlersRef.current = registerActionStepHandlers(result.invocationRef, {
        navigate: (nodeId, inPlace) => handlersRef.current.onRoot(nodeId, { newPane: !inPlace }),
        workspace: (op, nodeId) => {
          if (op === 'openSplitPane') {
            handlersRef.current.onRoot(nodeId, { newPane: true });
            return;
          }
          // The registry resolved a DESIRED END STATE, so honour it: pin state
          // can change between the menu opening and this step arriving, and a
          // blind toggle would then undo what the user asked for.
          const pinned = handlersRef.current.isNodePinned(nodeId);
          if (op === 'pin' ? !pinned : pinned) handlersRef.current.onTogglePin(nodeId);
        },
        reveal: (target) => {
          if (target.surface === 'description') handlersRef.current.onEditDescription();
          else if (target.surface === 'viewToolbar') {
            handlersRef.current.onRevealViewToolbar(target.visualRowId, target.nodeId);
          } else handlersRef.current.onOpenViewSection(target.nodeId, target.section);
        },
        // One staging path for both object kinds; the menu never stages a page,
        // but routing through the shared helper keeps the two from drifting.
        composerHandoff: (object) => stageComposerObject(object),
      });
      setOpening(result);
    }).catch(() => {
      if (!cancelled) closeOnce();
    });
    return () => {
      cancelled = true;
      const ref = invocationRef.current;
      if (ref) void window.lin?.actions?.event({ kind: 'abandoned', invocationRef: ref });
      // A plan's renderer legs arrive from MAIN, one round trip per step after
      // each preceding main step succeeds — arbitrarily later than this
      // unmount. So the handler is released when the request settles, not on a
      // timer that would silently drop every reveal.
      releaseHandlersIfIdle();
    };
  }, [seed]);

  useDismissibleOverlay(menuRef, props.onClose, {
    escape: false,
    ignoreRefs: dismissIgnoreRefs,
  });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: props.onClose,
    kind: mode.kind === 'main' ? 'menu' : 'dialog',
    // The surface does not exist until the opening resolves, so the focus-in
    // effect must re-run then — otherwise the menu never takes focus and Escape
    // is never captured.
    focusKey: opening ? mode.kind : 'pending',
  });
  const closeViewModeMenu = () => setViewModeMenuState('closed');
  const { onKeyDown: onViewModeMenuKeyDown } = useMenuKeyboard({
    surfaceRef: viewModeMenuRef,
    onClose: closeViewModeMenu,
    kind: 'menu',
    active: viewModeMenuState === 'keyboard',
    getRestoreTarget: () => viewModeItemRef.current,
    focusKey: `${viewModeMenuState}:${currentViewMode(props)}`,
  });

  const runRequest = async (presentation: ActionPresentation, args: unknown) => {
    const ref = invocationRef.current;
    if (!ref) return;
    inFlightRef.current += 1;
    try {
      const result = await window.lin?.actions?.request({
        actionId: presentation.actionId,
        invocationRef: ref,
        subjectRef: presentation.subjectRef,
        arguments: args,
      } as never);
      if (result?.status === 'completed') {
        applyActionFocus(result.focus);
        // Succeeding is not a reason to erase someone else's failure: the notice
        // is app-wide, so clearing here would delete a report this action never
        // made. It expires on its own.
      } else if (result?.status !== 'cancelled') {
        // Anything that is not a completion is a failure the user must see: a
        // rejected command, an unacked renderer step, a half-applied plan, or a
        // subject that went stale. A deliberate CANCEL is none of those — the
        // user declined the sheet, and reporting that as an error would be a
        // banner for doing exactly what they meant.
        reportActionError(actionFailureMessage(result, t));
      }
      closeOnce();
    } finally {
      inFlightRef.current -= 1;
      releaseHandlersIfIdle();
    }
  };

  const activate = (presentation: ActionPresentation) => {
    if (presentation.evaluation.status !== 'applicable') return;
    if (presentation.binding.state === 'needsParameter') {
      const parameter = presentation.binding.parameter;
      setMode({
        kind: 'parameter',
        slot: {
          actionId: presentation.actionId,
          subjectRef: presentation.subjectRef,
          parameterId: parameter.parameterId,
        } as ArgumentSlot,
        title: nameFor(parameter.title, locale),
        inputLabel: nameFor(parameter.inputLabel, locale),
        placeholder: nameFor(parameter.placeholder, locale),
      });
      setQuery('');
      return;
    }
    // Confirmation is main's own native sheet now, so the menu closes on the
    // click either way — the sheet is what stays in front of the user.
    closeOnce();
    void runRequest(presentation, presentation.binding.arguments);
  };

  // --- parameter candidates (debounce + request identity + cancellation) -----

  const parameterSlot = mode.kind === 'parameter' ? mode.slot : null;
  const latestRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!parameterSlot) {
      setCandidates({ query: '', items: [] });
      return;
    }
    const ref = invocationRef.current;
    if (!ref) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const requestId = `${Date.now()}:${Math.random()}` as RequestId;
      latestRequestRef.current = requestId;
      void window.lin?.actions?.queryParameters({
        invocationRef: ref,
        openSeq: null,
        slot: parameterSlot,
        requestId,
        query,
      }).then((result) => {
        // Drop anything that is not the latest request for this slot.
        if (cancelled || latestRequestRef.current !== requestId) return;
        if (result.status !== 'ready') return;
        setCandidates({ query, items: result.items });
      });
    }, query ? CANDIDATE_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parameterSlot, query]);

  const menuActions = opening?.menuActions ?? [];
  const viewModeActions = menuActions.filter((action) => action.actionId === 'setViewMode');

  const modeLabel = mode.kind === 'main' ? tc.nodeActions : mode.title;

  if (!opening) return null;

  const renderMain = () => {
    const rendered: React.ReactNode[] = [];
    let previousGroup: number | null = null;
    let viewModeRendered = false;
    for (const action of menuActions) {
      const group = MENU_GROUP[action.actionId];
      if (action.actionId === 'setViewMode') {
        if (viewModeRendered) continue;
        viewModeRendered = true;
        if (previousGroup !== null && group !== previousGroup) {
          rendered.push(<div className="node-context-separator" key={`sep-${group}`} role="separator" />);
        }
        previousGroup = group;
        rendered.push(
          <MenuItem
            key="setViewMode"
            active={viewModeMenuOpen}
            activeClassName="is-open"
            aria-expanded={viewModeMenuOpen}
            aria-haspopup="menu"
            className="node-context-item"
            icon={actionIcon(activeViewModeIcon(viewModeActions, props, props.index))}
            label={nameFor(ACTION_FAMILY_NAMES.setViewMode, locale)}
            meta={<ChevronRightIcon size={ICON_SIZE.menu} />}
            onClick={() => setViewModeMenuState('keyboard')}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' && viewModeMenuOpen) {
                event.preventDefault();
                event.stopPropagation();
                closeViewModeMenu();
                return;
              }
              if (event.key !== 'ArrowRight') return;
              event.preventDefault();
              event.stopPropagation();
              setViewModeMenuState('keyboard');
            }}
            onMouseEnter={() => {
              setViewModeMenuState((current) => current === 'keyboard' ? current : 'pointer');
            }}
            ref={viewModeItemRef}
            role="menuitem"
          />,
        );
        continue;
      }
      if (previousGroup !== null && group !== previousGroup) {
        rendered.push(<div className="node-context-separator" key={`sep-${group}-${rendered.length}`} role="separator" />);
      }
      previousGroup = group;
      const disabled = action.evaluation.status !== 'applicable';
      rendered.push(
        <MenuItem
          key={`${action.actionId}:${JSON.stringify(action.binding.state === 'ready' ? action.binding.arguments : 'parameter')}`}
          className={`node-context-item ${isDangerAction(action) ? 'is-danger' : ''}`}
          disabled={disabled}
          icon={actionIcon(action.iconId)}
          label={nameFor(action.names, locale)}
          onClick={() => activate(action)}
          onFocus={closeViewModeMenu}
          onMouseEnter={closeViewModeMenu}
          role="menuitem"
        />,
      );
    }
    return <>{rendered}</>;
  };

  const renderViewModeMenu = () => (
    <MenuSurface
      ref={viewModeMenuRef}
      aria-label={nameFor(ACTION_FAMILY_NAMES.setViewMode, locale)}
      className="node-context-menu node-context-submenu"
      preserveSelection
      role="menu"
      style={viewModeMenuStyle}
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          event.preventDefault();
          props.onClose();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          event.stopPropagation();
          closeViewModeMenu();
          viewModeItemRef.current?.focus({ preventScroll: true });
          return;
        }
        onViewModeMenuKeyDown(event);
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {viewModeActions.map((action) => {
        const mode_ = action.binding.state === 'ready'
          ? (action.binding.arguments as { mode: 'outline' | 'table' }).mode
          : 'outline';
        const active = mode_ === currentViewMode(props);
        return (
          <MenuItem
            key={mode_}
            active={active}
            aria-checked={active}
            className="node-context-item"
            icon={actionIcon(action.iconId)}
            label={nameFor(action.names, locale)}
            meta={active ? <CheckIcon size={ICON_SIZE.menu} /> : null}
            onClick={() => activate(action)}
            role="menuitemradio"
          />
        );
      })}
    </MenuSurface>
  );

  const pickCandidate = (candidate: ObjectPresentation) => {
    if (mode.kind !== 'parameter') return;
    const presentation = menuActions.find((action) => (
      action.actionId === mode.slot.actionId
      && action.subjectRef === mode.slot.subjectRef
      && action.binding.state === 'needsParameter'
    ));
    if (!presentation) return;
    const args = mode.slot.parameterId === 'tag'
      ? { tag: candidate.objectRef }
      : { destination: candidate.objectRef };
    closeOnce();
    void runRequest(presentation, args);
  };

  const renderParameter = (parameterMode: Extract<MenuMode, { kind: 'parameter' }>) => (
    <>
      <div className="node-context-subhead">
        <Button onClick={() => setMode({ kind: 'main' })} size="sm" variant="ghost">{tc.back}</Button>
        <span>{parameterMode.title}</span>
      </div>
      <Input
        className="node-context-search"
        label={parameterMode.inputLabel}
        value={query}
        placeholder={parameterMode.placeholder}
        autoFocus
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          // While an IME composition is active, Enter belongs to the IME.
          if (isImeComposingEvent(event)) return;
          if (event.key !== 'Enter') return;
          if (parameterMode.slot.parameterId !== 'tag') return;
          const first = candidateForEnter(candidates, query);
          if (!first) {
            // Stale or empty: swallow the key rather than applying a candidate
            // resolved for text the user has already moved on from.
            event.preventDefault();
            return;
          }
          event.preventDefault();
          pickCandidate(first);
        }}
      />
      {candidates.items.map((candidate) => (
        <MenuItem
          key={candidate.objectRef}
          className="node-context-item"
          icon={candidateIcon(candidate, parameterMode, props.index)}
          label={candidateLabel(candidate, locale)}
          onClick={() => pickCandidate(candidate)}
        />
      ))}
    </>
  );

  return createPortal(
    <>
      <MenuSurface
        ref={menuRef}
        aria-label={modeLabel}
        className="node-context-menu"
        preserveSelection
        role={mode.kind === 'main' ? 'menu' : 'dialog'}
        style={menuStyle}
        onKeyDown={onKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {mode.kind === 'main'
          ? renderMain()
          : renderParameter(mode)}
      </MenuSurface>
      {mode.kind === 'main' && viewModeMenuOpen ? renderViewModeMenu() : null}
    </>,
    document.body,
  );
}

/** Say what went wrong, in the same place the shipped command runner did. */
function actionFailureMessage(
  result: ActionRequestResult | undefined,
  t: ReturnType<typeof useT>,
): string {
  const generic = t.shell.commandFailed;
  if (!result) return generic;
  if (result.status === 'failed') {
    const reason = result.reason;
    if (reason.kind === 'commandRejected' || reason.kind === 'rendererReported') return reason.code;
    return generic;
  }
  if (result.status === 'indeterminate') return generic;
  if (result.status === 'stale' || result.status === 'reEvaluated') return t.shell.commandStale;
  return generic;
}

function isDangerAction(action: ActionPresentation): boolean {
  return action.actionId === 'deleteForever' || action.actionId === 'emptyTrash';
}

function currentViewMode(props: NodeContextMenuProps): 'outline' | 'table' {
  const target = props.index.byId.get(props.targetId) ?? props.node;
  for (const childId of target.children ?? []) {
    const child = props.index.byId.get(childId);
    if (child?.type === 'viewDef') return child.viewMode === 'table' ? 'table' : 'outline';
  }
  return 'outline';
}

function activeViewModeIcon(
  actions: readonly ActionPresentation[],
  props: NodeContextMenuProps,
  _index: DocumentIndex,
): ActionPresentation['iconId'] {
  const active = currentViewMode(props);
  const match = actions.find((action) => (
    action.binding.state === 'ready'
    && (action.binding.arguments as { mode?: string }).mode === active
  ));
  return match?.iconId ?? 'outline';
}

function candidateLabel(candidate: ObjectPresentation, locale: Parameters<typeof nameFor>[1]): string {
  return candidate.name.source === 'literal'
    ? candidate.name.value
    : nameFor(candidate.name.values, locale);
}

function candidateIcon(
  candidate: ObjectPresentation,
  mode: Extract<MenuMode, { kind: 'parameter' }>,
  index: DocumentIndex,
) {
  if (mode.slot.parameterId !== 'tag') return <MoveToIcon size={ICON_SIZE.menu} />;
  if (candidate.kind === 'draft') return <SupertagIcon size={ICON_SIZE.menu} />;
  // By IDENTITY, not by rendered label: two tags can share a name and differ in
  // colour, and an untitled tag renders a fallback that matches nothing.
  const tag = candidate.backingNodeId ? index.byId.get(candidate.backingNodeId) : undefined;
  return (
    <span
      className="tag-selector-hash"
      style={tag ? { color: resolveTagColor(tag, index.byId).text } : undefined}
      aria-hidden="true"
    >
      #
    </span>
  );
}
