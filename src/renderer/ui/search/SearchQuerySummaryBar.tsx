import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import type { Messages } from '../../../core/i18n';
import { SEARCH_QUERY_COMPLEXITY_LIMITS } from '../../../core/searchQueryCompiler';
import { api } from '../../api/client';
import { inlineRefNodeId, type NodeId, type NodeProjection, type QueryLogic, type QueryOp } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import {
  CloseIcon,
  FieldIcon,
  FilterIcon,
  HashIcon,
  ReferenceIcon,
  RefreshIcon,
  SearchIcon,
  ShowToolbarIcon,
  type AppIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { IconButton } from '../primitives/IconButton';
import { Textarea } from '../primitives/Textarea';
import type { CommandRunner } from '../shared';

type SearchQueryChipKind = 'field' | 'logic' | 'reference' | 'tag' | 'text';

export interface SearchQuerySummaryChip {
  kind: SearchQueryChipKind;
  label: string;
}

export interface SearchQuerySummaryModel {
  chips: SearchQuerySummaryChip[];
  resultCount: number;
  truncated: boolean;
}

interface SearchQuerySummaryBarProps {
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
}

interface SearchQueryBuilderPanelProps extends SearchQuerySummaryBarProps {
  onClose: () => void;
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

const SEARCH_QUERY_SUMMARY_MAX_CHIPS = 64;

export function SearchQueryBuilderPanel({ index, nodeId, run, onClose }: SearchQueryBuilderPanelProps) {
  const t = useT();
  const builder = t.search.builder;
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const searchNode = index.byId.get(nodeId);
  const readOnly = Boolean(searchNode?.locked);
  const initialText = useMemo(() => searchQueryOutlineText(index, nodeId, t), [index, nodeId, t]);
  const model = useMemo(() => searchQuerySummaryModel(index, nodeId, t), [index, nodeId, t]);
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
          {model && (
            <span className="search-query-builder-count">
              {t.search.resultCount({ count: model.resultCount })}
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

export function searchQuerySummaryModel(index: DocumentIndex, nodeId: NodeId, t: Messages): SearchQuerySummaryModel | null {
  const searchNode = index.byId.get(nodeId);
  if (!searchNode || searchNode.type !== 'search') return null;

  const queryRoots = directConditionChildren(index, searchNode);
  const chipSummary = conditionChips(index, queryRoots.children.length > 0 ? queryRoots.children : [searchNode], t);
  const truncated = chipSummary.truncated || queryRoots.truncated;

  return {
    chips: truncated
      ? [...chipSummary.chips, { kind: 'logic', label: t.search.summary.truncated }]
      : chipSummary.chips,
    resultCount: searchNode.children.filter((childId) => {
      const child = index.byId.get(childId);
      return child?.type === 'reference' && Boolean(child.targetId);
    }).length,
    truncated,
  };
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

export function SearchQuerySummaryBar({ index, nodeId, run }: SearchQuerySummaryBarProps) {
  const t = useT();
  const summary = t.search.summary;
  const [refreshing, setRefreshing] = useState(false);
  const model = useMemo(() => searchQuerySummaryModel(index, nodeId, t), [index, nodeId, t]);

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

  const showViewToolbar = async () => {
    await run(() => api.setViewToolbarVisible(nodeId, true), { applyFocus: false });
  };

  return (
    <div className="search-query-summary-bar">
      <div className="search-query-summary-main">
        <div className="search-query-chip-list" aria-label={summary.rulesAriaLabel}>
          {model.chips.length > 0 ? model.chips.map((chip, index) => (
            <SearchQueryChip key={`${chip.kind}:${chip.label}:${index}`} chip={chip} />
          )) : (
            <span className="search-query-empty">{summary.noRules}</span>
          )}
        </div>
        <span className="search-query-result-count">
          {t.search.resultCount({ count: model.resultCount })}
        </span>
      </div>
      <div className="search-query-summary-actions">
        <IconButton
          className="search-query-toolbar-button"
          icon={ShowToolbarIcon}
          label={summary.viewLabel}
          onClick={() => void showViewToolbar()}
          title={summary.viewTitle}
          variant="toolbar"
        />
        <IconButton
          className={`search-query-toolbar-button search-query-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
          disabled={refreshing}
          icon={RefreshIcon}
          label={summary.refreshLabel}
          onClick={() => void refresh()}
          title={summary.refreshTitle}
          variant="toolbar"
        />
      </div>
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

function conditionChips(index: DocumentIndex, roots: QueryBearingProjection[], t: Messages): {
  chips: SearchQuerySummaryChip[];
  truncated: boolean;
} {
  type Frame = { condition: QueryBearingProjection; depth: number; exiting: boolean };

  const chipsById = new Map<NodeId, SearchQuerySummaryChip[]>();
  const childrenById = new Map<NodeId, QueryBearingProjection[]>();
  const active = new Set<NodeId>();
  const stack: Frame[] = [];
  let nodeCount = 0;
  let truncated = false;

  for (let rootIndex = roots.length - 1; rootIndex >= 0; rootIndex -= 1) {
    stack.push({ condition: roots[rootIndex]!, depth: 0, exiting: false });
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const condition = frame.condition;

    if (frame.exiting) {
      active.delete(condition.id);
      if (condition.queryLogic) {
        const childChips = (childrenById.get(condition.id) ?? [])
          .flatMap((child) => chipsById.get(child.id) ?? []);
        if (childChips.length > SEARCH_QUERY_SUMMARY_MAX_CHIPS) truncated = true;
        const chips = frame.depth === 0 && condition.queryLogic === 'AND'
          ? childChips
          : [{ kind: 'logic' as const, label: formatLogicGroup(condition.queryLogic, childChips, t) }];
        chipsById.set(condition.id, chips.slice(0, SEARCH_QUERY_SUMMARY_MAX_CHIPS));
      } else if (condition.queryOp) {
        chipsById.set(condition.id, [ruleChip(index, condition, condition.queryOp, t)]);
      } else {
        chipsById.set(condition.id, []);
      }
      continue;
    }

    if (chipsById.has(condition.id)) continue;
    if (active.has(condition.id)) {
      truncated = true;
      chipsById.set(condition.id, []);
      continue;
    }
    if (frame.depth > SEARCH_QUERY_COMPLEXITY_LIMITS.maxDepth || nodeCount >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxNodes) {
      truncated = true;
      chipsById.set(condition.id, []);
      continue;
    }
    nodeCount += 1;
    active.add(condition.id);
    stack.push({ ...frame, exiting: true });

    if (!condition.queryLogic) continue;
    const childResult = directConditionChildren(index, condition);
    if (childResult.truncated) truncated = true;
    childrenById.set(condition.id, childResult.children);
    for (let childIndex = childResult.children.length - 1; childIndex >= 0; childIndex -= 1) {
      const child = childResult.children[childIndex]!;
      if (!chipsById.has(child.id)) stack.push({ condition: child, depth: frame.depth + 1, exiting: false });
    }
  }

  const chips: SearchQuerySummaryChip[] = [];
  for (const root of roots) {
    for (const chip of chipsById.get(root.id) ?? []) {
      if (chips.length >= SEARCH_QUERY_SUMMARY_MAX_CHIPS) {
        truncated = true;
        break;
      }
      chips.push(chip);
    }
  }
  return { chips, truncated };
}

function ruleChip(index: DocumentIndex, condition: QueryBearingProjection, op: QueryOp, t: Messages): SearchQuerySummaryChip {
  const rules = t.search.rules;
  if (op === 'HAS_TAG') {
    return {
      kind: 'tag',
      label: condition.queryTagDefId ? tagName(index, condition.queryTagDefId, t) : rules.hasTag,
    };
  }

  if (FIELD_VALUE_OPS.has(op) || FIELD_STATE_OPS.has(op)) {
    return {
      kind: 'field',
      label: fieldRuleLabel(index, condition, op, t),
    };
  }

  if (TARGET_OPS.has(op)) {
    return {
      kind: 'reference',
      label: targetRuleLabel(index, condition, op, t),
    };
  }

  if (TEXT_OPS.has(op)) {
    return {
      kind: 'text',
      label: textRuleLabel(index, condition, op, t),
    };
  }

  return {
    kind: 'text',
    label: simpleOpLabel(op),
  };
}

function fieldRuleLabel(index: DocumentIndex, condition: QueryBearingProjection, op: QueryOp, t: Messages): string {
  const rules = t.search.rules;
  const field = condition.queryFieldDefId ? nodeTitle(index, condition.queryFieldDefId, t) : rules.fieldFallback;
  const values = valueLabels(index, condition, t);
  const value = values.join(', ');

  switch (op) {
    // Operator-symbol rules keep their math symbols (not localizable).
    case 'FIELD_IS':
      return value ? `${field} = ${value}` : `${field} =`;
    case 'FIELD_IS_NOT':
      return value ? `${field} != ${value}` : `${field} !=`;
    case 'FIELD_CONTAINS':
      return value ? rules.contains({ field, value }) : rules.containsBare({ field });
    case 'LT':
      return value ? `${field} < ${value}` : `${field} <`;
    case 'GT':
      return value ? `${field} > ${value}` : `${field} >`;
    case 'DATE_OVERLAPS':
      return value ? rules.overlaps({ field, value }) : rules.overlapsBare({ field });
    case 'IS_EMPTY':
      return rules.isEmpty({ field });
    case 'IS_NOT_EMPTY':
      return rules.isNotEmpty({ field });
    case 'HAS_FIELD':
      return condition.queryFieldDefId ? rules.hasField({ field }) : rules.hasFieldBare;
    case 'OVERDUE':
      return condition.queryFieldDefId ? rules.overdue({ field }) : rules.overdueBare;
    case 'FIELD_IS_SET':
      return rules.isSet({ field });
    case 'FIELD_IS_NOT_SET':
      return rules.isNotSet({ field });
    case 'FIELD_IS_DEFINED':
      return rules.isDefined({ field });
    case 'FIELD_IS_NOT_DEFINED':
      return rules.isNotDefined({ field });
    default:
      return `${field} ${simpleOpLabel(op)}`;
  }
}

function targetRuleLabel(index: DocumentIndex, condition: QueryBearingProjection, op: QueryOp, t: Messages): string {
  const rules = t.search.rules;
  const target = condition.queryTargetId
    ? nodeTitle(index, condition.queryTargetId, t)
    : valueLabels(index, condition, t)[0] ?? rules.targetFallback;
  switch (op) {
    case 'LINKS_TO':
      return rules.linksTo({ target });
    case 'CHILD_OF':
      return rules.childOf({ target });
    case 'OWNED_BY':
      return rules.ownedBy({ target });
    case 'DESCENDANT_OF':
      return rules.descendantOf({ target });
    case 'DESCENDANT_OF_WITH_REFS':
      return rules.descendantOfWithRefs({ target });
    default:
      return `${simpleOpLabel(op)} ${target}`;
  }
}

function textRuleLabel(index: DocumentIndex, condition: QueryBearingProjection, op: QueryOp, t: Messages): string {
  const rules = t.search.rules;
  const values = valueLabels(index, condition, t);
  const value = values.join(', ');
  switch (op) {
    case 'STRING_MATCH':
      return value ? `"${value}"` : rules.text;
    case 'REGEXP_MATCH':
      return value ? `/${value}/` : rules.regexp;
    case 'IS_TYPE':
      return value ? rules.typeEq({ value }) : rules.typeBare;
    case 'FOR_DATE':
      return value ? rules.dateEq({ value }) : rules.dateBare;
    case 'FOR_RELATIVE_DATE':
      return value ? rules.dateEq({ value }) : rules.relativeDateBare;
    case 'SIBLING_NAMED':
      return value ? rules.siblingNamed({ value }) : rules.siblingNamedBare;
    case 'CREATED_LAST_DAYS':
      return value ? rules.createdInDays({ value }) : rules.createdRecently;
    case 'EDITED_LAST_DAYS':
      return value ? rules.editedInDays({ value }) : rules.editedRecently;
    case 'DONE_LAST_DAYS':
      return value ? rules.doneInDays({ value }) : rules.doneRecently;
    default:
      return value ? `${simpleOpLabel(op)} ${value}` : simpleOpLabel(op);
  }
}

function valueLabels(index: DocumentIndex, condition: QueryBearingProjection, t: Messages): string[] {
  const labels: string[] = [];
  for (const childId of condition.children) {
    if (labels.length >= SEARCH_QUERY_COMPLEXITY_LIMITS.maxOperandsPerRule) break;
    const child = index.byId.get(childId);
    if (!child || child.type === 'queryCondition') continue;
    const label = operandLabel(index, child, t);
    if (label) labels.push(label);
  }
  if (labels.length > 0) return uniqueLabels(labels);
  const text = condition.content.text.trim();
  return text ? [text] : [];
}

function operandLabel(index: DocumentIndex, node: NodeProjection, t: Messages): string {
  if (node.type === 'reference' && node.targetId) return nodeTitle(index, node.targetId, t);
  const inlineRef = node.content.inlineRefs[0];
  const inlineNodeId = inlineRef ? inlineRefNodeId(inlineRef) : null;
  if (inlineNodeId) return inlineRef?.displayName || nodeTitle(index, inlineNodeId, t);
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

function formatLogicGroup(logic: QueryLogic, chips: SearchQuerySummaryChip[], t: Messages): string {
  const rules = t.search.rules;
  if (chips.length === 0) return rules.logicEmpty({ logic });
  const separator = logic === 'OR' ? rules.connectorOr : rules.connectorAnd;
  return rules.logicGroup({ logic, body: chips.map((chip) => chip.label).join(separator) });
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
