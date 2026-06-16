import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type DragEventHandler,
  type ReactNode,
  type RefObject,
} from 'react';
import type { NodeId } from '../api/types';
import { useT } from '../i18n/I18nProvider';
import type { DocumentIndex, UiState } from '../state/document';
import { ChevronLeftIcon, CloseIcon } from './icons';
import { FLAT_OUTLINER_ENABLED, OutlinerFlatView } from './outliner/OutlinerFlatView';
import { OutlinerView } from './outliner/OutlinerView';
import { IconButton } from './primitives/IconButton';
import type { CommandRunner, NavigateRootOptions, TriggerState } from './shared';

type FlatOutlinerProps = ComponentProps<typeof OutlinerFlatView>;
type TreeOutlinerProps = ComponentProps<typeof OutlinerView>;

export function usePanelTitleDock() {
  const mainPanelRef = useRef<HTMLElement | null>(null);
  const stickyBreadcrumbRef = useRef<HTMLDivElement | null>(null);
  const titleRowRef = useRef<HTMLDivElement | null>(null);
  const [titleDocked, setTitleDocked] = useState(false);

  const updateTitleDockedState = useCallback(() => {
    const panel = mainPanelRef.current;
    const breadcrumbEl = stickyBreadcrumbRef.current;
    const titleRow = titleRowRef.current;
    if (!panel || !breadcrumbEl || !titleRow) {
      setTitleDocked(false);
      return;
    }
    const threshold = Math.max(0, titleRow.offsetTop - breadcrumbEl.offsetHeight - 1);
    const nextDocked = panel.scrollTop >= threshold;
    setTitleDocked((prev) => (prev === nextDocked ? prev : nextDocked));
  }, []);

  const requestTitleDockMeasure = useCallback(() => {
    window.requestAnimationFrame(updateTitleDockedState);
  }, [updateTitleDockedState]);

  const resetPanelViewport = useCallback(() => {
    const panel = mainPanelRef.current;
    if (panel) panel.scrollTop = 0;
    setTitleDocked(false);
    requestTitleDockMeasure();
  }, [requestTitleDockMeasure]);

  useEffect(() => {
    const handleResize = () => updateTitleDockedState();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateTitleDockedState]);

  return {
    mainPanelRef,
    requestTitleDockMeasure,
    resetPanelViewport,
    stickyBreadcrumbRef,
    titleDocked,
    titleRowRef,
    updateTitleDockedState,
  };
}

interface PanelStickyBreadcrumbProps {
  breadcrumbAriaLabel: string;
  canGoBack: boolean;
  children: ReactNode;
  closeLabel: string;
  currentTitle: string;
  origin: ReactNode;
  onBack: () => void;
  onClose: () => void;
  previousPageLabel: string;
  showClose: boolean;
  stickyRef: RefObject<HTMLDivElement | null>;
  titleDocked: boolean;
}

export function PanelStickyBreadcrumb(props: PanelStickyBreadcrumbProps) {
  return (
    <div className="panel-sticky-breadcrumb" ref={props.stickyRef}>
      <div className="panel-breadcrumb-leading">
        {/* Per-pane back only. Forward (and the active-pane back) live in the
            global window chrome next to the sidebar toggle (Cmd+[ / Cmd+]) -
            see WindowChrome. */}
        <IconButton
          className="panel-page-back-button"
          disabled={!props.canGoBack}
          icon={ChevronLeftIcon}
          iconSize={14}
          label={props.previousPageLabel}
          onClick={props.onBack}
          title={props.previousPageLabel}
          variant="panel"
        />
        {props.origin}
      </div>
      <nav className="panel-breadcrumb" aria-label={props.breadcrumbAriaLabel}>
        {props.children}
        {props.titleDocked && (
          <span className="panel-breadcrumb-segment panel-breadcrumb-current">
            <span className="panel-breadcrumb-divider">/</span>
            <span className="panel-breadcrumb-current-label" data-current-page-title>
              {props.currentTitle}
            </span>
          </span>
        )}
      </nav>
      {/* Close lives INSIDE the breadcrumb (the pane's toolbar row): it is a no-drag
          DOM descendant of the breadcrumb's drag region - the only reliable carve-out
          on macOS (see breadcrumb.css) - and aligns to the same --panel-content-x as
          the content on the right. */}
      {props.showClose && (
        <IconButton
          className="panel-breadcrumb-close"
          icon={CloseIcon}
          label={props.closeLabel}
          onClick={props.onClose}
          title={props.closeLabel}
          variant="panel"
        />
      )}
    </div>
  );
}

interface PanelChildrenOutlineProps {
  className?: string;
  dragId: NodeId | null;
  draftPlaceholder?: string;
  index: DocumentIndex;
  isNodePinned: (nodeId: NodeId) => boolean;
  label?: ReactNode;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  onTogglePin: (nodeId: NodeId) => void;
  panelId: string;
  parentId: NodeId;
  rootId: NodeId;
  rows?: TreeOutlinerProps['rows'];
  run: CommandRunner;
  scrollParentRef: FlatOutlinerProps['scrollParentRef'];
  setDragId: (nodeId: NodeId | null) => void;
  setTrigger: (trigger: TriggerState) => void;
  setUi: FlatOutlinerProps['setUi'];
  trailingDraft?: FlatOutlinerProps['trailingDraft'];
  trigger: TriggerState;
  ui: UiState;
  uiRef: FlatOutlinerProps['uiRef'];
}

export function PanelChildrenOutline(props: PanelChildrenOutlineProps) {
  const t = useT();
  const className = ['outliner', props.className].filter(Boolean).join(' ');

  // The node outline is an ARIA tree: `treeitem` rows carry level / expanded /
  // selected state (see OutlinerRowShell). Multi-select is supported, so the tree
  // is `aria-multiselectable`. Structure-only — the sighted keyboard model lives
  // in useWorkspaceKeyboard and is unchanged.
  return (
    <div
      className={className}
      role="tree"
      aria-label={t.outliner.treeAriaLabel}
      aria-multiselectable="true"
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      {props.label}
      {FLAT_OUTLINER_ENABLED ? (
        <OutlinerFlatView
          panelId={props.panelId}
          parentId={props.parentId}
          rootId={props.rootId}
          onRoot={props.onRoot}
          index={props.index}
          isNodePinned={props.isNodePinned}
          ui={props.ui}
          uiRef={props.uiRef}
          setUi={props.setUi}
          run={props.run}
          onTogglePin={props.onTogglePin}
          trigger={props.trigger}
          setTrigger={props.setTrigger}
          dragId={props.dragId}
          setDragId={props.setDragId}
          trailingDraft={props.trailingDraft}
          draftPlaceholder={props.draftPlaceholder}
          scrollParentRef={props.scrollParentRef}
        />
      ) : (
        <OutlinerView
          panelId={props.panelId}
          parentId={props.parentId}
          rootId={props.rootId}
          onRoot={props.onRoot}
          depth={0}
          index={props.index}
          isNodePinned={props.isNodePinned}
          ui={props.ui}
          uiRef={props.uiRef}
          setUi={props.setUi}
          run={props.run}
          onTogglePin={props.onTogglePin}
          trigger={props.trigger}
          setTrigger={props.setTrigger}
          dragId={props.dragId}
          setDragId={props.setDragId}
          rows={props.rows}
          trailingDraft={props.trailingDraft}
          draftPlaceholder={props.draftPlaceholder}
        />
      )}
    </div>
  );
}
