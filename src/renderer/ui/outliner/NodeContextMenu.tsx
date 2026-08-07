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
  ArgumentSlot,
  ChallengeToken,
  ConfirmationSpec,
  InvocationOpened,
  InvocationRef,
  ObjectPresentation,
  ObjectRef,
  RequestId,
} from '../../../core/actions/types';
import { requestSendNodeReferenceToThreadComposer } from '../../agent/agentReveal';
import type { NodeId, NodeProjection } from '../../api/types';
import { useI18n, useT } from '../../i18n/I18nProvider';
import type { DocumentIndex, ToolbarDropdownSection } from '../../state/document';
import { applyActionFocus, registerActionStepHandlers } from '../interactions/actionSteps';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { ChevronRightIcon, CheckIcon, ICON_SIZE, MoveToIcon, SupertagIcon } from '../icons';
import { Button } from '../primitives/Button';
import { ConfirmDialog } from '../primitives/ConfirmDialog';
import { Input } from '../primitives/Input';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { overlayAnchorFromPoint, useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
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
  viewToolbarVisibleInRow: boolean;
  openId: NodeId;
  selectedIds: Set<NodeId>;
  index: DocumentIndex;
  isPinned: boolean;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onTogglePin: (nodeId: NodeId) => void;
  onEditDescription: () => void;
  onRevealViewToolbar: (visualRowId: NodeId, nodeId: NodeId) => void;
  onOpenViewSection: (nodeId: NodeId, section: ToolbarDropdownSection) => void;
  onClose: () => void;
}

type MenuMode =
  | { kind: 'main' }
  | { kind: 'viewMode' }
  | { kind: 'parameter'; slot: ArgumentSlot; title: string; inputLabel: string; placeholder: string };

interface PendingConfirmation {
  challenge: ChallengeToken;
  confirm: ConfirmationSpec;
  presentation: ActionPresentation;
}

const CANDIDATE_DEBOUNCE_MS = 120;

export function NodeContextMenu(props: NodeContextMenuProps) {
  const t = useT();
  const { locale } = useI18n();
  const tc = t.outliner.contextMenu;
  const [opening, setOpening] = useState<InvocationOpened | null>(null);
  const [mode, setMode] = useState<MenuMode>({ kind: 'main' });
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<readonly ObjectPresentation[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);
  const invocationRef = useRef<InvocationRef | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuAnchor = useMemo(() => overlayAnchorFromPoint(props.x, props.y), [props.x, props.y]);
  const menuStyle = useAnchoredOverlay(menuRef, {
    anchorRect: menuAnchor,
    layoutKey: `${mode.kind}:${query.length}:${opening ? 1 : 0}`,
    maxHeight: 440,
    placement: 'bottom-start',
    width: mode.kind === 'main' ? 240 : 280,
  });

  // The seed carries renderer FACTS only. Main validates the ids, derives each
  // node's row/content/canonical-surface facets plus the selection roots,
  // constructs the object set, and mints the ref and lifetime.
  const seed = useMemo(() => ({
    from: 'mainRenderer' as const,
    anchorNodeId: props.node.id,
    visualRowId: props.visualRowId,
    panelId: props.panelId,
    selectedIds: [...props.selectedIds],
    isPinned: props.isPinned,
    rowExpanded: props.viewToolbarVisibleInRow,
  }), [
    props.isPinned,
    props.node.id,
    props.panelId,
    props.selectedIds,
    props.viewToolbarVisibleInRow,
    props.visualRowId,
  ]);

  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const handlersRef = useRef({
    onRoot: props.onRoot,
    onTogglePin: props.onTogglePin,
    onEditDescription: props.onEditDescription,
    onRevealViewToolbar: props.onRevealViewToolbar,
    onOpenViewSection: props.onOpenViewSection,
  });
  handlersRef.current = {
    onRoot: props.onRoot,
    onTogglePin: props.onTogglePin,
    onEditDescription: props.onEditDescription,
    onRevealViewToolbar: props.onRevealViewToolbar,
    onOpenViewSection: props.onOpenViewSection,
  };

  useEffect(() => {
    let cancelled = false;
    let unregister: (() => void) | null = null;
    void window.lin?.actions?.open(seed).then((result) => {
      if (cancelled || !result) return;
      invocationRef.current = result.invocationRef;
      // The handlers outlive this component on purpose: the menu closes before
      // its plan settles, and these callbacks only push workspace UI state.
      unregister = registerActionStepHandlers(result.invocationRef, {
        navigate: (nodeId, inPlace) => handlersRef.current.onRoot(nodeId, { newPane: !inPlace }),
        workspace: (op, nodeId) => {
          if (op === 'openSplitPane') handlersRef.current.onRoot(nodeId, { newPane: true });
          else handlersRef.current.onTogglePin(nodeId);
        },
        reveal: (target) => {
          if (target.surface === 'description') handlersRef.current.onEditDescription();
          else if (target.surface === 'viewToolbar') {
            handlersRef.current.onRevealViewToolbar(target.visualRowId, target.nodeId);
          } else handlersRef.current.onOpenViewSection(target.nodeId, target.section);
        },
        composerHandoff: (object) => {
          requestSendNodeReferenceToThreadComposer({
            nodeId: object.nodeId,
            title: object.title,
          });
        },
      });
      setOpening(result);
    });
    return () => {
      cancelled = true;
      const ref = invocationRef.current;
      if (ref) void window.lin?.actions?.event({ kind: 'abandoned', invocationRef: ref });
      // Steps are dispatched before the record is abandoned, so release the
      // handler on the next tick rather than racing the in-flight plan.
      const release = unregister;
      if (release) setTimeout(release, 0);
    };
  }, [seed]);

  useDismissibleOverlay(menuRef, props.onClose, {
    disabled: pendingConfirm !== null,
    escape: false,
  });
  const { onKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: props.onClose,
    kind: mode.kind === 'main' ? 'menu' : 'dialog',
    focusKey: mode.kind,
  });

  const runRequest = async (
    presentation: ActionPresentation,
    args: unknown,
    challenge?: ChallengeToken,
  ) => {
    const ref = invocationRef.current;
    if (!ref) return;
    const result = await window.lin?.actions?.request({
      actionId: presentation.actionId,
      invocationRef: ref,
      subjectRef: presentation.subjectRef,
      arguments: args,
      ...(challenge ? { challenge } : {}),
    } as never);
    if (result?.status === 'confirmationRequired') {
      setPendingConfirm({
        challenge: result.challenge,
        confirm: result.confirm,
        presentation: result.presentation,
      });
      return;
    }
    if (result?.status === 'completed') applyActionFocus(result.focus);
    setPendingConfirm(null);
    onCloseRef.current();
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
    // An action carrying `confirm` keeps the menu open until it resolves.
    if (!presentation.confirm) onCloseRef.current();
    void runRequest(presentation, presentation.binding.arguments);
  };

  // --- parameter candidates (debounce + request identity + cancellation) -----

  const parameterSlot = mode.kind === 'parameter' ? mode.slot : null;
  const latestRequestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!parameterSlot) {
      setCandidates([]);
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
        setCandidates(result.items);
      });
    }, query ? CANDIDATE_DEBOUNCE_MS : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parameterSlot, query]);

  const menuActions = opening?.menuActions ?? [];
  const viewModeActions = menuActions.filter((action) => action.actionId === 'setViewMode');

  const modeLabel = mode.kind === 'main'
    ? tc.nodeActions
    : mode.kind === 'viewMode'
      ? nameFor(ACTION_FAMILY_NAMES.setViewMode, locale)
      : mode.title;

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
            className="node-context-item"
            icon={actionIcon(activeViewModeIcon(viewModeActions, props, props.index))}
            label={nameFor(ACTION_FAMILY_NAMES.setViewMode, locale)}
            meta={<ChevronRightIcon size={ICON_SIZE.menu} />}
            onClick={() => setMode({ kind: 'viewMode' })}
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
          role="menuitem"
        />,
      );
    }
    return <>{rendered}</>;
  };

  const renderViewMode = () => (
    <>
      <div className="node-context-subhead">
        <Button onClick={() => setMode({ kind: 'main' })} size="sm" variant="ghost">{tc.back}</Button>
        <span>{nameFor(ACTION_FAMILY_NAMES.setViewMode, locale)}</span>
      </div>
      {viewModeActions.map((action) => {
        const mode_ = action.binding.state === 'ready'
          ? (action.binding.arguments as { mode: 'outline' | 'table' }).mode
          : 'outline';
        const active = mode_ === currentViewMode(props);
        return (
          <MenuItem
            key={mode_}
            active={active}
            className="node-context-item"
            icon={actionIcon(action.iconId)}
            label={nameFor(action.names, locale)}
            meta={active ? <CheckIcon size={ICON_SIZE.menu} /> : null}
            onClick={() => activate(action)}
          />
        );
      })}
    </>
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
    onCloseRef.current();
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
          const first = candidates[0];
          if (!first) return;
          event.preventDefault();
          pickCandidate(first);
        }}
      />
      {candidates.map((candidate) => (
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
          : mode.kind === 'viewMode'
            ? renderViewMode()
            : renderParameter(mode)}
      </MenuSurface>
      {pendingConfirm ? (
        <ConfirmDialog
          danger={pendingConfirm.confirm.danger}
          title={nameFor(pendingConfirm.confirm.title, locale)}
          message={nameFor(pendingConfirm.confirm.message, locale)}
          confirmLabel={nameFor(pendingConfirm.confirm.confirmLabel, locale)}
          onCancel={() => {
            const ref = invocationRef.current;
            const challenge = pendingConfirm.challenge;
            setPendingConfirm(null);
            // Main learns the confirmation was declined, so the record returns
            // to `live` and the challenge dies with it.
            if (ref) {
              void window.lin?.actions?.event({
                kind: 'confirmationCancelled',
                invocationRef: ref,
                challenge,
              });
            }
          }}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            onCloseRef.current();
            void runRequest(
              pending.presentation,
              pending.presentation.binding.state === 'ready'
                ? pending.presentation.binding.arguments
                : {},
              pending.challenge,
            );
          }}
        />
      ) : null}
    </>,
    document.body,
  );
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
  const tag = tagNodeForCandidate(candidate.objectRef, candidate, index);
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

/**
 * The candidate presentation carries the tag's literal name, not its id — the
 * ref is opaque by design. Resolve the colour by name from the live index.
 */
function tagNodeForCandidate(
  _ref: ObjectRef,
  candidate: ObjectPresentation,
  index: DocumentIndex,
): NodeProjection | undefined {
  if (candidate.name.source !== 'literal') return undefined;
  const label = candidate.name.value;
  return index.projection.nodes.find(
    (node) => node.type === 'tagDef' && node.content.text === label,
  );
}
