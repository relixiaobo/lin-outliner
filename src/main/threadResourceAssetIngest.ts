import { decodeThreadResourceReference } from '../core/agent/codec';
import type { ThreadResourceReference } from '../core/agent/protocol';
import type { AssetMetadata } from '../core/types';

export const MAX_THREAD_RESOURCE_ASSET_INGEST_BYTES = 20 * 1024 * 1024;

export interface ThreadResourceAssetIngestDependencies {
  readonly readResource: (
    threadId: string,
    ref: ThreadResourceReference,
  ) => Promise<Uint8Array | null>;
  readonly ingestResource: (
    bytes: Uint8Array,
    ref: ThreadResourceReference,
  ) => Promise<AssetMetadata>;
}

export async function ingestThreadResourceAsset(
  input: Record<string, unknown>,
  dependencies: ThreadResourceAssetIngestDependencies,
): Promise<AssetMetadata | null> {
  const keys = Object.keys(input);
  if (keys.length !== 2 || keys.some((key) => key !== 'threadId' && key !== 'resourceRef')) {
    throw new Error('ingest_thread_resource accepts exactly threadId and resourceRef');
  }
  if (typeof input.threadId !== 'string' || !input.threadId.trim()) {
    throw new Error('ingest_thread_resource.threadId must be a non-empty string');
  }
  const ref = decodeThreadResourceReference(
    input.resourceRef,
    'ingest_thread_resource.resourceRef',
  );
  if (ref.byteLength > MAX_THREAD_RESOURCE_ASSET_INGEST_BYTES) return null;
  const bytes = await dependencies.readResource(input.threadId, ref);
  if (!bytes || bytes.byteLength !== ref.byteLength) return null;
  return dependencies.ingestResource(bytes, ref);
}
