import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizePreviewHttpUrl,
  type PreviewAuthorizeLinkedFileResult,
  type PreviewForgetLinkedFileResult,
  type PreviewListDirectoryResult,
  type PreviewReadBytesResult,
  type PreviewReadTextResult,
  type PreviewResolveSourceResult,
} from '../../src/core/preview';
import { PREVIEW_LOCAL_URL_SCHEME } from '../../src/core/assets';
import { handlePreviewCommand, type PreviewCommandContext } from '../../src/main/previewSource';
import type { CommandResult } from '../../src/core/types';
import type { TrustedLocalFileReference } from '../../src/main/localFileReferenceSecurity';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';
import { LinkedFileGrantStore } from '../../src/main/linkedFileGrantStore';
import { LocalFilePreviewStreamRegistry } from '../../src/main/localFilePreviewStream';

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

  test('authorizes one external attachment without widening the trusted roots', async () => {
    const externalRoot = await mkdtemp(join(tmpdir(), 'lin-preview-attachment-test-'));
    try {
      const attachmentPath = join(externalRoot, 'attached.txt');
      const substitutedPath = join(externalRoot, 'substituted.txt');
      await writeFile(attachmentPath, 'attached bytes');
      await writeFile(substitutedPath, 'substituted bytes');
      const attachmentStats = await stat(attachmentPath);
      const streamPaths: string[] = [];
      const context = previewContext({
        threadAttachmentFile: async (threadId, attachmentId) => (
          threadId === 'thread-1' && attachmentId === 'attachment-1'
            ? {
                entryKind: 'file',
                path: attachmentPath,
                stats: attachmentStats,
                acceptedPathHints: ['attached.txt'],
              }
            : null
        ),
        threadManagedFileStreamUrl: async (filePath) => {
          streamPaths.push(filePath);
          return `${PREVIEW_LOCAL_URL_SCHEME}://attachment-token`;
        },
      });
      const authorizedTarget = {
        kind: 'local-file' as const,
        path: 'attached.txt',
        entryKind: 'file' as const,
        threadId: 'thread-1',
        attachmentId: 'attachment-1',
      };

      const resolved = await handlePreviewCommand('preview_resolve_source', {
        target: authorizedTarget,
      }, context) as PreviewResolveSourceResult;
      expect(resolved.source).toMatchObject({
        kind: 'file',
        displayPath: attachmentPath,
        streamUrl: `${PREVIEW_LOCAL_URL_SCHEME}://attachment-token`,
        target: { path: attachmentPath, threadId: 'thread-1', attachmentId: 'attachment-1' },
      });
      expect(streamPaths).toEqual([attachmentPath]);

      const text = await handlePreviewCommand('preview_read_text', {
        target: authorizedTarget,
      }, context) as PreviewReadTextResult;
      expect(text.text).toBe('attached bytes');

      const substituted = await handlePreviewCommand('preview_resolve_source', {
        target: { ...authorizedTarget, path: substitutedPath },
      }, context) as PreviewResolveSourceResult;
      expect(substituted.source).toBeNull();

      const ambient = await handlePreviewCommand('preview_resolve_source', {
        target: { kind: 'local-file', path: attachmentPath, entryKind: 'file' },
      }, context) as PreviewResolveSourceResult;
      expect(ambient.source).toBeNull();
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  test('resolves a typed Thread resource without exposing its canonical storage path', async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), 'lin-preview-resource-test-'));
    try {
      const observedPath = join(managedRoot, 'tool-output.png');
      await writeFile(observedPath, 'managed image bytes');
      const observedStats = await stat(observedPath);
      const ref = {
        id: 'resource:00000000-0000-4000-8000-00000000000a',
        mimeType: 'image/png',
        byteLength: 19,
        fileName: 'tool-output.png',
      };
      const context = previewContext({
        threadResourceFile: async (threadId, candidate) => (
          threadId === 'thread-1' && candidate.id === ref.id
            ? {
                entryKind: 'file',
                path: observedPath,
                stats: observedStats,
                acceptedPathHints: [ref.fileName],
              }
            : null
        ),
      });
      const target = {
        kind: 'local-file' as const,
        path: ref.fileName,
        entryKind: 'file' as const,
        threadId: 'thread-1',
        resourceRef: ref,
      };

      const resolved = await handlePreviewCommand('preview_resolve_source', { target }, context) as PreviewResolveSourceResult;
      expect(resolved.source).toMatchObject({
        kind: 'file',
        name: 'tool-output.png',
        displayPath: observedPath,
        target: { threadId: 'thread-1', resourceRef: ref },
      });
      const text = await handlePreviewCommand('preview_read_text', { target }, context) as PreviewReadTextResult;
      expect(text.text).toBe('managed image bytes');

      const substituted = await handlePreviewCommand('preview_read_text', {
        target: { ...target, path: '/tmp/substituted.png' },
      }, context) as PreviewReadTextResult;
      expect(substituted.text).toBe('managed image bytes');
    } finally {
      await rm(managedRoot, { recursive: true, force: true });
    }
  });

  test('resolves an image artifact by canonical identity and rendition MIME', async () => {
    const managedRoot = await mkdtemp(join(tmpdir(), 'lin-preview-image-artifact-test-'));
    try {
      const observationBytes = Buffer.from('png observation bytes');
      const observedPath = join(managedRoot, 'stable-artifact-path');
      await writeFile(observedPath, observationBytes);
      const observedStats = await stat(observedPath);
      const artifact = createImageArtifactReference({
        createdAt: 1,
        retention: 'observationOnly',
        original: null,
        observation: {
          id: 'resource:00000000-0000-4000-8000-00000000000b',
          mimeType: 'image/png',
          byteLength: observationBytes.byteLength,
          fileName: 'prompt.png',
        },
        sourceDimensions: { width: 3_840, height: 2_160 },
        observationDimensions: { width: 1_920, height: 1_080 },
      });
      const streamCalls: Array<{ path: string; mimeType: string }> = [];
      const context = previewContext({
        threadImageArtifactFile: async (threadId, candidate) => (
          threadId === 'thread-1' && candidate.id === artifact.id
            ? {
                entryKind: 'file',
                path: observedPath,
                stats: observedStats,
                mimeType: 'image/png',
                acceptedPathHints: [artifact.id, artifact.observation.fileName],
              }
            : null
        ),
        threadManagedFileStreamUrl: async (path, mimeType) => {
          streamCalls.push({ path, mimeType });
          return `${PREVIEW_LOCAL_URL_SCHEME}://artifact-token`;
        },
      });
      const target = {
        kind: 'local-file' as const,
        path: artifact.id,
        entryKind: 'file' as const,
        label: 'Generated chart',
        threadId: 'thread-1',
        imageArtifactRef: artifact,
      };

      const resolved = await handlePreviewCommand('preview_resolve_source', { target }, context) as PreviewResolveSourceResult;
      expect(resolved.source).toMatchObject({
        kind: 'file',
        name: 'Generated chart',
        ext: 'png',
        mimeType: 'image/png',
        displayPath: observedPath,
        streamUrl: `${PREVIEW_LOCAL_URL_SCHEME}://artifact-token`,
        target: { threadId: 'thread-1', imageArtifactRef: artifact },
      });
      expect(streamCalls).toEqual([{ path: observedPath, mimeType: 'image/png' }]);

      const bytes = await handlePreviewCommand('preview_read_bytes', { target }, context) as PreviewReadBytesResult;
      expect(Buffer.from(bytes.bytes!)).toEqual(observationBytes);
      expect(bytes.mimeType).toBe('image/png');

      const substituted = await handlePreviewCommand('preview_resolve_source', {
        target: { ...target, path: '/tmp/substituted.png' },
      }, context) as PreviewResolveSourceResult;
      expect(substituted.source).toBeNull();
    } finally {
      await rm(managedRoot, { recursive: true, force: true });
    }
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

  test('resolves EPUB assets through an opaque fetchable stream', async () => {
    const filePath = join(root, 'book.epub');
    await writeFile(filePath, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const streamCalls: Array<{ filePath: string; mimeType: string }> = [];
    const assetService = {
      lookup: async () => ({
        id: 'asset-book',
        mimeType: 'application/epub+zip',
        byteSize: 4,
        originalFilename: 'book.epub',
        createdAt: 1,
      }),
      pathFor: async () => filePath,
    };
    const context = previewContext({
      assetService,
      assetFileStreamUrl: async (resolvedPath, mimeType) => {
        streamCalls.push({ filePath: resolvedPath, mimeType });
        return `${PREVIEW_LOCAL_URL_SCHEME}://epub-token`;
      },
    });

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'asset', assetId: 'asset-book' },
    }, context) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      sourceKind: 'asset',
      name: 'book.epub',
      streamUrl: `${PREVIEW_LOCAL_URL_SCHEME}://epub-token`,
    });
    expect(streamCalls).toEqual([{ filePath, mimeType: 'application/epub+zip' }]);

    const fallback = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'asset', assetId: 'asset-book' },
    }, previewContext({
      assetService,
      assetFileStreamUrl: async () => null,
    })) as PreviewResolveSourceResult;
    expect(fallback.source?.kind === 'file' ? fallback.source.streamUrl : 'unexpected-source').toBeUndefined();
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

  test('resolves local MP4 files as video preview sources', async () => {
    const filePath = join(root, 'clip.mp4');
    await writeFile(filePath, new Uint8Array([0, 0, 0, 0]));
    const issued: Array<{ path: string; mimeType: string }> = [];

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'local-file', path: filePath, entryKind: 'file' },
    }, previewContext({
      localFileStreamUrl: async (file, mimeType) => {
        issued.push({ path: file.path, mimeType });
        return `${PREVIEW_LOCAL_URL_SCHEME}://token-1`;
      },
    })) as PreviewResolveSourceResult;

    expect(resolved.source).toMatchObject({
      kind: 'file',
      sourceKind: 'local-file',
      name: 'clip.mp4',
      ext: 'mp4',
      mimeType: 'video/mp4',
      entryKind: 'file',
      streamUrl: `${PREVIEW_LOCAL_URL_SCHEME}://token-1`,
    });
    expect(issued).toEqual([{ path: await realpath(filePath), mimeType: 'video/mp4' }]);
  });

  test('normalizes only http(s) URL preview sources', async () => {
    expect(normalizePreviewHttpUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(normalizePreviewHttpUrl('file:///tmp/report.html')).toBeNull();
    expect(normalizePreviewHttpUrl('javascript:alert(1)')).toBeNull();

    const resolved = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'url', url: 'https://example.com/docs', label: 'Example docs' },
    }, previewContext()) as PreviewResolveSourceResult;
    expect(resolved.source).toEqual({
      kind: 'url',
      id: 'url:https://example.com/docs',
      target: { kind: 'url', url: 'https://example.com/docs', label: 'Example docs' },
      title: 'Example docs',
      url: 'https://example.com/docs',
    });

    const rejected = await handlePreviewCommand('preview_resolve_source', {
      target: { kind: 'url', url: 'file:///tmp/report.html' },
    }, previewContext()) as PreviewResolveSourceResult;
    expect(rejected.source).toBeNull();
  });

  test('authorizes, resolves, reads, forgets, and revalidates one exact linked file', async () => {
    const filePath = join(root, 'linked.md');
    const otherPath = join(root, 'other.md');
    await writeFile(filePath, '# Linked source');
    await writeFile(otherPath, '# Other source');
    const sourceText = pathToFileURL(filePath).href;
    const target = {
      kind: 'linked-file' as const,
      sourceValueId: 'source:linked',
      sourceText,
      label: 'Linked note',
    };
    const grants = new LinkedFileGrantStore(join(root, 'linked-file-grants.json'));
    const streamCalls: string[] = [];
    const baseContext = previewContext({
      linkedFileGrant: grants,
      linkedFileStreamUrl: async (file) => {
        streamCalls.push(file.path);
        await file.handle.close();
        return `${PREVIEW_LOCAL_URL_SCHEME}://linked-file-token`;
      },
    });

    const denied = await handlePreviewCommand(
      'preview_resolve_source',
      { target },
      baseContext,
    ) as PreviewResolveSourceResult;
    expect(denied).toEqual({ source: null, error: 'file-access-denied' });

    const mismatch = await handlePreviewCommand(
      'preview_authorize_linked_file',
      { target },
      { ...baseContext, chooseLinkedFile: async () => otherPath },
    ) as PreviewAuthorizeLinkedFileResult;
    expect(mismatch).toEqual({ authorized: false, error: 'different-file' });

    const authorized = await handlePreviewCommand(
      'preview_authorize_linked_file',
      { target },
      { ...baseContext, chooseLinkedFile: async () => filePath },
    ) as PreviewAuthorizeLinkedFileResult;
    expect(authorized).toEqual({ authorized: true });

    const ready = await handlePreviewCommand(
      'preview_resolve_source',
      { target },
      baseContext,
    ) as PreviewResolveSourceResult;
    expect(ready.source).toMatchObject({
      kind: 'file',
      sourceKind: 'linked-file',
      name: 'Linked note',
      streamUrl: `${PREVIEW_LOCAL_URL_SCHEME}://linked-file-token`,
      target,
    });
    expect(ready.source && 'displayPath' in ready.source ? ready.source.displayPath : undefined).toBeUndefined();
    expect(JSON.stringify(ready)).not.toContain('canonicalPath');
    expect(JSON.stringify(ready)).not.toContain('device');
    expect(JSON.stringify(ready)).not.toContain('inode');
    expect(streamCalls).toEqual([await realpath(filePath)]);

    const bytes = await handlePreviewCommand(
      'preview_read_bytes',
      { target },
      baseContext,
    ) as PreviewReadBytesResult;
    expect(Buffer.from(bytes.bytes!)).toEqual(Buffer.from('# Linked source'));

    const forgotten = await handlePreviewCommand(
      'preview_forget_linked_file',
      { target },
      baseContext,
    ) as PreviewForgetLinkedFileResult;
    expect(forgotten).toEqual({ forgotten: true });
    expect(await handlePreviewCommand('preview_resolve_source', { target }, baseContext))
      .toEqual({ source: null, error: 'file-access-denied' });

    expect((await grants.authorize(sourceText, filePath)).authorized).toBe(true);
    await rm(filePath);
    expect(await handlePreviewCommand('preview_resolve_source', { target }, baseContext))
      .toEqual({ source: null, error: 'file-unavailable' });
  });

  test('never redefines an exact grant after a symlink substitution during token issue', async () => {
    const filePath = join(root, 'linked.txt');
    const replacementPath = join(root, 'replacement.txt');
    const unauthorizedPath = join(root, 'unauthorized.txt');
    await writeFile(filePath, 'AUTHORIZED');
    await writeFile(replacementPath, 'AUTHORIZED');
    await writeFile(unauthorizedPath, 'UNAUTHORIZED');
    const sourceText = pathToFileURL(filePath).href;
    const target = { kind: 'linked-file' as const, sourceValueId: 'source:race', sourceText };
    const grants = new LinkedFileGrantStore(join(root, 'race-grants.json'));
    expect(await grants.authorize(sourceText, filePath)).toEqual({ authorized: true });
    const streams = new LocalFilePreviewStreamRegistry(() => []);
    let token: string | null = null;
    try {
      const resolved = await handlePreviewCommand('preview_resolve_source', { target }, previewContext({
        linkedFileGrant: grants,
        linkedFileStreamUrl: async (file, mimeType) => {
          await rename(filePath, replacementPath);
          await symlink(unauthorizedPath, filePath);
          token = await streams.issueExactFile(file, mimeType);
          return token ? `${PREVIEW_LOCAL_URL_SCHEME}://${token}` : null;
        },
      })) as PreviewResolveSourceResult;

      expect(token).not.toBeNull();
      expect(resolved.source).toMatchObject({ sizeBytes: 'AUTHORIZED'.length });
      const response = await streams.serve(token!, { headers: new Headers() });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('UNAUTHORIZED');
    } finally {
      await streams.close();
    }
  });

  test('admits Link File and Replace with File grants before their document mutations', async () => {
    const filePath = join(root, 'workflow.txt');
    await writeFile(filePath, 'workflow');
    const grants = new LinkedFileGrantStore(join(root, 'workflow-grants.json'));
    const mutations: Array<{ kind: string; ownerId: string; sourceText: string; sourceValueId?: string }> = [];
    const settlement = { update: { kind: 'test' } } as unknown as CommandResult;
    const context = previewContext({
      chooseLinkedFile: async () => filePath,
      linkedFileGrant: grants,
      mutateLinkedFileSource: async (input) => {
        const resolution = await grants.resolve(input.sourceText);
        expect(resolution.status).toBe('ready');
        if (resolution.status === 'ready') await resolution.file.handle.close();
        mutations.push(input);
        return settlement;
      },
    });

    expect(await handlePreviewCommand('preview_link_file_source', { ownerId: 'node:owner' }, context))
      .toBe(settlement);
    expect(await handlePreviewCommand('preview_replace_source_with_file', {
      ownerId: 'node:owner',
      sourceValueId: 'node:source',
    }, context)).toBe(settlement);
    expect(mutations).toEqual([
      { kind: 'add', ownerId: 'node:owner', sourceText: pathToFileURL(filePath).href },
      {
        kind: 'replace',
        ownerId: 'node:owner',
        sourceValueId: 'node:source',
        sourceText: pathToFileURL(filePath).href,
      },
    ]);
  });

  test('revokes only a newly created grant when linked-file settlement fails', async () => {
    const newPath = join(root, 'new-grant.txt');
    const existingPath = join(root, 'existing-grant.txt');
    await writeFile(newPath, 'new');
    await writeFile(existingPath, 'existing');
    const grants = new LinkedFileGrantStore(join(root, 'compensation-grants.json'));
    const rejectMutation = async (): Promise<CommandResult> => {
      throw new Error('settlement failed');
    };

    await expect(handlePreviewCommand('preview_link_file_source', { ownerId: 'node:owner' }, previewContext({
      chooseLinkedFile: async () => newPath,
      linkedFileGrant: grants,
      mutateLinkedFileSource: rejectMutation,
    }))).rejects.toThrow('settlement failed');
    expect(await grants.resolve(pathToFileURL(newPath).href)).toEqual({ status: 'denied' });

    const existingSourceText = pathToFileURL(existingPath).href;
    expect(await grants.authorize(existingSourceText, existingPath)).toEqual({ authorized: true });
    await expect(handlePreviewCommand('preview_link_file_source', { ownerId: 'node:owner' }, previewContext({
      chooseLinkedFile: async () => existingPath,
      linkedFileGrant: grants,
      mutateLinkedFileSource: rejectMutation,
    }))).rejects.toThrow('settlement failed');
    const preserved = await grants.resolve(existingSourceText);
    expect(preserved.status).toBe('ready');
    if (preserved.status === 'ready') await preserved.file.handle.close();
  });

  test('returns bounded command results for invalid linked-file targets', async () => {
    const context = previewContext();
    expect(await handlePreviewCommand('preview_authorize_linked_file', { target: {} }, context))
      .toEqual({ authorized: false, error: 'invalid-source' });
    expect(await handlePreviewCommand('preview_forget_linked_file', { target: {} }, context))
      .toEqual({ forgotten: false });
  });

  function previewContext(overrides: Partial<PreviewCommandContext> = {}): PreviewCommandContext {
    return {
      agentLocalFileRoots: [root],
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
  if (extension === '.mp4') return 'video/mp4';
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
