import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadFileSource, ThreadResourceReference } from '../../src/core/agent/protocol';
import { MAX_IMAGE_ATTACHMENT_SOURCE_BYTES } from '../../src/core/agentAttachmentLimits';
import { AttachmentResolver } from '../../src/main/agent/tools/attachments';
import { createImageArtifactReference } from '../../src/main/agent/imageArtifacts';

const roots: string[] = [];
const THREAD_ID = '018f0f24-7b2e-7a3f-8a4b-123456789abc';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AttachmentResolver', () => {
  test('canonicalizes a very large local file without copying or applying a shared source limit', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const externalRoot = await temporaryRoot('tenon-attachment-source-');
    const sourcePath = join(externalRoot, 'large-local.bin');
    await writeFile(sourcePath, '');
    await truncate(sourcePath, 3 * 1024 * 1024 * 1024);
    const resolver = resolverWithResources(new Map());

    const [resolved] = await resolver.resolve([
      attachment('local', 'large-local.bin', 'application/octet-stream', {
        kind: 'localFile',
        path: sourcePath,
      }),
    ], resolutionContext(workdir));

    expect(resolved).toMatchObject({
      source: { kind: 'localFile', path: await realpath(sourcePath) },
      sizeBytes: 3 * 1024 * 1024 * 1024,
    });
    expect((await stat(sourcePath)).size).toBe(3 * 1024 * 1024 * 1024);
  });

  test('resolves managed payloads and records an immutable image artifact reference', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const managedRoot = await temporaryRoot('tenon-attachment-managed-');
    const documentPath = join(managedRoot, 'report.pdf');
    const imagePath = join(managedRoot, 'source.png');
    await writeFile(documentPath, 'managed report');
    await writeFile(imagePath, 'image source');
    const documentRef = resourceRef('1', 'application/pdf', 14, 'report.pdf');
    const imageRef = resourceRef('2', 'image/png', 12, 'source.png');
    const promptRef = resourceRef('3', 'image/png', 8, 'prompt.png');
    const snapshots: string[] = [];
    const resolver = new AttachmentResolver({
      useResourcePath: async (_threadId, ref, use) => {
        const resourcePath = new Map([
          [documentRef.id, documentPath],
          [imageRef.id, imagePath],
          [promptRef.id, join(managedRoot, 'prompt.png')],
        ]).get(ref.id);
        return resourcePath ? use(resourcePath) : null;
      },
      prepareImageArtifact: async ({ attachment, sourcePath }) => {
        snapshots.push(sourcePath);
        return preparedArtifact(attachment.source, promptRef, true);
      },
    });
    const createdResources: ThreadResourceReference[] = [];

    const resolved = await resolver.resolve([
      attachment('document', 'report.pdf', 'application/octet-stream', {
        kind: 'threadPayload',
        ref: documentRef,
      }),
      attachment('image', 'source.png', 'image/png', {
        kind: 'threadPayload',
        ref: imageRef,
      }),
    ], resolutionContext(workdir, createdResources));

    expect(resolved[0]).toMatchObject({
      mimeType: 'application/pdf',
      sizeBytes: 14,
      source: { kind: 'threadPayload', ref: documentRef },
    });
    expect(resolved[1]).toMatchObject({
      artifactRef: {
        retention: 'durable',
        original: { kind: 'threadPayload', ref: imageRef },
        observation: promptRef,
      },
    });
    expect(snapshots).toEqual([imagePath]);
    expect(createdResources).toEqual([promptRef]);
  });

  test('fails closed when a managed payload is unavailable', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const missingRef = resourceRef('4', 'application/pdf', 10, 'missing.pdf');
    const resolver = resolverWithResources(new Map());

    await expect(resolver.resolve([
      attachment('missing', 'missing.pdf', 'application/pdf', {
        kind: 'threadPayload',
        ref: missingRef,
      }),
    ], resolutionContext(workdir)))
      .rejects.toThrow('Managed attachment payload is unavailable or corrupt');
  });

  test('reports a created snapshot before a later attachment fails', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const managedRoot = await temporaryRoot('tenon-attachment-managed-');
    const imagePath = join(managedRoot, 'source.png');
    await writeFile(imagePath, 'image source');
    const imageRef = resourceRef('a', 'image/png', 12, 'source.png');
    const missingRef = resourceRef('b', 'text/plain', 7, 'missing.txt');
    const promptRef = resourceRef('c', 'image/png', 8, 'prompt.png');
    const createdResources: ThreadResourceReference[] = [];
    const resolver = new AttachmentResolver({
      useResourcePath: async (_threadId, ref, use) => ref.id === imageRef.id ? use(imagePath) : null,
      prepareImageArtifact: async ({ attachment }) => preparedArtifact(attachment.source, promptRef, true),
    });

    await expect(resolver.resolve([
      attachment('image', 'source.png', 'image/png', { kind: 'threadPayload', ref: imageRef }),
      attachment('missing', 'missing.txt', 'text/plain', { kind: 'threadPayload', ref: missingRef }),
    ], resolutionContext(workdir, createdResources)))
      .rejects.toThrow('Managed attachment payload is unavailable or corrupt');
    expect(createdResources).toEqual([promptRef]);
  });

  test('rejects an oversized managed image before resolving or hashing its payload', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    let resolutions = 0;
    const resolver = new AttachmentResolver({
      useResourcePath: async () => {
        resolutions += 1;
        return null;
      },
      prepareImageArtifact: async ({ attachment }) => preparedArtifact(
        attachment.source,
        resourceRef('f', 'image/png', 1, 'prompt.png'),
        true,
      ),
    });

    await expect(resolver.resolve([
      attachment('large-image', 'large.png', 'application/octet-stream', {
        kind: 'threadPayload',
        ref: resourceRef(
          '5',
          'image/png',
          MAX_IMAGE_ATTACHMENT_SOURCE_BYTES + 1,
          'large.png',
        ),
      }),
    ], resolutionContext(workdir))).rejects.toThrow('image decode budget');
    expect(resolutions).toBe(0);
  });

  test('serializes image snapshot preparation to bound aggregate decode work', async () => {
    const workdir = await temporaryRoot('tenon-attachment-workdir-');
    const managedRoot = await temporaryRoot('tenon-attachment-managed-');
    const resources = new Map<string, string>();
    const refs = await Promise.all(['first', 'second', 'third'].map(async (name, index) => {
      const filePath = join(managedRoot, `${name}.png`);
      await writeFile(filePath, name);
      const ref = resourceRef(String(index + 6), 'image/png', name.length, `${name}.png`);
      resources.set(ref.id, filePath);
      return ref;
    }));
    let activePreparations = 0;
    let maximumPreparations = 0;
    const resolver = new AttachmentResolver({
      useResourcePath: async (_threadId, ref, use) => {
        const resourcePath = resources.get(ref.id);
        return resourcePath ? use(resourcePath) : null;
      },
      prepareImageArtifact: async ({ attachment }) => {
        activePreparations += 1;
        maximumPreparations = Math.max(maximumPreparations, activePreparations);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activePreparations -= 1;
        return preparedArtifact(
          attachment.source,
          resourceRef('f', 'image/png', 1, 'prompt.png'),
          true,
        );
      },
    });

    await resolver.resolve(refs.map((ref, index) => attachment(
      `image-${index}`,
      ref.fileName,
      ref.mimeType,
      { kind: 'threadPayload', ref },
    )), resolutionContext(workdir));

    expect(maximumPreparations).toBe(1);
  });
});

function resolverWithResources(resources: ReadonlyMap<string, string>): AttachmentResolver {
  return new AttachmentResolver({
    useResourcePath: async (_threadId, ref, use) => {
      const resourcePath = resources.get(ref.id);
      return resourcePath ? use(resourcePath) : null;
    },
    prepareImageArtifact: async ({ attachment }) => preparedArtifact(
      attachment.source,
      resourceRef('f', 'image/png', 1, 'prompt.png'),
      true,
    ),
  });
}

function resolutionContext(
  cwd: string,
  createdResources: ThreadResourceReference[] = [],
) {
  return {
    threadId: THREAD_ID,
    cwd,
    recordCreatedResource: (ref: ThreadResourceReference) => createdResources.push(ref),
  };
}

function attachment(
  id: string,
  name: string,
  mimeType: string,
  source:
    | { readonly kind: 'localFile'; readonly path: string }
    | { readonly kind: 'threadPayload'; readonly ref: ThreadResourceReference },
) {
  return { type: 'attachment' as const, id, name, mimeType, sizeBytes: 1, source };
}

function resourceRef(
  digit: string,
  mimeType: string,
  byteLength: number,
  fileName: string,
): ThreadResourceReference {
  return { id: digit.repeat(64), mimeType, byteLength, fileName };
}

function preparedArtifact(
  source: ThreadFileSource,
  observation: ThreadResourceReference,
  created: boolean,
) {
  return {
    artifactRef: createImageArtifactReference({
      createdAt: 1,
      retention: source.kind === 'localFile' ? 'external' : 'durable',
      original: source,
      observation,
      sourceDimensions: { width: 2, height: 2 },
      observationDimensions: { width: 1, height: 1 },
    }),
    createdResources: created ? [observation] : [],
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
