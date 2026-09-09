import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';
import { expectToolOutputContract } from '../helpers/toolOutputContract';

async function fixture(
  run: (
    root: string,
    call: (name: string, args: unknown, signal?: AbortSignal) => Promise<any>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'tenon-text-cursor-'));
  const tools = createLocalTools({ localRoot: root });
  try {
    await run(root, async (name, args, signal) => {
      const result = await tools.find((t) => t.name === name)!.execute('read', args, signal);
      if ('data' in result && result.data !== undefined) expectToolOutputContract(name, result.data);
      return result.details;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('ordinary file continuations', () => {
  for (const encoding of ['utf8', 'utf16le'] as const) {
    test(`reads a long JSON string across ${encoding} code point boundaries without gaps`, async () => {
      await fixture(async (root, call) => {
        const file = join(root, 'detail.json');
        const content = JSON.stringify({ value: `${'界😀'.repeat(140_000)} final error: missing owner` });
        await writeFile(file, Buffer.from(`\ufeff${content}`, encoding));
        let page = await call('file_read', { file_path: file });
        let result = '';
        const cursors = new Set<string>();
        for (let count = 0; count < 10; count++) {
          expect(page.ok).toBe(true);
          expect(page.data.file.content.length).toBeLessThanOrEqual(200_000);
          expect(page.data.file.content).not.toContain('\ufffd');
          result += page.data.file.content;
          const cursor = page.data.file.nextCursor;
          if (!cursor) break;
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
          page = await call('file_read', { file_path: file, cursor });
        }
        expect(cursors.size).toBeGreaterThan(1);
        expect(result === content).toBe(true);
        expect(JSON.parse(result).value.endsWith('final error: missing owner')).toBe(true);
      });
    });
  }

  test('preserves the separator when the first page fills exactly before a new long line', async () => {
    await fixture(async (root, call) => {
      const file = join(root, 'boundary.txt');
      const content = 'a'.repeat(199_999) + '\n' + '😀'.repeat(100_001);
      await writeFile(file, content);
      let page = await call('file_read', { file_path: file });
      let joined = page.data.file.content;
      while (page.data.file.nextCursor) {
        page = await call('file_read', { file_path: file, cursor: page.data.file.nextCursor });
        expect(page.ok).toBe(true);
        joined += page.data.file.content;
      }
      expect(joined === content).toBe(true);
    });
  });

  for (const encoding of ['utf8', 'utf16le'] as const) {
    for (const newline of ['\r\n', '\r']) {
      test(`normalizes ${JSON.stringify(newline)} in ${encoding} across page and decoding boundaries`, async () => {
        await fixture(async (root, call) => {
          const width = encoding === 'utf16le' ? 2 : 1;
          const bomBytes = Buffer.byteLength('\ufeff', encoding);
          const scenarios = [
            'x'.repeat(199_999) + newline + 'ab' + newline + 'cd',
            'x'.repeat((65_536 - bomBytes) / width - 1) + newline + '😀'.repeat(105_000),
            'x'.repeat(200_000 + 16_384 / width - 1) + newline + 'ab' + newline + 'cd',
            'x'.repeat(399_999) + newline + 'tail',
            'x'.repeat(200_010) + newline,
          ];
          for (const [index, content] of scenarios.entries()) {
            const file = join(root, `newlines-${index}.txt`);
            await writeFile(file, Buffer.from('\ufeff' + content, encoding));
            let page = await call('file_read', { file_path: file });
            let joined = '';
            let pages = 0;
            do {
              expect(page.ok).toBe(true);
              expect(page.data.file.content).not.toContain('\r');
              expect(page.data.file.content.length).toBeLessThanOrEqual(200_000);
              joined += page.data.file.content;
              expect(++pages).toBeLessThan(10);
              if (!page.data.file.nextCursor) break;
              page = await call('file_read', { file_path: file, cursor: page.data.file.nextCursor });
            } while (true);
            expect(pages).toBeGreaterThan(1);
            expect(joined === content.replace(/\r\n?/g, '\n')).toBe(true);
          }
        });
      });
    }
    test(`counts standalone CR lines in ${encoding} continuation windows`, async () => {
      await fixture(async (root, call) => {
        const file = join(root, 'line-limits.txt');
        const content = 'x'.repeat(200_010) + '\rab\rcd';
        await writeFile(file, Buffer.from('\ufeff' + content, encoding));
        let page = await call('file_read', { file_path: file });
        let joined = page.data.file.content;
        for (let line = 1; line <= 3; line++) {
          page = await call('file_read', { file_path: file, cursor: page.data.file.nextCursor, limit: 1 });
          expect(page.ok).toBe(true);
          expect(page.data.file.startLine).toBe(line);
          expect(page.data.file.numLines).toBe(1);
          joined += page.data.file.content;
        }
        expect(page.data.file.nextCursor).toBeNull();
        expect(page.data.file.totalLines).toBe(3);
        expect(joined === content.replace(/\r/g, '\n')).toBe(true);
      });
    });
  }

  for (const encoding of ['utf8', 'utf16le'] as const) {
    for (const withBom of encoding === 'utf8' ? [false, true] : [true]) {
      test(`keeps matching-line context for zero-width and ordinary matches in ${encoding}, BOM=${withBom}`, async () => {
        await fixture(async (root, call) => {
          const file = join(root, 'context.txt');
          for (const newline of ['\n', '\r\n']) {
            await writeFile(
              file,
              Buffer.from(
                (withBom ? '\ufeff' : '') + `original decision${newline}next action${newline}`,
                encoding,
              ),
            );
            for (const pattern of ['^', '$', 'decision']) {
              const found = await call('file_grep', { path: file, pattern, output_mode: 'content' });
              expect(found.ok).toBe(true);
              expect(found.data.content).toContain('1:original decision');
              if (pattern !== 'decision') expect(found.data.content).toContain('2:next action');
            }
          }
        });
      });
    }
  }

  test('keeps bounded context around a deep UTF-16 match without advertising a raw-byte cursor', async () => {
    await fixture(async (root, call) => {
      const file = join(root, 'long-utf16.txt');
      await writeFile(
        file,
        Buffer.from(
          '\ufeffheader\r\n' + '界😀'.repeat(50_000) + ' original decision: next action ' + 'y'.repeat(1_000),
          'utf16le',
        ),
      );
      const found = await call('file_grep', { path: file, pattern: 'decision', output_mode: 'content' });
      expect(found.ok).toBe(true);
      expect(found.data.content).toContain('original decision: next action');
      expect(found.data.content.length).toBeLessThan(1_000);
      expect(found.data.content).not.toContain('\ufffd');
      expect(found.data.readLocations[0]).toMatchObject({ filePath: file, line: 2, cursor: null });
    });
  });

  test('rejects replacement, a cursor for another file, conflicting windows, and cancellation', async () => {
    await fixture(async (root, call) => {
      const file = join(root, 'detail.txt');
      await writeFile(file, 'x'.repeat(250_000));
      const page = await call('file_read', { file_path: file });
      const cursor = page.data.file.nextCursor;
      await writeFile(join(root, 'another.txt'), 'x'.repeat(250_000));
      expect((await call('file_read', { file_path: join(root, 'another.txt'), cursor })).error.code).toBe(
        'invalid_cursor',
      );
      expect((await call('file_read', { file_path: file, cursor, offset: 1 })).error.code).toBe(
        'invalid_args',
      );
      await expect(
        call('file_grep', { path: file, pattern: '^', output_mode: 'content' }, AbortSignal.abort()),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(call('file_read', { file_path: file, cursor }, AbortSignal.abort())).rejects.toMatchObject(
        { name: 'AbortError' },
      );
      await rename(join(root, 'another.txt'), file);
      expect((await call('file_read', { file_path: file, cursor })).error.code).toBe('source_changed');
    });
  });

  test('searches beyond 100 KB and reads the matching region through the returned ordinary cursor', async () => {
    await fixture(async (root, call) => {
      const file = join(root, 'record.json');
      await writeFile(
        file,
        JSON.stringify({ log: `${'x'.repeat(350_000)} ERR_OWNER_MISSING ${'y'.repeat(260_000)}` }),
      );
      const found = await call('file_grep', {
        path: root,
        pattern: 'ERR_OWNER_MISSING',
        output_mode: 'content',
      });
      expect(found.ok).toBe(true);
      expect(found.data.content).toContain('ERR_OWNER_MISSING');
      expect(found.data.content.length).toBeLessThan(1_000);
      const location = found.data.readLocations[0];
      expect(location.byteOffset).toBeGreaterThan(350_000);
      const read = await call('file_read', { file_path: location.filePath, cursor: location.cursor });
      expect(read.ok).toBe(true);
      expect(read.data.file.content).toContain('ERR_OWNER_MISSING');
      expect(read.data.file.content.length).toBeLessThanOrEqual(200_000);
      expect(read.data.file.nextCursor).toEqual(expect.any(String));
    });
  });

  test('retains regex anchors, context lines and navigable matches without altering the pattern', async () => {
    await fixture(async (root, call) => {
      await writeFile(join(root, 'context.txt'), 'before\nneedle only\nafter\nnot needle\n');
      const found = await call('file_grep', {
        path: root,
        pattern: '^needle',
        output_mode: 'content',
        context: 1,
      });
      expect(found.ok).toBe(true);
      expect(found.data.content).toContain('context.txt-1-before');
      expect(found.data.content).toContain('context.txt:2:needle only');
      expect(found.data.content).toContain('context.txt-3-after');
      expect(found.data.readLocations).toHaveLength(1);
      const location = found.data.readLocations[0];
      const read = await call('file_read', { file_path: location.filePath, cursor: location.cursor });
      expect(read.data.file.content.startsWith('needle only')).toBe(true);
    });
  });
});
