import type { AssetMetadata } from '../../api/types';
import type { PreviewTarget } from '../../../core/preview';
import { api } from '../../api/client';

// "Save this previewed non-node source into the outline." A non-node file preview
// (agent payload / local file / url) can be turned into a first-class file node:
// copy its bytes into the asset store, then create an attachment/image node. After
// that it is the ingested state of the same unified file surface.

/**
 * True when a non-node source can be copied into the asset store: a trusted local
 * file (full path ingest) or an agent payload (bounded byte read). An `asset` is
 * already a node; a remote `url` is not fetchable into an asset yet.
 */
export function canAddPreviewTargetToOutline(target: PreviewTarget): boolean {
  return target.kind === 'local-file' || target.kind === 'agent-payload';
}

/**
 * Copy a previewable non-node source into the asset store and return the committed
 * asset, or null when it is gone / out of policy / too large / unsupported. Anything
 * the preview can resolve, it can ingest — the same security boundary backs both.
 */
export async function ingestPreviewTargetToAsset(target: PreviewTarget): Promise<AssetMetadata | null> {
  if (target.kind === 'local-file') {
    // Full-file copy, no size cap, gated to the agent's trusted roots (the same gate
    // that let the file be previewed in the first place).
    return api.ingestLocalFileToAsset(target.path);
  }
  if (target.kind === 'agent-payload') {
    // No path is exposed for a payload, so ingest its bytes. The byte read is bounded
    // (it errors rather than truncating past the limit), so a huge payload reports
    // not-ingested instead of silently committing a partial file.
    const [bytesResult, sourceResult] = await Promise.all([
      api.readPreviewBytes(target),
      api.resolvePreviewSource(target),
    ]);
    const bytes = bytesResult.bytes;
    const source = sourceResult.source;
    if (!bytes || !source || source.kind !== 'file') return null;
    return api.ingestAssetFromData(new Uint8Array(bytes), source.mimeType, source.name);
  }
  return null;
}

// The bridge: the preview pane has no path to App's document state (command runner,
// projection, navigation), so — like `agentFileInsert` — it fires a request and App
// runs ingest + create-node + in-place panel bind. Single-handler: the request
// returns App's promise so the button confirms only on a real insert.
interface AddToOutlineRequest {
  panelId: string;
  target: PreviewTarget;
}

type AddToOutlineHandler = (request: AddToOutlineRequest) => Promise<boolean>;

let handler: AddToOutlineHandler | null = null;

/** Save the previewed source into the outline. Resolves to `true` when a node was
 *  created, `false` when nothing was inserted (no bridge yet, or the source is gone /
 *  too large / unsupported). The button confirms only on `true`. */
export function requestAddPreviewTargetToOutline(request: AddToOutlineRequest): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  return handler(request);
}

/** Register the ingest bridge (App). Returns an unsubscribe; last registration wins. */
export function onAddPreviewTargetToOutlineRequest(next: AddToOutlineHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}
