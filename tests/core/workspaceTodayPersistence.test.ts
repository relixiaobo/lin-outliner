import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OutlineRuntimeWorkspace } from '../../src/outline/runtime/runtimeWorkspace';

let workspaceRoot = '';

describe('workspace today-node persistence', () => {
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = '';
  });

  test('the today node id is stable across a Runtime reopen with no mutations in between', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'outline-today-persist-'));
    const first = await OutlineRuntimeWorkspace.open(workspaceRoot);
    const todayId = first.projection().todayId;
    expect(todayId.startsWith('date:')).toBe(true);

    const second = await OutlineRuntimeWorkspace.open(workspaceRoot);
    expect(second.projection().todayId).toBe(todayId);
    expect(second.projection().nodes.some((node) => node.id === todayId)).toBe(true);
  });
});
