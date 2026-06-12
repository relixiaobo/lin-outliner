import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
} from 'react';
import { api } from '../api/client';
import {
  nodeReferenceTarget,
  replaceAllRichTextPatch,
  type NodeId,
  type NodeProjection,
} from '../api/types';
import {
  type ReferenceSource,
  type ReferenceSummary,
} from '../../core/references';
import { buildPanelBreadcrumb } from './panelBreadcrumb';
import { replaceRichTextRangeWithInlineRef } from './editor/richTextCodec';
import { ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from './icons';
import { OutlinerPreviewRow } from './outliner/OutlinerPreviewRow';
import { useT } from '../i18n/I18nProvider';
import { outlinerChildParentId, resolveReferenceTargetId, type DocumentIndex } from '../state/document';
import type { CommandRunner, NavigateRootOptions } from './shared';
import { wantsNewPaneFromClick } from './shared';

interface BacklinksSectionProps {
  targetId: NodeId;
  index: DocumentIndex;
  summary: ReferenceSummary;
  run: CommandRunner;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
}

interface ReferenceRow {
  source: ReferenceSource;
  node: NodeProjection;
  key: string;
}

interface ReferenceOutlineRowProps {
  node: NodeProjection;
  depth: number;
  path: readonly NodeId[];
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  index: DocumentIndex;
  markerVariant: 'content' | 'reference';
  mentionLabel?: string;
  linkAction?: {
    source: ReferenceSource;
    targetTitle?: string;
    onLinkMention: (source: ReferenceSource) => void;
  };
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
  onOpenSourceInCurrentPane: (sourceNodeId: NodeId) => void;
  expandedSourceIds: ReadonlySet<NodeId>;
  onToggleSourceExpansion: (sourceNodeId: NodeId) => void;
}

export function BacklinksSection(props: BacklinksSectionProps) {
  return <BacklinksSectionContent key={props.targetId} {...props} />;
}

function BacklinksSectionContent(props: BacklinksSectionProps) {
  const t = useT();
  const labels = t.nodePanel.references;
  const { index, onRoot, run, targetId } = props;
  const [expanded, setExpanded] = useState(false);
  const [expandedSourceIds, setExpandedSourceIds] = useState<ReadonlySet<NodeId>>(() => new Set());
  const sources = props.summary.byTarget.get(targetId) ?? [];
  const counts = props.summary.countsByTarget.get(targetId);
  const totalCount = counts?.total ?? 0;

  const groups = useMemo(
    () => groupReferenceRows(sources, index, t.outliner.viewToolbar.fieldFallback),
    [sources, index, t.outliner.viewToolbar.fieldFallback],
  );

  const openSource = useCallback((event: MouseEvent, sourceNodeId: NodeId) => {
    onRoot(sourceNodeId, { focus: false, newPane: wantsNewPaneFromClick(event) });
  }, [onRoot]);
  const openSourceInCurrentPane = useCallback((sourceNodeId: NodeId) => {
    onRoot(sourceNodeId, { focus: false });
  }, [onRoot]);
  const toggleSourceExpansion = useCallback((sourceNodeId: NodeId) => {
    setExpandedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceNodeId)) {
        next.delete(sourceNodeId);
      } else {
        next.add(sourceNodeId);
      }
      return next;
    });
  }, []);

  const linkMention = useCallback((source: ReferenceSource) => {
    const mention = source.mention;
    if (!mention || mention.field !== 'content') return;
    const sourceNode = index.byId.get(source.sourceNodeId);
    const targetNode = index.byId.get(targetId);
    if (!sourceNode || !targetNode || sourceNode.locked) return;
    const currentText = sourceNode.content.text.slice(mention.start, mention.end);
    if (currentText.toLocaleLowerCase() !== mention.text.toLocaleLowerCase()) return;
    const displayName = targetNode.content.text.trim() || labels.untitledSource;
    const nextContent = replaceRichTextRangeWithInlineRef(
      sourceNode.content,
      mention.start,
      mention.end,
      { target: nodeReferenceTarget(targetId), displayName },
    );
    void run(() => api.applyNodeTextPatch(source.sourceNodeId, replaceAllRichTextPatch(nextContent)));
  }, [index.byId, labels.untitledSource, run, targetId]);

  if (totalCount === 0) return null;

  const countLabel = labels.counterLabel({ count: totalCount });
  const countDetail = counts
    ? labels.count({ total: counts.total, linked: counts.linked, unlinked: counts.unlinked })
    : labels.count({ total: totalCount, linked: totalCount, unlinked: 0 });

  return (
    <section className="backlinks-section" aria-label={labels.title}>
      <button
        type="button"
        className="backlinks-section-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? labels.collapse : labels.expand}
        title={countDetail}
        onClick={() => setExpanded((next) => !next)}
      >
        <span className="backlinks-section-count">{countLabel}</span>
        {expanded
          ? <ChevronDownIcon className="backlinks-section-chevron" size={ICON_SIZE.tiny} aria-hidden />
          : <ChevronRightIcon className="backlinks-section-chevron" size={ICON_SIZE.tiny} aria-hidden />}
      </button>
      {expanded && (
        <div className="backlinks-section-body">
          {groups.linked.length > 0 && (
            <ReferenceGroup
              heading={labels.linkedHeading({ count: groups.linked.length })}
              rows={groups.linked}
              labels={labels}
              index={index}
              onOpenSource={openSource}
              onOpenSourceInCurrentPane={openSourceInCurrentPane}
              expandedSourceIds={expandedSourceIds}
              onToggleSourceExpansion={toggleSourceExpansion}
            />
          )}
          {groups.fieldGroups.map((group) => (
            <ReferenceGroup
              key={group.fieldKey}
              heading={labels.fieldHeading({ field: group.fieldLabel, count: group.rows.length })}
              rows={group.rows}
              labels={labels}
              index={index}
              onOpenSource={openSource}
              onOpenSourceInCurrentPane={openSourceInCurrentPane}
              expandedSourceIds={expandedSourceIds}
              onToggleSourceExpansion={toggleSourceExpansion}
            />
          ))}
          {groups.unlinked.length > 0 && (
            <ReferenceGroup
              heading={labels.unlinkedHeading({ count: groups.unlinked.length })}
              rows={groups.unlinked}
              labels={labels}
              index={index}
              onOpenSource={openSource}
              onOpenSourceInCurrentPane={openSourceInCurrentPane}
              expandedSourceIds={expandedSourceIds}
              onToggleSourceExpansion={toggleSourceExpansion}
              onLinkMention={linkMention}
              targetTitle={index.byId.get(targetId)?.content.text.trim() || labels.untitledSource}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ReferenceGroup({
  heading,
  rows,
  labels,
  index,
  onOpenSource,
  onOpenSourceInCurrentPane,
  expandedSourceIds,
  onToggleSourceExpansion,
  onLinkMention,
  targetTitle,
}: {
  heading: string;
  rows: readonly ReferenceRow[];
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  index: DocumentIndex;
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
  onOpenSourceInCurrentPane: (sourceNodeId: NodeId) => void;
  expandedSourceIds: ReadonlySet<NodeId>;
  onToggleSourceExpansion: (sourceNodeId: NodeId) => void;
  onLinkMention?: (source: ReferenceSource) => void;
  targetTitle?: string;
}) {
  return (
    <div className="backlinks-group">
      <div className="backlinks-group-heading">{heading}</div>
      <div className="backlinks-list">
        {rows.map((row) => (
          <ReferenceResultRow
            key={row.key}
            row={row}
            labels={labels}
            index={index}
            onOpenSource={onOpenSource}
            onOpenSourceInCurrentPane={onOpenSourceInCurrentPane}
            expandedSourceIds={expandedSourceIds}
            onToggleSourceExpansion={onToggleSourceExpansion}
            onLinkMention={onLinkMention}
            targetTitle={targetTitle}
          />
        ))}
      </div>
    </div>
  );
}

function ReferenceResultRow({
  row,
  labels,
  index,
  onOpenSource,
  onOpenSourceInCurrentPane,
  expandedSourceIds,
  onToggleSourceExpansion,
  onLinkMention,
  targetTitle,
}: {
  row: ReferenceRow;
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  index: DocumentIndex;
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
  onOpenSourceInCurrentPane: (sourceNodeId: NodeId) => void;
  expandedSourceIds: ReadonlySet<NodeId>;
  onToggleSourceExpansion: (sourceNodeId: NodeId) => void;
  onLinkMention?: (source: ReferenceSource) => void;
  targetTitle?: string;
}) {
  const breadcrumb = buildPanelBreadcrumb(row.node, index).nodes;
  const mentionLabel = row.source.mention
    ? row.source.mention.field === 'description'
      ? labels.descriptionMention
      : ''
    : '';
  const markerVariant = row.source.kind === 'field' || row.node.type === 'reference' ? 'reference' : 'content';
  const linkAction = onLinkMention && row.source.mention?.field === 'content' && !row.node.locked
    ? { onLinkMention, source: row.source, targetTitle }
    : undefined;

  return (
    <article className="backlinks-row">
      {breadcrumb.length > 0 && (
        <BreadcrumbPath
          nodes={breadcrumb}
          labels={labels}
          onOpenSource={onOpenSource}
        />
      )}
      <ReferenceOutlineRow
        node={row.node}
        depth={0}
        path={[]}
        labels={labels}
        index={index}
        markerVariant={markerVariant}
        mentionLabel={mentionLabel}
        linkAction={linkAction}
        onOpenSource={onOpenSource}
        onOpenSourceInCurrentPane={onOpenSourceInCurrentPane}
        expandedSourceIds={expandedSourceIds}
        onToggleSourceExpansion={onToggleSourceExpansion}
      />
    </article>
  );
}

function ReferenceOutlineRow({
  node,
  depth,
  path,
  labels,
  index,
  markerVariant,
  mentionLabel,
  linkAction,
  onOpenSource,
  onOpenSourceInCurrentPane,
  expandedSourceIds,
  onToggleSourceExpansion,
}: ReferenceOutlineRowProps) {
  const displayNode = displaySourceNode(node, index);
  const openId = displayNode.id;
  const title = nodeTitle(displayNode, labels.untitledSource);
  const description = displayNode.description?.trim() ?? '';
  const childParentId = outlinerChildParentId(node.id, index.byId);
  const cycle = childParentId ? path.includes(childParentId) : false;
  const childIds = !childParentId || cycle ? [] : index.byId.get(childParentId)?.children ?? [];
  const expanded = expandedSourceIds.has(node.id);
  const childPath = childParentId ? [...path, childParentId] : path;

  return (
    <OutlinerPreviewRow
      nodeId={node.id}
      depth={depth}
      hasChildren={childIds.length > 0}
      expanded={expanded}
      markerVariant={markerVariant}
      openLabel={labels.openSource({ title })}
      title={title}
      meta={mentionLabel}
      description={description}
      action={linkAction && (
        <button
          type="button"
          className="backlinks-link-action"
          title={labels.linkMentionTitle({ title: linkAction.targetTitle ?? labels.untitledSource })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            linkAction.onLinkMention(linkAction.source);
          }}
        >
          {labels.linkMention}
        </button>
      )}
      onOpen={(event) => onOpenSource(event, openId)}
      onToggleExpand={() => onToggleSourceExpansion(node.id)}
      onDrillDown={() => onOpenSourceInCurrentPane(openId)}
    >
      {childIds.map((childId) => (
        <ReferenceChildOutlineRow
          key={childId}
          nodeId={childId}
          depth={depth + 1}
          path={childPath}
          labels={labels}
          index={index}
          onOpenSource={onOpenSource}
          onOpenSourceInCurrentPane={onOpenSourceInCurrentPane}
          expandedSourceIds={expandedSourceIds}
          onToggleSourceExpansion={onToggleSourceExpansion}
        />
      ))}
    </OutlinerPreviewRow>
  );
}

function ReferenceChildOutlineRow({
  nodeId,
  ...props
}: Omit<ReferenceOutlineRowProps, 'markerVariant' | 'node'> & {
  nodeId: NodeId;
}) {
  const node = props.index.byId.get(nodeId);
  if (!node) return null;
  return (
    <ReferenceOutlineRow
      {...props}
      node={node}
      markerVariant={node.type === 'reference' ? 'reference' : 'content'}
    />
  );
}

function BreadcrumbPath({
  nodes,
  labels,
  onOpenSource,
}: {
  nodes: readonly NodeProjection[];
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
}) {
  return (
    <div className="backlinks-row-path" aria-label={labels.breadcrumbLabel}>
      {nodes.map((node, index) => (
        <span key={node.id} className="backlinks-row-path-part">
          {index > 0 && <span className="backlinks-row-path-separator">/</span>}
          <button
            type="button"
            className="backlinks-row-path-button"
            title={nodeTitle(node, labels.untitledSource)}
            onClick={(event) => onOpenSource(event, node.id)}
          >
            {nodeTitle(node, labels.untitledSource)}
          </button>
        </span>
      ))}
    </div>
  );
}

function groupReferenceRows(sources: readonly ReferenceSource[], index: DocumentIndex, fieldFallback: string): {
  linked: ReferenceRow[];
  fieldGroups: Array<{ fieldKey: string; fieldLabel: string; rows: ReferenceRow[] }>;
  unlinked: ReferenceRow[];
} {
  const linked = dedupeRows(sources.filter((source) => source.kind === 'tree' || source.kind === 'inline'), index);
  const unlinked = dedupeRows(sources.filter((source) => source.kind === 'unlinked'), index, true);
  const fieldGroupsByKey = new Map<string, { fieldKey: string; fieldLabel: string; rows: ReferenceRow[] }>();
  for (const row of dedupeRows(sources.filter((source) => source.kind === 'field'), index)) {
    const fieldKey = row.source.fieldDefId ?? row.source.fieldEntryId ?? 'field';
    const group = fieldGroupsByKey.get(fieldKey);
    if (group) {
      group.rows.push(row);
      continue;
    }
    fieldGroupsByKey.set(fieldKey, {
      fieldKey,
      fieldLabel: fieldLabel(row.source, index, fieldFallback),
      rows: [row],
    });
  }
  return { linked, fieldGroups: [...fieldGroupsByKey.values()], unlinked };
}

function dedupeRows(
  sources: readonly ReferenceSource[],
  index: DocumentIndex,
  keepMentionRanges = false,
): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const node = index.byId.get(source.sourceNodeId);
    if (!node) continue;
    const mentionKey = keepMentionRanges && source.mention
      ? `${source.mention.field}:${source.mention.start}:${source.mention.end}`
      : '';
    const key = `${source.kind}:${source.sourceNodeId}:${source.fieldEntryId ?? ''}:${mentionKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ source, node, key });
  }
  return rows;
}

function fieldLabel(source: ReferenceSource, index: DocumentIndex, fieldFallback: string): string {
  const fieldDef = source.fieldDefId ? index.byId.get(source.fieldDefId) : undefined;
  if (fieldDef?.content.text.trim()) return fieldDef.content.text.trim();
  const fieldEntry = source.fieldEntryId ? index.byId.get(source.fieldEntryId) : undefined;
  return fieldEntry?.content.text.trim() || fieldFallback;
}

function nodeTitle(node: NodeProjection, fallback: string): string {
  return node.content.text.trim() || fallback;
}

function displaySourceNode(node: NodeProjection, index: DocumentIndex): NodeProjection {
  if (node.type !== 'reference' || !node.targetId) return node;
  const targetId = resolveReferenceTargetId(node.targetId, index.byId);
  return targetId ? index.byId.get(targetId) ?? node : node;
}
