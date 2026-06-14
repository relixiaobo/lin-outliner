import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { AddChildIcon, BackIcon, CheckIcon, ICON_SIZE, LoaderIcon, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
import { canAddPreviewTargetToOutline, requestAddPreviewTargetToOutline } from './previewIngest';
import {
  FilePreviewShell,
  canOpenPreviewSource,
  openPreviewSource,
  sourceMeta,
  sourceTitle,
  targetTitleFallback,
  usePreviewSource,
} from './previewRenderers';

interface FilePreviewPanelProps {
  canGoBack: boolean;
  onBack: () => void;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
  target: PreviewTarget;
}

/**
 * The pane preview for a source with no outliner node — an agent payload, a loose
 * local file, or a remote URL. It reuses the node-page preview body
 * (FilePreviewShell), so a non-node preview reads identically to a file node's node
 * page; only the chrome differs — a filename header here, the node breadcrumb there.
 * Its toolbar adds "add to outline", which copies the source into the outline as a
 * file node and navigates to it (the open/reveal/copy a node already carries).
 */
export function FilePreviewPanel({ canGoBack, onBack, onOpenTarget, target }: FilePreviewPanelProps) {
  const t = useT();
  const labels = t.shell.filePreview;
  const state = usePreviewSource(target);

  const openOriginal = useCallback(() => {
    if (state.status !== 'ready') return;
    void openPreviewSource(state.source);
  }, [state]);

  const title = state.status === 'ready'
    ? sourceTitle(state.source)
    : target.label ?? targetTitleFallback(target);
  const meta = state.status === 'ready' ? sourceMeta(state.source, labels) : null;
  const canOpen = state.status === 'ready' && canOpenPreviewSource(state.source);
  const canAdd = canAddPreviewTargetToOutline(target);

  // The file's name is the header title (like a node page); its actions live in the
  // body toolbar beside the meta, matching the node page's action strip.
  const actions = (canAdd || canOpen) ? (
    <>
      {canAdd ? <AddToOutlineButton target={target} /> : null}
      {canOpen ? (
        <ButtonControl aria-label={labels.open} className="file-node-action" onClick={openOriginal}>
          <OpenIcon size={ICON_SIZE.toolbar} />
        </ButtonControl>
      ) : null}
    </>
  ) : null;

  return (
    <section className="main-panel file-preview-panel" aria-label={title}>
      <header className="file-preview-header">
        {canGoBack ? (
          <IconButton
            className="file-preview-back"
            icon={BackIcon}
            label={t.nodePanel.previousPage}
            onClick={onBack}
            variant="panel"
          />
        ) : null}
        <h1 className="file-preview-heading" title={title}>{title}</h1>
      </header>

      <div className="file-preview-content">
        <FilePreviewShell
          variant="full"
          meta={meta}
          actions={actions}
          state={state}
          onOpenTarget={onOpenTarget}
        />
      </div>
    </section>
  );
}

/**
 * The "add to outline" action: fires the ingest bridge and confirms only on a real
 * insert. On success the pane navigates to the new node page, so this usually
 * unmounts before the confirmation paints — the navigation is the feedback; the
 * "added" state is the fallback when navigation is somehow skipped.
 */
function AddToOutlineButton({ target }: { target: PreviewTarget }) {
  const labels = useT().shell.filePreview;
  const [state, setState] = useState<'idle' | 'inserting' | 'inserted'>('idle');
  // A ref guards re-entry: `disabled` only lands next paint, so two clicks in one
  // frame would both read a stale `idle` and double-insert.
  const insertingRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    mountedRef.current = false;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function add() {
    if (insertingRef.current) return;
    insertingRef.current = true;
    setState('inserting');
    let added = false;
    try {
      added = await requestAddPreviewTargetToOutline(target);
    } catch {
      added = false;
    } finally {
      insertingRef.current = false;
    }
    if (!mountedRef.current) return;
    if (!added) {
      setState('idle');
      return;
    }
    setState('inserted');
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setState('idle');
      resetTimerRef.current = null;
    }, 1200);
  }

  const label = state === 'inserted' ? labels.addedToOutline : labels.addToOutline;
  const StateIcon = state === 'inserted' ? CheckIcon : state === 'inserting' ? LoaderIcon : AddChildIcon;
  return (
    <ButtonControl
      aria-label={label}
      className="file-node-action"
      disabled={state === 'inserting'}
      onClick={() => void add()}
      title={label}
    >
      <StateIcon
        aria-hidden="true"
        className={state === 'inserting' ? 'agent-tool-call-spinner' : undefined}
        size={ICON_SIZE.toolbar}
      />
    </ButtonControl>
  );
}
