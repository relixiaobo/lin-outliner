import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  atomicWriteFile,
  getJsonFileWriteLockCountForTests,
  readJsonOrDefault,
  updateJsonFile,
  writeJsonFile,
} from '../../src/main/jsonFileStore';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tenon-json-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('json file store', () => {
  test('writes stable pretty JSON with a trailing newline', async () => {
    const filePath = path.join(root, 'settings.json');
    await writeJsonFile(filePath, { b: 2, a: { c: true } });

    expect(await readFile(filePath, 'utf8')).toBe('{\n  "b": 2,\n  "a": {\n    "c": true\n  }\n}\n');
    expect(await readJsonOrDefault(filePath, { missing: true })).toEqual({ b: 2, a: { c: true } });
  });

  test('applies private file and directory modes on POSIX', async () => {
    const filePath = path.join(root, 'private', 'secret.json');
    await writeJsonFile(filePath, { token: 'secret' }, { mode: 0o600, directoryMode: 0o700 });

    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  test('serializes concurrent read-modify-write updates for one file', async () => {
    const filePath = path.join(root, 'counter.json');
    await writeJsonFile(filePath, { values: [] as string[] });

    const first = updateJsonFile(
      filePath,
      { values: [] as string[] },
      parseCounter,
      async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.values.push('first');
      },
    );
    const second = updateJsonFile(
      filePath,
      { values: [] as string[] },
      parseCounter,
      (state) => {
        state.values.push('second');
      },
    );

    await Promise.all([first, second]);

    expect(await readJsonOrDefault(filePath, { values: [] }, parseCounter)).toEqual({ values: ['first', 'second'] });
  });

  test('last atomic file writer wins with an intact file', async () => {
    const filePath = path.join(root, 'plain.txt');
    await Promise.all([
      atomicWriteFile(filePath, 'first'),
      atomicWriteFile(filePath, 'second'),
      atomicWriteFile(filePath, 'third'),
    ]);

    expect(['first', 'second', 'third']).toContain(await readFile(filePath, 'utf8'));
  });

  test('releases settled write locks so unique paths do not accumulate permanently', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      return writeJsonFile(path.join(root, `unique-${index}.json`), { index });
    }));

    expect(getJsonFileWriteLockCountForTests()).toBe(0);
  });

  test('rejects nested writes to the same path instead of hanging', async () => {
    const filePath = path.join(root, 'nested.json');

    await expect(updateJsonFile(
      filePath,
      { value: 0 },
      parseValue,
      async () => {
        await writeJsonFile(filePath, { value: 1 });
      },
    )).rejects.toThrow('Nested JSON file write lock');
  });
});

function parseCounter(value: unknown): { values: string[] } {
  const raw = value && typeof value === 'object' ? value as { values?: unknown } : {};
  return {
    values: Array.isArray(raw.values) ? raw.values.filter((item): item is string => typeof item === 'string') : [],
  };
}

function parseValue(value: unknown): { value: number } {
  const raw = value && typeof value === 'object' ? value as { value?: unknown } : {};
  return { value: typeof raw.value === 'number' ? raw.value : 0 };
}
