import { useMemo } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import { CopyIcon, FolderIcon, OpenIcon } from '../icons';
import type { FilePreviewNavigationOptions } from '../workspaceLayoutTypes';
import type { FilePreviewMenuAction } from './FilePreviewPill';
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
  ownerId: string;
  target: PreviewTarget;
  onOpenTarget: (target: PreviewTarget, options?: FilePreviewNavigationOptions) => void;
  initialExpanded?: boolean;
}

/** Preview body for one explicitly selected Source value of an ordinary Node. */
export function FilePreviewBody({
  accessibleName,
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
      icon: OpenIcon,
      run: () => onOpenTarget(target, { newPane: true, nodeId: ownerId, presentation: 'reader' }),
    };
    if (state.status !== 'ready') {
      return { primaryOpen: null, menuActions: [openInSplit] };
    }
    const source = state.source;
    const primaryOpen = canOpenPreviewSource(source)
      ? {
          label: source.kind === 'url' ? labels.openInBrowser : labels.openWithDefault,
          run: () => void openPreviewSource(source),
        }
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

  return (
    <FilePreviewShell
      accessibleName={accessibleName}
      state={state}
      onOpenTarget={onOpenTarget}
      primaryOpen={controls.primaryOpen}
      menuActions={controls.menuActions}
      meta={state.status === 'ready' ? sourceMeta(state.source, labels) : null}
      initialExpanded={initialExpanded}
    />
  );
}
