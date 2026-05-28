import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAgentLocalWorkspaceContext,
  createLocalTools,
  restorePostCompactReadFiles,
  visibleBash,
  visibleFileGlob,
  visibleFileGrep,
  visibleTaskStop,
  type BashData,
  type FileGlobData,
  type FileGrepData,
  type TaskStopData,
} from '../../src/main/agentLocalTools';
import type { ToolEnvelope } from '../../src/main/agentToolEnvelope';

const localToolSets = new Map<string, ReturnType<typeof createLocalTools>>();

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-'));
  try {
    return await fn(workspaceRoot);
  } finally {
    localToolSets.delete(workspaceRoot);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function executeTool<TData>(workspaceRoot: string, name: string, params: unknown): Promise<ToolEnvelope<TData>> {
  let tools = localToolSets.get(workspaceRoot);
  if (!tools) {
    tools = createLocalTools({ localRoot: workspaceRoot });
    localToolSets.set(workspaceRoot, tools);
  }
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  const result = await (tool!.execute as any)('test-call', params);
  return result.details as ToolEnvelope<TData>;
}

const hasPdfTools = commandExists('pdfinfo') && commandExists('pdftoppm');
const pdfTest = hasPdfTools ? test : test.skip;

function commandExists(command: string): boolean {
  return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
}

function commandPath(command: string): string | null {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function waitForFileContent(filePath: string, predicate: (content: string) => boolean, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastContent = '';
  while (Date.now() < deadline) {
    lastContent = await readFile(filePath, 'utf8');
    if (predicate(lastContent)) return lastContent;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return lastContent;
}

function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt8(0x89, 0);
  buffer.write('PNG\r\n\x1a\n', 1, 'binary');
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makePdf(pageTexts: string[]): string {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, index) => 3 + index);
  const contentIds = pageTexts.map((_, index) => 3 + pageTexts.length + index);
  const fontId = 3 + pageTexts.length * 2;
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  pageTexts.forEach((text, index) => {
    objects[pageIds[index]! - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`;
  });
  pageTexts.forEach((text, index) => {
    const stream = `BT /F1 24 Tf 100 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objects[contentIds[index]! - 1] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontId - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}

describe('agent local tools', () => {
  test('file_read returns bounded text and records a full read for edits', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

      const read = await executeTool<{
        type: 'text';
        file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number };
      }>(workspaceRoot, 'file_read', { file_path: filePath });

      expect(read.ok).toBe(true);
      expect(read.data!.type).toBe('text');
      expect(read.data!.file).toMatchObject({
        filePath,
        content: 'alpha\nbeta\ngamma',
        numLines: 3,
        startLine: 1,
        totalLines: 3,
      });
    });
  });

  test('file_read offset uses one-based line numbers', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8');

      const read = await executeTool<{
        type: 'text';
        file: { content: string; numLines: number; startLine: number; totalLines: number };
      }>(workspaceRoot, 'file_read', { file_path: filePath, offset: 2, limit: 1 });

      expect(read.ok).toBe(true);
      expect(read.data!.file).toMatchObject({
        content: 'beta',
        numLines: 1,
        startLine: 2,
        totalLines: 3,
      });
      expect(read.instructions).toContain('offset 3');
    });
  });

  test('file_read returns file_unchanged for repeated full reads of unchanged files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'alpha\nbeta\n', 'utf8');

      const first = await executeTool<{ type: 'text' }>(workspaceRoot, 'file_read', { file_path: filePath });
      const second = await executeTool<{ type: 'file_unchanged'; file: { filePath: string } }>(workspaceRoot, 'file_read', { file_path: filePath });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.status).toBe('unchanged');
      expect(second.data).toEqual({ type: 'file_unchanged', file: { filePath } });
      expect(second.instructions).toContain('unchanged');
    });
  });

  test('file tools notify path skills only after successful file operations', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');
      const touched: string[] = [];
      const skillRuntime = {
        notifyFileTouched: async (paths: string[]) => {
          touched.push(...paths);
        },
      };
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, skillRuntime as any);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;

      await (fileEdit.execute as any)('edit-fail', {
        file_path: filePath,
        old_string: 'alpha',
        new_string: 'beta',
      });
      expect(touched).toEqual([]);

      await (fileRead.execute as any)('read-ok', { file_path: filePath });
      expect(touched).toEqual([filePath]);
      touched.length = 0;

      await (fileEdit.execute as any)('edit-ok', {
        file_path: filePath,
        old_string: 'alpha',
        new_string: 'beta',
      });
      expect(touched).toEqual([filePath]);
    });
  });

  test('post-compact restore keeps only restored files in read freshness state', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const restoredPath = path.join(workspaceRoot, 'restored.txt');
      const skippedPath = path.join(workspaceRoot, 'skipped.txt');
      await writeFile(restoredPath, 'restored content\n', 'utf8');
      await writeFile(skippedPath, 'skipped content\n', 'utf8');

      const workspace = createAgentLocalWorkspaceContext(workspaceRoot);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      await (fileRead.execute as any)('read-1', { file_path: restoredPath });
      await (fileRead.execute as any)('read-2', { file_path: skippedPath });

      const restored = await restorePostCompactReadFiles(workspace, {
        maxFiles: 5,
        maxCharsPerFile: 10_000,
        maxTotalChars: 20_000,
        preservedFilePaths: new Set([skippedPath]),
      });

      expect(restored.map((file) => file.filePath)).toEqual([restoredPath]);
      expect(restored[0]!.content).toContain('restored content');
      expect(workspace.readFileState.has(restoredPath)).toBe(true);
      expect(workspace.readFileState.has(skippedPath)).toBe(false);
    });
  });

  test('local tool schemas use operational descriptions for model guidance', () => {
    const tools = createLocalTools({ localRoot: process.cwd() });
    const fileRead = tools.find((tool) => tool.name === 'file_read')!;
    const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;
    const bash = tools.find((tool) => tool.name === 'bash')!;
    const taskStop = tools.find((tool) => tool.name === 'task_stop')!;

    expect(fileRead.description).toContain('The file_path parameter must be an absolute path');
    expect(JSON.stringify(fileRead.parameters)).toContain('The line number to start reading from');
    expect(JSON.stringify(fileRead.parameters)).toContain('Maximum 20 pages per request');
    expect(fileEdit.description).toContain('Performs exact string replacements in files');
    expect(fileEdit.description).not.toContain('notebook_edit');
    expect(JSON.stringify(bash.parameters)).toContain('Clear, concise description');
    expect(JSON.stringify(bash.parameters)).toContain('Do not use vague words');
    expect(JSON.stringify(bash.parameters)).not.toContain('dangerouslyDisableSandbox');
    expect(JSON.stringify(bash.parameters).toLowerCase()).not.toContain('sandbox');
    expect(JSON.stringify(taskStop.parameters)).toContain('task_id returned by bash');
    expect(JSON.stringify(taskStop.parameters)).not.toContain('shell_id');
  });

  test('file_edit applies exact replacements only after file_read', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'src', 'app.ts');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'const name = "Lin";\nconsole.log(name);\n', 'utf8');

      const unread = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'Lin',
        new_string: 'Outliner',
      });
      expect(unread.ok).toBe(false);
      expect(unread.error?.code).toBe('file_not_read');

      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });
      const edited = await executeTool<{
        filePath: string;
        structuredPatch: Array<{ lines: string[] }>;
      }>(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'const name = "Lin";',
        new_string: 'const name = "Outliner";',
      });

      expect(edited.ok).toBe(true);
      expect(edited.data!.filePath).toBe(filePath);
      expect(edited.data!.structuredPatch[0]!.lines).toContain('+const name = "Outliner";');
      expect(await readFile(filePath, 'utf8')).toBe('const name = "Outliner";\nconsole.log(name);\n');
    });
  });

  test('file_edit preserves original line endings and text encoding', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'utf16.txt');
      await writeFile(filePath, Buffer.from('\ufeffalpha\r\nbeta\r\n', 'utf16le'));

      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });
      const edited = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'beta',
        new_string: 'gamma',
      });

      expect(edited.ok).toBe(true);
      const raw = await readFile(filePath);
      expect(raw[0]).toBe(0xff);
      expect(raw[1]).toBe(0xfe);
      expect(raw.toString('utf16le')).toBe('\ufeffalpha\r\ngamma\r\n');
    });
  });

  test('file_read returns image dimensions and attaches image content without duplicating base64 in text', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'image.png');
      await writeFile(filePath, makePng(7, 11));

      const read = await executeTool<{
        type: 'image';
        file: { base64: string; dimensions: { width: number; height: number } };
      }>(workspaceRoot, 'file_read', { file_path: filePath });

      expect(read.ok).toBe(true);
      expect(read.data!.file.dimensions).toEqual({ width: 7, height: 11 });

      const tool = createLocalTools({ localRoot: workspaceRoot }).find((candidate) => candidate.name === 'file_read')!;
      const result = await (tool.execute as any)('test-call', { file_path: filePath });
      const visible = JSON.parse(result.content[0].text);
      expect(visible.data.file.dimensions).toEqual({ width: 7, height: 11 });
      expect(visible.data.file.base64).toBeUndefined();
      expect(result.content.some((block: { type: string }) => block.type === 'image')).toBe(true);
    });
  });

  test('file_read parses Jupyter notebooks into cell text and outputs', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'analysis.ipynb');
      await writeFile(filePath, JSON.stringify({
        cells: [
          { cell_type: 'markdown', source: ['# Notes\n', 'hello'] },
          {
            cell_type: 'code',
            execution_count: 1,
            source: 'print("hi")',
            outputs: [{ text: ['hi\n'] }],
          },
        ],
      }), 'utf8');

      const read = await executeTool<{
        type: 'notebook';
        file: { totalCells: number; content: string; cells: Array<{ cellType: string; outputs?: string[] }> };
      }>(workspaceRoot, 'file_read', { file_path: filePath });

      expect(read.ok).toBe(true);
      expect(read.data!.file.totalCells).toBe(2);
      expect(read.data!.file.content).toContain('--- Cell 1 (markdown) ---');
      expect(read.data!.file.cells[1]!.outputs).toEqual(['hi\n']);
    });
  });

  test('file_edit rejects Jupyter notebooks without suggesting a missing notebook edit tool', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'analysis.ipynb');
      await writeFile(filePath, JSON.stringify({
        cells: [
          { cell_type: 'markdown', source: ['# Notes\n', 'hello'] },
        ],
      }), 'utf8');

      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });
      const edited = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'hello',
        new_string: 'hi',
      });

      expect(edited.ok).toBe(false);
      expect(edited.error?.code).toBe('notebook_edit_required');
      expect(edited.instructions).toContain('file_read');
      expect(edited.instructions).not.toContain('notebook_edit');
    });
  });

  pdfTest('file_read renders requested PDF pages as image parts', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'sample.pdf');
      await writeFile(filePath, makePdf(['First page', 'Second page']), 'utf8');

      const tool = createLocalTools({ localRoot: workspaceRoot }).find((candidate) => candidate.name === 'file_read')!;
      const result = await (tool.execute as any)('test-call', { file_path: filePath, pages: '2' });
      const read = result.details as ToolEnvelope<{
        type: 'parts';
        file: { count: number; outputDir: string; originalSize: number; pages: { firstPage: number; lastPage: number }; extractedText?: { chars: number } };
      }>;

      expect(read.ok).toBe(true);
      expect(read.data!.type).toBe('parts');
      expect(read.data!.file.count).toBe(1);
      expect(read.data!.file.pages).toEqual({ firstPage: 2, lastPage: 2 });
      expect((await readdir(read.data!.file.outputDir)).some((entry) => entry.endsWith('.jpg'))).toBe(true);
      expect(result.content.some((block: { type: string }) => block.type === 'image')).toBe(true);
    });
  });

  test('file_edit detects user-modified files after read', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.md');
      await writeFile(filePath, 'first\nsecond\n', 'utf8');
      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await writeFile(filePath, 'first\nuser edit\n', 'utf8');

      const edited = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'second',
        new_string: 'agent edit',
      });

      expect(edited.ok).toBe(false);
      expect(edited.error?.code).toBe('user_modified');
    });
  });

  test('file_write creates files and requires a read before rewriting existing files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'docs', 'plan.md');

      const created = await executeTool<{ type: 'create'; filePath: string }>(workspaceRoot, 'file_write', {
        file_path: filePath,
        content: '# Plan\n',
      });
      expect(created.ok).toBe(true);
      expect(created.data).toMatchObject({ type: 'create', filePath });

      const existingPath = path.join(workspaceRoot, 'docs', 'existing.md');
      await writeFile(existingPath, '# User Plan\n', 'utf8');
      const blocked = await executeTool(workspaceRoot, 'file_write', {
        file_path: existingPath,
        content: '# Agent Plan\n',
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.error?.code).toBe('file_not_read');

      await executeTool(workspaceRoot, 'file_read', { file_path: existingPath });
      const updated = await executeTool<{ type: 'update' }>(workspaceRoot, 'file_write', {
        file_path: existingPath,
        content: '# Agent Plan\n',
      });
      expect(updated.ok).toBe(true);
      expect(updated.data!.type).toBe('update');
    });
  });

  test('file_glob and file_grep find workspace files without bash', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      const alpha = path.join(workspaceRoot, 'src', 'alpha.ts');
      const beta = path.join(workspaceRoot, 'src', 'beta.ts');
      await writeFile(alpha, 'export const city = "Chengdu";\n', 'utf8');
      await writeFile(beta, 'export const city = "Shanghai";\n', 'utf8');
      await writeFile(path.join(workspaceRoot, 'root.ts'), 'export const city = "Beijing";\n', 'utf8');

      const glob = await executeTool<{ filenames: string[] }>(workspaceRoot, 'file_glob', {
        pattern: 'src/**/*.ts',
      });
      expect(glob.ok).toBe(true);
      expect(glob.data!.filenames.sort()).toEqual(['src/alpha.ts', 'src/beta.ts']);

      const rootGlob = await executeTool<{ filenames: string[] }>(workspaceRoot, 'file_glob', {
        pattern: '*.ts',
      });
      expect(rootGlob.ok).toBe(true);
      expect(rootGlob.data!.filenames).toEqual(['root.ts']);

      const grep = await executeTool<{
        mode: 'content';
        content: string;
        numFiles: number;
      }>(workspaceRoot, 'file_grep', {
        pattern: 'Chengdu',
        path: path.join(workspaceRoot, 'src'),
        glob: '**/*.ts',
        output_mode: 'content',
      });
      expect(grep.ok).toBe(true);
      expect(grep.data!.numFiles).toBe(0);
      expect(grep.data!.content).toContain('src/alpha.ts:1:export const city = "Chengdu";');
    });
  });

  test('file_glob prefers rg --files candidates before falling back to directory walks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await mkdir(path.join(workspaceRoot, 'fake-bin'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'from-rg.ts'), 'export const source = "rg";\n', 'utf8');
      await writeFile(path.join(workspaceRoot, 'src', 'fallback-only.ts'), 'export const source = "fallback";\n', 'utf8');

      const realRg = commandPath('rg');
      const rgArgsLog = path.join(workspaceRoot, 'rg-args.log');
      const fakeRg = path.join(workspaceRoot, 'fake-bin', 'rg');
      await writeFile(fakeRg, [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--files" ]; then',
        '    printf \'%s\\n\' "$@" > "$RG_ARGS_LOG"',
        '    printf \'%b\' \'src/from-rg.ts\\000\'',
        '    exit 0',
        '  fi',
        'done',
        realRg ? `exec ${JSON.stringify(realRg)} "$@"` : 'exit 127',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakeRg, 0o755);

      const originalPath = process.env.PATH;
      const originalLog = process.env.RG_ARGS_LOG;
      process.env.PATH = [path.dirname(fakeRg), originalPath].filter(Boolean).join(path.delimiter);
      process.env.RG_ARGS_LOG = rgArgsLog;
      try {
        const glob = await executeTool<{ filenames: string[] }>(workspaceRoot, 'file_glob', {
          pattern: 'src/**/*.ts',
        });
        expect(glob.ok).toBe(true);
        expect(glob.data!.filenames).toEqual(['src/from-rg.ts']);

        const args = await readFile(rgArgsLog, 'utf8');
        expect(args).toContain('--files');
        expect(args).toContain('--null');
        expect(args).toContain('src/**/*.ts');
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalLog === undefined) {
          delete process.env.RG_ARGS_LOG;
        } else {
          process.env.RG_ARGS_LOG = originalLog;
        }
      }
    });
  });

  test('file_glob falls back to directory walking when rg --files fails', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await mkdir(path.join(workspaceRoot, 'fake-bin'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'fallback.ts'), 'export const source = "fallback";\n', 'utf8');

      const realRg = commandPath('rg');
      const rgArgsLog = path.join(workspaceRoot, 'rg-failed-args.log');
      const fakeRg = path.join(workspaceRoot, 'fake-bin', 'rg');
      await writeFile(fakeRg, [
        '#!/bin/sh',
        'for arg in "$@"; do',
        '  if [ "$arg" = "--files" ]; then',
        '    printf \'%s\\n\' "$@" > "$RG_ARGS_LOG"',
        '    echo "synthetic rg failure" >&2',
        '    exit 2',
        '  fi',
        'done',
        realRg ? `exec ${JSON.stringify(realRg)} "$@"` : 'exit 127',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakeRg, 0o755);

      const originalPath = process.env.PATH;
      const originalLog = process.env.RG_ARGS_LOG;
      process.env.PATH = [path.dirname(fakeRg), originalPath].filter(Boolean).join(path.delimiter);
      process.env.RG_ARGS_LOG = rgArgsLog;
      try {
        const glob = await executeTool<{ filenames: string[] }>(workspaceRoot, 'file_glob', {
          pattern: 'src/**/*.ts',
        });
        expect(glob.ok).toBe(true);
        expect(glob.data!.filenames).toEqual(['src/fallback.ts']);
        expect(await readFile(rgArgsLog, 'utf8')).toContain('--files');
      } finally {
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalLog === undefined) {
          delete process.env.RG_ARGS_LOG;
        } else {
          process.env.RG_ARGS_LOG = originalLog;
        }
      }
    });
  });

  test('file_grep uses ripgrep-style modes with relative paths and pagination', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'alpha.ts'), 'hello\nHELLO\n', 'utf8');
      await writeFile(path.join(workspaceRoot, 'src', 'beta.ts'), 'hello\n', 'utf8');

      const files = await executeTool<{ mode: 'files_with_matches'; filenames: string[]; appliedLimit?: number }>(workspaceRoot, 'file_grep', {
        pattern: 'hello',
        path: workspaceRoot,
        glob: '**/*.ts',
        head_limit: 1,
      });
      expect(files.ok).toBe(true);
      expect(files.data!.filenames).toHaveLength(1);
      expect(files.data!.filenames[0]!.startsWith('/')).toBe(false);
      expect(files.data!.appliedLimit).toBe(1);

      const count = await executeTool<{ mode: 'count'; content: string; numFiles: number; numMatches: number }>(workspaceRoot, 'file_grep', {
        pattern: 'hello',
        path: workspaceRoot,
        glob: '**/*.ts',
        output_mode: 'count',
        '-i': true,
      });
      expect(count.ok).toBe(true);
      expect(count.data!.content).toContain('src/alpha.ts:2');
      expect(count.data!.numMatches).toBe(3);
      expect(count.data!.numFiles).toBe(2);
    });
  });

  test('file_edit rejects empty old_string and points creation to file_write', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'empty.txt');
      await writeFile(filePath, '', 'utf8');
      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });

      const edited = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: '',
        new_string: 'hello',
      });

      expect(edited.ok).toBe(false);
      expect(edited.error?.code).toBe('empty_old_string');
      expect(edited.instructions).toContain('file_write');
    });
  });

  test('bash runs foreground commands and returns stdout', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const result = await executeTool<{ stdout: string; stderr: string; interrupted: boolean }>(workspaceRoot, 'bash', {
        command: 'printf "hello"',
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ stdout: 'hello', stderr: '', interrupted: false });
    });
  });

  test('bash treats semantic non-zero exits as successful tool results', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'notes.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');

      const result = await executeTool<{ exitCode: number; returnCodeInterpretation: string }>(workspaceRoot, 'bash', {
        command: `grep beta ${JSON.stringify(filePath)}`,
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        exitCode: 1,
        returnCodeInterpretation: 'No matches found',
      });
    });
  });

  test('bash background tasks can be stopped with task_stop', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const started = await executeTool<{ backgroundTaskId: string; persistedOutputPath: string; taskStatus: string }>(workspaceRoot, 'bash', {
        command: 'sleep 5',
        run_in_background: true,
      });
      expect(started.ok).toBe(true);
      expect(started.data!.backgroundTaskId).toStartWith('task_');
      expect(started.data!.taskStatus).toBe('running');

      const stopped = await executeTool<{ task_id: string; task_type: string; status: string; outputPath: string }>(workspaceRoot, 'task_stop', {
        task_id: started.data!.backgroundTaskId,
      });
      expect(stopped.ok).toBe(true);
      expect(stopped.data).toMatchObject({ task_id: started.data!.backgroundTaskId, task_type: 'bash', status: 'stopped' });
      expect(stopped.data!.outputPath).toBe(started.data!.persistedOutputPath);
      expect(await readFile(stopped.data!.outputPath, 'utf8')).toContain('status: stopped');
    });
  });

  test('bash background tasks write status and output to the returned file', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const started = await executeTool<{ backgroundTaskId: string; persistedOutputPath: string }>(workspaceRoot, 'bash', {
        command: 'printf "done"',
        run_in_background: true,
      });
      expect(started.ok).toBe(true);

      const output = await waitForFileContent(
        started.data!.persistedOutputPath,
        (content) => content.includes('status: completed') && content.includes('[stdout]\ndone'),
      );
      expect(output).toContain(`task_id: ${started.data!.backgroundTaskId}`);
      expect(output).toContain('status: completed');
      expect(output).toContain('[stdout]\ndone');
    });
  });

  test('bash background task history prunes old completed tasks', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const taskIds: string[] = [];
      for (let index = 0; index < 22; index += 1) {
        const started = await executeTool<{ backgroundTaskId: string; persistedOutputPath: string }>(workspaceRoot, 'bash', {
          command: `printf "task-${index}"`,
          run_in_background: true,
        });
        expect(started.ok).toBe(true);
        taskIds.push(started.data!.backgroundTaskId);
        const output = await waitForFileContent(
          started.data!.persistedOutputPath,
          (content) => content.includes('status: completed') && content.includes(`task-${index}`),
          3000,
        );
        expect(output).toContain('status: completed');
      }

      const pruned = await executeTool(workspaceRoot, 'task_stop', {
        task_id: taskIds[0],
      });
      expect(pruned.ok).toBe(false);
      expect(pruned.error?.code).toBe('task_not_found');

      const recentCompleted = await executeTool(workspaceRoot, 'task_stop', {
        task_id: taskIds.at(-1),
      });
      expect(recentCompleted.ok).toBe(false);
      expect(recentCompleted.error?.code).toBe('task_not_running');
    });
  });
});

describe('local tool model-visible projections', () => {
  test('bash keeps output and signals, drops echoed command and telemetry', () => {
    const data: BashData = {
      stdout: 'hi',
      stderr: '',
      interrupted: false,
      exitCode: 0,
      command: 'echo hi',
      returnCodeInterpretation: undefined,
      noOutputExpected: false,
      dangerouslyDisableSandbox: false,
    };
    expect(visibleBash(data)).toEqual({ stdout: 'hi', stderr: '' });
  });

  test('bash surfaces non-zero exit, interruption, and background/persisted paths', () => {
    const failed: BashData = {
      stdout: '',
      stderr: 'boom',
      interrupted: true,
      exitCode: 1,
      command: 'false',
    };
    expect(visibleBash(failed)).toEqual({ stdout: '', stderr: 'boom', interrupted: true, exitCode: 1 });

    const background: BashData = {
      stdout: '',
      stderr: '',
      interrupted: false,
      backgroundTaskId: 'task_1',
      taskStatus: 'running',
      command: 'sleep 100',
      persistedOutputPath: '/tmp/task_1.log',
      startedAt: '2026-05-26T00:00:00.000Z',
    };
    expect(visibleBash(background)).toEqual({
      stdout: '',
      stderr: '',
      backgroundTaskId: 'task_1',
      taskStatus: 'running',
      persistedOutputPath: '/tmp/task_1.log',
    });
  });

  test('file_glob keeps filenames and only includes truncated when true', () => {
    const data: FileGlobData = { durationMs: 12, numFiles: 2, filenames: ['a.ts', 'b.ts'], truncated: false };
    expect(visibleFileGlob(data)).toEqual({ filenames: ['a.ts', 'b.ts'] });
    expect(visibleFileGlob({ ...data, truncated: true })).toEqual({ filenames: ['a.ts', 'b.ts'], truncated: true });
  });

  test('file_grep returns mode-specific shapes without derivable counts', () => {
    const filesMode: FileGrepData = { mode: 'files_with_matches', numFiles: 2, filenames: ['a.ts', 'b.ts'] };
    expect(visibleFileGrep(filesMode)).toEqual({ mode: 'files_with_matches', filenames: ['a.ts', 'b.ts'] });

    const contentMode: FileGrepData = { mode: 'content', numFiles: 0, filenames: [], content: 'a.ts:1:hit', numLines: 1, appliedLimit: 1, appliedOffset: 0 };
    expect(visibleFileGrep(contentMode)).toEqual({ mode: 'content', content: 'a.ts:1:hit' });

    const countMode: FileGrepData = { mode: 'count', numFiles: 2, filenames: [], content: 'a.ts:2', numMatches: 3 };
    expect(visibleFileGrep(countMode)).toEqual({ mode: 'count', content: 'a.ts:2', numMatches: 3 });
  });

  test('task_stop keeps id/status/outputPath and drops the echoed message', () => {
    const data: TaskStopData = {
      message: 'Successfully stopped task: task_1 (sleep 100)',
      task_id: 'task_1',
      task_type: 'bash',
      command: 'sleep 100',
      status: 'stopped',
      outputPath: '/tmp/task_1.log',
    };
    expect(visibleTaskStop(data)).toEqual({ task_id: 'task_1', status: 'stopped', outputPath: '/tmp/task_1.log' });
  });
});
