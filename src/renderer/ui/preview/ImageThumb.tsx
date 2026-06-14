import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { fileNodeTarget, type FileNode } from './fileNode';

/**
 * The row-level thumbnail for an image file node. Images are the one file kind that
 * renders inline — an image's content is its identity, where every other file is a
 * plain icon + filename row. This is deliberately light: it reads the image bytes
 * through the sandboxed preview API and shows a bounded `<img>`, with none of the
 * heavy preview-renderer module (shiki / pdf.js / markdown) the node-page body pulls
 * in, so the outliner hot path stays cheap. Clicking opens the file's node page for
 * the full-size view.
 */
export function ImageThumb({ node, onOpen }: { node: FileNode; onOpen: () => void }) {
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

  if (!src) return null;
  const alt = node.content.text || '';
  return (
    <button
      type="button"
      className="row-image-thumb"
      // A thumb click means "open the image"; keep it from reaching the row, where
      // it would otherwise move edit focus into the filename editor.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      aria-label={labels.open}
    >
      <img alt={alt} src={src} />
    </button>
  );
}
