import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Core } from '../../src/core/core';
import { buildTextSearchIndex } from '../../src/core/searchEngine';
import { createDataImportTool } from '../../src/main/agentDataImportTool';
import type { ImportPack } from '../../src/main/agentDataImportPack';
import { createAgentLocalWorkspaceContext } from '../../src/main/agentLocalTools';
import {
  checkedState,
  fieldReads,
  indexProjection,
  normalChildIds,
} from '../../src/main/agentNodeToolProjection';
import type { OutlinerToolHost } from '../../src/main/agentNodeTools';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';

function hostFor(core: Core): OutlinerToolHost {
  return {
    getProjection: () => core.projection(),
    getTextSearchIndex: () => buildTextSearchIndex(core.projection()),
    transaction: async (meta, fn) => core.transaction(meta.origin ?? 'agent', fn, meta),
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

function createImportToolExecutor(core: Core, root: string): (params: unknown) => Promise<ToolEnvelope<any>> {
  const workspace = createAgentLocalWorkspaceContext(root);
  const tool = createDataImportTool(hostFor(core), { workspace });
  return async (params: unknown) => {
    const result = await (tool.execute as any)('test-call', params);
    return result.details as ToolEnvelope<any>;
  };
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

describe('data_import agent tool', () => {
  test('requires a matching dry-run preview and stages a validated Import Pack', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tenon-data-import-'));
    try {
      const packFile = await writePack(root, samplePack());
      const core = Core.new();
      const executeImportTool = createImportToolExecutor(core, root);

      const withoutPreview = await executeImportTool({ pack_file: 'pack.json' });
      expect(withoutPreview.ok).toBe(false);
      expect(withoutPreview.error?.code).toBe('preview_required');

      const dryRun = await executeImportTool({ pack_file: 'pack.json', dry_run: true });
      expect(dryRun.ok).toBe(true);
      expect(dryRun.status).toBe('unchanged');
      expect(dryRun.data).toMatchObject({
        sectionCount: 1,
        nodeCount: 3,
        createdRootIds: [],
        stats: samplePack().stats,
      });
      expect(dryRun.data.previewId).toStartWith('preview:');

      const otherParentId = core.createNode(core.projection().todayId, null, 'Other destination').focus!.nodeId;
      const mismatch = await executeImportTool({
        pack_file: 'pack.json',
        parent_id: otherParentId,
        confirmed_preview_id: dryRun.data.previewId,
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.error?.code).toBe('preview_mismatch');

      const secondDryRun = await executeImportTool({ pack_file: 'pack.json', dry_run: true });
      const imported = await executeImportTool({
        pack_file: 'pack.json',
        confirmed_preview_id: secondDryRun.data.previewId,
      });
      expect(imported.ok).toBe(true);
      expect(imported.data.verification).toMatchObject({ ok: true });
      expect(imported.data.createdRootIds).toHaveLength(1);

      const index = indexProjection(core.projection());
      const stagingRoot = index.nodes.get(imported.data.stagingRootId)!;
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
      const executeImportTool = createImportToolExecutor(Core.new(), root);
      const result = await executeImportTool({ pack_file: 'pack.json', dry_run: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('stats_mismatch');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
