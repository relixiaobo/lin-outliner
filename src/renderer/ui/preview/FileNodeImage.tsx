import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { FileNodeActionMenu } from './FileNodeActionMenu';
import { fileNodeTarget, type FileNode } from './fileNode';

/**
 * An image file node's outliner row content: the image itself, rendered inline as a
 * bounded preview — an image's content is its identity, so it shows directly instead
 * of a file-type icon + filename (other file kinds use FileNodeCard). The filename is
 * edited on the node page, not in the row. A ⋯ menu sits at the image's top-right,
 * revealed on hover, offering Maximize (open the node page, full size) + Reveal.
 * Clicking the image also maximizes it; the leading bullet/chevron still drill /
 * expand children, so it is a full node.
 *
 * Light by design: it reads the image bytes through the sandboxed preview API and
 * shows a bounded `<img>`, with none of the heavy preview-renderer module (shiki /
 * pdf.js / markdown) the node-page body pulls in, so the outliner hot path stays cheap.
 */
export function FileNodeImage({ node, onMaximize }: { node: FileNode; onMaximize: () => void }) {
  const ta = useT().outliner.field.attachment;
  const labels = useT().shell.filePreview;
  // Stable identity: re-resolve only when the backing source changes, not on every
  // projection update (which hands us a fresh node object with the same image).
  const sourceKey = node.assetId ?? (node.type === 'image' ? node.mediaUrl : null) ?? null;
  const target = useMemo(() => fileNodeTarget(node), [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [src, setSrc] = useState<string | null>(target?.kind === 'url' ? target.url : null);

  useEffect(() => {
    if (!target || target.kind === 'url') {
      setSrc(target?.kind === 'url' ? target.url : null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void api.readPreviewBytes(target).then((result) => {
      if (cancelled || !result.bytes) return;
      objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
      setSrc(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target]);

  return (
    <div className="file-node-image">
      <button
        aria-label={labels.open}
        className="file-node-image-button"
        // A click maximizes the image (its node page); keep it off the row, where it
        // would otherwise move edit focus into the hidden filename anchor.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMaximize();
        }}
        type="button"
      >
        {src ? <img alt={node.content.text || ''} src={src} /> : null}
      </button>
      <div className="file-node-image-actions" data-preserve-selection>
        <FileNodeActionMenu node={node} primaryLabel={ta.maximize} onPrimary={onMaximize} />
      </div>
    </div>
  );
}
