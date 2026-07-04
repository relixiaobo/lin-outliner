import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { plainText, type CreateNodeTree } from '../core/types';
import {
  checkedState,
  fieldReads,
  indexProjection,
  isInTrash,
  normalChildIds,
} from './agentNodeToolProjection';
import type { OutlinerToolHost } from './agentNodeTools';
import { LocalToolFailure, resolveAgentLocalReadPath, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { errorMessage } from './agentNodeToolUtils';
import {
  validateImportPack,
  type ImportNode,
  type ImportPack,
  type ImportStats,
  type ImportWarning,
} from './agentDataImportPack';

export interface ImportServiceOptions {
  workspace?: AgentLocalWorkspaceContext;
  localFileRoot?: string;
  toolName?: string;
  now?: () => number;
  idGenerator?: () => string;
}

export interface ImportPackFileRequest {
  packFile: string;
  parentId?: string;
  mode?: 'stage';
}

export interface ImportPackContentRequest {
  packContent: string;
  packLabel?: string;
  parentId?: string;
  mode?: 'stage';
}

export interface ImportPackCommitFileRequest extends ImportPackFileRequest {
  previewId?: string;
}

export interface ImportPackCommitContentRequest extends ImportPackContentRequest {
  previewId?: string;
}

export interface ImportServiceResult {
  importId: string;
  previewId?: string;
  stagingRootId?: string;
  sectionCount: number;
  nodeCount: number;
  createdRootIds: string[];
  warnings: ImportWarning[];
  stats: ImportStats;
  operationId?: string;
  verification?: ImportVerification;
}

export interface ImportVerification {
  ok: boolean;
  expected: Pick<ImportStats, 'sections' | 'nodes' | 'descriptions' | 'tags' | 'fields' | 'checked'>;
  actual: Pick<ImportStats, 'sections' | 'nodes' | 'descriptions' | 'tags' | 'fields' | 'checked'>;
  mismatches: string[];
}

export class ImportServiceFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly instructions?: string,
    readonly data?: ImportServiceResult,
    readonly warnings?: readonly string[],
  ) {
    super(message);
    this.name = 'ImportServiceFailure';
  }
}

interface LoadedPack {
  packLabel: string;
  packHash: string;
  pack: ImportPack;
  warnings: ImportWarning[];
}

interface PreviewRecord {
  packHash: string;
  parentId: string;
  mode: 'stage';
  createdAt: number;
}

const MAX_PACK_BYTES = 50 * 1024 * 1024;
export const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;
const IMPORT_YIELD_EVERY_NODES = 50;
const DEFAULT_IMPORT_TOOL_NAME = 'tenon-import';

export class AgentImportService {
  private readonly previewRecords = new Map<string, PreviewRecord>();
  private readonly toolName: string;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  constructor(
    private readonly host: OutlinerToolHost,
    private readonly options: ImportServiceOptions = {},
  ) {
    this.toolName = options.toolName ?? DEFAULT_IMPORT_TOOL_NAME;
    this.now = options.now ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async previewFromFile(input: ImportPackFileRequest): Promise<ImportServiceResult> {
    const normalized = normalizeImportRequest(input);
    const loaded = await loadImportPackFromFile(normalized.packFile, this.options);
    const parentId = this.resolveParentId(normalized.parentId);
    const previewId = `preview:${this.idGenerator()}`;
    this.previewRecords.set(previewId, {
      packHash: loaded.packHash,
      parentId,
      mode: normalized.mode,
      createdAt: this.now(),
    });
    this.cleanupPreviewRecords();
    return resultForPreview(loaded, previewId);
  }

  async previewFromContent(input: ImportPackContentRequest): Promise<ImportServiceResult> {
    const normalized = normalizeContentImportRequest(input);
    const loaded = loadImportPackFromContent(normalized.packContent, normalized.packLabel);
    const parentId = this.resolveParentId(normalized.parentId);
    const previewId = `preview:${this.idGenerator()}`;
    this.previewRecords.set(previewId, {
      packHash: loaded.packHash,
      parentId,
      mode: normalized.mode,
      createdAt: this.now(),
    });
    this.cleanupPreviewRecords();
    return resultForPreview(loaded, previewId);
  }

  async commitFromFile(input: ImportPackCommitFileRequest): Promise<ImportServiceResult> {
    const normalized = normalizeImportRequest(input);
    const loaded = await loadImportPackFromFile(normalized.packFile, this.options);
    return this.commitLoadedPack(loaded, {
      parentId: normalized.parentId,
      mode: normalized.mode,
      previewId: input.previewId,
    });
  }

  async commitFromContent(input: ImportPackCommitContentRequest): Promise<ImportServiceResult> {
    const normalized = normalizeContentImportRequest(input);
    const loaded = loadImportPackFromContent(normalized.packContent, normalized.packLabel);
    return this.commitLoadedPack(loaded, {
      parentId: normalized.parentId,
      mode: normalized.mode,
      previewId: input.previewId,
    });
  }

  private async commitLoadedPack(
    loaded: LoadedPack,
    input: { parentId?: string; mode: 'stage'; previewId?: string },
  ): Promise<ImportServiceResult> {
    const parentId = this.resolveParentId(input.parentId);
    const previewError = validatePreview(this.previewRecords, input.previewId, {
      packHash: loaded.packHash,
      parentId,
      mode: input.mode,
    }, this.now());
    if (previewError) {
      throw new ImportServiceFailure(
        previewError.code,
        previewError.message,
        'Run tenon-import preview again, review the preview, then retry with the returned preview id.',
      );
    }

    const materialized = await materializeImportPack(this.host, loaded.pack, parentId, this.toolName);
    const stagingRootId = materialized.createdRootIds[0];
    if (!stagingRootId) throw new Error('Import did not create a staging root.');
    const verification = verifyImportedSubtree(this.host, stagingRootId, loaded.pack.stats);
    const data: ImportServiceResult = {
      importId: `import:${this.idGenerator()}`,
      stagingRootId,
      sectionCount: loaded.pack.stats.sections,
      nodeCount: loaded.pack.stats.nodes,
      createdRootIds: materialized.createdRootIds,
      warnings: loaded.warnings,
      stats: loaded.pack.stats,
      verification,
    };
    if (!verification.ok) {
      throw new ImportServiceFailure(
        'verification_failed',
        'Import wrote a staging subtree, but post-import verification found mismatched counts.',
        'Inspect the staging root, use operation_history to undo if needed, and report the mismatch before retrying.',
        data,
        verification.mismatches,
      );
    }
    return data;
  }

  private resolveParentId(parentIdInput: string | undefined): string {
    const projection = this.host.getProjection();
    const index = indexProjection(projection);
    const parentId = parentIdInput ?? projection.todayId;
    const parent = index.nodes.get(parentId);
    if (!parent || isInTrash(index, parentId)) {
      throw new ImportServiceFailure(
        'invalid_destination',
        `Destination parent node is not available: ${parentId}`,
        'Choose a visible destination parent node and run tenon-import preview again.',
      );
    }
    return parentId;
  }

  private cleanupPreviewRecords(): void {
    cleanupPreviewRecords(this.previewRecords, this.now());
  }
}

export async function loadImportPackFromFile(packFileInput: string, options: Pick<ImportServiceOptions, 'workspace' | 'localFileRoot'> = {}): Promise<LoadedPack> {
  const packFile = resolvePackFilePath(packFileInput, options);
  const info = await stat(packFile);
  if (!info.isFile()) throw new LocalToolFailure('invalid_pack_file', `Import Pack path is not a file: ${packFile}`);
  if (info.size > MAX_PACK_BYTES) throw new LocalToolFailure('pack_too_large', `Import Pack is too large: ${info.size} bytes.`);
  const raw = await readFile(packFile, 'utf8');
  return loadImportPackFromContent(raw, packFile);
}

export function loadImportPackFromContent(packContent: string, packLabel = '(inline import pack)'): LoadedPack {
  if (Buffer.byteLength(packContent, 'utf8') > MAX_PACK_BYTES) {
    throw new LocalToolFailure('pack_too_large', `Import Pack is too large: ${Buffer.byteLength(packContent, 'utf8')} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(packContent);
  } catch (error) {
    throw new LocalToolFailure('invalid_json', `Import Pack is not valid JSON: ${errorMessage(error)}`);
  }
  const validation = validateImportPack(parsed);
  if (!validation.ok) throw new LocalToolFailure(validation.code, validation.message);
  return {
    packLabel,
    packHash: createHash('sha256').update(packContent).digest('hex'),
    pack: validation.pack,
    warnings: validation.pack.warnings,
  };
}

export function resolvePackFilePath(packFileInput: string, options: Pick<ImportServiceOptions, 'workspace' | 'localFileRoot'> = {}): string {
  if (options.workspace) return resolveAgentLocalReadPath(options.workspace, packFileInput);
  const expanded = packFileInput.startsWith('~/')
    ? path.join(process.env.HOME ?? '', packFileInput.slice(2))
    : packFileInput;
  const root = path.resolve(options.localFileRoot ?? process.cwd());
  const resolved = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new LocalToolFailure('path_outside_local_root', `Path is outside the allowed file area: ${resolved}`);
  }
  return resolved;
}

export function visibleImportServiceResult(data: ImportServiceResult): unknown {
  return {
    importId: data.importId,
    ...(data.previewId ? { previewId: data.previewId } : {}),
    ...(data.stagingRootId ? { stagingRootId: data.stagingRootId } : {}),
    sectionCount: data.sectionCount,
    nodeCount: data.nodeCount,
    createdRootIds: data.createdRootIds,
    warnings: data.warnings.slice(0, 20),
    stats: data.stats,
    ...(data.verification ? { verification: data.verification } : {}),
  };
}

function normalizeImportRequest<T extends ImportPackFileRequest>(input: T): Required<Pick<ImportPackFileRequest, 'packFile' | 'mode'>> & Pick<ImportPackFileRequest, 'parentId'> {
  const packFile = typeof input.packFile === 'string' ? input.packFile.trim() : '';
  if (!packFile) throw new ImportServiceFailure('invalid_args', 'pack_file is required.');
  const mode = input.mode ?? 'stage';
  if (mode !== 'stage') throw new ImportServiceFailure('invalid_args', 'mode must be "stage".');
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  return { packFile, mode, ...(parentId ? { parentId } : {}) };
}

function normalizeContentImportRequest<T extends ImportPackContentRequest>(input: T): Required<Pick<ImportPackContentRequest, 'packContent' | 'mode'>> & Pick<ImportPackContentRequest, 'packLabel' | 'parentId'> {
  if (typeof input.packContent !== 'string' || input.packContent.trim().length === 0) {
    throw new ImportServiceFailure('invalid_args', 'packContent is required.');
  }
  const mode = input.mode ?? 'stage';
  if (mode !== 'stage') throw new ImportServiceFailure('invalid_args', 'mode must be "stage".');
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  const packLabel = typeof input.packLabel === 'string' && input.packLabel.trim() ? input.packLabel.trim() : undefined;
  return {
    packContent: input.packContent,
    mode,
    ...(packLabel ? { packLabel } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function resultForPreview(loaded: LoadedPack, previewId: string): ImportServiceResult {
  return {
    importId: `import:${loaded.packHash.slice(0, 16)}`,
    previewId,
    sectionCount: loaded.pack.stats.sections,
    nodeCount: loaded.pack.stats.nodes,
    createdRootIds: [],
    warnings: loaded.warnings,
    stats: loaded.pack.stats,
  };
}

function validatePreview(
  previewRecords: Map<string, PreviewRecord>,
  previewId: string | undefined,
  expected: Omit<PreviewRecord, 'createdAt'>,
  now: number,
): { code: string; message: string } | null {
  if (!previewId) return { code: 'preview_required', message: 'previewId is required for import commit.' };
  const record = previewRecords.get(previewId);
  if (!record || now - record.createdAt > IMPORT_PREVIEW_TTL_MS) {
    previewRecords.delete(previewId);
    return { code: 'preview_expired', message: 'The confirmed preview id is missing or expired.' };
  }
  if (
    record.packHash !== expected.packHash
    || record.parentId !== expected.parentId
    || record.mode !== expected.mode
  ) {
    return { code: 'preview_mismatch', message: 'The confirmed preview id does not match the current pack, destination, or mode.' };
  }
  previewRecords.delete(previewId);
  return null;
}

function cleanupPreviewRecords(previewRecords: Map<string, PreviewRecord>, now: number): void {
  for (const [id, record] of previewRecords) {
    if (now - record.createdAt > IMPORT_PREVIEW_TTL_MS) previewRecords.delete(id);
  }
}

async function materializeImportPack(
  host: OutlinerToolHost,
  pack: ImportPack,
  parentId: string,
  toolName: string,
): Promise<{ createdRootIds: string[] }> {
  const rootTree = importPackToCreateNodeTree(pack);
  const meta = {
    origin: 'agent',
    tool: toolName,
    summary: `Created import staging tree for ${pack.stats.nodes} cleaned nodes.`,
  } as const;
  const outcome = host.createNodesFromTreeYielding
    ? await host.createNodesFromTreeYielding(parentId, [rootTree], meta, {
      yieldEveryNodes: IMPORT_YIELD_EVERY_NODES,
      commitEveryNodes: IMPORT_YIELD_EVERY_NODES,
    })
    : host.transaction
      ? await host.transaction(meta, async () => host.handle('create_nodes_from_tree', { parentId, nodes: [rootTree] }, meta))
      : await host.handle('create_nodes_from_tree', { parentId, nodes: [rootTree] }, meta);
  const stagingRootId = focusNodeId(outcome);
  if (!stagingRootId) throw new Error('Import did not create a staging root.');
  return { createdRootIds: [stagingRootId] };
}

function importPackToCreateNodeTree(pack: ImportPack): CreateNodeTree {
  const rootTitle = `Import: ${path.basename(pack.source.path).replace(/\.[^.]+$/u, '')}`;
  return treeNode(rootTitle, pack.sections.map((section) =>
    treeNode(section.title, section.nodes.map(importNodeToCreateNodeTree))));
}

function importNodeToCreateNodeTree(node: ImportNode): CreateNodeTree {
  if (node.code) {
    return {
      content: plainText(node.code.text),
      ...(node.description?.trim() ? { description: node.description } : {}),
      children: (node.children ?? []).map(importNodeToCreateNodeTree),
      type: 'codeBlock',
      codeLanguage: node.code.language,
      tags: node.tags ?? [],
      fields: fieldRows(node),
      ...(node.checked !== undefined ? { checkbox: true, done: node.checked } : {}),
    };
  }
  return {
    content: plainText(node.title),
    ...(node.description?.trim() ? { description: node.description } : {}),
    children: (node.children ?? []).map(importNodeToCreateNodeTree),
    tags: node.tags ?? [],
    fields: fieldRows(node),
    ...(node.checked !== undefined ? { checkbox: true, done: node.checked } : {}),
  };
}

function treeNode(title: string, children: CreateNodeTree[]): CreateNodeTree {
  return {
    content: plainText(title),
    children,
  };
}

function fieldRows(node: ImportNode): CreateNodeTree['fields'] {
  return (node.fields ?? []).flatMap((field) =>
    field.values.map((value) => ({ name: field.name, value })));
}

function focusNodeId(outcome: unknown): string | null {
  const candidate = outcome && typeof outcome === 'object' ? outcome as { focus?: { nodeId?: unknown } } : {};
  return typeof candidate.focus?.nodeId === 'string' ? candidate.focus.nodeId : null;
}

function verifyImportedSubtree(host: OutlinerToolHost, stagingRootId: string, expectedStats: ImportStats): ImportVerification {
  const index = indexProjection(host.getProjection());
  const sectionIds = normalChildIds(index, stagingRootId, false);
  const actual = {
    sections: sectionIds.length,
    nodes: 0,
    descriptions: 0,
    tags: 0,
    fields: 0,
    checked: 0,
  };
  for (const sectionId of sectionIds) {
    for (const nodeId of normalChildIds(index, sectionId, false)) collectImportedStats(index, nodeId, actual);
  }
  const expected = {
    sections: expectedStats.sections,
    nodes: expectedStats.nodes,
    descriptions: expectedStats.descriptions,
    tags: expectedStats.tags,
    fields: expectedStats.fields,
    checked: expectedStats.checked,
  };
  const mismatches: string[] = [];
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) mismatches.push(`${key}: expected ${expected[key]}, actual ${actual[key]}`);
  }
  return { ok: mismatches.length === 0, expected, actual, mismatches };
}

function collectImportedStats(
  index: ReturnType<typeof indexProjection>,
  nodeId: string,
  stats: Pick<ImportStats, 'nodes' | 'descriptions' | 'tags' | 'fields' | 'checked'>,
): void {
  const node = index.nodes.get(nodeId);
  if (!node || isInTrash(index, nodeId)) return;
  stats.nodes += 1;
  if ((node.description ?? '').trim()) stats.descriptions += 1;
  stats.tags += node.tags.length;
  stats.fields += fieldReads(index, node, false).length;
  if (checkedState(index, node) === true) stats.checked += 1;
  for (const childId of normalChildIds(index, nodeId, false)) collectImportedStats(index, childId, stats);
}
