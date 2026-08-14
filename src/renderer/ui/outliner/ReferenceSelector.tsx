import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { CommandResult, NodeId, NodeProjection } from '../../api/types';
import { nodeFromProjectionUpdate, type DocumentIndex } from '../../state/document';
import {
  displayReachabilityForParent,
  type DisplayReachabilityResult,
} from '../../state/displayReachability';
import { AddIcon, CalendarIcon, ICON_SIZE } from '../icons';
import { buildReferenceCandidates, referenceCandidateLabels, type ReferenceCandidate, type ReferenceCandidateLabels } from '../interactions/referenceCandidates';
import {
  getTreeReferenceBlockReason,
  getTreeReferenceBlockReasonFromReachability,
  type TreeReferenceBlockReason,
} from '../interactions/referenceRules';
import { commandRunnerNoop, type CommandRunner, type CommandRunnerOperationResult } from '../shared';
import { NodeReferenceMenuIcon } from './NodeReferenceMenuIcon';
import { PopoverEmpty, PopoverListItem } from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

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
  applyReference?: (target: NodeProjection) => Promise<CommandRunnerOperationResult>;
}

export function referenceItems(params: {
  query: string;
  index: DocumentIndex;
  currentNodeId: NodeId | null;
  treeReferenceParentId?: NodeId | null;
  excludeCurrentNode?: boolean;
  includeFileNodes?: boolean;
  labels?: ReferenceCandidateLabels;
  resolveTreeReferenceBlockReason?: (targetId: NodeId) => TreeReferenceBlockReason | null;
  skipTreeReferenceChecks?: boolean;
}): ReferenceCandidate[] {
  return buildReferenceCandidates({
    index: params.index,
    currentNodeId: params.currentNodeId,
    query: params.query,
    treeReferenceParentId: params.treeReferenceParentId,
    excludeCurrentNode: params.excludeCurrentNode,
    includeFileNodes: params.includeFileNodes,
    labels: params.labels,
    resolveTreeReferenceBlockReason: params.resolveTreeReferenceBlockReason,
    skipTreeReferenceChecks: params.skipTreeReferenceChecks,
  });
}

function nodeFromOutcome(outcome: CommandResult, nodeId: NodeId): NodeProjection | undefined {
  return nodeFromProjectionUpdate(outcome.update, nodeId);
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
  const t = useT();
  const tr = t.outliner.field;
  const treeReferenceParentId = props.treeReferenceParentId ?? null;
  const displayGraphCacheKey = props.index.displayGraphCacheKey ?? props.index;
  const latestIndexRef = useRef(props.index);
  latestIndexRef.current = props.index;
  const [reachabilityState, setReachabilityState] = useState<{
    cacheKey: object;
    parentId: NodeId;
    value: DisplayReachabilityResult;
  } | null>(null);
  const reachability = reachabilityState?.cacheKey === displayGraphCacheKey
    && reachabilityState.parentId === treeReferenceParentId
    ? reachabilityState.value
    : null;

  useEffect(() => {
    if (!treeReferenceParentId) return;
    let cancelled = false;
    void displayReachabilityForParent(latestIndexRef.current, treeReferenceParentId).then((value) => {
      if (cancelled) return;
      setReachabilityState({ cacheKey: displayGraphCacheKey, parentId: treeReferenceParentId, value });
    });
    return () => {
      cancelled = true;
    };
  }, [displayGraphCacheKey, treeReferenceParentId]);

  const labels = useMemo(() => referenceCandidateLabels(t), [t]);
  const items = useMemo(() => referenceItems({
    query: props.query,
    index: props.index,
    currentNodeId: props.currentNodeId,
    treeReferenceParentId,
    labels,
    resolveTreeReferenceBlockReason: reachability
      ? (targetId) => getTreeReferenceBlockReasonFromReachability({
          parentId: treeReferenceParentId!,
          targetId,
          byId: props.index.byId,
          reachability,
        })
      : undefined,
    skipTreeReferenceChecks: Boolean(treeReferenceParentId && !reachability),
  }), [labels, props.currentNodeId, props.index, props.query, reachability, treeReferenceParentId]);

  const targetIsSelectable = (targetId: NodeId): boolean => {
    if (!treeReferenceParentId) return true;
    const reason = reachability
      ? getTreeReferenceBlockReasonFromReachability({
          parentId: treeReferenceParentId,
          targetId,
          byId: props.index.byId,
          reachability,
        })
      : getTreeReferenceBlockReason({
          parentId: treeReferenceParentId,
          targetId,
          byId: props.index.byId,
        });
    return reason === null || reason === 'already_in_parent';
  };

  const selectTarget = (target: NodeProjection) => {
    props.close();
    void props.run(async () => {
      if (props.applyReference) {
        const result = await props.applyReference(target);
        return result ?? commandRunnerNoop();
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
        return result ?? created;
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
      // `ensure_date_node` is idempotent: referencing an already-existing daily
      // note bumps no revision, so its delta is empty and the node isn't in
      // `changedNodes`. Fall back to the held index, where it already lives.
      const target = targetId
        ? nodeFromOutcome(outcome, targetId) ?? props.index.byId.get(targetId)
        : undefined;
      if (!target) return outcome;
      if (props.applyReference) {
        const result = await props.applyReference(target);
        return result ?? outcome;
      }
      await props.clearTriggerText();
      return api.addReference(props.currentNodeId, target.id);
    });
  };

  if (items.length === 0) {
    return <PopoverEmpty>{tr.noMatches}</PopoverEmpty>;
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
                <span>{item.type === 'create' ? tr.createReference({ label: item.label }) : item.label}</span>
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
                if (!targetIsSelectable(item.id)) return;
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
