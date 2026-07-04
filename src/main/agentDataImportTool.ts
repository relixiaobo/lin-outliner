import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { plainText, type CreateNodeTree } from '../core/types';
import { checkedState, fieldReads, indexProjection, isInTrash, normalChildIds } from './agentNodeToolProjection';
import type { OutlinerToolHost } from './agentNodeTools';
import { LocalToolFailure, resolveAgentLocalReadPath, type AgentLocalWorkspaceContext } from './agentLocalTools';
import { agentToolResult, errorEnvelope, successEnvelope, type ToolEnvelope } from './agentToolEnvelope';
import { elapsed, errorMessage, jsonByteLength } from './agentNodeToolUtils';
import {
  validateImportPack,
  type ImportNode,
  type ImportPack,
  type ImportStats,
  type ImportWarning,
} from './agentDataImportPack';

interface DataImportInput {
  pack_file?: string;
  mode?: 'stage';
  parent_id?: string;
  dry_run?: boolean;
  confirmed_preview_id?: string;
}

interface DataImportResult {
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

interface ImportVerification {
  ok: boolean;
  expected: Pick<ImportStats, 'sections' | 'nodes' | 'descriptions' | 'tags' | 'fields' | 'checked'>;
  actual: Pick<ImportStats, 'sections' | 'nodes' | 'descriptions' | 'tags' | 'fields' | 'checked'>;
  mismatches: string[];
}

interface DataImportToolOptions {
  workspace?: AgentLocalWorkspaceContext;
  localFileRoot?: string;
}

interface LoadedPack {
  packFile: string;
  packHash: string;
  pack: ImportPack;
  warnings: ImportWarning[];
}

interface PreviewRecord {
  packFile: string;
  packHash: string;
  parentId: string;
  mode: 'stage';
  createdAt: number;
}

const DATA_IMPORT_TOOL = 'data_import';
const MAX_PACK_BYTES = 50 * 1024 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const IMPORT_YIELD_EVERY_NODES = 50;
const previewRecordsByHost = new WeakMap<OutlinerToolHost, Map<string, PreviewRecord>>();

export const DATA_IMPORT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['pack_file'],
  properties: {
    pack_file: {
      type: 'string',
      minLength: 1,
      description: 'Path to an Import Pack v1 JSON file produced by a data-cleanup adapter.',
    },
    mode: {
      type: 'string',
      enum: ['stage'],
      description: 'Import mode. v1 supports only stage, which creates one explicit staging root.',
    },
    parent_id: {
      type: 'string',
      minLength: 1,
      description: "Destination parent node id. Omit to stage under today's journal node.",
    },
    dry_run: {
      type: 'boolean',
      description: 'Validate and preview only; do not mutate the document.',
    },
    confirmed_preview_id: {
      type: 'string',
      minLength: 1,
      description: 'Preview id returned by a matching dry-run after the user approves the preview.',
    },
  },
} as const;

export function createDataImportTool(host: OutlinerToolHost, options: DataImportToolOptions = {}): AgentTool<any, ToolEnvelope<DataImportResult>> {
  const previewRecords = previewRecordsForHost(host);

  return {
    name: DATA_IMPORT_TOOL,
    label: 'Data Import',
    description: [
      'Import cleaned external data into Tenon from an Import Pack v1 JSON file.',
      'Use dry_run first, show the preview/stats/warnings to the user, then call again with confirmed_preview_id only after approval.',
      'This is the only bulk write path for data-cleanup imports; adapter scripts must not create nodes directly.',
    ].join(' '),
    parameters: DATA_IMPORT_PARAMETERS,
    executionMode: 'sequential',
    execute: async (_toolCallId, rawParams: unknown) => {
      const started = Date.now();
      const params = normalizeDataImportInput(rawParams);
      if ('error' in params) {
        return agentToolResult(errorEnvelope<DataImportResult>(DATA_IMPORT_TOOL, 'invalid_args', params.error, {
          instructions: 'Call data_import with pack_file, dry_run true for preview, then confirmed_preview_id for the write.',
          metrics: { durationMs: elapsed(started) },
        }));
      }

      try {
        const loaded = await loadImportPack(params.pack_file, options);
        const projection = host.getProjection();
        const index = indexProjection(projection);
        const parentId = params.parent_id ?? projection.todayId;
        const parent = index.nodes.get(parentId);
        if (!parent || isInTrash(index, parentId)) {
          return agentToolResult(errorEnvelope<DataImportResult>(DATA_IMPORT_TOOL, 'invalid_destination', `Destination parent node is not available: ${parentId}`, {
            instructions: 'Choose a visible destination parent node and run data_import dry_run again.',
            metrics: { durationMs: elapsed(started) },
          }));
        }

        if (params.dry_run) {
          const previewId = `preview:${randomUUID()}`;
          previewRecords.set(previewId, {
            packFile: loaded.packFile,
            packHash: loaded.packHash,
            parentId,
            mode: params.mode,
            createdAt: Date.now(),
          });
          cleanupPreviewRecords(previewRecords);
          const data = resultForPreview(loaded, previewId);
          return agentToolResult(successEnvelope(DATA_IMPORT_TOOL, data, {
            status: 'unchanged',
            warnings: loaded.warnings.map((warning) => `${warning.code}: ${warning.message}`),
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }), visibleDataImportResult(data));
        }

        const previewError = validatePreview(previewRecords, params.confirmed_preview_id, {
          packFile: loaded.packFile,
          packHash: loaded.packHash,
          parentId,
          mode: params.mode,
        });
        if (previewError) {
          return agentToolResult(errorEnvelope<DataImportResult>(DATA_IMPORT_TOOL, previewError.code, previewError.message, {
            instructions: 'Run data_import with dry_run true again, review the preview, then retry with the returned preview id.',
            metrics: { durationMs: elapsed(started) },
          }));
        }

        const materialized = host.createNodesFromTreeYielding
          ? await materializeImportPack(host, loaded.pack, parentId)
          : host.transaction
            ? await host.transaction({ origin: 'agent', tool: DATA_IMPORT_TOOL, summary: `Imported ${loaded.pack.stats.nodes} cleaned nodes.` }, async () =>
              materializeImportPack(host, loaded.pack, parentId))
            : await materializeImportPack(host, loaded.pack, parentId);
        const stagingRootId = materialized.createdRootIds[0];
        if (!stagingRootId) throw new Error('Import did not create a staging root.');
        const verification = verifyImportedSubtree(host, stagingRootId, loaded.pack.stats);
        const data: DataImportResult = {
          importId: `import:${randomUUID()}`,
          stagingRootId,
          sectionCount: loaded.pack.stats.sections,
          nodeCount: loaded.pack.stats.nodes,
          createdRootIds: materialized.createdRootIds,
          warnings: loaded.warnings,
          stats: loaded.pack.stats,
          verification,
        };
        if (!verification.ok) {
          return agentToolResult(errorEnvelope<DataImportResult>(DATA_IMPORT_TOOL, 'verification_failed', 'Import wrote a staging subtree, but post-import verification found mismatched counts.', {
            data,
            instructions: 'Inspect the staging root, use operation_history to undo if needed, and report the mismatch before retrying.',
            warnings: verification.mismatches,
            metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
          }), visibleDataImportResult(data));
        }
        return agentToolResult(successEnvelope(DATA_IMPORT_TOOL, data, {
          warnings: loaded.warnings.map((warning) => `${warning.code}: ${warning.message}`),
          metrics: { durationMs: elapsed(started), outputBytes: jsonByteLength(data) },
        }), visibleDataImportResult(data));
      } catch (error) {
        const failure = error instanceof LocalToolFailure
          ? { code: error.code, message: error.message, instructions: error.instructions }
          : { code: 'import_failed', message: errorMessage(error), instructions: 'Inspect the Import Pack and rerun data_import dry_run before retrying.' };
        return agentToolResult(errorEnvelope<DataImportResult>(DATA_IMPORT_TOOL, failure.code, failure.message, {
          instructions: failure.instructions,
          metrics: { durationMs: elapsed(started) },
        }));
      }
    },
  };
}

function previewRecordsForHost(host: OutlinerToolHost): Map<string, PreviewRecord> {
  const existing = previewRecordsByHost.get(host);
  if (existing) return existing;
  const records = new Map<string, PreviewRecord>();
  previewRecordsByHost.set(host, records);
  return records;
}

function normalizeDataImportInput(rawParams: unknown): Required<Pick<DataImportInput, 'pack_file' | 'mode' | 'dry_run'>> & Pick<DataImportInput, 'parent_id' | 'confirmed_preview_id'> | { error: string } {
  const params = rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams) ? rawParams as DataImportInput : {};
  const packFile = typeof params.pack_file === 'string' ? params.pack_file.trim() : '';
  if (!packFile) return { error: 'pack_file is required.' };
  const mode = params.mode ?? 'stage';
  if (mode !== 'stage') return { error: 'mode must be "stage".' };
  const parentId = typeof params.parent_id === 'string' && params.parent_id.trim() ? params.parent_id.trim() : undefined;
  const confirmedPreviewId = typeof params.confirmed_preview_id === 'string' && params.confirmed_preview_id.trim()
    ? params.confirmed_preview_id.trim()
    : undefined;
  return {
    pack_file: packFile,
    mode,
    dry_run: params.dry_run === true,
    ...(parentId ? { parent_id: parentId } : {}),
    ...(confirmedPreviewId ? { confirmed_preview_id: confirmedPreviewId } : {}),
  };
}

async function loadImportPack(packFileInput: string, options: DataImportToolOptions): Promise<LoadedPack> {
  const packFile = resolvePackFilePath(packFileInput, options);
  const info = await stat(packFile);
  if (!info.isFile()) throw new LocalToolFailure('invalid_pack_file', `Import Pack path is not a file: ${packFile}`);
  if (info.size > MAX_PACK_BYTES) throw new LocalToolFailure('pack_too_large', `Import Pack is too large: ${info.size} bytes.`);
  const raw = await readFile(packFile, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LocalToolFailure('invalid_json', `Import Pack is not valid JSON: ${errorMessage(error)}`);
  }
  const validation = validateImportPack(parsed);
  if (!validation.ok) throw new LocalToolFailure(validation.code, validation.message);
  return {
    packFile,
    packHash: createHash('sha256').update(raw).digest('hex'),
    pack: validation.pack,
    warnings: validation.pack.warnings,
  };
}

function resolvePackFilePath(packFileInput: string, options: DataImportToolOptions): string {
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

function resultForPreview(loaded: LoadedPack, previewId: string): DataImportResult {
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
): { code: string; message: string } | null {
  if (!previewId) return { code: 'preview_required', message: 'confirmed_preview_id is required for non-dry-run import.' };
  const record = previewRecords.get(previewId);
  if (!record || Date.now() - record.createdAt > PREVIEW_TTL_MS) {
    previewRecords.delete(previewId);
    return { code: 'preview_expired', message: 'The confirmed preview id is missing or expired.' };
  }
  if (
    record.packFile !== expected.packFile
    || record.packHash !== expected.packHash
    || record.parentId !== expected.parentId
    || record.mode !== expected.mode
  ) {
    return { code: 'preview_mismatch', message: 'The confirmed preview id does not match the current pack, destination, or mode.' };
  }
  previewRecords.delete(previewId);
  return null;
}

function cleanupPreviewRecords(previewRecords: Map<string, PreviewRecord>): void {
  const now = Date.now();
  for (const [id, record] of previewRecords) {
    if (now - record.createdAt > PREVIEW_TTL_MS) previewRecords.delete(id);
  }
}

async function materializeImportPack(
  host: OutlinerToolHost,
  pack: ImportPack,
  parentId: string,
): Promise<{ createdRootIds: string[] }> {
  const rootTree = importPackToCreateNodeTree(pack);
  const meta = {
    origin: 'agent',
    tool: DATA_IMPORT_TOOL,
    summary: `Created import staging tree for ${pack.stats.nodes} cleaned nodes.`,
  } as const;
  const outcome = host.createNodesFromTreeYielding
    ? await host.createNodesFromTreeYielding(parentId, [rootTree], meta, {
      yieldEveryNodes: IMPORT_YIELD_EVERY_NODES,
      commitEveryNodes: IMPORT_YIELD_EVERY_NODES,
    })
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

function visibleDataImportResult(data: DataImportResult): unknown {
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
