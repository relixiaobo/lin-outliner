import { expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs';
import * as promises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTools } from '../../src/main/agent/capabilities/agentLocalTools';
import { expectToolOutputContract } from '../helpers/toolOutputContract';

/** Count actual preview I/O, independently of wall-clock speed and ripgrep's child process. */
async function withPreviewReads<T>(file: string, run: () => Promise<T>, onFirstChunk?: () => Promise<void>) {
  const streams: filesystem.ReadStream[] = [];
  let positionalBytes = 0;
  const open = promises.open;
  const createReadStream = filesystem.createReadStream;
  const readSpies: Array<{ mockRestore(): void }> = [];
  const streamSpy = spyOn(filesystem, 'createReadStream').mockImplementation((...args) => {
    const stream = createReadStream(...args);
    if (String(args[0]) === file) {
      streams.push(stream);
      if (onFirstChunk) {
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
          let first = true;
          for await (const chunk of iterate()) {
            if (first) {
              first = false;
              await onFirstChunk();
            }
            yield chunk;
          }
        };
      }
    }
    return stream;
  });
  const openSpy = spyOn(promises, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      readSpies.push(
        spyOn(handle, 'read').mockImplementation(async (...args: any[]) => {
          const result = await (read as any)(...args);
          positionalBytes += result.bytesRead;
          return result;
        }),
      );
    }
    return handle;
  });
  try {
    const result = await run();
    return {
      result,
      streamCount: streams.length,
      bytesRead: positionalBytes + streams.reduce((sum, stream) => sum + stream.bytesRead, 0),
    };
  } finally {
    openSpy.mockRestore();
    streamSpy.mockRestore();
    for (const spy of readSpies) spy.mockRestore();
  }
}

for (const format of ['utf8', 'utf8-bom', 'utf16le'] as const) {
  test(`bounds preview reads for 100 adjacent matches after a large ${format} prefix`, async () => {
    const root = await promises.mkdtemp(join(tmpdir(), 'tenon-grep-io-'));
    try {
      const file = join(root, 'history.txt');
      const encoding = format === 'utf16le' ? 'utf16le' : 'utf8';
      const prefix = (format === 'utf8' ? '' : '\ufeff') + 'x'.repeat(1024 * 1024) + '\n';
      const lines = Array.from({ length: 100 }, (_, index) => `decision-${index} needle next-${index}`);
      const matchedRegion = prefix + lines.join('\n') + '\n';
      // The unrequested suffix must not become another whole-file read.
      await promises.writeFile(file, Buffer.from(matchedRegion + 'z'.repeat(1024 * 1024), encoding));
      const tools = createLocalTools({ localRoot: root });
      const grep = tools.find((tool) => tool.name === 'file_grep')!;
      const measured = await withPreviewReads(file, async () =>
        grep.execute('search', {
          path: file,
          pattern: 'needle',
          output_mode: 'content',
          head_limit: 100,
        }),
      );
      const envelope = measured.result.details as any;
      expect(envelope.ok).toBe(true);
      expectToolOutputContract('file_grep', measured.result.data);
      expect(envelope.data.numLines).toBe(100);
      expect(envelope.data.readLocations).toHaveLength(100);
      for (const line of lines) expect(envelope.data.content).toContain(line);
      if (format === 'utf16le') {
        expect(measured.streamCount).toBe(1);
        expect(measured.bytesRead).toBeLessThan(Buffer.byteLength(matchedRegion, encoding) + 128 * 1024);
        expect(envelope.data.readLocations.every((location: any) => location.cursor === null)).toBe(true);
      } else {
        expect(measured.streamCount).toBe(0);
        expect(measured.bytesRead).toBeGreaterThan(0);
        expect(measured.bytesRead).toBeLessThanOrEqual(4096 + lines.length * 4096);
        const first = envelope.data.readLocations[0];
        const read = await tools
          .find((tool) => tool.name === 'file_read')!
          .execute('read', {
            file_path: first.filePath,
            cursor: first.cursor,
            limit: 1,
          });
        expect((read.details as any).data.file.content).toBe(lines[0] + '\n');
      }
    } finally {
      await promises.rm(root, { recursive: true, force: true });
    }
  });
}

for (const action of ['replace', 'cancel'] as const) {
  test(`discards an in-flight UTF-16 preview batch on source ${action}`, async () => {
    const root = await promises.mkdtemp(join(tmpdir(), 'tenon-grep-interrupt-'));
    try {
      const file = join(root, 'history.txt');
      await promises.writeFile(
        file,
        Buffer.from(
          '\ufeff' + 'x'.repeat(1024 * 1024) + '\nold decision needle\nold action needle',
          'utf16le',
        ),
      );
      const replacement = join(root, 'replacement.txt');
      await promises.writeFile(replacement, Buffer.from('\ufeffnew generation', 'utf16le'));
      const controller = new AbortController();
      const grep = createLocalTools({ localRoot: root }).find((tool) => tool.name === 'file_grep')!;
      const call = withPreviewReads(
        file,
        async () =>
          grep.execute(
            'search',
            {
              path: file,
              pattern: 'needle',
              output_mode: 'content',
            },
            controller.signal,
          ),
        async () => {
          if (action === 'cancel') controller.abort();
          else await promises.rename(replacement, file);
        },
      );
      if (action === 'cancel') await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      else {
        const measured = await call;
        expect(measured.streamCount).toBe(1);
        const envelope = measured.result.details as any;
        expect(envelope.ok).toBe(true);
        expect(envelope.data.content).toBe('2:needle\n3:needle');
        expect(envelope.data.readLocations.every((location: any) => location.cursor === null)).toBe(true);
      }
    } finally {
      await promises.rm(root, { recursive: true, force: true });
    }
  });
}

test('preserves paging and overlapping UTF-16 match windows across files', async () => {
  const root = await promises.mkdtemp(join(tmpdir(), 'tenon-grep-windows-'));
  try {
    const files = [join(root, 'a.txt'), join(root, 'b.txt')];
    for (const [fileIndex, file] of files.entries()) {
      const fragments = Array.from(
        { length: 10 },
        (_, index) => `decision-${fileIndex}-${index} needle action-${fileIndex}-${index}`,
      );
      await promises.writeFile(
        file,
        Buffer.from('\ufeff' + '界😀'.repeat(10_000) + fragments.join(' '), 'utf16le'),
      );
    }
    const grep = createLocalTools({ localRoot: root }).find((tool) => tool.name === 'file_grep')!;
    const measured = await withPreviewReads(files[1]!, async () =>
      grep.execute('search', {
        path: root,
        pattern: 'needle',
        output_mode: 'content',
        offset: 7,
        head_limit: 12,
      }),
    );
    expect(measured.streamCount).toBe(1);
    const envelope = measured.result.details as any;
    expect(envelope.ok).toBe(true);
    expectToolOutputContract('file_grep', measured.result.data);
    expect(envelope.data).toMatchObject({ numLines: 12, appliedOffset: 7, appliedLimit: 12 });
    const rows = envelope.data.content.split('\n');
    for (let index = 0; index < 12; index++) {
      const fileIndex = index < 3 ? 0 : 1;
      const matchIndex = index < 3 ? index + 7 : index - 3;
      expect(rows[index]).toContain(
        `decision-${fileIndex}-${matchIndex} needle action-${fileIndex}-${matchIndex}`,
      );
      expect(envelope.data.readLocations[index]).toMatchObject({
        filePath: files[fileIndex],
        line: 1,
        cursor: null,
      });
    }
    expect(envelope.data.content).not.toContain('\ufffd');
    expect(Buffer.byteLength(envelope.data.content)).toBeLessThan(20_000);
  } finally {
    await promises.rm(root, { recursive: true, force: true });
  }
});
