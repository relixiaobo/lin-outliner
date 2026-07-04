import { describe, expect, test } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import type { ImportPack } from '../../src/main/agentDataImportPack';
import { AgentImportApiServer, type ImportApiDescriptor, type ImportApiResponse } from '../../src/main/agentImportApi';
import { AgentImportService } from '../../src/main/agentImportService';
import { createAgentLocalWorkspaceContext } from '../../src/main/agentLocalTools';
import {
  checkedState,
  fieldReads,
  indexProjection,
  normalChildIds,
} from '../../src/main/agentNodeToolProjection';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';

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

async function callImportApi(descriptor: ImportApiDescriptor, pathname: '/preview' | '/commit', body: Record<string, unknown>): Promise<ImportApiResponse> {
  const payload = `${JSON.stringify(body)}\n`;
  return await new Promise<ImportApiResponse>((resolve, reject) => {
    const request = httpRequest({
      socketPath: descriptor.socketPath,
      path: pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
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

describe('Tenon import service', () => {
  test('requires a matching dry-run preview and stages a validated Import Pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-'));
    try {
      const packFile = await writePack(root, samplePack());
      const core = Core.new();
      const importService = createImportService(core, root);

      await expect(importService.commitFromFile({ packFile: 'pack.json' }))
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
      })).rejects.toMatchObject({ code: 'preview_mismatch' });

      const secondDryRun = await importService.previewFromFile({ packFile: 'pack.json' });
      const imported = await importService.commitFromFile({
        packFile: 'pack.json',
        previewId: secondDryRun.previewId,
      });
      expect(imported.verification).toMatchObject({ ok: true });
      expect(imported.createdRootIds).toHaveLength(1);

      const history = core.operationHistory({ action: 'list', origin: 'agent' });
      expect(history.items?.[0]).toMatchObject({
        tool: 'tenon-import',
        summary: 'Created import staging tree for 3 cleaned nodes.',
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects malformed packs before previewing or mutating', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-invalid-'));
    try {
      const pack = samplePack();
      pack.stats.nodes = 99;
      await writePack(root, pack);
      const importService = createImportService(Core.new(), root);
      await expect(importService.previewFromFile({ packFile: 'pack.json' }))
        .rejects.toMatchObject({ code: 'stats_mismatch' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('local API previews and commits bounded pack content through the import service', async () => {
    const userData = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-api-user-data-'));
    try {
      const packContent = `${JSON.stringify(samplePack(), null, 2)}\n`;
      const core = Core.new();
      const service = new AgentImportService(hostFor(core), { toolName: 'tenon-import' });
      const api = new AgentImportApiServer(service, { userDataDir: userData });
      const descriptor = await api.start();
      try {
        const preview = await callImportApi(descriptor, '/preview', { packContent, packLabel: 'sample.tana.json' });
        expect(preview.ok).toBe(true);
        const previewData = preview.data as { previewId?: string; createdRootIds?: string[] };
        expect(previewData.previewId).toStartWith('preview:');
        expect(previewData.createdRootIds).toEqual([]);

        const commit = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId: previewData.previewId,
        });
        expect(commit.ok).toBe(true);
        expect((commit.data as { verification?: { ok?: boolean } }).verification?.ok).toBe(true);

        const reused = await callImportApi(descriptor, '/commit', {
          packContent,
          packLabel: 'sample.tana.json',
          previewId: previewData.previewId,
        });
        expect(reused.ok).toBe(false);
        expect(reused.error?.code).toBe('preview_expired');
      } finally {
        await api.stop();
      }
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});
