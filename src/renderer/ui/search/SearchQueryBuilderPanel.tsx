import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import type { Messages } from '../../../core/i18n';
import { SEARCH_QUERY_COMPLEXITY_LIMITS } from '../../../core/searchQueryCompiler';
import { api } from '../../api/client';
import { inlineRefNodeId, type NodeId, type NodeProjection, type QueryOp } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import {
  CloseIcon,
  FilterIcon,
  RefreshIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Textarea } from '../primitives/Textarea';
import type { CommandRunner } from '../shared';

interface SearchQueryBuilderPanelProps {
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
  onClose: () => void;
}

const TEXT_OPS = new Set<QueryOp>([
  'STRING_MATCH',
  'REGEXP_MATCH',
  'IS_TYPE',
  'FOR_DATE',
  'FOR_RELATIVE_DATE',
  'SIBLING_NAMED',
  'CREATED_LAST_DAYS',
  'EDITED_LAST_DAYS',
  'DONE_LAST_DAYS',
]);

export function SearchQueryBuilderPanel({ index, nodeId, run, onClose }: SearchQueryBuilderPanelProps) {
  const t = useT();
  const builder = t.search.builder;
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const searchNode = index.byId.get(nodeId);
  const readOnly = Boolean(searchNode?.locked);
  const initialText = useMemo(() => searchQueryOutlineText(index, nodeId, t), [index, nodeId, t]);
  const resultCount = useMemo(() => searchQueryResultCount(index, nodeId), [index, nodeId]);
  const [draft, setDraft] = useState(initialText);

  useEffect(() => {
    setDraft(initialText);
    setLocalError(null);
  }, [initialText, nodeId]);

  const dirty = draft !== initialText;
  const rows = Math.min(12, Math.max(5, draft.split('\n').length + 1));

  const save = async () => {
    if (readOnly || saving || !draft.trim()) return;
    setSaving(true);
    setLocalError(null);
    try {
      const result = await run(() => api.setSearchQueryOutline(nodeId, draft), { applyFocus: false });
      if (!result) setLocalError(builder.saveError);
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await run(() => api.refreshSearchNodeResults(nodeId), { applyFocus: false });
    } finally {
      setRefreshing(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Escape' && !dirty) {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <section className="search-query-builder-panel" data-search-query-builder>
      <div className="search-query-builder-header">
        <div className="search-query-builder-title">
          <FilterIcon size={14} />
          <span>{builder.title}</span>
          {resultCount !== null && (
            <span className="search-query-builder-count">
              {t.search.resultCount({ count: resultCount })}
            </span>
          )}
        </div>
        <div className="search-query-builder-actions">
          <IconButton
            className={`search-query-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
            disabled={refreshing}
            icon={RefreshIcon}
            label={builder.refreshLabel}
            onClick={() => void refresh()}
            title={builder.refreshTitle}
            variant="toolbar"
          />
          <IconButton
            className="search-query-refresh-button"
            icon={CloseIcon}
            label={builder.closeLabel}
            onClick={onClose}
            title={builder.closeTitle}
            variant="toolbar"
          />
        </div>
      </div>
      <Textarea
        className="search-query-builder-textarea"
        label={builder.queryAriaLabel}
        value={draft}
        rows={rows}
        readOnly={readOnly}
        spellCheck={false}
        placeholder={'- STRING_MATCH\n  - value:: keyword'}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="search-query-builder-footer">
        <span className="search-query-builder-status">
          {localError ?? (readOnly ? builder.statusLocked : dirty ? builder.statusUnsaved : builder.statusSaved)}
        </span>
        <div className="search-query-builder-buttons">
          <Button
            disabled={readOnly || !dirty || saving}
            onClick={() => {
              setDraft(initialText);
              setLocalError(null);
            }}
            size="sm"
            variant="ghost"
          >
            {builder.reset}
          </Button>
          <Button
            disabled={readOnly || !dirty || saving || !draft.trim()}
            onClick={() => void save()}
            size="sm"
            variant="primary"
          >
            {saving ? builder.saving : builder.save}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** A projected node carrying query params — a `search` (inline) or `queryCondition`. */
type QueryBearingProjection = Extract<NodeProjection, { type: 'search' } | { type: 'queryCondition' }>;

export function searchQueryResultCount(index: DocumentIndex, nodeId: NodeId): number | null {
  const searchNode = index.byId.get(nodeId);
  if (!searchNode || searchNode.type !== 'search') return null;
  return searchNode.children.filter((childId) => {
    const child = index.byId.get(childId);
    return child?.type === 'reference' && Boolean(child.targetId);
  }).length;
}

export function searchQueryOutlineText(index: DocumentIndex, nodeId: NodeId, t: Messages): string {
  const searchNode = index.byId.get(nodeId);
  if (!searchNode || searchNode.type !== 'search') return '';

  const queryRoots = directConditionChildren(index, searchNode);
  const roots = queryRoots.children.length > 0
    ? queryRoots.children
    : searchNode.queryLogic || searchNode.queryOp ? [searchNode] : [];
  return conditionOutlineLines(index, roots, t).join('\n');
}

function conditionOutlineLines(index: DocumentIndex, roots: QueryBearingProjection[], t: Messages): string[] {
  const lines: string[] = [];
  const visited = new Set<NodeId>();
  const stack: Array<{ condition: QueryBearingProjection; level: number }> = [];
  let nodeCount = 0;

  for (let rootIndex = roots.length - 1; rootIndex >= 0; rootIndex -= 1) {
    stack.push({ condition: roots[rootIndex]!, level: 0 });
  }

  while (stack.length > 0) {
    const { condition, level } = stack.pop()!;
    if (visited.has(condition.id)) continue;
    if (level > SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth) break;
    if (nodeCount >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes) break;
    nodeCount += 1;
    visited.add(condition.id);

    const indent = '  '.repeat(level);
    if (condition.queryLogic) {
      lines.push(`${indent}- ${condition.queryLogic}`);
      const children = directConditionChildren(index, condition).children;
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        stack.push({ condition: children[childIndex]!, level: level + 1 });
      }
      continue;
    }

    if (!condition.queryOp) continue;
    lines.push(`${indent}- ${condition.queryOp}`);
    if (condition.queryFieldDefId) lines.push(`${indent}  - field:: ${nodeReference(index, condition.queryFieldDefId, t)}`);
    if (condition.queryTagDefId) lines.push(`${indent}  - tag:: ${nodeReference(index, condition.queryTagDefId, t, tagName(index, condition.queryTagDefId, t))}`);
    if (condition.queryTargetId) lines.push(`${indent}  - target:: ${nodeReference(index, condition.queryTargetId, t)}`);
    for (const operand of operandOutlineTexts(index, condition, t)) {
      lines.push(`${indent}  - value:: ${operand}`);
    }
  }
  return lines;
}

function operandOutlineTexts(index: DocumentIndex, condition: QueryBearingProjection, t: Messages): string[] {
  const operands: string[] = [];
  for (const childId of condition.children) {
    if (operands.length >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxOperandsPerRule) break;
    const child = index.byId.get(childId);
    if (!child || child.type === 'queryCondition') continue;
    const text = operandOutlineText(index, child, t);
    if (text) operands.push(text);
  }
  if (operands.length > 0) return uniqueLabels(operands);

  const text = condition.content.text.trim();
  if (condition.queryOp && TEXT_OPS.has(condition.queryOp) && text && text !== condition.queryOp) return [text];
  return [];
}

function operandOutlineText(index: DocumentIndex, node: NodeProjection, t: Messages): string {
  if (node.type === 'reference' && node.targetId) return nodeReference(index, node.targetId, t, node.content.text.trim() || undefined);
  const inlineRef = node.content.inlineRefs[0];
  const inlineNodeId = inlineRef ? inlineRefNodeId(inlineRef) : null;
  if (inlineNodeId) return nodeReference(index, inlineNodeId, t, inlineRef?.displayName);
  return node.content.text.trim();
}

function directConditionChildren(index: DocumentIndex, node: NodeProjection): {
  children: QueryBearingProjection[];
  truncated: boolean;
} {
  const children: QueryBearingProjection[] = [];
  let truncated = false;
  for (const childId of node.children) {
    const child = index.byId.get(childId);
    if (child?.type !== 'queryCondition') continue;
    if (children.length >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxChildrenPerGroup) {
      truncated = true;
      break;
    }
    children.push(child);
  }
  return { children, truncated };
}

function nodeTitle(index: DocumentIndex, nodeId: NodeId, t: Messages): string {
  return index.byId.get(nodeId)?.content.text.trim() || t.common.untitled;
}

function nodeReference(index: DocumentIndex, nodeId: NodeId, t: Messages, label?: string): string {
  return formatNodeReferenceMarker(label ?? nodeTitle(index, nodeId, t), nodeId);
}

function tagName(index: DocumentIndex, tagId: NodeId, t: Messages): string {
  const title = nodeTitle(index, tagId, t);
  return title.startsWith('#') ? title : `#${title}`;
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    result.push(label);
  }
  return result;
}
