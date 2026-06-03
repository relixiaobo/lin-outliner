import { api } from '../../api/client';
import type { CommandOutcome, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { AddIcon, CalendarIcon, ICON_SIZE } from '../icons';
import { buildReferenceCandidates, type ReferenceCandidate } from '../interactions/referenceCandidates';
import type { CommandRunner } from '../shared';
import { NodeReferenceMenuIcon } from './NodeReferenceMenuIcon';
import { PopoverEmpty, PopoverListItem } from './PopoverList';

interface ReferenceSelectorProps {
  query: string;
  index: DocumentIndex;
  currentNodeId: NodeId;
  treeReferenceParentId?: NodeId | null;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
  run: CommandRunner;
  close: () => void;
  clearTriggerText: () => Promise<void>;
  applyReference?: (target: NodeProjection) => Promise<CommandOutcome | DocumentProjection | null | void>;
}

export function referenceItems(params: {
  query: string;
  index: DocumentIndex;
  currentNodeId: NodeId | null;
  treeReferenceParentId?: NodeId | null;
  excludeCurrentNode?: boolean;
}): ReferenceCandidate[] {
  return buildReferenceCandidates({
    index: params.index,
    currentNodeId: params.currentNodeId,
    query: params.query,
    treeReferenceParentId: params.treeReferenceParentId,
    excludeCurrentNode: params.excludeCurrentNode,
  });
}

function nodeFromOutcome(outcome: CommandOutcome, nodeId: NodeId): NodeProjection | undefined {
  return outcome.projection.nodes.find((node) => node.id === nodeId);
}

function dateParts(date: Date): { year: number; month: number; day: number } {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function iconForItem(item: ReferenceCandidate, index: DocumentIndex) {
  if (item.type === 'date') return <CalendarIcon size={ICON_SIZE.menu} />;
  if (item.type === 'create') return <AddIcon size={ICON_SIZE.menu} />;
  return <NodeReferenceMenuIcon index={index} node={index.byId.get(item.id)} />;
}

export function ReferenceSelector(props: ReferenceSelectorProps) {
  const items = referenceItems({
    query: props.query,
    index: props.index,
    currentNodeId: props.currentNodeId,
    treeReferenceParentId: props.treeReferenceParentId,
  });

  const selectTarget = (target: NodeProjection) => {
    props.close();
    void props.run(async () => {
      if (props.applyReference) {
        const result = await props.applyReference(target);
        return result ?? api.getProjection();
      }
      await props.clearTriggerText();
      return api.addReference(props.currentNodeId, target.id);
    });
  };

  const createAndSelect = (label: string) => {
    props.close();
    void props.run(async () => {
      const created = await api.createNode(props.index.projection.libraryId, null, label);
      const targetId = created.focus?.nodeId;
      const target = targetId ? nodeFromOutcome(created, targetId) : undefined;
      if (!target) return created;
      if (props.applyReference) {
        const result = await props.applyReference(target);
        return result ?? api.getProjection();
      }
      await props.clearTriggerText();
      return api.addReference(props.currentNodeId, target.id);
    });
  };

  const ensureDateAndSelect = (date: Date) => {
    props.close();
    void props.run(async () => {
      const parts = dateParts(date);
      const outcome = await api.ensureDateNode(parts.year, parts.month, parts.day);
      const targetId = outcome.focus?.nodeId;
      const target = targetId ? nodeFromOutcome(outcome, targetId) : undefined;
      if (!target) return outcome;
      if (props.applyReference) {
        const result = await props.applyReference(target);
        return result ?? api.getProjection();
      }
      await props.clearTriggerText();
      return api.addReference(props.currentNodeId, target.id);
    });
  };

  if (items.length === 0) {
    return <PopoverEmpty>No matches</PopoverEmpty>;
  }

  return (
    <>
      {items.map((item, index) => {
        const disabled = item.type === 'node' && Boolean(item.disabledReason);
        return (
          <PopoverListItem
            key={item.type === 'node' ? item.id : `${item.type}:${item.label}`}
            active={index === props.selectedIndex}
            disabled={disabled}
            data-create-reference={item.type === 'create' ? 'true' : undefined}
            title={item.type === 'node' ? item.disabledReason ?? undefined : undefined}
            icon={iconForItem(item, props.index)}
            iconClassName="popover-item-icon"
            label={(
              <>
                <span>{item.type === 'create' ? `Create "${item.label}"` : item.label}</span>
                {item.type === 'node' && item.breadcrumb && (
                  <span className="popover-item-meta">{item.breadcrumb}</span>
                )}
                {item.type === 'node' && item.disabledReason && (
                  <span className="popover-item-meta">{item.disabledReason}</span>
                )}
              </>
            )}
            onMouseEnter={() => props.setSelectedIndex(index)}
            onClick={() => {
              if (disabled) return;
              if (item.type === 'node') {
                const target = props.index.byId.get(item.id);
                if (target) selectTarget(target);
                return;
              }
              if (item.type === 'date') {
                ensureDateAndSelect(item.date);
                return;
              }
              createAndSelect(item.label);
            }}
          />
        );
      })}
    </>
  );
}
