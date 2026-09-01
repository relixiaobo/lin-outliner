import type { CSSProperties } from 'react';
import type { ThreadReferenceView } from '../../core/agent/protocol';
import { isContentBearingNode, type NodeId } from '../api/types';
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
export const THREAD_THREAD_REFERENCE_LINK_PREFIX = 'lin-thread:';

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

export function threadReferenceHref(threadId: string): string {
  return `#${THREAD_THREAD_REFERENCE_LINK_PREFIX}${encodeURIComponent(threadId)}`;
}

export function threadIdFromReferenceHref(href: string | undefined): string | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  if (!normalizedHref?.startsWith(THREAD_THREAD_REFERENCE_LINK_PREFIX)) return null;
  const encodedThreadId = normalizedHref.slice(THREAD_THREAD_REFERENCE_LINK_PREFIX.length);
  try {
    return decodeURIComponent(encodedThreadId);
  } catch {
    return encodedThreadId;
  }
}

export function shortThreadReferenceId(threadId: string): string {
  return `${threadId.slice(0, 8)}...${threadId.slice(-4)}`;
}

export function threadReferenceDisplayLabel(
  threadId: string,
  resolution: ThreadReferenceView | undefined,
  fallback: string,
): string {
  return resolution?.title?.trim() || `${fallback} ${shortThreadReferenceId(threadId)}`;
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
  const node = index?.byId.get(nodeId);
  const title = node && isContentBearingNode(node) ? node.content.text.trim() : '';
  return title || label.trim() || fallback;
}
