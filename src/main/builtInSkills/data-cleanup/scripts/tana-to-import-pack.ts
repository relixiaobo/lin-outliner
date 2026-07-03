#!/usr/bin/env bun
import path from 'node:path';
import {
  computeStats,
  coverageFromEntries,
  extractInlineTags,
  htmlToText,
  optionFlag,
  optionValue,
  readJson,
  requiredArg,
  summarizeWarnings,
  writeJson,
  type CoverageEntry,
  type ImportNode,
  type ImportOptions,
  type ImportPack,
  type ImportSection,
} from './import-pack-lib';

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

const USAGE = 'Usage: bun tana-to-import-pack.ts <tana-export.json> --out <pack.json> [--coverage-out <coverage.json>] [--fidelity content|clean|full]';
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

async function main() {
  const args = process.argv.slice(2);
  const source = requiredArg(args, 0, USAGE);
  const out = optionValue(args, '--out');
  if (!out) throw new Error(USAGE);
  const coverageOut = optionValue(args, '--coverage-out') ?? `${out.replace(/\.json$/u, '')}.coverage.json`;
  const fidelity = optionValue(args, '--fidelity') ?? 'clean';
  if (fidelity !== 'content' && fidelity !== 'clean' && fidelity !== 'full') throw new Error('--fidelity must be content, clean, or full');
  const includeTrash = optionFlag(args, '--include-trash');

  const raw = await readJson(source);
  const pack = await convertTanaExport(raw, {
    source,
    coverageOut,
    includeTrash,
    options: {
      fidelity,
      dateGrouping: 'stage_headings',
      tags: fidelity !== 'content',
      fields: fidelity === 'full' ? 'field_rows' : fidelity === 'clean' ? 'text_children' : 'omit',
      doneState: fidelity !== 'content',
    },
  });
  await writeJson(pack.coverage.entriesFile ?? coverageOut, packCoverageEntries);
  await writeJson(out, pack);
  console.log(JSON.stringify({
    ok: true,
    out,
    coverageOut: pack.coverage.entriesFile,
    stats: pack.stats,
    warnings: pack.warnings,
  }, null, 2));
}

let packCoverageEntries: CoverageEntry[] = [];

async function convertTanaExport(
  raw: unknown,
  config: {
    source: string;
    coverageOut: string;
    includeTrash: boolean;
    options: ImportOptions;
  },
): Promise<ImportPack> {
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
  for (const list of children.values()) {
    list.sort((left, right) => createdAt(left) - createdAt(right) || left.id.localeCompare(right.id));
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

  const sectionNodes: ImportNode[] = [];
  for (const child of children.get(rootId) ?? []) {
    if (shouldDropRoot(child, trashRoots, systemRoots, config.includeTrash)) {
      markSubtree(child, children, entries, visited, dropReason(child, trashRoots, systemRoots, config.includeTrash));
      continue;
    }
    const converted = convertDoc(child, { byId, children, entries, visited, trashRoots, systemRoots, includeTrash: config.includeTrash, options: config.options });
    if (converted) sectionNodes.push(converted);
  }

  for (const doc of docs) {
    if (visited.has(doc.id)) continue;
    if (!isImportableDoc(doc)) {
      markSubtree(doc, children, entries, visited, unsupportedReason(doc), unsupportedStatus(doc));
      continue;
    }
    const converted = convertDoc(doc, { byId, children, entries, visited, trashRoots, systemRoots, includeTrash: config.includeTrash, options: config.options });
    if (converted) sectionNodes.push(converted);
  }

  const sections: ImportSection[] = [{
    id: 'tana-workspace',
    title: 'Tana Workspace',
    kind: 'library',
    nodes: sectionNodes,
  }];
  const coverage = coverageFromEntries(entries, path.resolve(config.coverageOut));
  packCoverageEntries = entries;
  const pack: ImportPack = {
    version: 1,
    source: {
      kind: 'tana',
      path: path.resolve(config.source),
      sourceId: String(data.currentWorkspaceId ?? rootId),
    },
    options: config.options,
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
    warnings: summarizeWarnings(entries),
    sections,
  };
  pack.stats = computeStats(pack);
  return pack;
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
  const codeText = docType === 'codeblock' ? title || description : '';
  const node: ImportNode = {
    title: tagExtraction.title || description.slice(0, 80) || '(untitled)',
    ...(description ? { description } : {}),
    ...(tagExtraction.tags.length ? { tags: tagExtraction.tags } : {}),
    ...(context.options.doneState && doc.props?._done ? { checked: true } : {}),
    ...(codeText ? { code: { text: codeText, language: undefined } } : {}),
    ...(context.options.fields === 'field_rows' && mergedFields.length ? { fields: mergedFields } : {}),
    ...(childNodes.length ? { children: childNodes } : {}),
    sourceId: doc.id,
  };
  context.entries.push({ sourceId: doc.id, status: 'imported', target: doc.id });
  return node;
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

function markMergedDoc(sourceId: string, context: TanaConvertContext, target: string): void {
  const doc = context.byId.get(sourceId);
  if (!doc || context.visited.has(doc.id)) return;
  context.visited.add(doc.id);
  context.entries.push({ sourceId: doc.id, status: 'merged', reason: 'field_tuple_part', target });
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
  const name = nameOf(doc).toLowerCase();
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

function createdAt(doc: TanaDoc): number {
  return typeof doc.props?.created === 'number' ? doc.props.created : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
