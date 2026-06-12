import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { RowMarker } from './outliner/RowMarker';
import { useT } from '../i18n/I18nProvider';
import type { DocumentIndex, ReferencesSectionRequest } from '../state/document';
import type { CommandRunner, NavigateRootOptions } from './shared';
import { wantsNewPaneFromClick } from './shared';

interface BacklinksSectionProps {
  targetId: NodeId;
  index: DocumentIndex;
  summary: ReferenceSummary;
  run: CommandRunner;
  onRoot: (nodeId: NodeId, options?: NavigateRootOptions) => void;
  openRequest: ReferencesSectionRequest | null;
  onOpenRequestConsumed: (request: ReferencesSectionRequest) => void;
}

interface ReferenceRow {
  source: ReferenceSource;
  node: NodeProjection;
  key: string;
}

export function BacklinksSection(props: BacklinksSectionProps) {
  const t = useT();
  const labels = t.nodePanel.references;
  const { index, onOpenRequestConsumed, onRoot, openRequest, run, targetId } = props;
  const sectionRef = useRef<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const sources = props.summary.byTarget.get(targetId) ?? [];
  const counts = props.summary.countsByTarget.get(targetId);
  const totalCount = counts?.total ?? 0;

  const groups = useMemo(
    () => groupReferenceRows(sources, index, t.outliner.viewToolbar.fieldFallback),
    [sources, index, t.outliner.viewToolbar.fieldFallback],
  );

  useEffect(() => {
    setExpanded(false);
  }, [targetId]);

  useEffect(() => {
    const request = openRequest;
    if (!request || request.nodeId !== targetId) return;
    setExpanded(true);
    window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ block: 'nearest' });
    });
    onOpenRequestConsumed(request);
  }, [onOpenRequestConsumed, openRequest, targetId]);

  const openSource = useCallback((event: MouseEvent, sourceNodeId: NodeId) => {
    onRoot(sourceNodeId, { focus: false, newPane: wantsNewPaneFromClick(event) });
  }, [onRoot]);

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
    <section className="backlinks-section" ref={sectionRef} aria-label={labels.title}>
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
              heading={labels.linkedHeading}
              rows={groups.linked}
              labels={labels}
              index={index}
              onOpenSource={openSource}
            />
          )}
          {groups.fieldGroups.map((group) => (
            <ReferenceGroup
              key={group.fieldKey}
              heading={labels.fieldHeading({ field: group.fieldLabel })}
              rows={group.rows}
              labels={labels}
              index={index}
              onOpenSource={openSource}
            />
          ))}
          {groups.unlinked.length > 0 && (
            <ReferenceGroup
              heading={labels.unlinkedHeading}
              rows={groups.unlinked}
              labels={labels}
              index={index}
              onOpenSource={openSource}
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
  onLinkMention,
  targetTitle,
}: {
  heading: string;
  rows: readonly ReferenceRow[];
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  index: DocumentIndex;
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
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
  onLinkMention,
  targetTitle,
}: {
  row: ReferenceRow;
  labels: ReturnType<typeof useT>['nodePanel']['references'];
  index: DocumentIndex;
  onOpenSource: (event: MouseEvent, sourceNodeId: NodeId) => void;
  onLinkMention?: (source: ReferenceSource) => void;
  targetTitle?: string;
}) {
  const title = nodeTitle(row.node, labels.untitledSource);
  const breadcrumb = buildPanelBreadcrumb(row.node, index).nodes;
  const mentionLabel = row.source.mention
    ? row.source.mention.field === 'description'
      ? labels.descriptionMention
      : ''
    : '';
  const markerVariant = row.source.kind === 'field' ? 'reference' : 'content';

  return (
    <article className="backlinks-row">
      {breadcrumb.length > 0 && (
        <BreadcrumbPath
          nodes={breadcrumb}
          labels={labels}
          onOpenSource={onOpenSource}
        />
      )}
      <div className="backlinks-row-line">
        <button
          type="button"
          className="backlinks-row-open"
          aria-label={labels.openSource({ title })}
          onClick={(event) => onOpenSource(event, row.node.id)}
        >
          <span className="backlinks-row-highlight" aria-hidden />
          <span className="backlinks-row-leading" aria-hidden>
            <span className="backlinks-row-chevron-slot">
              <ChevronRightIcon size={ICON_SIZE.rowGlyph} />
            </span>
            <span className="backlinks-row-marker">
              <RowMarker
                hasChildren={false}
                expanded={false}
                variant={markerVariant}
              />
            </span>
          </span>
          <span className="backlinks-row-main">
            <span className="backlinks-row-title">{title}</span>
            {mentionLabel && <span className="backlinks-row-snippet">{mentionLabel}</span>}
          </span>
        </button>
        {onLinkMention && row.source.mention?.field === 'content' && !row.node.locked && (
          <button
            type="button"
            className="backlinks-link-action"
            title={labels.linkMentionTitle({ title: targetTitle ?? labels.untitledSource })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onLinkMention(row.source);
            }}
          >
            {labels.linkMention}
          </button>
        )}
      </div>
    </article>
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
