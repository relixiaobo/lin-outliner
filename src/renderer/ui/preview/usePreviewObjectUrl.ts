import { useEffect, useState } from 'react';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';

/**
 * Read a preview target's bytes into an object URL, revoking it on cleanup or when the
 * target changes, with an in-flight cancel guard so a late resolve never paints onto a
 * changed node or leaks the URL after unmount.
 *
 * `enabled` gates the read so a consumer that prefers a direct/stream URL pays the byte
 * read only when it needs the fallback: the preview body reads when there is no
 * `streamUrl`; an inline file image reads only after the cached `asset://` <img> errors.
 *
 * Returns the resolved object URL, or an `error` code (e.g. `'too-large'`) when the read
 * fails — keeping one copy of this async/lifecycle state machine across every consumer.
 */
export function usePreviewObjectUrl(
  target: PreviewTarget | null,
  options: { enabled?: boolean; mimeType?: string } = {},
): { src: string | null; error?: string } {
  const { enabled = true, mimeType } = options;
  const [state, setState] = useState<{ src: string | null; error?: string }>({ src: null });

  useEffect(() => {
    if (!enabled || !target) {
      setState({ src: null });
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ src: null });
    void api.readPreviewBytes(target)
      .then((result) => {
        if (cancelled) return;
        if (!result.bytes) {
          setState({ src: null, error: result.error });
          return;
        }
        objectUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType ?? mimeType }));
        setState({ src: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ src: null, error: error instanceof Error ? error.message : undefined });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [target, enabled, mimeType]);

  return state;
}
