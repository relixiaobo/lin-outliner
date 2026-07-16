import { beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFolderCapabilitySnapshot } from '../../src/main/agentFolderCapabilities';
import {
  clearRipgrepCommandCacheForTests,
  getBundledRipgrepExecutablePath,
  resolveRipgrepCommand,
} from '../../src/main/agentRipgrep';

beforeEach(() => {
  clearRipgrepCommandCacheForTests();
});

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearRipgrepCommandCacheForTests();
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    clearRipgrepCommandCacheForTests();
  }
}

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-ripgrep-provider-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function processCapabilities(root: string) {
  return createFolderCapabilitySnapshot({
    workspaceRoot: root,
    includeSystemRoots: true,
  }, []);
}

test('resolves LIN_AGENT_RIPGREP_COMMAND with fixed prefix args', async () => {
  await withTempDir(async (root) => {
    const fakeRg = path.join(root, 'fake-rg');
    await writeFile(fakeRg, [
      '#!/bin/sh',
      'if [ "$1" = "--fixed-prefix" ] && [ "$2" = "--version" ]; then',
      '  echo "ripgrep 15.1.0"',
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 2',
      '',
    ].join('\n'), 'utf8');
    await chmod(fakeRg, 0o755);

    await withEnv({
      LIN_AGENT_RIPGREP_COMMAND: `${fakeRg} --fixed-prefix`,
      PATH: path.join(root, 'empty-path'),
      LIN_AGENT_EXTRA_TOOL_PATH: undefined,
    }, async () => {
      await mkdir(process.env.PATH!, { recursive: true });
      const resolved = await resolveRipgrepCommand(root, processCapabilities(root));
      expect(resolved).toMatchObject({
        command: fakeRg,
        argsPrefix: ['--fixed-prefix'],
        mode: 'env',
        source: 'LIN_AGENT_RIPGREP_COMMAND',
      });
      expect(resolved.version).toContain('ripgrep 15.1.0');
    });
  });
});

const bundledRipgrepTest = getBundledRipgrepExecutablePath() ? test : test.skip;

bundledRipgrepTest('resolves bundled ripgrep when PATH has no system rg', async () => {
  await withTempDir(async (root) => {
    const emptyPath = path.join(root, 'empty-path');
    await mkdir(emptyPath);

    await withEnv({
      LIN_AGENT_RIPGREP_COMMAND: undefined,
      LIN_AGENT_EXTRA_TOOL_PATH: undefined,
      PATH: emptyPath,
    }, async () => {
      const resolved = await resolveRipgrepCommand(root, processCapabilities(root));
      expect(resolved.mode).toBe('bundled');
      expect(resolved.command).toBe(getBundledRipgrepExecutablePath());
      expect(resolved.version).toContain('ripgrep 15.1.0');
    });
  });
});
