import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userData = '';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const {
  appendAgentToolPermissionAllowRule,
  readAgentToolPermissionSettings,
  writeAgentToolPermissionSettings,
} = await import('../../src/main/agentToolPermissionStore');

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-permissions-'));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('agent tool permission store', () => {
  test('persists the global permission file as private JSON', async () => {
    await writeAgentToolPermissionSettings({
      permissions: { allow: ['Action(file.read.allowed_file_area)'], ask: [], deny: [] },
    });

    const filePath = path.join(userData, 'agent-tool-permissions.json');
    expect(await readAgentToolPermissionSettings()).toEqual({
      permissions: { allow: ['Action(file.read.allowed_file_area)'], ask: [], deny: [] },
    });
    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('serializes concurrent allow-rule appends without dropping a rule', async () => {
    await Promise.all([
      appendAgentToolPermissionAllowRule('Action(file.read.allowed_file_area)'),
      appendAgentToolPermissionAllowRule('Action(shell.project_script)'),
      appendAgentToolPermissionAllowRule('Action(web.fetch)'),
    ]);

    const raw = JSON.parse(await readFile(path.join(userData, 'agent-tool-permissions.json'), 'utf8')) as {
      permissions?: { allow?: string[] };
    };
    expect(raw.permissions?.allow?.sort()).toEqual([
      'Action(file.read.allowed_file_area)',
      'Action(shell.project_script)',
      'Action(web.fetch)',
    ]);
  });
});
