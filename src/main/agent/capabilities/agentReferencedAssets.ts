import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ReferencedResourceSnapshot,
  ReferencedResourcesContextPayload,
  ThreadResourceReference,
} from '../../../core/agent/protocol';
import {
  type AssetMetadata,
  type DocumentProjection,
  type NodeProjection,
} from '../../../core/types';
import { parseAssetSourceUri } from '../../../core/source';
import { sourceFieldValues } from '../../../core/sourceField';
import {
  nodeBreadcrumb,
  outlineText,
  resolvedNodeTitle,
} from '../context/userView';

const MAX_RESOURCE_CONTENT_CHARS = 16_000;
const MAX_INLINE_IMAGES = 8;
export const MAX_REFERENCED_RESOURCE_BYTES = 50 * 1024 * 1024;
const INLINE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface ReferencedAssetResolution {
  readonly path: string;
  readonly metadata: AssetMetadata | null;
}

export interface ReferencedResourceAdmission {
  readonly payload: ReferencedResourcesContextPayload;
  readonly resourceRefs: readonly ThreadResourceReference[];
  readonly createdResourceRefs: readonly ThreadResourceReference[];
}

export async function admitReferencedResources(input: {
  readonly projection: DocumentProjection | null;
  readonly references: readonly { readonly nodeId: string; readonly note?: string }[];
  readonly resolveAsset?: (assetId: string) => Promise<ReferencedAssetResolution | null>;
  readonly writeResource: (
    bytes: Uint8Array,
    mimeType: string,
    fileName: string,
  ) => Promise<{ readonly ref: ThreadResourceReference; readonly created: boolean }>;
}): Promise<ReferencedResourceAdmission | null> {
  if (input.references.length === 0) return null;
  const byId = new Map(input.projection?.nodes.map((node) => [node.id, node]) ?? []);
  const resources: ReferencedResourceSnapshot[] = [];
  const resourceRefs: ThreadResourceReference[] = [];
  const createdResourceRefs: ThreadResourceReference[] = [];
  const admittedAssets = new Map<string, ThreadResourceReference>();
  const dependencyKeys = new Set<string>();
  let inlineImages = 0;

  for (const reference of uniqueReferences(input.references)) {
    const node = byId.get(reference.nodeId);
    if (!node) {
      resources.push(unavailable(reference.nodeId, reference.note ?? reference.nodeId, 'unknown', 'missing'));
      continue;
    }
    const content = resourceContent(node, byId);
    const base = {
      nodeId: node.id,
      nodeType: node.type ?? 'outline',
      title: resolvedNodeTitle(node, byId),
      breadcrumb: nodeBreadcrumb(node, byId),
      content: content.text,
      contentTruncated: content.truncated,
    };
    const assetId = firstManagedAssetId(node, byId);
    if (!assetId) {
      resources.push({
        ...base,
        resourceRef: null,
        inlineImage: false,
        unavailableReason: null,
      });
      continue;
    }
    const admitted = admittedAssets.get(assetId);
    if (admitted) {
      resources.push({ ...base, resourceRef: admitted, inlineImage: false, unavailableReason: null });
      continue;
    }
    try {
      const resolved = await input.resolveAsset?.(assetId) ?? null;
      if (!resolved) {
        resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'missing' });
        continue;
      }
      if ((resolved.metadata?.byteSize ?? 0) > MAX_REFERENCED_RESOURCE_BYTES) {
        resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'quotaExceeded' });
        continue;
      }
      const handle = await open(
        resolved.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (!handle) {
        resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'missing' });
        continue;
      }
      let bytes: Buffer;
      try {
        const file = await handle.stat();
        if (!file.isFile()) {
          resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'corrupt' });
          continue;
        }
        if (file.size > MAX_REFERENCED_RESOURCE_BYTES) {
          resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'quotaExceeded' });
          continue;
        }
        bytes = await handle.readFile();
        if (bytes.byteLength > MAX_REFERENCED_RESOURCE_BYTES) {
          resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'quotaExceeded' });
          continue;
        }
        if (resolved.metadata && bytes.byteLength !== resolved.metadata.byteSize) {
          resources.push({ ...base, resourceRef: null, inlineImage: false, unavailableReason: 'corrupt' });
          continue;
        }
      } finally {
        await handle.close();
      }
      const mimeType = normalizedMimeType(resolved.metadata?.mimeType);
      const fileName = resolved.metadata?.originalFilename || basename(resolved.path)
        || 'resource';
      const written = await input.writeResource(bytes, mimeType, fileName);
      admittedAssets.set(assetId, written.ref);
      const dependencyKey = resourceDependencyKey(written.ref);
      const newDependency = !dependencyKeys.has(dependencyKey);
      const inlineImage = newDependency
        && inlineImages < MAX_INLINE_IMAGES
        && INLINE_IMAGE_MIME_TYPES.has(mimeType);
      if (inlineImage) inlineImages += 1;
      if (newDependency) {
        dependencyKeys.add(dependencyKey);
        resourceRefs.push(written.ref);
        if (written.created) createdResourceRefs.push(written.ref);
      }
      resources.push({ ...base, resourceRef: written.ref, inlineImage, unavailableReason: null });
    } catch (error) {
      resources.push({
        ...base,
        resourceRef: null,
        inlineImage: false,
        unavailableReason: resourceFailureReason(error),
      });
    }
  }

  return {
    payload: { schemaVersion: 1, kind: 'referencedResources', resources },
    resourceRefs,
    createdResourceRefs,
  };
}

function resourceDependencyKey(ref: ThreadResourceReference): string {
  return `${ref.id}\0${ref.mimeType}\0${ref.byteLength}\0${ref.fileName}`;
}

function resourceContent(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): { readonly text: string; readonly truncated: boolean } {
  const children = node.children.flatMap((childId) => {
    const child = byId.get(childId);
    return child ? [`- ${outlineText(child, byId)}`] : [];
  });
  const raw = [outlineText(node, byId), ...children].filter(Boolean).join('\n');
  if (raw.length <= MAX_RESOURCE_CONTENT_CHARS) return { text: raw, truncated: false };
  return { text: raw.slice(0, MAX_RESOURCE_CONTENT_CHARS), truncated: true };
}

function unavailable(
  nodeId: string,
  title: string,
  nodeType: string,
  unavailableReason: ReferencedResourceSnapshot['unavailableReason'],
): ReferencedResourceSnapshot {
  return {
    nodeId,
    nodeType,
    title,
    breadcrumb: [],
    content: '',
    contentTruncated: false,
    resourceRef: null,
    inlineImage: false,
    unavailableReason,
  };
}

function normalizedMimeType(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  if (normalized) return normalized;
  return 'application/octet-stream';
}

function firstManagedAssetId(
  node: NodeProjection,
  byId: ReadonlyMap<string, NodeProjection>,
): string | undefined {
  for (const value of sourceFieldValues(byId, node.id)) {
    const assetId = parseAssetSourceUri(value.sourceText);
    if (assetId) return assetId;
  }
  return undefined;
}

function resourceFailureReason(error: unknown): ReferencedResourceSnapshot['unavailableReason'] {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('quota') || message.includes('budget') || message.includes('large')) return 'quotaExceeded';
  if (message.includes('unsupported')) return 'unsupported';
  return 'corrupt';
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function uniqueReferences(
  references: readonly { readonly nodeId: string; readonly note?: string }[],
): Array<{ readonly nodeId: string; readonly note?: string }> {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.nodeId)) return false;
    seen.add(reference.nodeId);
    return true;
  });
}
