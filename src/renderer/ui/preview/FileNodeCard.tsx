import { useT } from '../../i18n/I18nProvider';
import { INLINE_FILE_ICON_CLASS } from '../editor/inlineFileIcon';
import { FileNodeActionMenu } from './FileNodeActionMenu';
import { fileNodeIconKind, fileNodeMeta, type FileNode } from './fileNode';

interface FileNodeCardProps {
  node: FileNode;
  /** Open the file's node page in the current panel (a card click, "the preview page"). */
  onOpen: () => void;
  /** Open the file's node page in a split pane (the ⋯ menu's primary action). */
  onOpenSplit: () => void;
}

/**
 * A non-image file node's outliner row content: a uniform card — file-type icon, the
 * filename (display-only, single line, truncated), a meta line (type · size · …), and
 * a ⋯ action menu. The whole card is click-to-open: a click opens the file's node
 * page (the preview), so the filename is never edited inline (rename on the node
 * page). The leading bullet/chevron stay on the row, so a file is a full node: the
 * chevron expands its children. Images render inline via FileNodeImage instead.
 */
export function FileNodeCard({ node, onOpen, onOpenSplit }: FileNodeCardProps) {
  const ta = useT().outliner.field.attachment;
  const meta = fileNodeMeta(node, ta);
  const filename = node.content.text
    || (node.type === 'attachment' ? node.originalFilename : undefined)
    || '';

  return (
    <div
      className="file-node-card"
      // A card click opens the file (its node page); keep mousedown off the row so it
      // never moves edit focus into the hidden filename anchor.
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onOpen}
    >
      <span
        aria-hidden="true"
        className={`file-node-card-icon ${INLINE_FILE_ICON_CLASS}`}
        data-file-icon-kind={fileNodeIconKind(node)}
      />
      <div className="file-node-card-main">
        <span className="file-node-card-name" title={filename}>{filename}</span>
        {meta ? <span className="file-node-card-meta">{meta}</span> : null}
      </div>
      <div className="file-node-card-actions" data-preserve-selection>
        <FileNodeActionMenu node={node} primaryLabel={ta.openInSplit} onPrimary={onOpenSplit} />
      </div>
    </div>
  );
}
