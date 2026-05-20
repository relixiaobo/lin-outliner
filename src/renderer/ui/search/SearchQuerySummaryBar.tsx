import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { NodeId, NodeProjection, QueryLogic, QueryOp } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import {
  FieldIcon,
  FilterIcon,
  HashIcon,
  ReferenceIcon,
  RefreshIcon,
  SearchIcon,
  type AppIcon,
} from '../icons';
import { IconButton } from '../primitives/IconButton';
import type { CommandRunner } from '../shared';

type SearchQueryChipKind = 'field' | 'logic' | 'reference' | 'tag' | 'text';

export interface SearchQuerySummaryChip {
  kind: SearchQueryChipKind;
  label: string;
}

export interface SearchQuerySummaryModel {
  chips: SearchQuerySummaryChip[];
  resultCount: number;
}

interface SearchQuerySummaryBarProps {
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
}

const FIELD_VALUE_OPS = new Set<QueryOp>(['FIELD_IS', 'FIELD_IS_NOT', 'FIELD_CONTAINS', 'LT', 'GT', 'DATE_OVERLAPS']);
const FIELD_STATE_OPS = new Set<QueryOp>([
  'IS_EMPTY',
  'IS_NOT_EMPTY',
  'HAS_FIELD',
  'OVERDUE',
  'FIELD_IS_SET',
  'FIELD_IS_NOT_SET',
  'FIELD_IS_DEFINED',
  'FIELD_IS_NOT_DEFINED',
]);
const TARGET_OPS = new Set<QueryOp>(['LINKS_TO', 'CHILD_OF', 'OWNED_BY', 'DESCENDANT_OF', 'DESCENDANT_OF_WITH_REFS']);
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

export function searchQuerySummaryModel(index: DocumentIndex, nodeId: NodeId): SearchQuerySummaryModel | null {
  const searchNode = index.byId.get(nodeId);
  if (!searchNode || searchNode.type !== 'search') return null;

  const queryRoots = directConditionChildren(index, searchNode);
  const chips = queryRoots.length > 0
    ? queryRoots.flatMap((condition) => conditionChips(index, condition, 0))
    : conditionChips(index, searchNode, 0);

  return {
    chips,
    resultCount: searchNode.children.filter((childId) => {
      const child = index.byId.get(childId);
      return child?.type === 'reference' && Boolean(child.targetId);
    }).length,
  };
}

export function SearchQuerySummaryBar({ index, nodeId, run }: SearchQuerySummaryBarProps) {
  const [refreshing, setRefreshing] = useState(false);
  const model = useMemo(() => searchQuerySummaryModel(index, nodeId), [index, nodeId]);

  if (!model) return null;

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await run(() => api.refreshSearchNodeResults(nodeId));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="search-query-summary-bar">
      <div className="search-query-summary-main">
        <div className="search-query-chip-list" aria-label="Search rules">
          {model.chips.length > 0 ? model.chips.map((chip, index) => (
            <SearchQueryChip key={`${chip.kind}:${chip.label}:${index}`} chip={chip} />
          )) : (
            <span className="search-query-empty">No rules</span>
          )}
        </div>
        <span className="search-query-result-count">
          {model.resultCount} {model.resultCount === 1 ? 'result' : 'results'}
        </span>
      </div>
      <IconButton
        className={`search-query-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
        disabled={refreshing}
        icon={RefreshIcon}
        label="Refresh search results"
        onClick={() => void refresh()}
        title="Refresh"
        variant="toolbar"
      />
    </div>
  );
}

function SearchQueryChip({ chip }: { chip: SearchQuerySummaryChip }) {
  const Icon = chipIcon(chip.kind);
  return (
    <span className={`search-query-chip search-query-chip-${chip.kind}`} title={chip.label}>
      <Icon size={13} />
      <span className="search-query-chip-label">{chip.label}</span>
    </span>
  );
}

function conditionChips(index: DocumentIndex, condition: NodeProjection, depth: number): SearchQuerySummaryChip[] {
  if (condition.queryLogic) {
    const childChips = directConditionChildren(index, condition)
      .flatMap((child) => conditionChips(index, child, depth + 1));
    if (depth === 0 && condition.queryLogic === 'AND') return childChips;
    return [{
      kind: 'logic',
      label: formatLogicGroup(condition.queryLogic, childChips),
    }];
  }

  if (!condition.queryOp) return [];
  return [ruleChip(index, condition, condition.queryOp)];
}

function ruleChip(index: DocumentIndex, condition: NodeProjection, op: QueryOp): SearchQuerySummaryChip {
  if (op === 'HAS_TAG') {
    return {
      kind: 'tag',
      label: condition.queryTagDefId ? tagName(index, condition.queryTagDefId) : 'Has tag',
    };
  }

  if (FIELD_VALUE_OPS.has(op) || FIELD_STATE_OPS.has(op)) {
    return {
      kind: 'field',
      label: fieldRuleLabel(index, condition, op),
    };
  }

  if (TARGET_OPS.has(op)) {
    return {
      kind: 'reference',
      label: targetRuleLabel(index, condition, op),
    };
  }

  if (TEXT_OPS.has(op)) {
    return {
      kind: 'text',
      label: textRuleLabel(index, condition, op),
    };
  }

  return {
    kind: 'text',
    label: simpleOpLabel(op),
  };
}

function fieldRuleLabel(index: DocumentIndex, condition: NodeProjection, op: QueryOp): string {
  const field = condition.queryFieldDefId ? nodeTitle(index, condition.queryFieldDefId) : 'Field';
  const values = valueLabels(index, condition);
  const value = values.join(', ');

  switch (op) {
    case 'FIELD_IS':
      return value ? `${field} = ${value}` : `${field} =`;
    case 'FIELD_IS_NOT':
      return value ? `${field} != ${value}` : `${field} !=`;
    case 'FIELD_CONTAINS':
      return value ? `${field} contains ${value}` : `${field} contains`;
    case 'LT':
      return value ? `${field} < ${value}` : `${field} <`;
    case 'GT':
      return value ? `${field} > ${value}` : `${field} >`;
    case 'DATE_OVERLAPS':
      return value ? `${field} overlaps ${value}` : `${field} overlaps date`;
    case 'IS_EMPTY':
      return `${field} is empty`;
    case 'IS_NOT_EMPTY':
      return `${field} is not empty`;
    case 'HAS_FIELD':
      return condition.queryFieldDefId ? `Has ${field}` : 'Has field';
    case 'OVERDUE':
      return condition.queryFieldDefId ? `${field} overdue` : 'Overdue';
    case 'FIELD_IS_SET':
      return `${field} is set`;
    case 'FIELD_IS_NOT_SET':
      return `${field} is not set`;
    case 'FIELD_IS_DEFINED':
      return `${field} is defined`;
    case 'FIELD_IS_NOT_DEFINED':
      return `${field} is not defined`;
    default:
      return `${field} ${simpleOpLabel(op)}`;
  }
}

function targetRuleLabel(index: DocumentIndex, condition: NodeProjection, op: QueryOp): string {
  const target = condition.targetId
    ? nodeTitle(index, condition.targetId)
    : valueLabels(index, condition)[0] ?? 'target';
  switch (op) {
    case 'LINKS_TO':
      return `Links to ${target}`;
    case 'CHILD_OF':
      return `Child of ${target}`;
    case 'OWNED_BY':
      return `Owned by ${target}`;
    case 'DESCENDANT_OF':
      return `Descendant of ${target}`;
    case 'DESCENDANT_OF_WITH_REFS':
      return `Descendant of ${target} with refs`;
    default:
      return `${simpleOpLabel(op)} ${target}`;
  }
}

function textRuleLabel(index: DocumentIndex, condition: NodeProjection, op: QueryOp): string {
  const values = valueLabels(index, condition);
  const value = values.join(', ');
  switch (op) {
    case 'STRING_MATCH':
      return value ? `"${value}"` : 'Text';
    case 'REGEXP_MATCH':
      return value ? `/${value}/` : 'Regexp';
    case 'IS_TYPE':
      return value ? `Type = ${value}` : 'Type';
    case 'FOR_DATE':
      return value ? `Date = ${value}` : 'Date';
    case 'FOR_RELATIVE_DATE':
      return value ? `Date = ${value}` : 'Relative date';
    case 'SIBLING_NAMED':
      return value ? `Sibling named ${value}` : 'Sibling named';
    case 'CREATED_LAST_DAYS':
      return value ? `Created in ${value} days` : 'Created recently';
    case 'EDITED_LAST_DAYS':
      return value ? `Edited in ${value} days` : 'Edited recently';
    case 'DONE_LAST_DAYS':
      return value ? `Done in ${value} days` : 'Done recently';
    default:
      return value ? `${simpleOpLabel(op)} ${value}` : simpleOpLabel(op);
  }
}

function valueLabels(index: DocumentIndex, condition: NodeProjection): string[] {
  const labels = condition.children.flatMap((childId): string[] => {
    const child = index.byId.get(childId);
    if (!child || child.type === 'queryCondition') return [];
    const label = operandLabel(index, child);
    return label ? [label] : [];
  });
  if (labels.length > 0) return uniqueLabels(labels);
  const text = condition.content.text.trim();
  return text ? [text] : [];
}

function operandLabel(index: DocumentIndex, node: NodeProjection): string {
  if (node.type === 'reference' && node.targetId) return nodeTitle(index, node.targetId);
  const inlineRef = node.content.inlineRefs[0];
  if (inlineRef) return inlineRef.displayName || nodeTitle(index, inlineRef.targetNodeId);
  return node.content.text.trim();
}

function directConditionChildren(index: DocumentIndex, node: NodeProjection): NodeProjection[] {
  return node.children
    .map((childId) => index.byId.get(childId))
    .filter((child): child is NodeProjection => child?.type === 'queryCondition');
}

function formatLogicGroup(logic: QueryLogic, chips: SearchQuerySummaryChip[]): string {
  if (chips.length === 0) return `${logic} empty`;
  const separator = logic === 'OR' ? ' or ' : logic === 'NOT' ? ' and ' : ' and ';
  return `${logic} ${chips.map((chip) => chip.label).join(separator)}`;
}

function chipIcon(kind: SearchQueryChipKind): AppIcon {
  switch (kind) {
    case 'field':
      return FieldIcon;
    case 'logic':
      return FilterIcon;
    case 'reference':
      return ReferenceIcon;
    case 'tag':
      return HashIcon;
    case 'text':
      return SearchIcon;
  }
}

function nodeTitle(index: DocumentIndex, nodeId: NodeId): string {
  return index.byId.get(nodeId)?.content.text.trim() || 'Untitled';
}

function tagName(index: DocumentIndex, tagId: NodeId): string {
  const title = nodeTitle(index, tagId);
  return title.startsWith('#') ? title : `#${title}`;
}

function simpleOpLabel(op: QueryOp): string {
  return op.toLowerCase().replaceAll('_', ' ');
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
