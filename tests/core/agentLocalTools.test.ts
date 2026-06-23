import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildAgentLocalToolProcessEnv,
  createAgentLocalWorkspaceContext,
  createLocalTools,
  POPPLER_RECOVERY_INSTRUCTIONS,
  restorePostCompactReadFiles,
  scratchRootForWorkdir,
  setAgentLocalPermissionRoots,
  visibleBash,
  visibleFileGlob,
  visibleFileGrep,
  visibleTaskStop,
  type BashData,
  type FileGlobData,
  type FileGrepData,
  type TaskStopData,
} from '../../src/main/agentLocalTools';
import { AgentSkillRuntime } from '../../src/main/agentSkills';
import { agentAttachmentDir, materializePathBackedAttachment } from '../../src/main/agentAttachmentMaterialization';
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
const hasPdfTextTools = commandExists('pdfinfo') && commandExists('pdftotext');
const pdfTextTest = hasPdfTextTools ? test : test.skip;

// file_grep shells out to a real `rg` binary; skip ripgrep-backed cases when the
// binary is not on PATH (mirrors the pdfTest pattern).
const hasRipgrep = commandExists('rg');
const ripgrepTest = hasRipgrep ? test : test.skip;

function commandExists(command: string): boolean {
  return !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
}

function commandPath(command: string): string | null {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function withPrependedPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = [binDir, originalPath].filter(Boolean).join(path.delimiter);
  try {
    return await fn();
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
}

test('agent local tool process env includes configured and standard tool paths', () => {
  const originalPath = process.env.PATH;
  const originalExtraPath = process.env.LIN_AGENT_EXTRA_TOOL_PATH;
  const extraPath = path.join(tmpdir(), 'lin-extra-tools');
  process.env.PATH = ['/usr/bin', '/opt/homebrew/bin'].join(path.delimiter);
  process.env.LIN_AGENT_EXTRA_TOOL_PATH = [extraPath, '/usr/bin'].join(path.delimiter);
  try {
    const env = buildAgentLocalToolProcessEnv();
    const segments = env.PATH?.split(path.delimiter) ?? [];
    expect(segments.slice(0, 3)).toEqual([extraPath, '/usr/bin', '/opt/homebrew/bin']);
    expect(segments).toContain('/usr/local/bin');
    expect(segments.filter((segment) => segment === '/usr/bin')).toHaveLength(1);
    expect(segments.filter((segment) => segment === '/opt/homebrew/bin')).toHaveLength(1);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalExtraPath === undefined) {
      delete process.env.LIN_AGENT_EXTRA_TOOL_PATH;
    } else {
      process.env.LIN_AGENT_EXTRA_TOOL_PATH = originalExtraPath;
    }
  }
});

test('Poppler recovery instructions tell the agent to install with bash and retry', () => {
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('Run bash to detect an available package manager');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('Do not assume Homebrew is available');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('`brew install poppler`');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('`sudo port install poppler`');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('`sudo apt-get update && sudo apt-get install -y poppler-utils`');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('If no supported package manager is available');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('pdftotext');
  expect(POPPLER_RECOVERY_INSTRUCTIONS).toContain('retry the same file_read or file_convert call');
});

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

describe('scratchRootForWorkdir', () => {
  test('prefers the explicit scratch root and otherwise falls back to <workdir>/tmp', () => {
    const workdir = path.join(path.parse(process.cwd()).root, 'work');
    const explicit = path.join(path.parse(process.cwd()).root, 'data', 'agent-scratch');

    // Explicit app-owned scratch wins, independent of the workdir.
    expect(scratchRootForWorkdir(workdir, explicit)).toBe(path.resolve(explicit));
    // Fallback keeps the legacy in-workdir layout for callers built with only a workdir.
    expect(scratchRootForWorkdir(workdir, undefined)).toBe(path.join(path.resolve(workdir), 'tmp'));
  });
});

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

  test('file_read rejects symlinks that resolve outside the local root', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-outside-'));
      try {
        const outsideFile = path.join(outsideRoot, 'secret.txt');
        const linkPath = path.join(workspaceRoot, 'linked-secret.txt');
        await writeFile(outsideFile, 'secret', 'utf8');
        await symlink(outsideFile, linkPath);

        const read = await executeTool(workspaceRoot, 'file_read', { file_path: linkPath });

        expect(read.ok).toBe(false);
        expect(read.error?.code).toBe('path_outside_local_root');
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  test('scratch root is readable but not writable when it sits outside the workdir', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const scratchRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-scratch-'));
      try {
        // A materialized attachment / fetched binary lands in scratch (a sibling of the workdir).
        const scratchFile = path.join(scratchRoot, 'agent-attachments', 'doc.txt');
        await mkdir(path.dirname(scratchFile), { recursive: true });
        await writeFile(scratchFile, 'attachment body', 'utf8');

        const tools = createLocalTools({ localRoot: workspaceRoot, scratchRoot });
        const fileRead = tools.find((tool) => tool.name === 'file_read')!;
        const read = (await (fileRead.execute as any)('call', { file_path: scratchFile })).details as ToolEnvelope<{
          type: 'text';
          file: { content: string };
        }>;

        expect(read.ok).toBe(true);
        expect(read.data!.file.content).toBe('attachment body');

        // Scratch is read-only for the agent: a write to a scratch path is rejected even though
        // reading it is allowed — the agent writes its own outputs to the workdir.
        const fileWrite = tools.find((tool) => tool.name === 'file_write')!;
        const blockedWrite = (await (fileWrite.execute as any)('call', {
          file_path: path.join(scratchRoot, 'agent-attachments', 'sneaky.txt'),
          content: 'no',
        })).details as ToolEnvelope<unknown>;
        expect(blockedWrite.ok).toBe(false);
        expect(blockedWrite.error?.code).toBe('path_outside_local_root');

        // The same read path is rejected when scratch is not declared, proving the allowance is
        // the scratch root and not a loosened boundary.
        const sealed = createLocalTools({ localRoot: workspaceRoot }).find((tool) => tool.name === 'file_read')!;
        const denied = (await (sealed.execute as any)('call', { file_path: scratchFile })).details as ToolEnvelope<unknown>;
        expect(denied.ok).toBe(false);
        expect(denied.error?.code).toBe('path_outside_local_root');
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    });
  });

  test('remembered scope grants widen file-tool containment without changing the relative base', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const handedRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-handed-'));
      try {
        const handedFile = path.join(handedRoot, 'notes.txt');
        await writeFile(handedFile, 'handed notes', 'utf8');
        const workspace = createAgentLocalWorkspaceContext(workspaceRoot);
        setAgentLocalPermissionRoots(workspace, [{ access: 'read', root: handedRoot }]);
        const tools = createLocalTools({ workspace });
        const fileRead = tools.find((tool) => tool.name === 'file_read')!;
        const fileWrite = tools.find((tool) => tool.name === 'file_write')!;
        const read = (await (fileRead.execute as any)('call', { file_path: handedFile })).details as ToolEnvelope<{
          type: 'text';
          file: { content: string };
        }>;
        expect(read.ok).toBe(true);
        expect(read.data!.file.content).toBe('handed notes');

        const readOnlyWrite = (await (fileWrite.execute as any)('call', {
          file_path: path.join(handedRoot, 'created.txt'),
          content: 'no',
        })).details as ToolEnvelope<unknown>;
        expect(readOnlyWrite.ok).toBe(false);
        expect(readOnlyWrite.error?.code).toBe('path_outside_local_root');

        const exactNewFile = path.join(handedRoot, 'exact-new.txt');
        setAgentLocalPermissionRoots(workspace, [{ access: 'write', root: exactNewFile }]);
        const exactWrite = (await (fileWrite.execute as any)('call', {
          file_path: exactNewFile,
          content: 'exact',
        })).details as ToolEnvelope<{ type: 'create'; filePath: string }>;
        expect(exactWrite.ok).toBe(true);
        const siblingWrite = (await (fileWrite.execute as any)('call', {
          file_path: path.join(handedRoot, 'sibling.txt'),
          content: 'no',
        })).details as ToolEnvelope<unknown>;
        expect(siblingWrite.ok).toBe(false);
        expect(siblingWrite.error?.code).toBe('path_outside_local_root');

        setAgentLocalPermissionRoots(workspace, [{ access: 'write', root: handedRoot }]);
        const write = (await (fileWrite.execute as any)('call', {
          file_path: path.join(handedRoot, 'created.txt'),
          content: 'yes',
        })).details as ToolEnvelope<{ type: 'create'; filePath: string }>;
        expect(write.ok).toBe(true);
        expect(await readFile(path.join(handedRoot, 'created.txt'), 'utf8')).toBe('yes');

        const rootDelete = (await (tools.find((tool) => tool.name === 'file_delete')!.execute as any)('call', {
          file_path: handedRoot,
        })).details as ToolEnvelope<unknown>;
        expect(rootDelete.ok).toBe(false);
        expect(rootDelete.error?.code).toBe('root_delete_forbidden');

        const relativeWrite = (await (fileWrite.execute as any)('call', {
          file_path: 'relative.txt',
          content: 'relative stays in workdir',
        })).details as ToolEnvelope<{ type: 'create'; filePath: string }>;
        expect(relativeWrite.ok).toBe(true);
        expect(relativeWrite.data!.filePath).toBe(path.join(workspaceRoot, 'relative.txt'));
      } finally {
        await rm(handedRoot, { recursive: true, force: true });
      }
    });
  });

  test('file_convert uses handed scope roots for office-to-PDF output', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const inputRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-convert-input-'));
      const outputRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-convert-output-'));
      try {
        const fakeBin = path.join(workspaceRoot, 'fake-bin');
        await mkdir(fakeBin, { recursive: true });
        const fakeSoffice = path.join(fakeBin, 'soffice');
        await writeFile(fakeSoffice, [
          '#!/bin/sh',
          'outdir=""',
          'input=""',
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          '    --outdir) shift; outdir="$1" ;;',
          '    *) input="$1" ;;',
          '  esac',
          '  shift',
          'done',
          'base=${input##*/}',
          'name=${base%.*}',
          'printf "converted:%s\\n" "$input" > "$outdir/$name.pdf"',
          '',
        ].join('\n'), 'utf8');
        await chmod(fakeSoffice, 0o755);

        const inputPath = path.join(inputRoot, 'deck.pptx');
        const outputPath = path.join(outputRoot, 'deck.pdf');
        await writeFile(inputPath, 'presentation bytes', 'utf8');
        const workspace = createAgentLocalWorkspaceContext(workspaceRoot);
        setAgentLocalPermissionRoots(workspace, [
          { access: 'read', root: inputRoot },
          { access: 'write', root: outputRoot },
        ]);
        const fileConvert = createLocalTools({ workspace }).find((tool) => tool.name === 'file_convert')!;

        await withPrependedPath(fakeBin, async () => {
          const result = (await (fileConvert.execute as any)('convert-office', {
            input_path: inputPath,
            output_format: 'pdf',
            output_path: outputPath,
          })).details as ToolEnvelope<{
            outputs: Array<{ filePath: string; format: string; mimeType: string; sizeBytes: number }>;
            command: { executable: string; shell: false; args: string[] };
          }>;

          expect(result.ok).toBe(true);
          expect(result.data!.outputs).toEqual([{
            filePath: outputPath,
            format: 'pdf',
            mimeType: 'application/pdf',
            sizeBytes: (await readFile(outputPath)).byteLength,
          }]);
          expect(result.data!.command).toMatchObject({
            executable: 'soffice',
            shell: false,
          });
          expect(result.data!.command.args).toContain('--convert-to');
          expect(await readFile(outputPath, 'utf8')).toBe(`converted:${inputPath}\n`);
        });
      } finally {
        await rm(inputRoot, { recursive: true, force: true });
        await rm(outputRoot, { recursive: true, force: true });
      }
    });
  });

  test('file_convert cannot target self-definition outputs', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const inputPath = path.join(workspaceRoot, 'image.png');
      await writeFile(inputPath, makePng(4, 4));

      const result = await executeTool(workspaceRoot, 'file_convert', {
        input_path: inputPath,
        output_format: 'pdf',
        output_path: path.join(workspaceRoot, '.agents', 'skills', 'convert-skill', 'SKILL.md'),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('self_definition_convert_output_not_supported');
    });
  });

  test('file_convert renders every PDF page to image files when pages is omitted', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const fakeBin = path.join(workspaceRoot, 'fake-pdf-bin');
      await mkdir(fakeBin, { recursive: true });
      const fakePdfinfo = path.join(fakeBin, 'pdfinfo');
      await writeFile(fakePdfinfo, [
        '#!/bin/sh',
        'printf "Pages:          15\\n"',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakePdfinfo, 0o755);
      const fakePdftoppm = path.join(fakeBin, 'pdftoppm');
      await writeFile(fakePdftoppm, [
        '#!/bin/sh',
        'first=1',
        'last=1',
        'prefix=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -f) shift; first="$1" ;;',
        '    -l) shift; last="$1" ;;',
        '    *) prefix="$1" ;;',
        '  esac',
        '  shift',
        'done',
        'i="$first"',
        'while [ "$i" -le "$last" ]; do',
        '  printf "page%s\\n" "$i" > "$prefix-$i.png"',
        '  i=$((i + 1))',
        'done',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakePdftoppm, 0o755);

      const inputPath = path.join(workspaceRoot, 'source.pdf');
      const outputDir = path.join(workspaceRoot, 'pages');
      await writeFile(inputPath, '%PDF synthetic', 'utf8');
      const fileConvert = createLocalTools({ localRoot: workspaceRoot }).find((tool) => tool.name === 'file_convert')!;

      await withPrependedPath(fakeBin, async () => {
        const result = (await (fileConvert.execute as any)('convert-pdf', {
          input_path: inputPath,
          output_format: 'png',
          output_dir: outputDir,
        })).details as ToolEnvelope<{
          outputs: Array<{ filePath: string; format: string; mimeType: string; sizeBytes: number }>;
          command: { executable: string; shell: false };
        }>;

        expect(result.ok).toBe(true);
        expect(result.data!.command).toMatchObject({ executable: 'pdftoppm', shell: false });
        expect(result.data!.outputs.map((output) => path.basename(output.filePath))).toEqual(
          Array.from({ length: 15 }, (_, index) => `source-${index + 1}.png`),
        );
        expect(await readFile(path.join(outputDir, 'source-1.png'), 'utf8')).toBe('page1\n');
        expect(await readFile(path.join(outputDir, 'source-15.png'), 'utf8')).toBe('page15\n');
      });
    });
  });

  test('file_convert maps pdftoppm password failures to actionable PDF errors', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const fakeBin = path.join(workspaceRoot, 'fake-protected-pdf-bin');
      await mkdir(fakeBin, { recursive: true });
      const fakePdfinfo = path.join(fakeBin, 'pdfinfo');
      await writeFile(fakePdfinfo, [
        '#!/bin/sh',
        'printf "Pages:          1\\n"',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakePdfinfo, 0o755);
      const fakePdftoppm = path.join(fakeBin, 'pdftoppm');
      await writeFile(fakePdftoppm, [
        '#!/bin/sh',
        'printf "Incorrect password\\n" >&2',
        'exit 1',
        '',
      ].join('\n'), 'utf8');
      await chmod(fakePdftoppm, 0o755);

      const inputPath = path.join(workspaceRoot, 'protected.pdf');
      await writeFile(inputPath, '%PDF protected', 'utf8');
      const fileConvert = createLocalTools({ localRoot: workspaceRoot }).find((tool) => tool.name === 'file_convert')!;

      await withPrependedPath(fakeBin, async () => {
        const result = (await (fileConvert.execute as any)('convert-protected-pdf', {
          input_path: inputPath,
          output_format: 'png',
        })).details as ToolEnvelope<unknown>;

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('pdf_password_protected');
        expect(result.instructions).toContain('unprotected');
      });
    });
  });

  test('file_convert rejects PDF page-image-only parameters during normalization', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const inputPath = path.join(workspaceRoot, 'source.txt');
      await writeFile(inputPath, 'not convertible', 'utf8');
      const fileConvert = createLocalTools({ localRoot: workspaceRoot }).find((tool) => tool.name === 'file_convert')!;

      const result = (await (fileConvert.execute as any)('convert-invalid-pages', {
        input_path: inputPath,
        output_format: 'png',
        pages: '1-2',
      })).details as ToolEnvelope<unknown>;

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_args');
      expect(result.error?.message).toContain('pages is only valid');
    });
  });

  test('a materialized attachment in a separate scratch root is readable by file_read (production layout)', async () => {
    // Production wires workdir and scratch as independent siblings (`<userData>/agent-workdir`
    // and `<userData>/agent-scratch`), unlike the `<workdir>/tmp` default the other tests inherit.
    // This proves the materializer's target dir and the file tool's trusted-roots set agree when
    // scratch genuinely sits OUTSIDE the workdir — the round-trip the two-root model relies on.
    await withWorkspace(async (workspaceRoot) => {
      const scratchRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-scratch-'));
      const sourceRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-source-'));
      try {
        const sourcePath = path.join(sourceRoot, 'report.txt');
        await writeFile(sourcePath, 'materialized body', 'utf8');

        // The app materializes an out-of-area attachment exactly as production does.
        const attachment = await materializePathBackedAttachment(workspaceRoot, scratchRoot, {
          name: 'report.txt',
          path: sourcePath,
        });
        expect(attachment.path).toStartWith(agentAttachmentDir(scratchRoot));
        expect(attachment.path).not.toStartWith(path.resolve(workspaceRoot));

        // The agent can then read that materialized path back through file_read.
        const fileRead = createLocalTools({ localRoot: workspaceRoot, scratchRoot })
          .find((tool) => tool.name === 'file_read')!;
        const read = (await (fileRead.execute as any)('call', { file_path: attachment.path })).details as ToolEnvelope<{
          type: 'text';
          file: { content: string };
        }>;
        expect(read.ok).toBe(true);
        expect(read.data!.file.content).toBe('materialized body');
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
        await rm(sourceRoot, { recursive: true, force: true });
      }
    });
  });

  test('file_glob rejects symlinked directories that resolve outside the local root', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lin-local-tools-outside-'));
      try {
        const linkPath = path.join(workspaceRoot, 'outside-dir');
        await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret', 'utf8');
        await symlink(outsideRoot, linkPath, 'dir');

        const glob = await executeTool(workspaceRoot, 'file_glob', { path: linkPath, pattern: '**/*' });

        expect(glob.ok).toBe(false);
        expect(glob.error?.code).toBe('path_outside_local_root');
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
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
      // A partial read carries a structured truncation signal, not just prose.
      expect(read.status).toBe('partial');
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
        resolveSkillTarget: () => null,
      };
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime as any);
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
    const fileDelete = tools.find((tool) => tool.name === 'file_delete')!;
    const bash = tools.find((tool) => tool.name === 'bash')!;
    const taskStop = tools.find((tool) => tool.name === 'task_stop')!;

    expect(fileRead.description).toContain('The file_path parameter must be an absolute path');
    expect(JSON.stringify(fileRead.parameters)).toContain('The line number to start reading from');
    expect(JSON.stringify(fileRead.parameters)).toContain('Maximum 20 pages per request');
    expect(fileEdit.description).toContain('Performs exact string replacements in files');
    expect(fileEdit.description).not.toContain('notebook_edit');
    expect(fileDelete.description).toContain('agent trash');
    expect(JSON.stringify(fileDelete.parameters)).toContain('move to agent trash');
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

  test('file_read converts rich documents to Markdown with MarkItDown', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const binDir = path.join(workspaceRoot, 'fake-markitdown-bin');
      await mkdir(binDir, { recursive: true });
      const fakeMarkitdown = path.join(binDir, 'markitdown');
      await writeFile(fakeMarkitdown, [
        '#!/bin/sh',
        'if [ "$1" = "--help" ]; then echo "Usage: markitdown"; exit 0; fi',
        'printf "# Converted\\n\\nSource: %s\\n" "$1"',
      ].join('\n'), 'utf8');
      await chmod(fakeMarkitdown, 0o755);

      const filePath = path.join(workspaceRoot, 'brief.docx');
      await writeFile(filePath, 'fake office payload', 'utf8');

      const originalCommand = process.env.LIN_AGENT_MARKITDOWN_COMMAND;
      delete process.env.LIN_AGENT_MARKITDOWN_COMMAND;
      try {
        await withPrependedPath(binDir, async () => {
          const read = await executeTool<{
            type: 'markdown';
            file: {
              filePath: string;
              content: string;
              converter: 'markitdown';
              truncated: boolean;
              originalSize: number;
            };
          }>(workspaceRoot, 'file_read', { file_path: filePath });

          expect(read.ok).toBe(true);
          expect(read.data!.type).toBe('markdown');
          expect(read.data!.file).toMatchObject({
            filePath,
            content: `# Converted\n\nSource: ${filePath}`,
            converter: 'markitdown',
            truncated: false,
            originalSize: 'fake office payload'.length,
          });
          expect(read.instructions).toBe('The document was converted to Markdown locally.');

          const tool = createLocalTools({ localRoot: workspaceRoot }).find((candidate) => candidate.name === 'file_read')!;
          const result = await (tool.execute as any)('rich-doc-visible', { file_path: filePath });
          const visible = JSON.parse(result.content[0].text);
          expect(visible.data.file.content).toContain('# Converted');
          expect(result.content).toHaveLength(1);
        });
      } finally {
        if (originalCommand === undefined) {
          delete process.env.LIN_AGENT_MARKITDOWN_COMMAND;
        } else {
          process.env.LIN_AGENT_MARKITDOWN_COMMAND = originalCommand;
        }
      }
    });
  });

  test('file_read returns a recoverable MarkItDown dependency error for rich documents', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const originalCommand = process.env.LIN_AGENT_MARKITDOWN_COMMAND;
      process.env.LIN_AGENT_MARKITDOWN_COMMAND = path.join(workspaceRoot, 'missing-markitdown');
      try {
        const filePath = path.join(workspaceRoot, 'brief.pptx');
        await writeFile(filePath, 'fake office payload', 'utf8');

        const read = await executeTool(workspaceRoot, 'file_read', { file_path: filePath });

        expect(read.ok).toBe(false);
        expect(read.error?.code).toBe('markitdown_unavailable');
        expect(read.instructions).toContain('python3 -m pip install --user');
        expect(read.instructions).toContain('Do not assume Homebrew is available');
        expect(read.instructions).toContain('retry the same file_read call');
      } finally {
        if (originalCommand === undefined) {
          delete process.env.LIN_AGENT_MARKITDOWN_COMMAND;
        } else {
          process.env.LIN_AGENT_MARKITDOWN_COMMAND = originalCommand;
        }
      }
    });
  });

  pdfTextTest('file_read extracts PDF text without native provider payloads', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'sample.pdf');
      await writeFile(filePath, makePdf(['First page', 'Second page']), 'utf8');

      const tool = createLocalTools({ localRoot: workspaceRoot }).find((candidate) => candidate.name === 'file_read')!;
      const result = await (tool.execute as any)('test-call', { file_path: filePath });
      const read = result.details as ToolEnvelope<{
        type: 'pdf';
        file: { filePath: string; originalSize: number; totalPages: number; mode: string; pages: { firstPage: number; lastPage: number }; extractedText?: { truncated: boolean } };
      }>;
      const visible = JSON.parse(result.content[0].text);

      expect(read.ok).toBe(true);
      expect(read.data!.type).toBe('pdf');
      expect(read.data!.file.mode).toBe('text');
      expect(read.data!.file.totalPages).toBe(2);
      expect(read.data!.file.pages).toEqual({ firstPage: 1, lastPage: 2 });
      expect(read.data!.file.extractedText?.truncated).toBe(false);
      expect(visible.data.file).toEqual({
        filePath,
        originalSize: read.data!.file.originalSize,
        totalPages: 2,
        mode: 'text',
        pages: { firstPage: 1, lastPage: 2 },
        extractedText: { truncated: false },
      });
      expect(JSON.stringify(visible)).not.toContain('base64');
      expect(JSON.stringify(visible)).not.toContain('input_file');
      expect(result.content.some((block: { type: string; text?: string }) => block.type === 'text' && block.text?.includes('First page'))).toBe(true);
      expect(result.content.some((block: { type: string }) => block.type === 'image')).toBe(false);
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
        type: 'pdf';
        file: { renderedImages?: { count: number; outputDir: string }; originalSize: number; pages: { firstPage: number; lastPage: number }; extractedText?: { chars: number } };
      }>;

      expect(read.ok).toBe(true);
      expect(read.data!.type).toBe('pdf');
      expect(read.data!.file.renderedImages?.count).toBe(1);
      expect(read.data!.file.pages).toEqual({ firstPage: 2, lastPage: 2 });
      expect((await readdir(read.data!.file.renderedImages!.outputDir)).some((entry) => entry.endsWith('.jpg'))).toBe(true);
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

  test('file_delete moves files and directories to agent trash instead of unlinking', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const filePath = path.join(workspaceRoot, 'dist', 'bundle.js');
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'console.log("old");\n', 'utf8');

      await executeTool(workspaceRoot, 'file_read', { file_path: filePath });
      const deleted = await executeTool<{ filePath: string; trashPath: string; kind: string }>(workspaceRoot, 'file_delete', {
        file_path: filePath,
      });

      expect(deleted.ok).toBe(true);
      expect(deleted.data).toMatchObject({ filePath, kind: 'file' });
      expect(await readFile(deleted.data!.trashPath, 'utf8')).toBe('console.log("old");\n');
      await expect(readFile(filePath, 'utf8')).rejects.toThrow();

      const editAfterDelete = await executeTool(workspaceRoot, 'file_edit', {
        file_path: filePath,
        old_string: 'old',
        new_string: 'new',
      });
      expect(editAfterDelete.ok).toBe(false);
      expect(editAfterDelete.error?.code).toBe('file_not_found');

      const dirPath = path.join(workspaceRoot, 'old-dir');
      await mkdir(dirPath, { recursive: true });
      await writeFile(path.join(dirPath, 'note.txt'), 'recoverable\n', 'utf8');
      const deletedDir = await executeTool<{ trashPath: string; kind: string }>(workspaceRoot, 'file_delete', {
        file_path: dirPath,
      });
      expect(deletedDir.ok).toBe(true);
      expect(deletedDir.data!.kind).toBe('directory');
      expect(await readFile(path.join(deletedDir.data!.trashPath, 'note.txt'), 'utf8')).toBe('recoverable\n');
    });
  });

  test('file_delete refuses the file area root and the agent trash itself', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const rootDelete = await executeTool(workspaceRoot, 'file_delete', {
        file_path: workspaceRoot,
      });
      expect(rootDelete.ok).toBe(false);
      expect(rootDelete.error?.code).toBe('root_delete_forbidden');

      const trashPath = path.join(workspaceRoot, '.agent-trash', 'manual');
      await mkdir(trashPath, { recursive: true });
      const trashDelete = await executeTool(workspaceRoot, 'file_delete', {
        file_path: trashPath,
      });
      expect(trashDelete.ok).toBe(false);
      expect(trashDelete.error?.code).toBe('trash_delete_forbidden');
    });
  });

  test('file_write validates agent-authored skills and hot-reloads the registry', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileWrite = tools.find((tool) => tool.name === 'file_write')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'draft-skill', 'SKILL.md');

      const result = await (fileWrite.execute as any)('write-skill', {
        file_path: skillFile,
        content: [
          '---',
          'description: Draft skill for local authoring',
          'disable-model-invocation: true',
          'allowed-tools: Bash(git status:*), file_read',
          '---',
          'Use the draft workflow.',
          '',
        ].join('\n'),
      });
      const details = result.details as ToolEnvelope<{ skillWrite?: { changeType: string; skillName: string } }>;
      const skill = await skillRuntime.getSkill('draft-skill');

      expect(details.ok).toBe(true);
      expect(details.data?.skillWrite).toMatchObject({
        changeType: 'create',
        skillName: 'draft-skill',
      });
      expect(details.instructions).toContain('registry has been reloaded');
      expect(skill).toMatchObject({
        name: 'draft-skill',
        source: 'project',
        modelInvocable: false,
        userInvocable: true,
      });
      expect(skill?.body).toContain('Use the draft workflow.');
    });
  });

  test('file_edit hot-reloads existing user-only skill content', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'existing-skill', 'SKILL.md');
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, [
        '---',
        'description: Existing local skill',
        'disable-model-invocation: true',
        '---',
        'Use old instructions.',
        '',
      ].join('\n'), 'utf8');

      expect((await skillRuntime.getSkill('existing-skill'))?.body).toContain('old instructions');
      await (fileRead.execute as any)('read-skill', { file_path: skillFile });
      const result = await (fileEdit.execute as any)('edit-skill', {
        file_path: skillFile,
        old_string: 'Use old instructions.',
        new_string: 'Use new instructions.',
      });
      const details = result.details as ToolEnvelope<{ skillWrite?: { changeType: string } }>;
      const skill = await skillRuntime.getSkill('existing-skill');

      expect(details.ok).toBe(true);
      expect(details.data?.skillWrite).toMatchObject({ changeType: 'patch' });
      expect(skill?.body).toContain('Use new instructions.');
    });
  });

  test('agent skill writes are immediately available to model and slash invocation', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileWrite = tools.find((tool) => tool.name === 'file_write')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'guarded-skill', 'SKILL.md');

      const result = await (fileWrite.execute as any)('write-guarded-skill', {
        file_path: skillFile,
        content: [
          '---',
          'description: Guarded skill for local authoring',
          '---',
          'Use guarded instructions.',
          '',
        ].join('\n'),
      });
      expect((result.details as ToolEnvelope<unknown>).ok).toBe(true);

      const skill = await skillRuntime.getSkill('guarded-skill');
      expect(skill?.modelInvocable).toBe(true);
      expect(skill?.ratified).toBe(true);
      expect(skill?.accepted).toBe(false);

      const listing = skillRuntime.drainSteeringMessages()
        .map((message) => message.content[0]?.type === 'text' ? message.content[0].text : '')
        .join('\n');
      expect(listing).toContain('guarded-skill');

      // Model-triggered invocation and slash invocation both work without a trust prompt.
      const agentInvocation = await skillRuntime.invokeSkill({ skill: 'guarded-skill', trigger: 'agent' });
      expect(agentInvocation.ok).toBe(true);
      expect((await skillRuntime.getSkill('guarded-skill'))?.accepted).toBe(false);
      const slashInvocation = await skillRuntime.invokeSkill({ skill: 'guarded-skill', trigger: 'slash' });
      expect(slashInvocation.ok).toBe(true);

      // A project hand-edit changes the content hash but stays model-usable.
      await writeFile(skillFile, [
        '---',
        'description: Guarded skill for local authoring',
        '---',
        'Use user-tuned instructions.',
        '',
      ].join('\n'), 'utf8');
      await skillRuntime.notifySkillContentWritten([skillFile]);
      const handEdited = await skillRuntime.getSkill('guarded-skill');
      expect(handEdited?.ratified).toBe(true);
      expect(handEdited?.accepted).toBe(false);
      expect((await skillRuntime.invokeSkill({ skill: 'guarded-skill', trigger: 'agent' })).ok).toBe(true);
      expect((await skillRuntime.getSkill('guarded-skill'))?.accepted).toBe(false);
    });
  });

  test('gateway-captured previous content powers single-step undo of an agent edit', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'undoable-skill', 'SKILL.md');
      const originalContent = [
        '---',
        'description: Hand-authored skill the agent will edit',
        '---',
        'Use hand-tuned instructions.',
        '',
      ].join('\n');
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, originalContent, 'utf8');

      await (fileRead.execute as any)('read-undoable-skill', { file_path: skillFile });
      const result = await (fileEdit.execute as any)('edit-undoable-skill', {
        file_path: skillFile,
        old_string: 'Use hand-tuned instructions.',
        new_string: 'Use agent-edited instructions.',
      });
      expect((result.details as ToolEnvelope<unknown>).ok).toBe(true);
      const edited = await skillRuntime.getSkill('undoable-skill');
      expect(edited?.ratified).toBe(true);
      expect(edited?.canUndoLastAgentEdit).toBe(true);

      // Undo restores the user's bytes and consumes the one-shot previous-version slot.
      await skillRuntime.undoLastAgentSkillEdit('undoable-skill');
      const restored = await skillRuntime.getSkill('undoable-skill');
      expect(restored?.body).toContain('hand-tuned instructions');
      expect(restored?.ratified).toBe(true);
      expect(restored?.canUndoLastAgentEdit).toBe(false);
    });
  });

  test('skill validation lets agents repair broken previous frontmatter', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'repair-skill', 'SKILL.md');
      const brokenContent = [
        '---',
        'description: [broken',
        '---',
        'Use broken instructions.',
        '',
      ].join('\n');
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, brokenContent, 'utf8');

      await (fileRead.execute as any)('read-repair-skill', { file_path: skillFile });
      const result = await (fileEdit.execute as any)('repair-skill', {
        file_path: skillFile,
        old_string: brokenContent,
        new_string: [
          '---',
          'description: Repaired skill for local authoring',
          'disable-model-invocation: true',
          '---',
          'Use repaired instructions.',
          '',
        ].join('\n'),
      });
      const details = result.details as ToolEnvelope<{ skillWrite?: { changeType: string } }>;

      expect(details.ok).toBe(true);
      expect(details.data?.skillWrite).toMatchObject({ changeType: 'patch' });
      expect((await skillRuntime.getSkill('repair-skill'))?.body).toContain('repaired instructions');
      expect((await skillRuntime.getSkill('repair-skill'))?.modelInvocable).toBe(false);
    });
  });

  test('file_edit on a CRLF/BOM skill still records matching provenance (no fail-open)', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const tools = createLocalTools({ workspace });
      const fileRead = tools.find((tool) => tool.name === 'file_read')!;
      const fileEdit = tools.find((tool) => tool.name === 'file_edit')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'crlf-skill', 'SKILL.md');
      // A hand-authored skill with BOM + CRLF line endings (e.g. written on Windows).
      const initialContent = `﻿${[
        '---',
        'description: Hand-authored CRLF skill',
        '---',
        'Use hand-tuned instructions.',
        '',
      ].join('\r\n')}`;
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, initialContent, 'utf8');
      const initialSkill = await skillRuntime.getSkill('crlf-skill');
      expect(initialSkill?.ratified).toBe(true);
      await skillRuntime.acceptSkill('crlf-skill', initialSkill?.contentHash ?? '');
      expect((await skillRuntime.getSkill('crlf-skill'))?.ratified).toBe(true);

      // An agent patch preserves model usability even though writeTextFile restores
      // CRLF/BOM on disk; the canonical hash still tracks exact content identity.
      await (fileRead.execute as any)('read-crlf-skill', { file_path: skillFile });
      const result = await (fileEdit.execute as any)('edit-crlf-skill', {
        file_path: skillFile,
        old_string: 'Use hand-tuned instructions.',
        new_string: 'Use agent-patched instructions.',
      });
      expect((result.details as ToolEnvelope<unknown>).ok).toBe(true);

      const patched = await skillRuntime.getSkill('crlf-skill');
      expect(patched?.body).toContain('agent-patched');
      expect(patched?.ratified).toBe(true);
      const agentInvocation = await skillRuntime.invokeSkill({ skill: 'crlf-skill', trigger: 'agent' });
      expect(agentInvocation.ok).toBe(true);
      expect((await skillRuntime.getSkill('crlf-skill'))?.ratified).toBe(true);
    });
  });

  test('agent-authored allowed-tools activate after automatic model invocation', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillRuntime = new AgentSkillRuntime({ localRoot: workspaceRoot, includeUserSkills: false });
      const workspace = createAgentLocalWorkspaceContext(workspaceRoot, undefined, skillRuntime);
      const fileWrite = createLocalTools({ workspace }).find((tool) => tool.name === 'file_write')!;
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'risky-skill', 'SKILL.md');

      const result = await (fileWrite.execute as any)('write-risky-skill', {
        file_path: skillFile,
        content: [
          '---',
          'description: Risky skill for local authoring',
          'allowed-tools: file_write, Bash(*)',
          '---',
          'Use risky instructions.',
          '',
        ].join('\n'),
      });
      expect((result.details as ToolEnvelope<unknown>).ok).toBe(true);

      const agentInvocation = await skillRuntime.invokeSkill({ skill: 'risky-skill', trigger: 'agent' });
      expect(agentInvocation.ok).toBe(true);
      expect(skillRuntime.getActivePermissionRules()).toEqual(['file_write', 'Bash(*)']);
    });
  });

  test('file_write allows root-level self-definition README files', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillReadme = path.join(workspaceRoot, '.agents', 'skills', 'README.md');
      const agentReadme = path.join(workspaceRoot, '.agents', 'agents', 'README.md');

      const skillWrite = await executeTool(workspaceRoot, 'file_write', {
        file_path: skillReadme,
        content: 'Skill authoring notes\n',
      });
      const agentWrite = await executeTool(workspaceRoot, 'file_write', {
        file_path: agentReadme,
        content: 'Agent authoring notes\n',
      });

      expect(skillWrite.ok).toBe(true);
      expect(agentWrite.ok).toBe(true);
      expect(await readFile(skillReadme, 'utf8')).toBe('Skill authoring notes\n');
      expect(await readFile(agentReadme, 'utf8')).toBe('Agent authoring notes\n');
    });
  });

  test('file_write rejects agent definition symlink escapes before validation', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(path.join(tmpdir(), 'lin-agent-definition-escape-'));
      try {
        await mkdir(path.join(workspaceRoot, '.agents'), { recursive: true });
        await symlink(outsideRoot, path.join(workspaceRoot, '.agents', 'agents'), 'dir');

        const result = await executeTool(workspaceRoot, 'file_write', {
          file_path: path.join(workspaceRoot, '.agents', 'agents', 'escape-agent', 'AGENT.md'),
          content: [
            '---',
            'name: Escape Agent',
            'description: Attempts to escape through symlink.',
            'permission-mode: restricted',
            '---',
            'Do not write outside the workspace.',
            '',
          ].join('\n'),
        });

        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('path_outside_local_root');
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  test('file_delete refuses self-definition content', async () => {
    await withWorkspace(async (workspaceRoot) => {
      const skillFile = path.join(workspaceRoot, '.agents', 'skills', 'delete-skill', 'SKILL.md');
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, '---\ndescription: Delete skill fixture\n---\nBody\n', 'utf8');

      const fileDelete = createLocalTools({ localRoot: workspaceRoot }).find((tool) => tool.name === 'file_delete')!;
      const skillDelete = await (fileDelete.execute as any)('delete-skill', { file_path: skillFile });

      expect((skillDelete.details as ToolEnvelope<unknown>).ok).toBe(false);
      expect((skillDelete.details as ToolEnvelope<unknown>).error?.code).toBe('self_definition_delete_not_supported');
    });
  });

  // file_glob works without ripgrep (it falls back to a pure-JS directory walk),
  // so its coverage must not be gated on `rg` being installed.
  test('file_glob finds workspace files without bash', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'alpha.ts'), 'export const city = "Chengdu";\n', 'utf8');
      await writeFile(path.join(workspaceRoot, 'src', 'beta.ts'), 'export const city = "Shanghai";\n', 'utf8');
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
    });
  });

  ripgrepTest('file_grep finds workspace content without bash', async () => {
    await withWorkspace(async (workspaceRoot) => {
      await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
      await writeFile(path.join(workspaceRoot, 'src', 'alpha.ts'), 'export const city = "Chengdu";\n', 'utf8');
      await writeFile(path.join(workspaceRoot, 'src', 'beta.ts'), 'export const city = "Shanghai";\n', 'utf8');

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

  ripgrepTest('file_grep uses ripgrep-style modes with relative paths and pagination', async () => {
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

  test('file_grep returns mode-specific shapes without mode or derivable counts', () => {
    const filesMode: FileGrepData = { mode: 'files_with_matches', numFiles: 2, filenames: ['a.ts', 'b.ts'] };
    const filesVisible = visibleFileGrep(filesMode);
    expect(filesVisible).toEqual({ filenames: ['a.ts', 'b.ts'] });
    expect(filesVisible).not.toHaveProperty('mode');

    const contentMode: FileGrepData = { mode: 'content', numFiles: 0, filenames: [], content: 'a.ts:1:hit', numLines: 1, appliedLimit: 1, appliedOffset: 0 };
    const contentVisible = visibleFileGrep(contentMode);
    expect(contentVisible).toEqual({ content: 'a.ts:1:hit' });
    expect(contentVisible).not.toHaveProperty('mode');

    const countMode: FileGrepData = { mode: 'count', numFiles: 2, filenames: [], content: 'a.ts:2', numMatches: 3 };
    const countVisible = visibleFileGrep(countMode);
    expect(countVisible).toEqual({ content: 'a.ts:2', numMatches: 3 });
    expect(countVisible).not.toHaveProperty('mode');
  });

  test('task_stop keeps only outputPath and drops the echoed message, id, and status', () => {
    const data: TaskStopData = {
      message: 'Successfully stopped task: task_1 (sleep 100)',
      task_id: 'task_1',
      task_type: 'bash',
      command: 'sleep 100',
      status: 'stopped',
      outputPath: '/tmp/task_1.log',
    };
    const visible = visibleTaskStop(data);
    expect(visible).toEqual({ outputPath: '/tmp/task_1.log' });
    expect(visible).not.toHaveProperty('task_id');
    expect(visible).not.toHaveProperty('status');
    expect(visible).not.toHaveProperty('message');
  });
});
