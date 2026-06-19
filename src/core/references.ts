import { refRoleCountsAsBacklink } from './configSchema';
import {
  inlineRefNodeId,
  type NodeId,
  type NodeType,
  type RefRole,
  type RichText,
} from './types';

export type ReferenceSourceKind = 'tree' | 'inline' | 'field' | 'unlinked';
export type ReferenceMentionField = 'content' | 'description';

export interface ReferenceMentionRange {
  field: ReferenceMentionField;
  start: number;
  end: number;
  text: string;
}

export interface ReferenceSource {
  targetId: NodeId;
  sourceNodeId: NodeId;
  referenceNodeId: NodeId;
  kind: ReferenceSourceKind;
  fieldEntryId?: NodeId;
  fieldDefId?: NodeId;
  inlineDisplayName?: string;
  mention?: ReferenceMentionRange;
}

export interface ReferenceCounts {
  linked: number;
  unlinked: number;
  total: number;
}

export interface ReferenceSummary {
  byTarget: ReadonlyMap<NodeId, readonly ReferenceSource[]>;
  countsByTarget: ReadonlyMap<NodeId, ReferenceCounts>;
}

export interface ReferenceNodeLike {
  id: NodeId;
  type?: NodeType;
  parentId?: NodeId | null;
  children: readonly NodeId[];
  content: RichText;
  description?: string;
  targetId?: NodeId;
  fieldDefId?: NodeId;
  refRole?: RefRole;
}

export interface ReferenceSummaryOptions {
  includeUnlinked?: boolean;
  includeDescriptions?: boolean;
  mentionTargetIds?: readonly NodeId[];
  isDeleted?: (nodeId: NodeId) => boolean;
  minMentionLength?: number;
}

const MIN_MENTION_LENGTH = 3;
const NON_MENTION_NODE_TYPES = new Set<NodeType>([
  'fieldEntry',
  'reference',
  'defConfig',
  'systemOption',
  'viewDef',
  'sortRule',
  'filterRule',
  'displayField',
  'queryCondition',
]);

interface MentionTarget {
  nodeId: NodeId;
  text: string;
  lowerText: string;
}

export function buildReferenceSummary(
  byId: ReadonlyMap<NodeId, ReferenceNodeLike>,
  options: ReferenceSummaryOptions = {},
): ReferenceSummary {
  const byTarget = new Map<NodeId, ReferenceSource[]>();
  const isDeleted = options.isDeleted ?? (() => false);

  for (const node of byId.values()) {
    if (isDeleted(node.id)) continue;
    if (node.type === 'reference' && node.targetId && refRoleCountsAsBacklink(node)) {
      const source = referenceSourceForNode(byId, node);
      if (!source) continue;
      addReferenceSource(byTarget, {
        targetId: node.targetId,
        sourceNodeId: source.sourceNodeId,
        referenceNodeId: node.id,
        kind: source.kind,
        fieldEntryId: source.fieldEntryId,
        fieldDefId: source.fieldDefId,
      });
    }

    for (const inlineRef of node.content.inlineRefs) {
      const targetId = inlineRefNodeId(inlineRef);
      if (!targetId) continue;
      addReferenceSource(byTarget, {
        targetId,
        sourceNodeId: node.id,
        referenceNodeId: node.id,
        kind: 'inline',
        inlineDisplayName: inlineRef.displayName,
      });
    }
  }

  if (options.includeUnlinked) {
    addUnlinkedMentions(byId, byTarget, isDeleted, options);
  }

  return {
    byTarget,
    countsByTarget: buildCountsByTarget(byTarget),
  };
}

export function referencesForTarget(
  byId: ReadonlyMap<NodeId, ReferenceNodeLike>,
  targetId: NodeId,
  options: ReferenceSummaryOptions = {},
): readonly ReferenceSource[] {
  return buildReferenceSummary(byId, options).byTarget.get(targetId) ?? [];
}

function referenceSourceForNode(
  byId: ReadonlyMap<NodeId, ReferenceNodeLike>,
  reference: ReferenceNodeLike,
): Pick<ReferenceSource, 'sourceNodeId' | 'kind' | 'fieldEntryId' | 'fieldDefId'> | null {
  const parent = reference.parentId ? byId.get(reference.parentId) : undefined;
  if (!parent) return null;
  if (parent?.type === 'fieldEntry') {
    return {
      sourceNodeId: parent.parentId ?? parent.id,
      kind: 'field',
      fieldEntryId: parent.id,
      fieldDefId: parent.fieldDefId,
    };
  }
  return {
    sourceNodeId: parent?.id ?? reference.id,
    kind: 'tree',
  };
}

function addReferenceSource(
  byTarget: Map<NodeId, ReferenceSource[]>,
  source: ReferenceSource,
): void {
  const existing = byTarget.get(source.targetId);
  if (existing) {
    existing.push(source);
    return;
  }
  byTarget.set(source.targetId, [source]);
}

function buildCountsByTarget(byTarget: ReadonlyMap<NodeId, readonly ReferenceSource[]>): Map<NodeId, ReferenceCounts> {
  const counts = new Map<NodeId, ReferenceCounts>();
  for (const [targetId, sources] of byTarget) {
    const linked = new Set<string>();
    const unlinked = new Set<string>();
    for (const source of sources) {
      if (source.kind === 'unlinked') {
        unlinked.add(referenceCountKey(source));
      } else {
        linked.add(referenceCountKey(source));
      }
    }
    counts.set(targetId, { linked: linked.size, unlinked: unlinked.size, total: linked.size + unlinked.size });
  }
  return counts;
}

function referenceCountKey(source: ReferenceSource): string {
  if (source.kind === 'unlinked') {
    const mention = source.mention;
    return `${source.kind}:${source.sourceNodeId}:${mention?.field ?? ''}:${mention?.start ?? ''}:${mention?.end ?? ''}`;
  }
  return `linked:${source.sourceNodeId}`;
}

function addUnlinkedMentions(
  byId: ReadonlyMap<NodeId, ReferenceNodeLike>,
  byTarget: Map<NodeId, ReferenceSource[]>,
  isDeleted: (nodeId: NodeId) => boolean,
  options: ReferenceSummaryOptions,
): void {
  const targetTitles = mentionTargetTitles(
    byId,
    isDeleted,
    options.minMentionLength ?? MIN_MENTION_LENGTH,
    options.mentionTargetIds,
  );
  if (targetTitles.length === 0) return;
  const targetsByFirstChar = mentionTargetsByFirstChar(targetTitles);

  const scanDescriptions = options.includeDescriptions ?? true;
  for (const source of byId.values()) {
    if (!nodeCanSourceUnlinkedMention(source, isDeleted)) continue;
    addUnlinkedMentionsFromText(
      byTarget,
      source,
      targetsByFirstChar,
      'content',
      source.content.text,
    );
    if (scanDescriptions && source.description) {
      addUnlinkedMentionsFromText(
        byTarget,
        source,
        targetsByFirstChar,
        'description',
        source.description,
      );
    }
  }
}

function mentionTargetTitles(
  byId: ReadonlyMap<NodeId, ReferenceNodeLike>,
  isDeleted: (nodeId: NodeId) => boolean,
  minMentionLength: number,
  mentionTargetIds?: readonly NodeId[],
): MentionTarget[] {
  const targets: MentionTarget[] = [];
  const seenTitlesByNode = new Set<string>();
  const allowedTargetIds = mentionTargetIds ? new Set(mentionTargetIds) : null;
  for (const node of byId.values()) {
    if (allowedTargetIds && !allowedTargetIds.has(node.id)) continue;
    if (isDeleted(node.id) || !nodeCanBeMentionTarget(node)) continue;
    const text = node.content.text.trim();
    if (text.length < minMentionLength) continue;
    const lowerText = caseFold(text);
    const key = `${node.id}\u0000${lowerText}`;
    if (seenTitlesByNode.has(key)) continue;
    seenTitlesByNode.add(key);
    targets.push({ nodeId: node.id, text, lowerText });
  }
  targets.sort((a, b) => b.text.length - a.text.length || a.text.localeCompare(b.text));
  return targets;
}

function mentionTargetsByFirstChar(targets: readonly MentionTarget[]): ReadonlyMap<string, readonly MentionTarget[]> {
  const byFirstChar = new Map<string, MentionTarget[]>();
  for (const target of targets) {
    const key = firstCaseFoldedChar(target.text);
    if (!key) continue;
    const bucket = byFirstChar.get(key);
    if (bucket) {
      bucket.push(target);
      continue;
    }
    byFirstChar.set(key, [target]);
  }
  return byFirstChar;
}

function nodeCanBeMentionTarget(node: ReferenceNodeLike): boolean {
  return node.type !== 'reference' && node.type !== 'fieldEntry' && node.type !== 'defConfig' && node.type !== 'systemOption';
}

function nodeCanSourceUnlinkedMention(node: ReferenceNodeLike, isDeleted: (nodeId: NodeId) => boolean): boolean {
  if (isDeleted(node.id)) return false;
  if (node.type && NON_MENTION_NODE_TYPES.has(node.type)) return false;
  return true;
}

function addUnlinkedMentionsFromText(
  byTarget: Map<NodeId, ReferenceSource[]>,
  source: ReferenceNodeLike,
  targetsByFirstChar: ReadonlyMap<string, readonly MentionTarget[]>,
  field: ReferenceMentionField,
  text: string,
): void {
  if (!text) return;
  for (let start = 0; start < text.length; start += 1) {
    const candidates = targetsByFirstChar.get(firstCaseFoldedChar(text[start] ?? ''));
    if (!candidates) continue;
    for (const target of candidates) {
      if (source.id === target.nodeId) continue;
      const end = start + target.text.length;
      if (end > text.length) continue;
      const matchedText = text.slice(start, end);
      if (caseFold(matchedText) !== target.lowerText) continue;
      if (!hasMentionBoundary(text, start, end)) continue;
      if (field === 'content' && hasInlineRefAtOffset(source, target.nodeId, start)) continue;
      addReferenceSource(byTarget, {
        targetId: target.nodeId,
        sourceNodeId: source.id,
        referenceNodeId: source.id,
        kind: 'unlinked',
        mention: {
          field,
          start,
          end,
          text: matchedText || target.text,
        },
      });
    }
  }
}

function hasInlineRefAtOffset(source: ReferenceNodeLike, targetId: NodeId, offset: number): boolean {
  return source.content.inlineRefs.some((inlineRef) =>
    inlineRef.offset === offset && inlineRefNodeId(inlineRef) === targetId);
}

function hasMentionBoundary(text: string, start: number, end: number): boolean {
  const first = text[start];
  const last = text[end - 1];
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return (!isMentionWord(first) || !isMentionWord(before)) && (!isMentionWord(last) || !isMentionWord(after));
}

function isMentionWord(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function caseFold(value: string): string {
  return value.toLocaleLowerCase();
}

function firstCaseFoldedChar(value: string): string {
  return caseFold(value).slice(0, 1);
}
