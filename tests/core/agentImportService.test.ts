import { describe, expect, test } from 'bun:test';
import { execFile as execFileCallback } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import type { AgentMutationCausation } from '../../src/core/agent/protocol';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { ImportPack } from '../../src/main/agent/capabilities/agentDataImportPack';
import { AgentImportApiServer, type ImportApiDescriptor, type ImportApiResponse } from '../../src/main/agent/capabilities/agentImportApi';
import { AgentImportService, importYieldEveryNodesForStats, resolvePackFilePath } from '../../src/main/agent/capabilities/agentImportService';
import {
  createAgentLocalWorkspaceContext,
  createLocalTools,
  type BashData,
} from '../../src/main/agent/capabilities/agentLocalTools';
import {
  checkedState,
  fieldReads,
  indexProjection,
  normalChildIds,
} from '../../src/main/agent/capabilities/agentNodeToolProjection';
import type { OutlinerToolHost } from '../../src/main/agent/capabilities/agentNodeTools';
import type { ToolEnvelope } from '../../src/main/agent/capabilities/agentToolEnvelope';
import { ToolRuntime } from '../../src/main/agent/runtime/ToolRuntime';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';
import {
  TENON_IMPORT_CAUSATION_TOKEN_ENV,
  TENON_IMPORT_CAUSATION_TOKEN_HEADER,
} from '../../src/main/tenonImportProtocol';
import {
  resolveTenonImportRuntime,
  TENON_IMPORT_API_DESCRIPTOR_ENV,
  TENON_IMPORT_CLI_ENTRY_ENV,
  TENON_IMPORT_CLI_RUNTIME_ENV,
} from '../../src/main/tenonImportRuntime';
import { createTenonImportShellEnvironmentProvider } from '../../src/main/tenonImportShellEnvironment';

const execFile = promisify(execFileCallback);
const TENON_IMPORT_TOOL = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'main',
  'builtInSkills',
  'tenon-import',
  'scripts',
  'tenon-import.ts',
);
const IMPORT_CAUSATION = {
  threadId: 'thread:import-test',
  turnId: 'turn:import-test',
  itemId: 'item:import-test',
} as const;
const ROOT_CONFIGURATION = {
  profileName: 'tenon-import-integration',
  developerInstructions: [],
  model: 'test-model',
  reasoningEffort: 'medium',
  tools: ['bash'],
  skills: [],
  preloadedSkills: [],
  plugins: [],
  mcpServers: [],
} as const satisfies EffectiveThreadConfiguration;

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    getTextSearchIndex: () => buildTextSearchIndex(core.projection()),
    transaction: async (meta, fn) => core.transaction(meta.origin ?? 'agent', fn, meta),
    createNodesFromTreeYielding: async (parentId, nodes, meta, options) => {
      const focus = await core.transaction(meta.origin ?? 'agent', () =>
        core.createNodesFromTreeYieldingFocus(parentId, nodes, {
          yieldEveryNodes: options?.yieldEveryNodes,
          commitEveryNodes: options?.commitEveryNodes,
        }), meta);
      return focus ? { focus } : {};
    },
    createImportTreeBatchesYielding: async (batches, meta, options) => {
      const nodeIdsBefore = new Set(core.projection().nodes.map((node) => node.id));
      const undoGroupStarted = core.beginUndoGroup();
      try {
        return await core.transaction(meta.origin ?? 'agent', async () => {
          const resolved = batches.map((batch) => {
            const parentId = batch.target.kind === 'date'
              ? core.ensureDateNode(batch.target.year, batch.target.month, batch.target.day).focus?.nodeId
              : batch.target.parentId;
            if (!parentId) throw new Error(`Test import host did not resolve ${batch.batchId}`);
            return { batch, parentId };
          });
          const rootIds = resolved.map((): string[] => []);
          await core.createNodeTreeBatchesYieldingFocus(
            resolved.map(({ batch, parentId }) => ({ parentId, nodes: batch.nodes })),
            {
              yieldEveryNodes: options?.yieldEveryNodes,
              commitEveryNodes: options?.commitEveryNodes,
              onRootCreated: (batchIndex, nodeId) => rootIds[batchIndex]!.push(nodeId),
            },
          );
          return {
            batches: resolved.map(({ batch, parentId }, index) => ({
              batchId: batch.batchId,
              parentId,
              parentCreated: batch.target.kind === 'date' && !nodeIdsBefore.has(parentId),
              rootIds: rootIds[index]!,
            })),
          };
        }, meta);
      } finally {
        if (undoGroupStarted) core.endUndoGroup();
      }
    },
    handle: async (command, args = {}, meta = {}) => {
      const run = () => {
        if (command === 'create_node') return core.createNode(String(args.parentId), nullableNumber(args.index), String(args.text ?? ''));
        if (command === 'create_rich_text_node') return core.createRichTextContentNode(String(args.parentId), nullableNumber(args.index), args.content as any);
        if (command === 'create_nodes_from_tree') return core.createNodesFromTree(String(args.parentId), Array.isArray(args.nodes) ? args.nodes as any : []);
        if (command === 'update_node_description') return core.updateNodeDescription(String(args.nodeId), nullableString(args.description));
        if (command === 'set_code_block') return core.setCodeBlock(String(args.nodeId), nullableString(args.codeLanguage) ?? undefined);
        if (command === 'set_node_checkbox_visible') return core.setNodeCheckboxVisible(String(args.nodeId), Boolean(args.visible));
        if (command === 'toggle_done') return core.toggleDone(String(args.nodeId));
        if (command === 'create_tag') return core.createTag(String(args.name ?? ''));
        if (command === 'apply_tag') return core.applyTag(String(args.nodeId), String(args.tagId));
        if (command === 'create_inline_field') return core.createInlineField(String(args.parentId), nullableNumber(args.index), String(args.name), 'plain');
        if (command === 'add_reference') return core.addReference(String(args.parentId), String(args.targetId), nullableNumber(args.index));
        throw new Error(`unsupported test command: ${command}`);
      };
      return meta.origin ? core.withOrigin(meta.origin, run) : run();
    },
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function writePack(root: string, pack: ImportPack): Promise<string> {
  const filePath = path.join(root, 'pack.json');
  await writeFile(filePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  return filePath;
}

async function callImportApi(
  descriptor: ImportApiDescriptor,
  pathname: '/preview' | '/commit',
  body: Record<string, unknown>,
  causationToken?: string,
): Promise<ImportApiResponse> {
  const payload = `${JSON.stringify(body)}\n`;
  return await new Promise<ImportApiResponse>((resolve, reject) => {
    const request = httpRequest({
      socketPath: descriptor.socketPath,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        ...(causationToken ? { [TENON_IMPORT_CAUSATION_TOKEN_HEADER]: causationToken } : {}),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(text) as ImportApiResponse);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function createImportService(core: Core, root: string): AgentImportService {
  const workspace = createAgentLocalWorkspaceContext(root);
  return new AgentImportService(hostFor(core), { workspace, toolName: 'tenon-import' });
}

function verificationMismatchHost(core: Core, targetTitle = 'Launch'): OutlinerToolHost {
  const base = hostFor(core);
  let materialized = false;
  return {
    ...base,
    getProjection: () => {
      const projection = base.getProjection();
      if (!materialized) return projection;
      return {
        ...projection,
        nodes: projection.nodes.map((node) => node.content.text === targetTitle
          ? { ...node, description: '' }
          : node),
      };
    },
    createNodesFromTreeYielding: async (...args) => {
      const result = await base.createNodesFromTreeYielding!(...args);
      materialized = true;
      return result;
    },
    createImportTreeBatchesYielding: async (...args) => {
      const result = await base.createImportTreeBatchesYielding!(...args);
      materialized = true;
      return result;
    },
  };
}

function stagingRoots(core: Core): string[] {
  return core.projection().nodes
    .filter((node) => node.content.text.startsWith('Import: '))
    .map((node) => node.id);
}

function previewIdFromResponse(response: ImportApiResponse): string {
  expect(response).toMatchObject({ ok: true, data: { status: 'previewed' } });
  if (response.data?.status !== 'previewed') throw new Error('Expected an import preview response.');
  return response.data.previewId;
}

function samplePack(): ImportPack {
  return {
    version: 1,
    source: {
      kind: 'tana',
      path: '/exports/sample.tana.json',
      sourceId: 'sample',
    },
    options: {
      fidelity: 'clean',
      dateGrouping: 'stage_headings',
      tags: true,
      fields: 'field_rows',
      doneState: true,
    },
    stats: {
      sourceRecords: 4,
      sections: 1,
      nodes: 3,
      descriptions: 1,
      tags: 1,
      fields: 1,
      checked: 1,
      dropped: 1,
    },
    coverage: {
      imported: 3,
      merged: 0,
      dropped: 1,
      unsupported: 0,
      empty: 0,
      unaccounted: 0,
    },
    warnings: [{
      code: 'trash_node',
      message: '1 source record was in Trash.',
      count: 1,
    }],
    sections: [{
      id: 'library',
      title: 'Library',
      kind: 'library',
      nodes: [{
        title: 'Launch',
        description: 'Q2 rollout',
        tags: ['project'],
        checked: true,
        fields: [{ name: 'Status', values: ['Active'] }],
        sourceId: 'n1',
        children: [{
          title: 'Draft plan',
          sourceId: 'n2',
        }],
      }, {
        title: 'Snippet',
        code: { language: 'typescript', text: 'const x = 1;' },
        sourceId: 'n3',
      }],
    }],
  };
}

function nativeDailyPack(): ImportPack {
  return {
    version: 1,
    source: {
      kind: 'tana',
      path: '/exports/daily.tana.json',
      sourceId: 'daily-sample',
    },
    options: {
      fidelity: 'clean',
      dateGrouping: 'native_daily',
      tags: false,
      fields: 'omit',
      doneState: false,
    },
    stats: {
      sourceRecords: 4,
      sections: 3,
      nodes: 4,
      descriptions: 0,
      tags: 0,
      fields: 0,
      checked: 0,
      dropped: 0,
    },
    coverage: {
      imported: 4,
      merged: 0,
      dropped: 0,
      unsupported: 0,
      empty: 0,
      unaccounted: 0,
    },
    warnings: [],
    sections: [{
      id: 'day-2026-08-20',
      title: '2026-08-20',
      kind: 'date',
      date: '2026-08-20',
      nodes: [{
        title: 'Imported existing-day root',
        children: [{ title: 'Imported child' }],
      }],
    }, {
      id: 'day-2026-08-21',
      title: '2026-08-21',
      kind: 'date',
      date: '2026-08-21',
      nodes: [{ title: 'Imported new-day root' }],
    }, {
      id: 'library',
      title: 'Tana Workspace',
      kind: 'library',
      nodes: [{ title: 'Library root' }],
    }],
  };
}

function largeNativeDailyPack(dateCount = 102, nodesPerDate = 120): ImportPack {
  const sections = Array.from({ length: dateCount }, (_value, dateIndex) => {
    const date = new Date(2025, 0, dateIndex + 1);
    const dateText = [
      String(date.getFullYear()).padStart(4, '0'),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
    return {
      id: `day-${dateText}`,
      title: dateText,
      kind: 'date' as const,
      date: dateText,
      nodes: Array.from({ length: nodesPerDate }, (_nodeValue, nodeIndex) => ({
        title: `Imported ${dateText} row ${nodeIndex + 1}`,
      })),
    };
  });
  const nodes = dateCount * nodesPerDate;
  return {
    version: 1,
    source: { kind: 'tana', path: '/exports/large-daily.tana.json' },
    options: {
      fidelity: 'content',
      dateGrouping: 'native_daily',
      tags: false,
      fields: 'omit',
      doneState: false,
    },
    stats: {
      sourceRecords: nodes,
      sections: dateCount,
      nodes,
      descriptions: 0,
      tags: 0,
      fields: 0,
      checked: 0,
      dropped: 0,
    },
    coverage: {
      imported: nodes,
      merged: 0,
      dropped: 0,
      unsupported: 0,
      empty: 0,
      unaccounted: 0,
    },
    warnings: [],
    sections,
  };
}

function rootRuntimeService(): ThreadService {
  return {
    collaborationToolContributions: () => [],
    extensionToolContributions: async () => [],
    subagentExecution: () => null,
    notifyToolStarted: async () => {},
    notifyToolCompleted: async () => {},
  } as unknown as ThreadService;
}

interface ImportCliResponse {
  readonly ok: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

type AuditedBashEnvelope = ToolEnvelope<BashData> & {
  readonly capabilityAudit?: {
    readonly behavior?: string;
    readonly descriptors?: ReadonlyArray<{ readonly actionKind?: string }>;
  };
};

function cliResponse(envelope: ToolEnvelope<BashData>): ImportCliResponse {
  if (!envelope.ok) {
    throw new Error(`Tenon import Bash command failed: ${JSON.stringify(envelope)}`);
  }
  return JSON.parse(envelope.data?.stdout ?? '{}') as ImportCliResponse;
}

describe('Tenon import service', () => {
  test('scales import yield chunks by estimated field materialization cost', () => {
    expect(importYieldEveryNodesForStats({ nodes: 20_000, fields: 0 })).toBe(50);
    expect(importYieldEveryNodesForStats({ nodes: 5_000, fields: 5_000 })).toBe(16);
    expect(importYieldEveryNodesForStats({ nodes: 5_000, fields: 10_000 })).toBe(10);
  });

  test('resolves absolute pack files outside the Thread working directory under Full Access', async () => {
    const workdir = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-workdir-'));
    const sourceDir = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-source-'));
    try {
      const sourcePath = path.join(sourceDir, 'pack.json');
      await writeFile(sourcePath, '{}', 'utf8');
      expect(resolvePackFilePath(sourcePath, { localFileRoot: workdir })).toBe(sourcePath);
    } finally {
      await Promise.all([
        rm(workdir, { recursive: true, force: true }),
        rm(sourceDir, { recursive: true, force: true }),
      ]);
    }
  });

  test('requires a matching dry-run preview and stages a validated Import Pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-'));
    try {
      const packFile = await writePack(root, samplePack());
      const core = Core.new();
      const importService = createImportService(core, root);

      await expect(importService.commitFromFile({ packFile: 'pack.json', causation: IMPORT_CAUSATION }))
        .rejects.toMatchObject({ code: 'preview_required' });

      const dryRun = await importService.previewFromFile({ packFile: 'pack.json' });
      expect(dryRun).toMatchObject({
        sectionCount: 1,
        nodeCount: 3,
        createdRootIds: [],
        stats: samplePack().stats,
      });
      expect(dryRun.previewId).toStartWith('preview:');

      const otherParentId = core.createNode(core.projection().todayId, null, 'Other destination').focus!.nodeId;
      await expect(importService.commitFromFile({
        packFile: 'pack.json',
        parentId: otherParentId,
        previewId: dryRun.previewId,
        causation: IMPORT_CAUSATION,
      })).rejects.toMatchObject({ code: 'preview_mismatch' });

      const secondDryRun = await importService.previewFromFile({ packFile: 'pack.json' });
      const imported = await importService.commitFromFile({
        packFile: 'pack.json',
        previewId: secondDryRun.previewId,
        causation: IMPORT_CAUSATION,
      });
      expect(imported.status).toBe('staged');
      expect(imported.verification).toMatchObject({ ok: true });
      expect(imported.createdRootIds).toHaveLength(1);

      const history = core.operationHistory({ action: 'list', origin: 'agent' });
      expect(history.items?.[0]).toMatchObject({
        operationId: imported.operationId,
        tool: 'tenon-import',
        summary: 'Created import staging tree for 3 cleaned nodes.',
        causation: IMPORT_CAUSATION,
        canUndo: true,
      });

      const index = indexProjection(core.projection());
      const stagingRoot = index.nodes.get(imported.stagingRootId!)!;
      expect(stagingRoot.content.text).toBe('Import: sample.tana');

      const sectionId = normalChildIds(index, stagingRoot.id, false)[0]!;
      expect(index.nodes.get(sectionId)?.content.text).toBe('Library');
      const [launchId, codeId] = normalChildIds(index, sectionId, false);
      const launch = index.nodes.get(launchId!)!;
      const code = index.nodes.get(codeId!)!;

      expect(launch.content.text).toBe('Launch');
      expect(launch.description).toBe('Q2 rollout');
      expect(checkedState(index, launch)).toBe(true);
      expect(launch.tags.map((tagId) => index.nodes.get(tagId)?.content.text)).toEqual(['project']);
      expect(fieldReads(index, launch, false)).toEqual([{
        name: 'Status',
        type: 'plain',
        values: [{ text: 'Active', valueNodeId: expect.any(String) }],
        fieldEntryId: expect.any(String),
      }]);
      const launchChildId = normalChildIds(index, launch.id, false)[0]!;
      expect(index.nodes.get(launchChildId)?.content.text).toBe('Draft plan');
      expect(code).toMatchObject({
        type: 'codeBlock',
        codeLanguage: 'typescript',
        content: { text: 'const x = 1;' },
      });

      expect(core.operationHistory({
        action: 'undo',
        origin: 'agent',
        operationId: imported.operationId,
      }).count).toBe(1);
      expect(core.state().nodes[imported.stagingRootId]).toBeUndefined();
      expect(core.operationHistory({
        action: 'redo',
        origin: 'agent',
        operationId: imported.operationId,
      }).count).toBe(1);
      expect(core.state().nodes[imported.stagingRootId]).toBeDefined();

      const laterNodeId = (await core.transaction('agent', async () =>
        core.createNode(core.projection().todayId, null, 'Later Agent change'), {
        operationId: 'op:later-agent-change',
        tool: 'node_create',
      })).focus!.nodeId;
      expect(core.operationHistory({
        action: 'undo',
        origin: 'agent',
        operationId: imported.operationId,
      }).count).toBe(0);
      expect(core.state().nodes[imported.stagingRootId]).toBeDefined();
      expect(core.state().nodes[laterNodeId]).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('previews and atomically appends mixed packs to existing and new Daily Notes', async () => {
    const core = Core.new();
    const existingDayId = core.ensureDateNode(2026, 8, 20).focus!.nodeId;
    const existingChildId = core.createNode(existingDayId, null, 'Existing Daily Note content').focus!.nodeId;
    const service = new AgentImportService(hostFor(core), { toolName: 'tenon-import' });
    const packContent = JSON.stringify(nativeDailyPack());

    const preview = await service.previewFromContent({ packContent });
    expect(preview).toMatchObject({
      status: 'previewed',
      mode: 'native_daily',
      dailySummary: {
        dateSectionCount: 2,
        dateCount: 2,
        existingDateCount: 1,
        newDateCount: 1,
        nonDateSectionCount: 1,
        firstDate: '2026-08-20',
        lastDate: '2026-08-21',
      },
      warnings: [expect.objectContaining({ code: 'native_daily_append_only' })],
    });
    expect(core.state().nodes[existingChildId]?.content.text).toBe('Existing Daily Note content');

    const imported = await service.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    });
    if (imported.status !== 'imported_daily') throw new Error('Expected a native Daily Notes import.');
    const stagingRootId = imported.stagingRootId;
    expect(typeof stagingRootId).toBe('string');
    expect(imported).toMatchObject({
      mode: 'native_daily',
      verification: { ok: true },
      dailyTargets: [{
        date: '2026-08-20',
        dayNodeId: existingDayId,
        dayNodeCreated: false,
      }, {
        date: '2026-08-21',
        dayNodeCreated: true,
      }],
    });
    expect(imported.createdRootIds).toHaveLength(3);

    const index = indexProjection(core.projection());
    expect(normalChildIds(index, existingDayId, false).map((nodeId) => index.nodes.get(nodeId)?.content.text))
      .toEqual(['Existing Daily Note content', 'Imported existing-day root']);
    const newDay = imported.dailyTargets[1]!;
    expect(normalChildIds(index, newDay.dayNodeId, false).map((nodeId) => index.nodes.get(nodeId)?.content.text))
      .toEqual(['Imported new-day root']);
    expect(index.nodes.get(stagingRootId!)?.content.text).toBe('Import: daily.tana');
    const stagingSectionId = normalChildIds(index, stagingRootId!, false)[0]!;
    expect(index.nodes.get(stagingSectionId)?.content.text).toBe('Tana Workspace');

    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items?.[0]).toMatchObject({
      operationId: imported.operationId,
      summary: 'Imported 4 cleaned nodes into native Daily Notes.',
      canUndo: true,
    });
    expect(core.operationHistory({
      action: 'undo',
      origin: 'agent',
      operationId: imported.operationId,
    }).count).toBe(1);
    expect(core.state().nodes[existingDayId]).toBeDefined();
    expect(core.state().nodes[existingChildId]?.content.text).toBe('Existing Daily Note content');
    expect(core.state().nodes[newDay.dayNodeId]).toBeUndefined();
    expect(core.state().nodes[stagingRootId!]).toBeUndefined();
    for (const rootId of imported.createdRootIds) expect(core.state().nodes[rootId]).toBeUndefined();
  });

  test('binds preview identity to native_daily mode and preserves explicit stage mode', async () => {
    const core = Core.new();
    const service = new AgentImportService(hostFor(core));
    const packContent = JSON.stringify(nativeDailyPack());
    const nativePreview = await service.previewFromContent({ packContent });

    await expect(service.commitFromContent({
      packContent,
      mode: 'stage',
      previewId: nativePreview.previewId,
      causation: IMPORT_CAUSATION,
    })).rejects.toMatchObject({ code: 'preview_mismatch' });
    expect(stagingRoots(core)).toEqual([]);

    const stagePreview = await service.previewFromContent({ packContent, mode: 'stage' });
    expect(stagePreview.mode).toBe('stage');
    expect(stagePreview.dailySummary).toBeUndefined();
    const staged = await service.commitFromContent({
      packContent,
      mode: 'stage',
      previewId: stagePreview.previewId,
      causation: IMPORT_CAUSATION,
    });
    expect(staged).toMatchObject({ status: 'staged', mode: 'stage', verification: { ok: true } });
    expect(stagingRoots(core)).toHaveLength(1);
    expect(core.projection().nodes.some((node) => node.content.text === '2026-08-21' && node.tags.length > 0)).toBe(false);
  });

  test('rejects native_daily before mutation when dates or the atomic host seam are unavailable', async () => {
    const core = Core.new();
    const service = new AgentImportService(hostFor(core));
    const projectionBefore = structuredClone(core.projection());

    await expect(service.previewFromContent({
      packContent: JSON.stringify(samplePack()),
      mode: 'native_daily',
    })).rejects.toMatchObject({ code: 'native_daily_requires_dates' });
    expect(core.projection()).toEqual(projectionBefore);

    const legacyHost: OutlinerToolHost = {
      ...hostFor(core),
      createImportTreeBatchesYielding: undefined,
    };
    const legacyService = new AgentImportService(legacyHost);
    const packContent = JSON.stringify(nativeDailyPack());
    const preview = await legacyService.previewFromContent({ packContent });
    await expect(legacyService.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    })).rejects.toMatchObject({ code: 'native_daily_unavailable' });
    expect(core.projection()).toEqual(projectionBefore);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toEqual([]);
  });

  test('re-imports native Daily Note packs by appending another copy', async () => {
    const core = Core.new();
    const service = new AgentImportService(hostFor(core));
    const packContent = JSON.stringify(nativeDailyPack());

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preview = await service.previewFromContent({ packContent });
      if (attempt === 1) {
        expect(preview.dailySummary).toMatchObject({ existingDateCount: 2, newDateCount: 0 });
      }
      const result = await service.commitFromContent({
        packContent,
        previewId: preview.previewId,
        causation: IMPORT_CAUSATION,
      });
      expect(result.status).toBe('imported_daily');
    }

    expect(core.projection().nodes.filter((node) => node.content.text === 'Imported existing-day root')).toHaveLength(2);
    expect(core.projection().nodes.filter((node) => node.content.text === 'Imported new-day root')).toHaveLength(2);
    expect(stagingRoots(core)).toHaveLength(2);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toHaveLength(2);
  });

  test('rolls back native Daily Note scaffolding and every committed chunk on failure', async () => {
    const core = Core.new();
    const base = hostFor(core);
    let yields = 0;
    const failingHost: OutlinerToolHost = {
      ...base,
      createImportTreeBatchesYielding: async (batches, meta) => {
        const nodeIdsBefore = new Set(core.projection().nodes.map((node) => node.id));
        const undoGroupStarted = core.beginUndoGroup();
        try {
          return await core.transaction(meta.origin ?? 'agent', async () => {
            const resolved = batches.map((batch) => {
              const parentId = batch.target.kind === 'date'
                ? core.ensureDateNode(batch.target.year, batch.target.month, batch.target.day).focus!.nodeId
                : batch.target.parentId;
              return { batch, parentId };
            });
            const rootIds = resolved.map((): string[] => []);
            await core.createNodeTreeBatchesYieldingFocus(
              resolved.map(({ batch, parentId }) => ({ parentId, nodes: batch.nodes })),
              {
                yieldEveryNodes: 1,
                commitEveryNodes: 1,
                yield: async () => {
                  yields += 1;
                  if (yields === 2) throw new Error('injected native daily chunk failure');
                },
                onRootCreated: (batchIndex, nodeId) => rootIds[batchIndex]!.push(nodeId),
              },
            );
            return {
              batches: resolved.map(({ batch, parentId }, index) => ({
                batchId: batch.batchId,
                parentId,
                parentCreated: batch.target.kind === 'date' && !nodeIdsBefore.has(parentId),
                rootIds: rootIds[index]!,
              })),
            };
          }, meta);
        } finally {
          if (undoGroupStarted) core.endUndoGroup();
        }
      },
    };
    const service = new AgentImportService(failingHost);
    const packContent = JSON.stringify(nativeDailyPack());
    const preview = await service.previewFromContent({ packContent });
    const projectionBefore = structuredClone(core.projection());

    await expect(service.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    })).rejects.toThrow('injected native daily chunk failure');

    expect(yields).toBe(2);
    expect(core.projection()).toEqual(projectionBefore);
    expect(stagingRoots(core)).toEqual([]);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toEqual([]);
  });

  test('imports 102 Daily Notes and 12,240 nodes as one verified operation', async () => {
    const core = Core.new();
    const service = new AgentImportService(hostFor(core));
    const pack = largeNativeDailyPack();
    const packContent = JSON.stringify(pack);
    const preview = await service.previewFromContent({ packContent });
    expect(preview.dailySummary).toMatchObject({
      dateSectionCount: 102,
      dateCount: 102,
      existingDateCount: 0,
      newDateCount: 102,
    });

    const imported = await service.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    });
    if (imported.status !== 'imported_daily') throw new Error('Expected a native Daily Notes import.');
    expect(imported.verification).toMatchObject({
      ok: true,
      actual: { sections: 102, nodes: 12_240 },
    });
    expect(imported.dailyTargets).toHaveLength(102);
    expect(imported.createdRootIds).toHaveLength(12_240);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toHaveLength(1);
  }, 30_000);

  test('rejects malformed packs before previewing or mutating', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-invalid-'));
    try {
      const pack = samplePack();
      pack.stats.nodes = 99;
      await writePack(root, pack);
      const importService = createImportService(Core.new(), root);
      await expect(importService.previewFromFile({ packFile: 'pack.json' }))
        .rejects.toMatchObject({ code: 'stats_mismatch' });

      const invalidDatePack = nativeDailyPack();
      invalidDatePack.sections[0]!.date = '2026-02-30';
      await expect(importService.previewFromContent({ packContent: JSON.stringify(invalidDatePack) }))
        .rejects.toMatchObject({ code: 'invalid_section' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects canonical duplicate tags and fields during preview without writing', async () => {
    const core = Core.new();
    const service = new AgentImportService(hostFor(core));
    const projectionBefore = structuredClone(core.projection());
    const duplicateTagPack = samplePack();
    duplicateTagPack.sections[0]!.nodes[0]!.tags = ['Project', ' project '];
    duplicateTagPack.stats.tags = 2;
    await expect(service.previewFromContent({ packContent: JSON.stringify(duplicateTagPack) }))
      .rejects.toMatchObject({ code: 'duplicate_tag' });

    const duplicateFieldPack = samplePack();
    duplicateFieldPack.sections[0]!.nodes[0]!.fields = [
      { name: 'Status', values: ['Active'] },
      { name: ' status ', values: ['Review'] },
    ];
    duplicateFieldPack.stats.fields = 2;
    await expect(service.previewFromContent({ packContent: JSON.stringify(duplicateFieldPack) }))
      .rejects.toMatchObject({ code: 'duplicate_field' });

    const multiValuePack = samplePack();
    multiValuePack.sections[0]!.nodes[0]!.fields![0]!.values.push('Review');
    await expect(service.previewFromContent({ packContent: JSON.stringify(multiValuePack) }))
      .resolves.toMatchObject({ status: 'previewed' });
    expect(core.projection()).toEqual(projectionBefore);
    expect(core.operationHistory({ action: 'list' }).items).toEqual([]);
  });

  test('rolls back every materialization chunk when a yielding import fails', async () => {
    const core = Core.new();
    const base = hostFor(core);
    const failingHost: OutlinerToolHost = {
      ...base,
      createNodesFromTreeYielding: async (parentId, nodes, meta) => {
        const focus = await core.transaction(meta.origin ?? 'agent', () =>
          core.createNodesFromTreeYieldingFocus(parentId, nodes, {
            yieldEveryNodes: 1,
            commitEveryNodes: 1,
            yield: async () => { throw new Error('injected import chunk failure'); },
          }), meta);
        return focus ? { focus } : {};
      },
    };
    const service = new AgentImportService(failingHost);
    const packContent = JSON.stringify(samplePack());
    const preview = await service.previewFromContent({ packContent });
    const projectionBefore = structuredClone(core.projection());

    await expect(service.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    })).rejects.toThrow('injected import chunk failure');

    expect(core.projection()).toEqual(projectionBefore);
    expect(core.operationHistory({ action: 'list' }).items).toEqual([]);
  });

  test('returns one retained staging root when post-import verification mismatches', async () => {
    const core = Core.new();
    const service = new AgentImportService(verificationMismatchHost(core));
    const packContent = JSON.stringify(samplePack());
    const preview = await service.previewFromContent({ packContent });
    const result = await service.commitFromContent({
      packContent,
      previewId: preview.previewId,
      causation: IMPORT_CAUSATION,
    });
    if (result.status !== 'staged_with_errors') throw new Error('Expected staged verification errors.');

    expect(result).toMatchObject({
      status: 'staged_with_errors',
      retryAllowed: false,
      stagingRootId: expect.any(String),
      operationId: expect.stringMatching(/^op:/),
      mismatches: ['descriptions: expected 1, actual 0'],
      verification: { ok: false },
    });
    expect(stagingRoots(core)).toEqual([result.stagingRootId]);
    expect(core.operationHistory({ action: 'list', origin: 'agent' }).items?.[0])
      .toMatchObject({ operationId: result.operationId, causation: IMPORT_CAUSATION });
  });

  test('local API preserves native Daily Note verification failure data', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'tenon-native-daily-mismatch-'));
    const core = Core.new();
    const pack = nativeDailyPack();
    pack.sections[0]!.nodes[0]!.description = 'Expected description';
    pack.stats.descriptions = 1;
    const packContent = JSON.stringify(pack);
    const service = new AgentImportService(
      verificationMismatchHost(core, 'Imported existing-day root'),
      { toolName: 'tenon-import' },
    );
    const api = new AgentImportApiServer(service, { userDataDir: userData });
    const descriptor = await api.start();
    try {
      const previewId = previewIdFromResponse(await callImportApi(descriptor, '/preview', { packContent }));
      const response = await callImportApi(descriptor, '/commit', {
        packContent,
        previewId,
      }, api.issueCausationToken(IMPORT_CAUSATION));

      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('verification_failed');
      expect(response.data?.status).toBe('imported_daily_with_errors');
      if (response.data?.status !== 'imported_daily_with_errors') {
        throw new Error('Expected native Daily Note verification failure data.');
      }
      expect(response.data.retryAllowed).toBe(false);
      expect(response.data.mismatches).toEqual(['descriptions: expected 1, actual 0']);
      expect(response.data.dailyTargets).toHaveLength(2);
      expect(response.data.createdRootIds).toHaveLength(3);
      expect(stagingRoots(core)).toHaveLength(1);
      expect(core.operationHistory({ action: 'list', origin: 'agent' }).items?.[0]?.operationId)
        .toBe(response.data.operationId);
    } finally {
      await api.stop();
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('local API requires one-time Item causation and never accepts raw causation', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-api-user-data-'));
    try {
      const packContent = `${JSON.stringify(samplePack(), null, 2)}\n`;
      const core = Core.new();
      const service = new AgentImportService(hostFor(core), { toolName: 'tenon-import' });
      let now = 1_000;
      const api = new AgentImportApiServer(service, {
        userDataDir: userData,
        now: () => now,
        causationTokenTtlMs: 10,
        maxCausationTokens: 1,
      });
      const descriptor = await api.start();
      try {
        const preview = await callImportApi(descriptor, '/preview', { packContent, packLabel: 'sample.tana.json' });
        const previewId = previewIdFromResponse(preview);
        expect(preview.data?.createdRootIds).toEqual([]);

        const missing = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        });
        expect(missing).toMatchObject({ ok: false, error: { code: 'causation_token_required' } });
        expect(stagingRoots(core)).toEqual([]);

        const evictedToken = api.issueCausationToken(IMPORT_CAUSATION);
        const retainedToken = api.issueCausationToken(IMPORT_CAUSATION);
        const evicted = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        }, evictedToken);
        expect(evicted).toMatchObject({ ok: false, error: { code: 'causation_token_invalid' } });
        expect(stagingRoots(core)).toEqual([]);

        const rawCausation = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
          threadId: 'thread:forged',
        }, retainedToken);
        expect(rawCausation).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
        expect(stagingRoots(core)).toEqual([]);

        const consumedAfterInvalidBody = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        }, retainedToken);
        expect(consumedAfterInvalidBody).toMatchObject({
          ok: false,
          error: { code: 'causation_token_invalid' },
        });
        expect(stagingRoots(core)).toEqual([]);

        const expiredToken = api.issueCausationToken(IMPORT_CAUSATION);
        now += 10;
        const expired = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        }, expiredToken);
        expect(expired).toMatchObject({ ok: false, error: { code: 'causation_token_expired' } });
        expect(stagingRoots(core)).toEqual([]);

        const causationToken = api.issueCausationToken(IMPORT_CAUSATION);
        const commit = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        }, causationToken);
        expect(commit.ok).toBe(true);
        expect(commit.data).toMatchObject({ status: 'staged', verification: { ok: true } });
        expect(stagingRoots(core)).toHaveLength(1);

        const replayed = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId,
        }, causationToken);
        expect(replayed).toMatchObject({ ok: false, error: { code: 'causation_token_invalid' } });
        expect(stagingRoots(core)).toHaveLength(1);
        expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toHaveLength(1);
      } finally {
        await api.stop();
      }
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });

  test('root Agent Bash commits through the Skill CLI with Item-bound causation', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'tenon-root-bash-import-user-data-'));
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'tenon-root-bash-import-workspace-'));
    try {
      const packFile = await writePack(workspaceRoot, samplePack());
      const previewFile = path.join(workspaceRoot, 'preview.md');
      const core = Core.new();
      const service = createImportService(core, workspaceRoot);
      const api = new AgentImportApiServer(service, { userDataDir: userData });
      await api.start();
      try {
        const cli = resolveTenonImportRuntime({
          isPackaged: false,
          moduleDir: path.resolve(import.meta.dir, '..', '..', 'src', 'main'),
          resourcesPath: path.join(path.sep, 'unused'),
          processExecPath: path.join(path.sep, 'unused', 'Tenon'),
        });
        const issuedCausation: AgentMutationCausation[] = [];
        const processEnvironment = createTenonImportShellEnvironmentProvider({
          threadId: IMPORT_CAUSATION.threadId,
          turnId: IMPORT_CAUSATION.turnId,
          baseEnvironment: async () => ({
            env: {
              [TENON_IMPORT_API_DESCRIPTOR_ENV]: api.descriptorPath,
              [TENON_IMPORT_CLI_ENTRY_ENV]: cli.cliEntry,
              [TENON_IMPORT_CLI_RUNTIME_ENV]: cli.cliRuntime,
            },
            leadingToolPathSegments: [cli.binDir],
          }),
          issueCausationToken: (causation) => {
            issuedCausation.push(causation);
            return api.issueCausationToken(causation);
          },
        });
        const workspace = createAgentLocalWorkspaceContext(
          workspaceRoot,
          undefined,
          undefined,
          processEnvironment,
        );
        const runtime = new ToolRuntime(rootRuntimeService(), {
          capabilityTools: () => createLocalTools({ workspace }),
          capabilityConfig: { blocks: [] },
        });
        const context = {
          thread: {
            id: IMPORT_CAUSATION.threadId,
            parentThreadId: null,
            cwd: workspaceRoot,
          },
          turn: { id: IMPORT_CAUSATION.turnId },
          configuration: ROOT_CONFIGURATION,
        } as unknown as TurnExecutionContext;
        const bash = (await runtime.createTools(context)).find((tool) => tool.name === 'bash');
        if (!bash) throw new Error('Expected Bash in the root Agent tool catalog.');

        const preview = cliResponse((await bash.execute('item:preview', {
          command: `tenon-import preview ${JSON.stringify(packFile)} --out ${JSON.stringify(previewFile)} --json`,
        })).details as ToolEnvelope<BashData>);
        const previewId = preview.data?.previewId;
        expect(preview.ok).toBe(true);
        expect(typeof previewId).toBe('string');
        expect(previewId as string).toStartWith('preview:');
        expect(issuedCausation).toEqual([]);

        const commitEnvelope = (await bash.execute(IMPORT_CAUSATION.itemId, {
          command: `tenon-import commit ${JSON.stringify(packFile)} --preview-id ${JSON.stringify(previewId)} --json`,
        })).details as AuditedBashEnvelope;
        expect(commitEnvelope.capabilityAudit?.behavior).toBe('allow');
        expect(commitEnvelope.capabilityAudit?.descriptors?.map((descriptor) => descriptor.actionKind))
          .toContain('outline.edit');
        const committed = cliResponse(commitEnvelope);

        expect(committed).toMatchObject({
          ok: true,
          data: {
            status: 'staged',
            verification: { ok: true },
          },
        });
        const stagingRootId = committed.data?.stagingRootId;
        const operationId = committed.data?.operationId;
        expect(typeof stagingRootId).toBe('string');
        expect(typeof operationId).toBe('string');
        expect(operationId as string).toStartWith('op:');
        expect(issuedCausation).toEqual([IMPORT_CAUSATION]);
        expect(stagingRoots(core)).toEqual([stagingRootId]);
        expect(core.operationHistory({ action: 'list', origin: 'agent' }).items).toEqual([
          expect.objectContaining({
            operationId,
            tool: 'tenon-import',
            causation: IMPORT_CAUSATION,
          }),
        ]);
      } finally {
        await api.stop();
      }
    } finally {
      await Promise.all([
        rm(userData, { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ]);
    }
  });

  test('rejects invalid causation token server bounds at construction', () => {
    const service = new AgentImportService(hostFor(Core.new()));
    expect(() => new AgentImportApiServer(service, {
      userDataDir: '/tmp/tenon-import-invalid-token-ttl',
      causationTokenTtlMs: 0,
    })).toThrow('causationTokenTtlMs must be a positive safe integer');
    expect(() => new AgentImportApiServer(service, {
      userDataDir: '/tmp/tenon-import-invalid-token-capacity',
      maxCausationTokens: Number.NaN,
    })).toThrow('maxCausationTokens must be a positive safe integer');
  });

  test('CLI preserves staged verification failure data and exits non-zero without retrying', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-cli-user-data-'));
    const packRoot = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-cli-pack-'));
    try {
      const packFile = await writePack(packRoot, samplePack());
      const packContent = await Bun.file(packFile).text();
      const core = Core.new();
      const service = new AgentImportService(verificationMismatchHost(core), { toolName: 'tenon-import' });
      const api = new AgentImportApiServer(service, { userDataDir: userData });
      const descriptor = await api.start();
      try {
        const previewId = previewIdFromResponse(await callImportApi(descriptor, '/preview', {
          packContent,
          packLabel: packFile,
        }));
        const causationToken = api.issueCausationToken(IMPORT_CAUSATION);
        const failed = await execFile('bun', [
          TENON_IMPORT_TOOL,
          'commit',
          packFile,
          '--preview-id',
          previewId,
          '--json',
        ], {
          env: {
            ...process.env,
            [TENON_IMPORT_API_DESCRIPTOR_ENV]: api.descriptorPath,
            [TENON_IMPORT_CAUSATION_TOKEN_ENV]: causationToken,
          },
        }).then(
          () => null,
          (error: { code?: number | string; stdout?: string }) => ({
            exitCode: error.code,
            response: JSON.parse(error.stdout ?? '{}') as ImportApiResponse,
          }),
        );

        expect(failed).not.toBeNull();
        expect(failed?.exitCode).toBe(1);
        expect(failed?.response).toMatchObject({
          ok: false,
          error: { code: 'verification_failed' },
          data: {
            status: 'staged_with_errors',
            retryAllowed: false,
            stagingRootId: expect.any(String),
            operationId: expect.stringMatching(/^op:/),
            mismatches: ['descriptions: expected 1, actual 0'],
          },
        });
        if (failed?.response.data?.status !== 'staged_with_errors') {
          throw new Error('Expected CLI to preserve staged verification failure data.');
        }
        expect(stagingRoots(core)).toEqual([failed.response.data.stagingRootId]);
        expect(core.operationHistory({ action: 'list', origin: 'agent' }).items?.[0]).toMatchObject({
          operationId: failed.response.data.operationId,
          causation: IMPORT_CAUSATION,
        });
      } finally {
        await api.stop();
      }
    } finally {
      await Promise.all([
        rm(userData, { recursive: true, force: true }),
        rm(packRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
