import type { CSSProperties } from 'react';
import type { NodeId } from '../api/types';
import type { DocumentIndex } from '../state/document';
import { wantsNewPaneFromClick } from '../ui/shared';
import { inlineReferenceTextColor } from '../ui/tags/tagColors';

export interface ThreadNodeReferenceOpenOptions {
  readonly newPane?: boolean;
}

export type ThreadNodeReferenceOpenHandler = (
  nodeId: NodeId,
  options?: ThreadNodeReferenceOpenOptions,
) => void;

export const THREAD_NODE_REFERENCE_LINK_PREFIX = 'lin-node:';

export function threadNodeReferenceHref(nodeId: NodeId): string {
  return `#${THREAD_NODE_REFERENCE_LINK_PREFIX}${encodeURIComponent(nodeId)}`;
}

export function threadNodeIdFromReferenceHref(href: string | undefined): NodeId | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  if (!normalizedHref?.startsWith(THREAD_NODE_REFERENCE_LINK_PREFIX)) return null;
  const encodedNodeId = normalizedHref.slice(THREAD_NODE_REFERENCE_LINK_PREFIX.length);
  try {
    return decodeURIComponent(encodedNodeId);
  } catch {
    return encodedNodeId;
  }
}

export function threadNodeReferenceOpenOptionsFromClick(
  event: { readonly ctrlKey: boolean; readonly metaKey: boolean },
): ThreadNodeReferenceOpenOptions {
  return { newPane: wantsNewPaneFromClick(event) };
}

export function threadNodeReferenceStyle(
  nodeId: NodeId,
  index: DocumentIndex | undefined,
): CSSProperties | undefined {
  if (!index) return undefined;
  const color = inlineReferenceTextColor(nodeId, index);
  if (!color) return undefined;
  return {
    '--inline-ref-accent': color,
    color,
  } as CSSProperties;
}

export function threadNodeReferenceDisplayLabel(
  label: string,
  nodeId: NodeId,
  index: DocumentIndex | undefined,
  fallback: string,
): string {
  const explicit = label.trim();
  if (explicit) return explicit;
  const title = index?.byId.get(nodeId)?.content.text.trim();
  return title || fallback;
}
