import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentMutationCausation } from '../../../core/agent/protocol';
import { parseIsoLocalDateParts } from '../../../core/localDate';
import {
  DAILY_NOTES_ID,
  TAG_DAY_ID,
  TAG_WEEK_ID,
  TAG_YEAR_ID,
  plainText,
  type CreateNodeTree,
} from '../../../core/types';
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
  type ImportSection,
  type ImportStats,
  type ImportWarning,
} from './agentDataImportPack';

export type ImportMode = 'stage' | 'native_daily';

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
  mode?: ImportMode;
}

export interface ImportPackContentRequest {
  packContent: string;
  packLabel?: string;
  parentId?: string;
  mode?: ImportMode;
}

export interface ImportPackCommitFileRequest extends ImportPackFileRequest {
  previewId?: string;
  causation: AgentMutationCausation;
}

export interface ImportPackCommitContentRequest extends ImportPackContentRequest {
  previewId?: string;
  causation: AgentMutationCausation;
}

interface ImportServiceResultBase {
  importId: string;
  mode: ImportMode;
  sectionCount: number;
  nodeCount: number;
  createdRootIds: string[];
  warnings: ImportWarning[];
  stats: ImportStats;
}

export interface ImportPreviewResult extends ImportServiceResultBase {
  status: 'previewed';
  previewId: string;
  dailySummary?: ImportDailyPreviewSummary;
}

interface ImportStagedResultBase extends ImportServiceResultBase {
  stagingRootId: string;
  operationId: string;
  verification: ImportVerification;
}

export interface ImportStagedResult extends ImportStagedResultBase {
  status: 'staged';
  mode: 'stage';
}

export interface ImportStagedWithErrorsResult extends ImportStagedResultBase {
  status: 'staged_with_errors';
  mode: 'stage';
  mismatches: string[];
  retryAllowed: false;
}

export interface ImportDailyTarget {
  sectionId: string;
  date: string;
  dayNodeId: string;
  dayNodeCreated: boolean;
  createdRootIds: string[];
}

interface ImportNativeDailyResultBase extends ImportServiceResultBase {
  mode: 'native_daily';
  operationId: string;
  verification: ImportVerification;
  dailyTargets: ImportDailyTarget[];
  stagingRootId?: string;
}

export interface ImportNativeDailyResult extends ImportNativeDailyResultBase {
  status: 'imported_daily';
}

export interface ImportNativeDailyWithErrorsResult extends ImportNativeDailyResultBase {
  status: 'imported_daily_with_errors';
  mismatches: string[];
  retryAllowed: false;
}

export interface ImportDailyPreviewSummary {
  dateSectionCount: number;
  dateCount: number;
  existingDateCount: number;
  newDateCount: number;
  nonDateSectionCount: number;
  firstDate?: string;
  lastDate?: string;
}

export type ImportCommitResult =
  | ImportStagedResult
  | ImportStagedWithErrorsResult
  | ImportNativeDailyResult
  | ImportNativeDailyWithErrorsResult;
export type ImportServiceResult = ImportPreviewResult | ImportCommitResult;

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
  mode: ImportMode;
  createdAt: number;
}

interface NativeDailyMaterialization {
  createdRootIds: string[];
  dailyTargets: ImportDailyTarget[];
  stagingRootId?: string;
}

const MAX_PACK_BYTES = 50 * 1024 * 1024;
export const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;
const IMPORT_TARGET_TOUCHED_NODES_PER_CHUNK = 50;
const IMPORT_MIN_YIELD_EVERY_NODES = 10;
const IMPORT_MAX_YIELD_EVERY_NODES = 50;
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

  async previewFromFile(input: ImportPackFileRequest): Promise<ImportPreviewResult> {
    const normalized = normalizeImportRequest(input);
    const loaded = await loadImportPackFromFile(normalized.packFile, this.options);
    const mode = resolveImportMode(normalized.mode, loaded.pack);
    validateModeForPack(mode, loaded.pack);
    const parentId = this.resolveParentId(normalized.parentId);
    const previewId = `preview:${this.idGenerator()}`;
    this.previewRecords.set(previewId, {
      packHash: loaded.packHash,
      parentId,
      mode,
      createdAt: this.now(),
    });
    this.cleanupPreviewRecords();
    return resultForPreview(this.host, loaded, previewId, mode);
  }

  async previewFromContent(input: ImportPackContentRequest): Promise<ImportPreviewResult> {
    const normalized = normalizeContentImportRequest(input);
    const loaded = loadImportPackFromContent(normalized.packContent, normalized.packLabel);
    const mode = resolveImportMode(normalized.mode, loaded.pack);
    validateModeForPack(mode, loaded.pack);
    const parentId = this.resolveParentId(normalized.parentId);
    const previewId = `preview:${this.idGenerator()}`;
    this.previewRecords.set(previewId, {
      packHash: loaded.packHash,
      parentId,
      mode,
      createdAt: this.now(),
    });
    this.cleanupPreviewRecords();
    return resultForPreview(this.host, loaded, previewId, mode);
  }

  async commitFromFile(input: ImportPackCommitFileRequest): Promise<ImportCommitResult> {
    const normalized = normalizeImportRequest(input);
    const loaded = await loadImportPackFromFile(normalized.packFile, this.options);
    return this.commitLoadedPack(loaded, {
      parentId: normalized.parentId,
      mode: normalized.mode,
      previewId: input.previewId,
      causation: input.causation,
    });
  }

  async commitFromContent(input: ImportPackCommitContentRequest): Promise<ImportCommitResult> {
    const normalized = normalizeContentImportRequest(input);
    const loaded = loadImportPackFromContent(normalized.packContent, normalized.packLabel);
    return this.commitLoadedPack(loaded, {
      parentId: normalized.parentId,
      mode: normalized.mode,
      previewId: input.previewId,
      causation: input.causation,
    });
  }

  private async commitLoadedPack(
    loaded: LoadedPack,
    input: { parentId?: string; mode?: ImportMode; previewId?: string; causation: AgentMutationCausation },
  ): Promise<ImportCommitResult> {
    const causation = normalizeImportCausation(input.causation);
    const mode = resolveImportMode(input.mode, loaded.pack);
    validateModeForPack(mode, loaded.pack);
    const parentId = this.resolveParentId(input.parentId);
    const previewError = validatePreview(this.previewRecords, input.previewId, {
      packHash: loaded.packHash,
      parentId,
      mode,
    }, this.now());
    if (previewError) {
      throw new ImportServiceFailure(
        previewError.code,
        previewError.message,
        'Run tenon-import preview again, review the preview, then retry with the returned preview id.',
      );
    }

    const operationId = `op:${this.idGenerator()}`;
    if (mode === 'native_daily') {
      return this.commitNativeDailyPack(loaded, parentId, operationId, causation);
    }
    const materialized = await materializeImportPack(
      this.host,
      loaded.pack,
      parentId,
      this.toolName,
      operationId,
      causation,
    );
    const stagingRootId = materialized.createdRootIds[0];
    if (!stagingRootId) throw new Error('Import did not create a staging root.');
    const verification = verifyImportedSubtree(this.host, stagingRootId, loaded.pack.stats);
    const base = {
      importId: `import:${this.idGenerator()}`,
      mode: 'stage' as const,
      stagingRootId,
      operationId,
      sectionCount: loaded.pack.stats.sections,
      nodeCount: loaded.pack.stats.nodes,
      createdRootIds: materialized.createdRootIds,
      warnings: loaded.warnings,
      stats: loaded.pack.stats,
      verification,
    };
    if (!verification.ok) {
      return {
        ...base,
        status: 'staged_with_errors',
        mismatches: verification.mismatches,
        retryAllowed: false,
      };
    }
    return { ...base, status: 'staged' };
  }

  private async commitNativeDailyPack(
    loaded: LoadedPack,
    parentId: string,
    operationId: string,
    causation: AgentMutationCausation,
  ): Promise<ImportCommitResult> {
    const materialized = await materializeNativeDailyImportPack(
      this.host,
      loaded.pack,
      parentId,
      this.toolName,
      operationId,
      causation,
    );
    const verification = verifyNativeDailyImport(this.host, materialized, loaded.pack.stats);
    const base = {
      importId: `import:${this.idGenerator()}`,
      mode: 'native_daily' as const,
      operationId,
      sectionCount: loaded.pack.stats.sections,
      nodeCount: loaded.pack.stats.nodes,
      createdRootIds: materialized.createdRootIds,
      warnings: warningsForMode(loaded.warnings, 'native_daily'),
      stats: loaded.pack.stats,
      verification,
      dailyTargets: materialized.dailyTargets,
      ...(materialized.stagingRootId ? { stagingRootId: materialized.stagingRootId } : {}),
    };
    if (!verification.ok) {
      return {
        ...base,
        status: 'imported_daily_with_errors',
        mismatches: verification.mismatches,
        retryAllowed: false,
      };
    }
    return { ...base, status: 'imported_daily' };
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
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(root, expanded));
}

function normalizeImportRequest<T extends ImportPackFileRequest>(input: T): Pick<ImportPackFileRequest, 'packFile' | 'parentId' | 'mode'> & { packFile: string } {
  const packFile = typeof input.packFile === 'string' ? input.packFile.trim() : '';
  if (!packFile) throw new ImportServiceFailure('invalid_args', 'pack_file is required.');
  const mode = normalizeImportMode(input.mode);
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  return { packFile, ...(mode ? { mode } : {}), ...(parentId ? { parentId } : {}) };
}

function normalizeContentImportRequest<T extends ImportPackContentRequest>(input: T): Pick<ImportPackContentRequest, 'packContent' | 'packLabel' | 'parentId' | 'mode'> & { packContent: string } {
  if (typeof input.packContent !== 'string' || input.packContent.trim().length === 0) {
    throw new ImportServiceFailure('invalid_args', 'packContent is required.');
  }
  const mode = normalizeImportMode(input.mode);
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : undefined;
  const packLabel = typeof input.packLabel === 'string' && input.packLabel.trim() ? input.packLabel.trim() : undefined;
  return {
    packContent: input.packContent,
    ...(mode ? { mode } : {}),
    ...(packLabel ? { packLabel } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

function normalizeImportMode(value: unknown): ImportMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'stage' || value === 'native_daily') return value;
  throw new ImportServiceFailure('invalid_args', 'mode must be "stage" or "native_daily".');
}

function resolveImportMode(mode: ImportMode | undefined, pack: ImportPack): ImportMode {
  if (mode) return mode;
  return pack.options.dateGrouping === 'native_daily'
    && pack.sections.some((section) => section.kind === 'date')
    ? 'native_daily'
    : 'stage';
}

function validateModeForPack(mode: ImportMode, pack: ImportPack): void {
  if (mode === 'native_daily' && !pack.sections.some((section) => section.kind === 'date')) {
    throw new ImportServiceFailure(
      'native_daily_requires_dates',
      'native_daily mode requires at least one validated date section.',
      'Use stage mode for packs without date sections.',
    );
  }
}

function normalizeImportCausation(value: unknown): AgentMutationCausation {
  const candidate = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (
    typeof candidate.threadId !== 'string'
    || !candidate.threadId.trim()
    || typeof candidate.turnId !== 'string'
    || !candidate.turnId.trim()
    || typeof candidate.itemId !== 'string'
    || !candidate.itemId.trim()
  ) {
    throw new ImportServiceFailure('causation_required', 'Import commit requires valid Thread, Turn, and Item causation.');
  }
  return {
    threadId: candidate.threadId,
    turnId: candidate.turnId,
    itemId: candidate.itemId,
  };
}

function resultForPreview(
  host: OutlinerToolHost,
  loaded: LoadedPack,
  previewId: string,
  mode: ImportMode,
): ImportPreviewResult {
  return {
    status: 'previewed',
    importId: `import:${loaded.packHash.slice(0, 16)}`,
    mode,
    previewId,
    sectionCount: loaded.pack.stats.sections,
    nodeCount: loaded.pack.stats.nodes,
    createdRootIds: [],
    warnings: warningsForMode(loaded.warnings, mode),
    stats: loaded.pack.stats,
    ...(mode === 'native_daily' ? { dailySummary: nativeDailyPreviewSummary(host, loaded.pack) } : {}),
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
    return { code: 'preview_expired', message: 'The validated preview id is missing or expired.' };
  }
  if (
    record.packHash !== expected.packHash
    || record.parentId !== expected.parentId
    || record.mode !== expected.mode
  ) {
    return { code: 'preview_mismatch', message: 'The validated preview id does not match the current pack, destination, or mode.' };
  }
  previewRecords.delete(previewId);
  return null;
}

function cleanupPreviewRecords(previewRecords: Map<string, PreviewRecord>, now: number): void {
  for (const [id, record] of previewRecords) {
    if (now - record.createdAt > IMPORT_PREVIEW_TTL_MS) previewRecords.delete(id);
  }
}

function warningsForMode(warnings: readonly ImportWarning[], mode: ImportMode): ImportWarning[] {
  if (mode === 'stage') return [...warnings];
  const appendOnlyWarning: ImportWarning = {
    code: 'native_daily_append_only',
    message: 'Daily Note content is appended. Re-importing the same pack creates another copy.',
  };
  return warnings.some((warning) => warning.code === appendOnlyWarning.code)
    ? [...warnings]
    : [...warnings, appendOnlyWarning];
}

function nativeDailyPreviewSummary(host: OutlinerToolHost, pack: ImportPack): ImportDailyPreviewSummary {
  const index = indexProjection(host.getProjection());
  const dateSections = pack.sections.filter((section): section is ImportSection & { kind: 'date'; date: string } =>
    section.kind === 'date' && typeof section.date === 'string');
  const dates = [...new Set(dateSections.map((section) => section.date))].sort();
  const existingDateCount = dates.filter((date) => findDailyNoteId(index, date)).length;
  return {
    dateSectionCount: dateSections.length,
    dateCount: dates.length,
    existingDateCount,
    newDateCount: dates.length - existingDateCount,
    nonDateSectionCount: pack.sections.length - dateSections.length,
    ...(dates[0] ? { firstDate: dates[0] } : {}),
    ...(dates.at(-1) ? { lastDate: dates.at(-1) } : {}),
  };
}

function findDailyNoteId(
  index: ReturnType<typeof indexProjection>,
  date: string,
): string | null {
  const parts = parseIsoLocalDateParts(date);
  if (!parts) return null;
  const yearId = normalChildIds(index, DAILY_NOTES_ID, false).find((nodeId) => {
    const node = index.nodes.get(nodeId);
    return node?.content.text === String(parts.year) && node.tags.includes(TAG_YEAR_ID);
  });
  if (!yearId) return null;
  for (const weekId of normalChildIds(index, yearId, false)) {
    const week = index.nodes.get(weekId);
    if (!week?.tags.includes(TAG_WEEK_ID)) continue;
    const dayId = normalChildIds(index, weekId, false).find((nodeId) => {
      const node = index.nodes.get(nodeId);
      return node?.content.text === date && node.tags.includes(TAG_DAY_ID);
    });
    if (dayId) return dayId;
  }
  return null;
}

async function materializeImportPack(
  host: OutlinerToolHost,
  pack: ImportPack,
  parentId: string,
  toolName: string,
  operationId: string,
  causation: AgentMutationCausation,
): Promise<{ createdRootIds: string[] }> {
  const rootTree = importPackToCreateNodeTree(pack);
  const meta = {
    origin: 'agent',
    operationId,
    tool: toolName,
    summary: `Created import staging tree for ${pack.stats.nodes} cleaned nodes.`,
    causation,
  } as const;
  const yieldEveryNodes = importYieldEveryNodesForStats(pack.stats);
  const outcome = host.createNodesFromTreeYielding
    ? await host.createNodesFromTreeYielding(parentId, [rootTree], meta, {
      yieldEveryNodes,
      commitEveryNodes: yieldEveryNodes,
    })
    : host.transaction
      ? await host.transaction(meta, async () => host.handle('create_nodes_from_tree', { parentId, nodes: [rootTree] }, meta))
      : await host.handle('create_nodes_from_tree', { parentId, nodes: [rootTree] }, meta);
  const stagingRootId = focusNodeId(outcome);
  if (!stagingRootId) throw new Error('Import did not create a staging root.');
  return { createdRootIds: [stagingRootId] };
}

async function materializeNativeDailyImportPack(
  host: OutlinerToolHost,
  pack: ImportPack,
  parentId: string,
  toolName: string,
  operationId: string,
  causation: AgentMutationCausation,
): Promise<NativeDailyMaterialization> {
  if (!host.createImportTreeBatchesYielding) {
    throw new ImportServiceFailure(
      'native_daily_unavailable',
      'This Tenon host cannot atomically import content into Daily Notes.',
      'Update Tenon, then preview the pack again. Use stage mode only when a staging tree is acceptable.',
    );
  }
  const dateSections = pack.sections.flatMap((section, index) => {
    if (section.kind !== 'date' || !section.date) return [];
    const parts = parseIsoLocalDateParts(section.date);
    if (!parts) throw new Error(`Validated date section became invalid: ${section.date}`);
    return [{ section, batchId: `date:${index}:${section.id}`, parts }];
  });
  const nonDateSections = pack.sections.filter((section) => section.kind !== 'date');
  const stagingBatchId = 'staging:non-date-sections';
  const rootTitle = `Import: ${path.basename(pack.source.path).replace(/\.[^.]+$/u, '')}`;
  const batches = [
    ...dateSections.map(({ section, batchId, parts }) => ({
      batchId,
      target: { kind: 'date' as const, ...parts },
      nodes: section.nodes.map(importNodeToCreateNodeTree),
    })),
    ...(nonDateSections.length > 0 ? [{
      batchId: stagingBatchId,
      target: { kind: 'node' as const, parentId },
      nodes: [treeNode(rootTitle, nonDateSections.map((section) =>
        treeNode(section.title, section.nodes.map(importNodeToCreateNodeTree))))],
    }] : []),
  ];
  const yieldEveryNodes = importYieldEveryNodesForStats(pack.stats);
  const outcome = await host.createImportTreeBatchesYielding(batches, {
    origin: 'agent',
    operationId,
    tool: toolName,
    summary: `Imported ${pack.stats.nodes} cleaned nodes into native Daily Notes.`,
    causation,
  }, {
    yieldEveryNodes,
    commitEveryNodes: yieldEveryNodes,
  });
  const resultsByBatchId = new Map(outcome.batches.map((result) => [result.batchId, result]));
  const dailyTargets = dateSections.map(({ section, batchId }): ImportDailyTarget => {
    const result = resultsByBatchId.get(batchId);
    if (!result) throw new Error(`Import host omitted batch result: ${batchId}`);
    return {
      sectionId: section.id,
      date: section.date!,
      dayNodeId: result.parentId,
      dayNodeCreated: result.parentCreated,
      createdRootIds: result.rootIds,
    };
  });
  const stagingResult = resultsByBatchId.get(stagingBatchId);
  const stagingRootId = stagingResult?.rootIds[0];
  if (nonDateSections.length > 0 && !stagingRootId) {
    throw new Error('Import did not create a staging root for non-date sections.');
  }
  return {
    createdRootIds: [
      ...dailyTargets.flatMap((target) => target.createdRootIds),
      ...(stagingRootId ? [stagingRootId] : []),
    ],
    dailyTargets,
    ...(stagingRootId ? { stagingRootId } : {}),
  };
}

export function importYieldEveryNodesForStats(stats: Pick<ImportStats, 'nodes' | 'fields'>): number {
  const importedNodes = Math.max(1, stats.nodes);
  const averageFieldsPerNode = Math.max(0, stats.fields) / importedNodes;
  // Each imported field creates a fieldEntry and a value/reference child in
  // addition to the visible outline node. Keep the approximate touched-node
  // count per chunk stable, so field-heavy imports yield more often without
  // penalizing plain large outlines.
  const estimatedTouchedNodesPerImportedNode = 1 + (averageFieldsPerNode * 2);
  const chunk = Math.floor(IMPORT_TARGET_TOUCHED_NODES_PER_CHUNK / estimatedTouchedNodesPerImportedNode);
  return Math.max(
    IMPORT_MIN_YIELD_EVERY_NODES,
    Math.min(IMPORT_MAX_YIELD_EVERY_NODES, chunk),
  );
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

function verifyNativeDailyImport(
  host: OutlinerToolHost,
  materialized: NativeDailyMaterialization,
  expectedStats: ImportStats,
): ImportVerification {
  const index = indexProjection(host.getProjection());
  const stagingSectionIds = materialized.stagingRootId
    ? normalChildIds(index, materialized.stagingRootId, false)
    : [];
  const actual = {
    sections: materialized.dailyTargets.length + stagingSectionIds.length,
    nodes: 0,
    descriptions: 0,
    tags: 0,
    fields: 0,
    checked: 0,
  };
  for (const target of materialized.dailyTargets) {
    for (const nodeId of target.createdRootIds) collectImportedStats(index, nodeId, actual);
  }
  for (const sectionId of stagingSectionIds) {
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
