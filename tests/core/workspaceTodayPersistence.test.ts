import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let electronUserDataRoot = '';

mock.module('electron', () => ({
  app: {
    getPath: () => electronUserDataRoot,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({ clearStorageData: async () => undefined }),
  },
}));

type DocumentServiceModule = typeof import('../../src/main/documentService');
type DocumentServiceInstance = InstanceType<DocumentServiceModule['DocumentService']>;

let documentServiceModule: Promise<DocumentServiceModule> | null = null;

async function newService(): Promise<DocumentServiceInstance> {
  documentServiceModule ??= import('../../src/main/documentService');
  const { DocumentService } = await documentServiceModule;
  return new DocumentService();
}

describe('workspace today-node persistence', () => {
  beforeEach(async () => {
    electronUserDataRoot = await mkdtemp(path.join(tmpdir(), 'lin-today-persist-'));
  });

  afterEach(async () => {
    await rm(electronUserDataRoot, { recursive: true, force: true });
  });

  // The constructor lazily mints today's date node in memory. If init never
  // persists it, a second init (re-mount / restart before any mutation) reads a
  // file that lacks today and mints a *fresh* id — orphaning any renderer state
  // (panel root, persisted layout) that still points at the first id, which then
  // fails with `parent not found: date:…` on the first row of today's note.
  test('the today node id is stable across a re-init with no mutations in between', async () => {
    const first = await newService();
    const initial = await first.initWorkspace();
    const todayId = initial.projection.todayId;
    expect(todayId.startsWith('date:')).toBe(true);

    // No mutation happened — yet initWorkspace must have persisted the minted
    // today node, so a fresh service loading the same userData reuses its id.
    const second = await newService();
    const reloaded = await second.initWorkspace();
    expect(reloaded.projection.todayId).toBe(todayId);
    // And the node actually exists in the reloaded projection (not a dangling id).
    expect(reloaded.projection.nodes.some((node) => node.id === todayId)).toBe(true);
  });
});
