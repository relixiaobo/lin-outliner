import { useMemo, type CSSProperties } from 'react';
import { splitNodeReferenceMarkers } from '../../../core/nodeReferenceMarkup';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { wantsNewTabFromClick } from '../shared';
import { inlineReferenceTextColor } from '../tags/tagColors';

export interface AgentNodeReferenceOpenOptions {
  newTab?: boolean;
}

export type AgentNodeReferenceOpenHandler = (
  nodeId: NodeId,
  options?: AgentNodeReferenceOpenOptions,
) => void;

interface NodeReferenceClickEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
}

export function nodeReferenceOpenOptionsFromClick(
  event: NodeReferenceClickEventLike,
): AgentNodeReferenceOpenOptions {
  return { newTab: wantsNewTabFromClick(event) };
}

interface AgentInlineReferenceTextProps {
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  text: string;
}

export function AgentInlineReferenceText({
  index,
  onNodeReferenceOpen,
  text,
}: AgentInlineReferenceTextProps) {
  const segments = useMemo(() => splitNodeReferenceMarkers(text), [text]);

  return (
    <>
      {segments.map((segment, segmentIndex) => {
        if (segment.type === 'text') return segment.text;
        const style = nodeReferenceStyle(segment.nodeId, index);
        const label = nodeReferenceDisplayLabel(segment.label, segment.nodeId, index);
        const key = `${segment.raw}-${segment.nodeId}-${segmentIndex}`;
        if (!onNodeReferenceOpen) {
          return (
            <span
              className="inline-ref agent-message-inline-ref"
              data-inline-ref={segment.nodeId}
              key={key}
              style={style}
              title={label}
            >
              {label}
            </span>
          );
        }
        return (
          <button
            className="inline-ref agent-message-inline-ref"
            data-inline-ref={segment.nodeId}
            key={key}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(segment.nodeId, nodeReferenceOpenOptionsFromClick(event));
            }}
            style={style}
            title={label}
            type="button"
          >
            {label}
          </button>
        );
      })}
    </>
  );
}

export function nodeReferenceStyle(nodeId: NodeId, index: DocumentIndex | undefined): CSSProperties | undefined {
  if (!index) return undefined;
  const color = inlineReferenceTextColor(nodeId, index);
  if (!color) return undefined;
  return {
    '--inline-ref-accent': color,
    color,
  } as CSSProperties;
}

export function nodeReferenceDisplayLabel(
  label: string,
  nodeId: NodeId,
  index: DocumentIndex | undefined,
): string {
  const explicit = label.trim();
  if (explicit) return explicit;
  const title = index?.byId.get(nodeId)?.content.text.trim();
  if (title) return title;
  return 'Referenced node';
}
