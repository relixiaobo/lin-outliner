import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { formatNodeReferenceMarker } from '../../../core/referenceMarkup';
import type { Messages } from '../../../core/i18n';
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
  const chips = queryRoots.length > 0
    ? queryRoots.flatMap((condition) => conditionChips(index, condition, 0, t))
    : conditionChips(index, searchNode, 0, t);

  return {
    chips,
    resultCount: searchNode.children.filter((childId) => {
      const child = index.byId.get(childId);
      return child?.type === 'reference' && Boolean(child.targetId);
    }).length,
  };
}

export function searchQueryOutlineText(index: DocumentIndex, nodeId: NodeId, t: Messages): string {
  const searchNode = index.byId.get(nodeId);
  if (!searchNode || searchNode.type !== 'search') return '';

  const queryRoots = directConditionChildren(index, searchNode);
  const roots = queryRoots.length > 0
    ? queryRoots
    : searchNode.queryLogic || searchNode.queryOp ? [searchNode] : [];
  return roots.flatMap((condition) => conditionOutlineLines(index, condition, 0, t)).join('\n');
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
      <IconButton
        className={`search-query-refresh-button ${refreshing ? 'is-refreshing' : ''}`}
        disabled={refreshing}
        icon={RefreshIcon}
        label={summary.refreshLabel}
        onClick={() => void refresh()}
        title={summary.refreshTitle}
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

function conditionOutlineLines(index: DocumentIndex, condition: QueryBearingProjection, level: number, t: Messages): string[] {
  const indent = '  '.repeat(level);
  if (condition.queryLogic) {
    return [
      `${indent}- ${condition.queryLogic}`,
      ...directConditionChildren(index, condition).flatMap((child) => conditionOutlineLines(index, child, level + 1, t)),
    ];
  }

  if (!condition.queryOp) return [];
  const lines = [`${indent}- ${condition.queryOp}`];
  if (condition.queryFieldDefId) lines.push(`${indent}  - field:: ${nodeReference(index, condition.queryFieldDefId, t)}`);
  if (condition.queryTagDefId) lines.push(`${indent}  - tag:: ${nodeReference(index, condition.queryTagDefId, t, tagName(index, condition.queryTagDefId, t))}`);
  if (condition.queryTargetId) lines.push(`${indent}  - target:: ${nodeReference(index, condition.queryTargetId, t)}`);
  for (const operand of operandOutlineTexts(index, condition, t)) {
    lines.push(`${indent}  - value:: ${operand}`);
  }
  return lines;
}

function operandOutlineTexts(index: DocumentIndex, condition: QueryBearingProjection, t: Messages): string[] {
  const operands = condition.children.flatMap((childId): string[] => {
    const child = index.byId.get(childId);
    if (!child || child.type === 'queryCondition') return [];
    const text = operandOutlineText(index, child, t);
    return text ? [text] : [];
  });
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

function conditionChips(index: DocumentIndex, condition: QueryBearingProjection, depth: number, t: Messages): SearchQuerySummaryChip[] {
  if (condition.queryLogic) {
    const childChips = directConditionChildren(index, condition)
      .flatMap((child) => conditionChips(index, child, depth + 1, t));
    if (depth === 0 && condition.queryLogic === 'AND') return childChips;
    return [{
      kind: 'logic',
      label: formatLogicGroup(condition.queryLogic, childChips, t),
    }];
  }

  if (!condition.queryOp) return [];
  return [ruleChip(index, condition, condition.queryOp, t)];
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
  const labels = condition.children.flatMap((childId): string[] => {
    const child = index.byId.get(childId);
    if (!child || child.type === 'queryCondition') return [];
    const label = operandLabel(index, child, t);
    return label ? [label] : [];
  });
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

function directConditionChildren(index: DocumentIndex, node: NodeProjection): QueryBearingProjection[] {
  return node.children
    .map((childId) => index.byId.get(childId))
    .filter((child): child is QueryBearingProjection => child?.type === 'queryCondition');
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
