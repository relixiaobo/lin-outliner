import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTenonImportRuntime } from '../../src/main/tenonImportRuntime';

const require = createRequire(import.meta.url);
const { ensureTenonImportExecutable } = require('../../build/afterPack.cjs') as {
  ensureTenonImportExecutable(appPath: string): string;
};

describe('Tenon import runtime', () => {
  test('resolves the renamed built-in Skill wrapper in development', () => {
    const moduleDir = path.join(path.sep, 'repo', 'src', 'main');

    expect(resolveTenonImportRuntime({
      isPackaged: false,
      moduleDir,
      resourcesPath: path.join(path.sep, 'unused'),
      processExecPath: path.join(path.sep, 'unused', 'Tenon'),
    })).toEqual({
      binDir: path.join(path.sep, 'repo', 'src', 'main', 'builtInSkills', 'tenon-import', 'bin'),
      cliEntry: path.join(
        path.sep,
        'repo',
        'src',
        'main',
        'builtInSkills',
        'tenon-import',
        'scripts',
        'tenon-import.ts',
      ),
      cliRuntime: 'bun',
      runAsNode: false,
    });
  });

  test('resolves the renamed built-in Skill wrapper in packaged resources', () => {
    const resourcesPath = path.join(path.sep, 'Applications', 'Tenon.app', 'Contents', 'Resources');
    const processExecPath = path.join(path.sep, 'Applications', 'Tenon.app', 'Contents', 'MacOS', 'Tenon');

    expect(resolveTenonImportRuntime({
      isPackaged: true,
      moduleDir: path.join(path.sep, 'unused'),
      resourcesPath,
      processExecPath,
    })).toEqual({
      binDir: path.join(resourcesPath, 'built-in-skills', 'tenon-import', 'bin'),
      cliEntry: path.join(resourcesPath, 'tenon-import', 'tenon-import.mjs'),
      cliRuntime: processExecPath,
      runAsNode: true,
    });
  });

  test('afterPack restores the required wrapper mode and fails when it is missing', async () => {
    const appPath = await mkdtemp(path.join(tmpdir(), 'tenon-after-pack-'));
    const wrapperPath = path.join(
      appPath,
      'Contents',
      'Resources',
      'built-in-skills',
      'tenon-import',
      'bin',
      'tenon-import',
    );

    try {
      await mkdir(path.dirname(wrapperPath), { recursive: true });
      await writeFile(wrapperPath, '#!/bin/sh\n', 'utf8');
      await chmod(wrapperPath, 0o644);

      expect(ensureTenonImportExecutable(appPath)).toBe(wrapperPath);
      expect((await stat(wrapperPath)).mode & 0o777).toBe(0o755);
      expect(() => ensureTenonImportExecutable(path.join(appPath, 'missing'))).toThrow();
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });
});
