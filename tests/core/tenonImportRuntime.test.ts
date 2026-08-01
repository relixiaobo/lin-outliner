import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolveTenonImportRuntime } from '../../src/main/tenonImportRuntime';

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
});
