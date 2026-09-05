import { useMemo } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { CloseIcon, CopyIcon, FolderIcon, SplitPaneIcon } from '../icons';
import { previewOpenAction } from './previewOpenAction';
import { IconButton } from '../primitives/IconButton';
import type { FilePreviewNavigationOptions } from '../workspaceLayoutTypes';
import { FilePreviewPill, type FilePreviewMenuAction } from './FilePreviewPill';
import {
  FilePreviewShell,
  canCopyPreviewSource,
  canOpenPreviewSource,
  canRevealPreviewSource,
  copyPreviewSource,
  openPreviewSource,
  revealPreviewSource,
  sourceMeta,
  usePreviewSource,
} from './previewRenderers';

interface FilePreviewBodyProps {
  accessibleName?: string;
  dismiss?: { label: string; run: () => void };
  ownerId: string;
  target: PreviewTarget;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  initialExpanded?: boolean;
}

/** Preview body for one explicitly selected Source value of an ordinary Node. */
export function FilePreviewBody({
  accessibleName,
  dismiss,
  ownerId,
  target,
  onOpenTarget,
  initialExpanded = false,
}: FilePreviewBodyProps) {
  const labels = useT().shell.filePreview;
  const state = usePreviewSource(target);
  const controls = useMemo(() => {
    const openInSplit: FilePreviewMenuAction = {
      key: 'open-in-split',
      label: labels.openInSplitPane,
      icon: SplitPaneIcon,
      run: () => onOpenTarget(target, { newPane: true, nodeId: ownerId, presentation: 'reader' }),
    };
    if (state.status !== 'ready') {
      return { primaryOpen: null, menuActions: [openInSplit] };
    }
    const source = state.source;
    const primaryOpen = canOpenPreviewSource(source)
      ? previewOpenAction(source, labels, () => void openPreviewSource(source))
      : null;
    const menuActions: FilePreviewMenuAction[] = [openInSplit];
    if (canRevealPreviewSource(source)) {
      menuActions.push({
        key: 'reveal',
        label: labels.reveal,
        icon: FolderIcon,
        run: () => void revealPreviewSource(source),
      });
    }
    if (canCopyPreviewSource(source)) {
      menuActions.push({
        key: 'copy',
        label: labels.copyFile,
        icon: CopyIcon,
        run: () => void copyPreviewSource(source),
      });
    }
    return { primaryOpen, menuActions };
  }, [labels, onOpenTarget, ownerId, state, target]);
  const meta = state.status === 'ready' ? sourceMeta(state.source, labels) : null;
  const cornerAction = dismiss ? (
    <div className="outline-source-preview-actions" data-preserve-selection>
      <FilePreviewPill
        previewable={state.status === 'ready'}
        expanded
        onToggleExpand={() => undefined}
        primaryMode="none"
        primaryOpen={controls.primaryOpen}
        menuActions={controls.menuActions}
        meta={meta}
        placement="source-corner"
      />
      <IconButton
        className="outline-source-preview-close"
        icon={CloseIcon}
        label={dismiss.label}
        onClick={dismiss.run}
        variant="panel"
      />
    </div>
  ) : null;

  return (
    <FilePreviewShell
      accessibleName={accessibleName}
      cornerAction={cornerAction}
      state={state}
      onOpenTarget={onOpenTarget}
      primaryOpen={controls.primaryOpen}
      menuActions={controls.menuActions}
      meta={meta}
      initialExpanded={initialExpanded}
    />
  );
}
