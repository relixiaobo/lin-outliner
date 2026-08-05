import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_SCRATCH_TTL_MS,
  createManagedAttachmentObservation,
  isPathInside,
  pruneAgentScratch,
} from '../../src/main/agent/capabilities/agentAttachmentMaterialization';

describe('agent scratch lifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('checks path containment without treating sibling prefixes as descendants', () => {
    expect(isPathInside('/tmp/thread', '/tmp/thread/file.txt')).toBe(true);
    expect(isPathInside('/tmp/thread', '/tmp/thread')).toBe(true);
    expect(isPathInside('/tmp/thread', '/tmp/thread-other/file.txt')).toBe(false);
  });

  test('prunes expired entries across every scratch subdir, leaving fresh ones and the dirs intact', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const now = Date.now();
    const expiredSeconds = (now - AGENT_SCRATCH_TTL_MS - 1000) / 1000;
    // Two distinct scratch areas (attachments + web-fetch), each with one stale and one fresh file.
    for (const subdir of ['agent-attachments', 'agent-web-fetch']) {
      const dir = path.join(scratchRoot, subdir);
      await mkdir(dir, { recursive: true });
      const expiredPath = path.join(dir, 'expired.bin');
      await writeFile(expiredPath, 'old');
      await writeFile(path.join(dir, 'fresh.bin'), 'new');
      await utimes(expiredPath, expiredSeconds, expiredSeconds);
    }
    // A stray top-level file must not crash the sweep (readdir on it raises ENOTDIR).
    await writeFile(path.join(scratchRoot, 'stray.txt'), 'stray');

    await pruneAgentScratch(scratchRoot, now);

    for (const subdir of ['agent-attachments', 'agent-web-fetch']) {
      expect(await readdir(path.join(scratchRoot, subdir))).toEqual(['fresh.bin']);
    }
  });

  test('prunes expired generated image leftovers like every other scratch area', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const now = Date.now();
    const expiredSeconds = (now - AGENT_SCRATCH_TTL_MS - 1000) / 1000;
    const generatedDir = path.join(scratchRoot, 'generated-images', 'run-1');
    await mkdir(generatedDir, { recursive: true });
    const generatedPath = path.join(generatedDir, 'image.png');
    await writeFile(generatedPath, 'image bytes');
    await utimes(generatedPath, expiredSeconds, expiredSeconds);
    await utimes(path.dirname(generatedPath), expiredSeconds, expiredSeconds);

    await pruneAgentScratch(scratchRoot, now);

    await expect(readdir(generatedDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('pruneAgentScratch is a no-op when the scratch root does not exist', async () => {
    const scratchRoot = path.join(await mkdtempRoot('lin-agent-scratch-'), 'never-created');
    await expect(pruneAgentScratch(scratchRoot)).resolves.toBeUndefined();
  });

  test('replays managed resources through a stable provider observation path', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const ref = {
      id: 'a'.repeat(64),
      mimeType: 'application/pdf',
      byteLength: 5,
      fileName: 'report.pdf',
    };
    const materialize = async (_ref: typeof ref, targetDirectory: string) => {
      const file = path.join(targetDirectory, ref.fileName);
      await writeFile(file, 'bytes');
      return file;
    };
    const first = createManagedAttachmentObservation(scratchRoot, materialize, {
      stableWorkspaceKey: 'thread-1',
    });
    const firstPath = await first.resolvePath(ref);
    await first.dispose();
    const replay = createManagedAttachmentObservation(scratchRoot, materialize, {
      stableWorkspaceKey: 'thread-1',
    });
    const replayPath = await replay.resolvePath(ref);

    expect(replayPath).toBe(firstPath);
    expect(replayPath).toContain(`/provider-thread-1/${ref.id}/${ref.fileName}`);
    await replay.dispose();
  });

  test('materializes same-content resources with distinct file names in one stable workspace', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const firstRef = {
      id: 'b'.repeat(64),
      mimeType: 'text/plain',
      byteLength: 5,
      fileName: 'first.txt',
    };
    const secondRef = { ...firstRef, fileName: 'second.txt' };
    const observation = createManagedAttachmentObservation(scratchRoot, async (ref, targetDirectory) => {
      const file = path.join(targetDirectory, ref.fileName);
      await writeFile(file, 'bytes');
      return file;
    }, { stableWorkspaceKey: 'thread-1' });

    const [firstPath, secondPath] = await Promise.all([
      observation.resolvePath(firstRef),
      observation.resolvePath(secondRef),
    ]);

    expect(firstPath).toContain(`/${firstRef.id}/${firstRef.fileName}`);
    expect(secondPath).toContain(`/${secondRef.id}/${secondRef.fileName}`);
    expect(firstPath).not.toBe(secondPath);
    await observation.dispose();
  });

  test('keeps an artifact path stable when its original falls back to a differently encoded observation', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const original = {
      id: 'c'.repeat(64),
      mimeType: 'image/webp',
      byteLength: 8,
      fileName: 'source.webp',
    };
    const prompt = {
      id: 'd'.repeat(64),
      mimeType: 'image/png',
      byteLength: 11,
      fileName: 'prompt.png',
    };
    const artifact = {
      id: 'e'.repeat(64),
      createdAt: 1,
      retention: 'tiered' as const,
      original: { kind: 'threadPayload' as const, ref: original },
      observation: prompt,
      geometry: {
        sourceWidth: 4_000,
        sourceHeight: 2_000,
        observationWidth: 2_000,
        observationHeight: 1_000,
        observationToSource: [2, 0, 0, 2, 0, 0] as const,
      },
    };
    const materialize = (originalAvailable: boolean) => createManagedAttachmentObservation(
      scratchRoot,
      async (ref, targetDirectory) => {
        if (ref.id === original.id && !originalAvailable) return null;
        const file = path.join(targetDirectory, ref.fileName);
        await writeFile(file, ref.id === original.id ? 'original' : 'observation');
        return file;
      },
      { stableWorkspaceKey: 'thread-1' },
    );

    const full = materialize(true);
    const fullPath = await full.resolveArtifactPath(artifact);
    expect(path.basename(fullPath!)).toBe('image');
    expect(await readFile(fullPath!, 'utf8')).toBe('original');
    await full.dispose();

    const fallback = materialize(false);
    const fallbackPath = await fallback.resolveArtifactPath(artifact);
    expect(fallbackPath).toBe(fullPath);
    expect(await readFile(fallbackPath!, 'utf8')).toBe('observation');
    await fallback.dispose();
  });

  async function mkdtempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
