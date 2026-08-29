import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { CommandResult, NodeId, NodeProjection } from '../../api/types';
import { nodeFromProjectionUpdate, type DocumentIndex } from '../../state/document';
import {
  displayReachabilityForParent,
  type DisplayReachabilityResult,
} from '../../state/displayReachability';
import { AddIcon, ICON_SIZE } from '../icons';
import {
  admitReferenceCandidates,
  buildReferenceCandidates,
  referenceCandidateLabels,
  type AdmittedReferenceCandidate,
  type ReferenceCandidateLabels,
} from '../interactions/referenceCandidates';
import {
  getTreeReferenceBlockReason,
  getTreeReferenceBlockReasonFromReachability,
  type TreeReferenceBlockReason,
} from '../interactions/referenceRules';
import type { CommandRunner, CommandRunnerOperationResult } from '../shared';
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
  applyReference: (target: NodeProjection) => Promise<CommandRunnerOperationResult>;
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
}): AdmittedReferenceCandidate[] {
  return admitReferenceCandidates(buildReferenceCandidates({
    index: params.index,
    currentNodeId: params.currentNodeId,
    query: params.query,
    treeReferenceParentId: params.treeReferenceParentId,
    excludeCurrentNode: params.excludeCurrentNode,
    includeFileNodes: params.includeFileNodes,
    labels: params.labels,
    resolveTreeReferenceBlockReason: params.resolveTreeReferenceBlockReason,
    skipTreeReferenceChecks: params.skipTreeReferenceChecks,
    publicNodeIdsOnly: true,
  }));
}

function nodeFromOutcome(outcome: CommandResult, nodeId: NodeId): NodeProjection | undefined {
  return nodeFromProjectionUpdate(outcome.update, nodeId);
}

function iconForItem(item: AdmittedReferenceCandidate, index: DocumentIndex) {
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
  const reachabilityPending = Boolean(treeReferenceParentId && !reachability);

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
    void props.applyReference(target);
  };

  const createAndSelect = (label: string) => {
    props.close();
    void (async () => {
      const created = await props.run(
        () => api.createNode(props.index.projection.libraryId, null, label),
        { applyFocus: false },
      );
      if (!created || !('update' in created)) return;
      const targetId = created.focus?.nodeId;
      const target = targetId ? nodeFromOutcome(created, targetId) : undefined;
      if (!target) return;
      await props.applyReference(target);
    })();
  };

  if (items.length === 0) {
    return <PopoverEmpty>{tr.noMatches}</PopoverEmpty>;
  }

  return (
    <>
      {items.map((item, index) => {
        const disabled = item.type === 'node'
          && (reachabilityPending || Boolean(item.disabledReason));
        return (
          <PopoverListItem
            key={item.type === 'node' ? item.id : `${item.type}:${item.label}`}
            active={index === props.selectedIndex}
            disabled={disabled}
            data-create-reference={item.type === 'create' ? 'true' : undefined}
            title={item.type === 'node'
              ? item.disabledReason ?? (reachabilityPending ? t.common.loading : undefined)
              : undefined}
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
              createAndSelect(item.label);
            }}
          />
        );
      })}
    </>
  );
}
