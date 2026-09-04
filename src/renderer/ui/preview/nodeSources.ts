import { type NodeId } from '../../../core/types';
import { sourceFieldValues } from '../../../core/sourceField';
import {
  classifyNodeSource,
  parseAssetSourceUri,
  sourceKindFromMetadata,
  type ResolvedNodeSource,
} from '../../../core/source';
import type { PreviewResolveSourceResult, PreviewTarget } from '../../../core/preview';
import type { NodeProjection } from '../../api/types';
import { youtubePreviewRouteForUrl } from './urlPreviewRouting';

export interface NodeSourceDescriptor extends ResolvedNodeSource {
  previewTarget?: PreviewTarget;
}

export function applyHostSourceResolution(
  source: NodeSourceDescriptor,
  result: PreviewResolveSourceResult,
): NodeSourceDescriptor {
  const target = source.previewTarget;
  if (!target) return source;
  if (result.source) {
    const resolved = result.source;
    return {
      ...source,
      label: resolved.kind === 'url' ? resolved.title : resolved.name,
      kind: resolved.kind === 'url'
        ? source.kind
        : sourceKindFromMetadata(resolved.mimeType, resolved.name),
      previewTarget: resolved.target,
      availability: 'ready',
      reason: undefined,
      actions: target.kind === 'linked-file'
        ? ['copy-uri', 'edit', 'preview', 'retry', 'authorize', 'replace', 'remove']
        : source.actions,
    };
  }

  if (target.kind === 'linked-file') {
    const denied = result.error === 'file-access-denied';
    return {
      ...source,
      availability: denied ? 'denied' : 'unavailable',
      reason: denied ? 'file-access-denied' : 'file-unavailable',
      actions: denied
        ? ['copy-uri', 'edit', 'authorize', 'replace', 'remove']
        : ['copy-uri', 'edit', 'retry', 'authorize', 'replace', 'remove'],
    };
  }
  if (target.kind === 'asset') {
    return {
      ...source,
      availability: 'unavailable',
      reason: 'asset-unavailable',
      actions: ['copy-uri', 'edit', 'retry', 'replace', 'remove'],
    };
  }
  return {
    ...source,
    availability: 'unavailable',
    reason: 'network-unavailable',
    actions: ['copy-uri', 'edit', 'retry', 'replace', 'remove'],
  };
}

export function nodeSourceValues(
  ownerId: NodeId,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeSourceDescriptor[] {
  const values: NodeSourceDescriptor[] = [];
  for (const value of sourceFieldValues(byId, ownerId)) {
    const classified = classifyNodeSource(value.sourceText);
    const target = sourcePreviewTarget(value.node.id, value.sourceText, classified.label);
    values.push({
      ...classified,
      sourceValueId: value.node.id,
      ...(target ? { previewTarget: target } : {}),
    });
  }
  return values;
}

export function selectedNodeSource(
  ownerId: NodeId,
  selectedValueId: NodeId | null | undefined,
  byId: ReadonlyMap<NodeId, NodeProjection>,
): NodeSourceDescriptor | null {
  const values = nodeSourceValues(ownerId, byId);
  return values.find((value) => value.sourceValueId === selectedValueId) ?? values[0] ?? null;
}

export function sourcePreviewVisibleByDefault(source: NodeSourceDescriptor): boolean {
  const target = source.previewTarget;
  if (!target) return false;
  if (target.kind === 'asset' || target.kind === 'linked-file') return true;
  return target.kind === 'url' && youtubePreviewRouteForUrl(target.url) !== null;
}

export function sourcePreviewTarget(
  sourceValueId: NodeId,
  sourceText: string,
  label?: string,
): PreviewTarget | null {
  const assetId = parseAssetSourceUri(sourceText);
  if (assetId) return { kind: 'asset', assetId, ...(label ? { label } : {}) };

  let url: URL;
  try {
    url = new URL(sourceText);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return { kind: 'url', url: url.toString(), ...(label ? { label } : {}) };
  }
  if (url.protocol === 'file:') {
    return {
      kind: 'linked-file',
      sourceValueId,
      sourceText,
      ...(label ? { label } : {}),
    };
  }
  return null;
}
