import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import type { AgentPayloadRef } from '../../src/core/agentEventLog';
import type { PreviewListDirectoryResult, PreviewReadTextResult, PreviewResolveSourceResult } from '../../src/core/preview';
import { handlePreviewCommand, type PreviewCommandContext } from '../../src/main/previewSource';
import type { TrustedLocalFileReference } from '../../src/main/localFileReferenceSecurity';

describe('preview source commands', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lin-preview-source-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('resolves and reads local files only under the trusted root', async () => {
    const filePath = join(root, 'notes.md');
    await writeFile(filePath, '# Notes\n\nPreview body.');
    const context = previewContext();

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'local-file', path: filePath, entryKind: 'file' },
    }, context) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      sourceKind: 'local-file',
      name: 'notes.md',
      ext: 'md',
      mimeType: 'text/markdown',
      entryKind: 'file',
    });
    expect((resolved.source && 'displayPath' in resolved.source ? resolved.source.displayPath : '').endsWith('/notes.md')).toBe(true);

    const text = await handlePreviewCommand('preview_read_text', {
      target: { kind: 'local-file', path: filePath, entryKind: 'file' },
    }, context) as PreviewReadTextResult;
    expect(text.text).toContain('Preview body.');

    const outside = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'local-file', path: '/etc/passwd', entryKind: 'file' },
    }, context) as PreviewResolveSourceResult;
    expect(outside.source).toBeNull();
  });

  test('lists trusted local directories with directories first', async () => {
    await mkdir(join(root, 'folder'));
    await writeFile(join(root, 'folder', 'nested.txt'), 'nested');
    await writeFile(join(root, 'alpha.txt'), 'alpha');

    const result = await handlePreviewCommand('preview_list_directory', {
      target: { kind: 'local-file', path: root, entryKind: 'directory' },
    }, previewContext()) as PreviewListDirectoryResult;

    expect(result).toMatchObject({
      entries: [
        { entryKind: 'directory', name: 'folder', mimeType: 'inode/directory' },
        { entryKind: 'file', name: 'alpha.txt', mimeType: 'text/plain' },
      ],
      truncated: false,
    });
  });

  test('keeps agent payload preview conversation/run scoped', async () => {
    const calls: Array<[conversationId: string, payloadId: string, runId: string | undefined]> = [];
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'payload-1',
      storage: 'file',
      mimeType: 'text/plain',
      byteLength: 12,
      sha256: 'sha',
      role: 'tool_output',
      scope: { type: 'run', conversationId: 'conversation-1', runId: 'run-1' },
      summary: 'Tool output',
    };
    const context = previewContext({
      agentRuntime: {
        previewPayload: async (conversationId, payloadId, runId) => {
          calls.push([conversationId, payloadId, runId]);
          return conversationId === 'conversation-1' && payloadId === 'payload-1' && runId === 'run-1'
            ? payload
            : null;
        },
        previewPayloadBytes: async (conversationId, payloadId, runId) => (
          conversationId === 'conversation-1' && payloadId === 'payload-1' && runId === 'run-1'
            ? Buffer.from('payload text')
            : null
        ),
      },
    });

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: 'payload-1',
      },
    }, context) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      sourceKind: 'agent-payload',
      name: 'Tool output',
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: 'payload-1',
      },
    });
    expect(resolved.source && 'displayPath' in resolved.source ? resolved.source.displayPath : undefined).toBeUndefined();

    const text = await handlePreviewCommand('preview_read_text', {
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: 'payload-1',
      },
    }, context) as PreviewReadTextResult;
    expect(text.text).toBe('payload text');
    expect(calls).toContainEqual(['conversation-1', 'payload-1', 'run-1']);

    const missingRun = await handlePreviewCommand('preview_resolve_source', {
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        payloadId: 'payload-1',
      },
    }, context) as PreviewResolveSourceResult;
    expect(missingRun.source).toBeNull();
  });

  test('derives EPUB source extension from MIME when the payload has no filename', async () => {
    const payload: AgentPayloadRef = {
      kind: 'payload_ref',
      id: 'book-payload',
      storage: 'file',
      mimeType: 'application/epub+zip',
      byteLength: 4,
      sha256: 'sha',
      role: 'tool_output',
      scope: { type: 'run', conversationId: 'conversation-1', runId: 'run-1' },
    };
    const context = previewContext({
      agentRuntime: {
        previewPayload: async () => payload,
        previewPayloadBytes: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
    });

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: {
        kind: 'agent-payload',
        conversationId: 'conversation-1',
        runId: 'run-1',
        payloadId: 'book-payload',
      },
    }, context) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      name: 'book-payload.epub',
      ext: 'epub',
      mimeType: 'application/epub+zip',
    });
  });

  test('resolves local HTML files as text/html preview sources', async () => {
    const filePath = join(root, 'index.html');
    await writeFile(filePath, '<!doctype html><title>Preview</title>');

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'local-file', path: filePath, entryKind: 'file' },
    }, previewContext()) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      sourceKind: 'local-file',
      name: 'index.html',
      ext: 'html',
      mimeType: 'text/html',
      entryKind: 'file',
    });
  });

  function previewContext(overrides: Partial<PreviewCommandContext> = {}): PreviewCommandContext {
    return {
      agentLocalFileRoots: [root],
      agentRuntime: {
        previewPayload: async () => null,
        previewPayloadBytes: async () => null,
      },
      assetService: {
        lookup: async () => null,
        pathFor: async () => null,
      },
      inferMimeType,
      localFileReferencePreview,
      ...overrides,
    };
  }
});

function inferMimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  if (extension === '.html' || extension === '.htm') return 'text/html';
  if (extension === '.json') return 'application/json';
  return 'text/plain';
}

async function localFileReferencePreview(file: TrustedLocalFileReference) {
  const mimeType = file.entryKind === 'directory' ? 'inode/directory' : inferMimeType(file.path);
  return {
    entryKind: file.entryKind,
    path: file.path,
    name: basename(file.path),
    parentPath: dirname(file.path),
    mimeType,
    sizeBytes: file.entryKind === 'directory' ? 0 : file.stats.size,
    lastModified: file.stats.mtimeMs,
  };
}
