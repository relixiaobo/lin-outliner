#!/usr/bin/env bun
import path from 'node:path';
import {
  computeStats,
  coverageFromEntries,
  extractInlineTags,
  htmlToText,
  isValidIsoLocalDate,
  summarizeWarnings,
  type CoverageEntry,
  type ImportNode,
  type ImportOptions,
  type NormalizedImport,
  type ImportSection,
  type ImportWarning,
} from '../../../../outline/import/normalized';

interface TanaDoc {
  id: string;
  props?: Record<string, unknown>;
  children?: string[];
}

interface TanaConvertContext {
  byId: Map<string, TanaDoc>;
  children: Map<string, TanaDoc[]>;
  entries: CoverageEntry[];
  visited: Set<string>;
  trashRoots: Set<string>;
  systemRoots: Set<string>;
  includeTrash: boolean;
  options: ImportOptions;
}

interface TanaTupleField {
  tuple: TanaDoc;
  name: string;
  values: string[];
  consumedIds: string[];
}

const IMPORTABLE_TYPES = new Set(['', 'journal', 'home', 'journalPart', 'codeblock']);
const UNSUPPORTED_TYPES = new Set([
  'metanode',
  'tuple',
  'associatedData',
  'attrDef',
  'viewDef',
  'visual',
  'search',
  'workspace',
  'command',
  'systemTool',
  'syntax',
  'url',
  'chat',
  'chatbot',
  'placeholder',
  'settings',
  'tagDef',
]);
const EXCLUDED_ROOT_NAMES = new Set([
  'schema',
  'deleted nodes',
  'users',
  'avatar',
  'moveTo list'.toLowerCase(),
  'searches',
  'private drafts',
  'pins',
  'list of layouts',
  'list of sidebar areas',
  'quick add',
  'trailing sidebar container',
]);

let importCoverageEntries: CoverageEntry[] = [];

export function lastTanaCoverageEntries(): CoverageEntry[] {
  return importCoverageEntries;
}

export async function normalizeTanaExport(
  raw: unknown,
  config: {
    source: string;
    coverageOut: string;
    includeTrash: boolean;
    options: ImportOptions;
  },
): Promise<NormalizedImport> {
  const data = raw && typeof raw === 'object' ? raw as { docs?: unknown; currentWorkspaceId?: unknown } : {};
  if (!Array.isArray(data.docs)) throw new Error('Tana export must contain docs[].');
  const docs = data.docs.filter(isTanaDoc);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const children = new Map<string, TanaDoc[]>();
  for (const doc of docs) {
    const owner = ownerId(doc);
    if (!owner) continue;
    const list = children.get(owner) ?? [];
    list.push(doc);
    children.set(owner, list);
  }
  for (const [ownerId, list] of children) {
    const sourceOrder = new Map((byId.get(ownerId)?.children ?? []).map((childId, index) => [childId, index]));
    list.sort((left, right) => {
      const leftIndex = sourceOrder.get(left.id);
      const rightIndex = sourceOrder.get(right.id);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
      }
      return createdAt(left) - createdAt(right) || left.id.localeCompare(right.id);
    });
  }

  const currentWorkspaceId = typeof data.currentWorkspaceId === 'string' && byId.has(data.currentWorkspaceId)
    ? data.currentWorkspaceId
    : undefined;
  const rootId = currentWorkspaceId && (children.get(currentWorkspaceId)?.length ?? 0) > 0
    ? currentWorkspaceId
    : docs.find((doc) => doc.id && !ownerId(doc) && nameOf(doc).includes('Root node for file'))?.id
      ?? docs.find((doc) => !ownerId(doc))?.id;
  if (!rootId) throw new Error('Could not find Tana root node.');

  const entries: CoverageEntry[] = [];
  const visited = new Set<string>();
  const trashRoots = new Set(docs
    .filter((doc) => doc.id.endsWith('_TRASH') || nameOf(doc).toLowerCase() === 'deleted nodes')
    .map((doc) => doc.id));
  const systemRoots = new Set(docs
    .filter((doc) => doc.id.startsWith('SYS') || nameOf(doc).toLowerCase() === 'system nodes')
    .map((doc) => doc.id));
  const workspaceInternalRoots = new Set(docs
    .filter((doc) => isExcludedWorkspaceRootName(nameOf(doc)))
    .map((doc) => doc.id));

  const context: TanaConvertContext = {
    byId,
    children,
    entries,
    visited,
    trashRoots,
    systemRoots,
    includeTrash: config.includeTrash,
    options: config.options,
  };
  const dateSections = new Map<string, ImportSection>();
  const invalidJournalParts: TanaDoc[] = [];
  for (const doc of docs) {
    if (docTypeOf(doc) !== 'journalPart') continue;
    if (isInOwnedSet(doc, byId, systemRoots)) continue;
    if (isInOwnedSet(doc, byId, workspaceInternalRoots)) continue;
    if (!config.includeTrash && isInOwnedSet(doc, byId, trashRoots)) continue;
    const date = journalLocalDate(doc);
    if (!date) {
      invalidJournalParts.push(doc);
      continue;
    }
    visited.add(doc.id);
    entries.push({
      sourceId: doc.id,
      status: 'merged',
      reason: 'journal_date_container',
      target: `date:${date}`,
    });
    const nodes = (children.get(doc.id) ?? [])
      .filter((child) => docTypeOf(child) !== 'journalPart')
      .map((child) => convertDoc(child, context))
      .filter((child): child is ImportNode => Boolean(child));
    const existing = dateSections.get(date);
    if (existing) {
      existing.nodes.push(...nodes);
    } else {
      dateSections.set(date, {
        id: `tana-journal:${doc.id}`,
        title: date,
        kind: 'date',
        date,
        nodes,
      });
    }
  }

  const sectionNodes: ImportNode[] = [];
  for (const child of children.get(rootId) ?? []) {
    if (shouldDropRoot(child, trashRoots, systemRoots, config.includeTrash)) {
      markSubtree(child, children, entries, visited, dropReason(child, trashRoots, systemRoots, config.includeTrash));
      continue;
    }
    const converted = convertDoc(child, context);
    if (converted) sectionNodes.push(converted);
  }

  for (const doc of docs) {
    if (visited.has(doc.id)) continue;
    if (!isImportableDoc(doc)) {
      markSubtree(doc, children, entries, visited, unsupportedReason(doc), unsupportedStatus(doc));
      continue;
    }
    const converted = convertDoc(doc, context);
    if (converted) sectionNodes.push(converted);
  }

  const sections: ImportSection[] = [
    ...dateSections.values(),
    ...(sectionNodes.length > 0 || dateSections.size === 0 ? [{
      id: 'tana-workspace',
      title: 'Tana Workspace',
      kind: 'library' as const,
      nodes: sectionNodes,
    }] : []),
  ];
  const coverage = coverageFromEntries(entries, path.resolve(config.coverageOut));
  importCoverageEntries = entries;
  const pack: NormalizedImport = {
    version: 1,
    source: {
      kind: 'tana',
      path: path.resolve(config.source),
      sourceId: String(data.currentWorkspaceId ?? rootId),
    },
    options: {
      ...config.options,
      dateGrouping: dateSections.size > 0 ? 'native_daily' : 'stage_headings',
    },
    stats: {
      sourceRecords: 0,
      sections: 0,
      nodes: 0,
      descriptions: 0,
      tags: 0,
      fields: 0,
      checked: 0,
      dropped: 0,
    },
    coverage,
    warnings: [
      ...summarizeWarnings(entries),
      ...invalidJournalWarnings(invalidJournalParts),
    ],
    sections,
  };
  pack.stats = computeStats(pack);
  return pack;
}

function invalidJournalWarnings(docs: readonly TanaDoc[]): ImportWarning[] {
  if (docs.length === 0) return [];
  return [{
    code: 'invalid_journal_date',
    message: `${docs.length} journalPart record(s) did not have a deterministic local-date title and remained in the Tana Workspace section.`,
    count: docs.length,
  }];
}

function convertDoc(
  doc: TanaDoc,
  context: TanaConvertContext,
): ImportNode | null {
  if (context.visited.has(doc.id)) return null;
  if (isInOwnedSet(doc, context.byId, context.systemRoots)) {
    markSubtree(doc, context.children, context.entries, context.visited, 'system_node');
    return null;
  }
  if (!context.includeTrash && isInOwnedSet(doc, context.byId, context.trashRoots)) {
    markSubtree(doc, context.children, context.entries, context.visited, 'trash_node');
    return null;
  }
  if (!isImportableDoc(doc)) {
    markSubtree(doc, context.children, context.entries, context.visited, unsupportedReason(doc), unsupportedStatus(doc));
    return null;
  }
  context.visited.add(doc.id);

  const title = htmlToText(doc.props?.name);
  const description = htmlToText(doc.props?.description);
  const metadataTags = context.options.tags ? collectMetadataSupertags(doc, context) : [];
  const tupleFields = collectTupleFields(doc, context);
  const mergedFields = mergeTupleFields(tupleFields);
  const consumedFieldIds = new Set(tupleFields.flatMap((field) => [field.tuple.id, ...field.consumedIds]));
  const childNodes = (context.children.get(doc.id) ?? [])
    .filter((child) => !consumedFieldIds.has(child.id))
    .map((child) => convertDoc(child, context))
    .filter((child): child is ImportNode => Boolean(child));
  if (context.options.fields === 'text_children') {
    childNodes.unshift(...tupleFields.map((field): ImportNode => ({
      title: `${field.name}: ${field.values.join(', ')}`,
      sourceId: field.tuple.id,
    })));
  }
  if (!title && !description && childNodes.length === 0 && tupleFields.length === 0) {
    context.entries.push({ sourceId: doc.id, status: 'empty', reason: 'empty_node' });
    return null;
  }

  const docType = docTypeOf(doc);
  const tagExtraction = context.options.tags ? extractInlineTags(title) : { title, tags: [] };
  const tags = uniqueNames([...tagExtraction.tags, ...metadataTags]);
  const codeText = docType === 'codeblock' ? title || description : '';
  const node: ImportNode = {
    title: tagExtraction.title || description.slice(0, 80) || '(untitled)',
    ...(description ? { description } : {}),
    ...(tags.length ? { tags } : {}),
    ...(context.options.doneState && doc.props?._done ? { checked: true } : {}),
    ...(codeText ? { code: { text: codeText, language: undefined } } : {}),
    ...(context.options.fields === 'field_rows' && mergedFields.length ? { fields: mergedFields } : {}),
    ...(childNodes.length ? { children: childNodes } : {}),
    sourceId: doc.id,
  };
  context.entries.push({ sourceId: doc.id, status: 'imported', target: doc.id });
  return node;
}

function collectMetadataSupertags(doc: TanaDoc, context: TanaConvertContext): string[] {
  const metaNodeId = typeof doc.props?._metaNodeId === 'string' ? doc.props._metaNodeId : undefined;
  const metaNode = metaNodeId ? context.byId.get(metaNodeId) : undefined;
  if (!metaNode || docTypeOf(metaNode) !== 'metanode') return [];
  const tags: string[] = [];
  let consumedMetadata = false;
  for (const tuple of context.children.get(metaNode.id) ?? []) {
    if (docTypeOf(tuple) !== 'tuple' || context.visited.has(tuple.id)) continue;
    const tupleChildren = tuple.children ?? [];
    const attribute = tupleChildren[0] ? context.byId.get(tupleChildren[0]) : undefined;
    if (!attribute || meaningfulName(attribute).trim().toLowerCase() !== 'node supertags(s)') continue;
    const definitions = tupleChildren
      .slice(1)
      .map((childId) => context.byId.get(childId))
      .filter((candidate): candidate is TanaDoc => Boolean(candidate && docTypeOf(candidate) === 'tagDef'));
    const names = definitions.map(meaningfulName).filter(Boolean);
    if (names.length === 0) continue;
    consumedMetadata = true;
    tags.push(...names);
    context.visited.add(tuple.id);
    context.entries.push({ sourceId: tuple.id, status: 'imported', reason: 'supertag_tuple', target: doc.id });
    markMergedDoc(attribute.id, context, doc.id, 'supertag_tuple_part');
    for (const definition of definitions) {
      markMergedDoc(definition.id, context, doc.id, 'supertag_definition');
    }
  }
  if (consumedMetadata && !context.visited.has(metaNode.id)) {
    context.visited.add(metaNode.id);
    context.entries.push({ sourceId: metaNode.id, status: 'merged', reason: 'node_metadata', target: doc.id });
  }
  return uniqueNames(tags);
}

function collectTupleFields(doc: TanaDoc, context: TanaConvertContext): TanaTupleField[] {
  const fields: TanaTupleField[] = [];
  for (const child of context.children.get(doc.id) ?? []) {
    if (context.visited.has(child.id)) continue;
    const field = parseTupleField(child, context);
    if (!field) continue;
    if (context.options.fields === 'omit') {
      markSubtree(child, context.children, context.entries, context.visited, 'omitted_field_tuple');
      continue;
    }
    context.visited.add(child.id);
    context.entries.push({ sourceId: child.id, status: 'imported', reason: 'field_tuple', target: `${doc.id}:field:${field.name}` });
    for (const consumedId of field.consumedIds) {
      markMergedDoc(consumedId, context, `${doc.id}:field:${field.name}`);
    }
    fields.push(field);
  }
  return fields;
}

function parseTupleField(tuple: TanaDoc, context: TanaConvertContext): TanaTupleField | null {
  if (docTypeOf(tuple) !== 'tuple') return null;
  const childIds = tuple.children ?? [];
  if (childIds.length < 2) return null;
  const fieldDoc = context.byId.get(childIds[0]!);
  if (!fieldDoc) return null;
  const fieldName = meaningfulName(fieldDoc);
  if (!fieldName) return null;
  const values = childIds
    .slice(1)
    .map((childId) => context.byId.get(childId))
    .map((valueDoc) => valueDoc ? meaningfulValue(valueDoc) : '')
    .filter((value): value is string => Boolean(value));
  if (values.length === 0) return null;
  return {
    tuple,
    name: fieldName,
    values,
    consumedIds: childIds.filter((childId) => context.byId.has(childId)),
  };
}

function mergeTupleFields(fields: readonly TanaTupleField[]): Array<{ name: string; values: string[] }> {
  const byName = new Map<string, { name: string; values: string[] }>();
  for (const field of fields) {
    const key = field.name.trim().toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.values.push(...field.values);
    } else {
      byName.set(key, { name: field.name, values: [...field.values] });
    }
  }
  return [...byName.values()].map((field) => ({
    name: field.name,
    values: [...new Set(field.values)],
  }));
}

function meaningfulName(doc: TanaDoc): string {
  const name = nameOf(doc);
  if (!name || name === doc.id) return '';
  return name;
}

function meaningfulValue(doc: TanaDoc): string {
  const name = meaningfulName(doc);
  if (name) return name;
  const description = htmlToText(doc.props?.description);
  if (description) return description;
  return '';
}

function markMergedDoc(
  sourceId: string,
  context: TanaConvertContext,
  target: string,
  reason = 'field_tuple_part',
): void {
  const doc = context.byId.get(sourceId);
  if (!doc || context.visited.has(doc.id)) return;
  context.visited.add(doc.id);
  context.entries.push({ sourceId: doc.id, status: 'merged', reason, target });
}

function uniqueNames(values: readonly string[]): string[] {
  const names = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) names.set(trimmed.toLowerCase(), trimmed);
  }
  return [...names.values()];
}

function markSubtree(
  doc: TanaDoc,
  children: Map<string, TanaDoc[]>,
  entries: CoverageEntry[],
  visited: Set<string>,
  reason: string,
  status: CoverageEntry['status'] = 'dropped',
) {
  if (visited.has(doc.id)) return;
  visited.add(doc.id);
  entries.push({ sourceId: doc.id, status, reason });
  for (const child of children.get(doc.id) ?? []) markSubtree(child, children, entries, visited, reason, status);
}

function shouldDropRoot(doc: TanaDoc, trashRoots: Set<string>, systemRoots: Set<string>, includeTrash: boolean): boolean {
  if (systemRoots.has(doc.id) || doc.id.startsWith('SYS')) return true;
  if (!includeTrash && trashRoots.has(doc.id)) return true;
  return isExcludedWorkspaceRootName(nameOf(doc));
}

function isExcludedWorkspaceRootName(rawName: string): boolean {
  const name = rawName.toLowerCase();
  return [...EXCLUDED_ROOT_NAMES].some((prefix) => name === prefix || name.startsWith(prefix));
}

function dropReason(doc: TanaDoc, trashRoots: Set<string>, systemRoots: Set<string>, includeTrash: boolean): string {
  if (systemRoots.has(doc.id) || doc.id.startsWith('SYS')) return 'system_node';
  if (!includeTrash && trashRoots.has(doc.id)) return 'trash_node';
  return 'workspace_internal';
}

function isImportableDoc(doc: TanaDoc): boolean {
  return IMPORTABLE_TYPES.has(docTypeOf(doc));
}

function unsupportedStatus(doc: TanaDoc): CoverageEntry['status'] {
  return UNSUPPORTED_TYPES.has(docTypeOf(doc)) ? 'unsupported' : 'dropped';
}

function unsupportedReason(doc: TanaDoc): string {
  const type = docTypeOf(doc);
  return type ? `unsupported_${type}` : 'unreachable_node';
}

function isInOwnedSet(doc: TanaDoc, byId: Map<string, TanaDoc>, roots: Set<string>): boolean {
  let current: TanaDoc | undefined = doc;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (roots.has(current.id)) return true;
    seen.add(current.id);
    const owner = ownerId(current);
    current = owner ? byId.get(owner) : undefined;
  }
  return false;
}

function isTanaDoc(value: unknown): value is TanaDoc {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string');
}

function ownerId(doc: TanaDoc): string | null {
  return typeof doc.props?._ownerId === 'string' ? doc.props._ownerId : null;
}

function docTypeOf(doc: TanaDoc): string {
  return typeof doc.props?._docType === 'string' ? doc.props._docType : '';
}

function nameOf(doc: TanaDoc): string {
  return htmlToText(doc.props?.name);
}

function journalLocalDate(doc: TanaDoc): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?: - (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))?$/u.exec(nameOf(doc));
  const date = match?.[1];
  return date && isValidIsoLocalDate(date) ? date : null;
}

function createdAt(doc: TanaDoc): number {
  return typeof doc.props?.created === 'number' ? doc.props.created : 0;
}
