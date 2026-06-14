import { useCallback } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { BackIcon, ICON_SIZE, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { IconButton } from '../primitives/IconButton';
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

  // The file's name is the header title (like a node page); open lives in the body
  // toolbar beside the meta, matching the node page's action strip.
  const actions = canOpen ? (
    <ButtonControl aria-label={labels.open} className="file-node-action" onClick={openOriginal}>
      <OpenIcon size={ICON_SIZE.toolbar} />
    </ButtonControl>
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
