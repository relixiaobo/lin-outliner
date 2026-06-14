import { lazy, Suspense } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { useT } from '../../i18n/I18nProvider';
import type { FileNode } from './fileNode';

// The heavy preview machinery (react-markdown / shiki / pdf.js) loads only when a
// file node is actually expanded, so it never enters the outliner's synchronous
// import graph — every row renders an OutlinerItem, and the row hot path must stay
// lean (A9). The node-page body (NodePanel) imports FilePreviewBody eagerly; the
// outliner reaches it through this lazy boundary instead.
const FilePreviewBody = lazy(() =>
  import('./FilePreviewBody').then((module) => ({ default: module.FilePreviewBody })),
);

interface FilePreviewBlockProps {
  node: FileNode;
  onOpenTarget: (target: PreviewTarget, options?: { newPane?: boolean }) => void;
}

/**
 * The inline preview revealed as the child level of an expanded file node. A thin,
 * lazy wrapper over {@link FilePreviewBody} with a matching loading placeholder so
 * the chunk fetch never flashes empty.
 */
export function FilePreviewBlock({ node, onOpenTarget }: FilePreviewBlockProps) {
  const labels = useT().shell.filePreview;
  return (
    <Suspense
      fallback={(
        <div className="file-node-body file-node-body--inline">
          <div className="file-node-preview">
            <div className="file-preview-message">{labels.loading}</div>
          </div>
        </div>
      )}
    >
      <FilePreviewBody node={node} onOpenTarget={onOpenTarget} variant="inline" />
    </Suspense>
  );
}
