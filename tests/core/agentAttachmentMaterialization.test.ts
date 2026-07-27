import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_GENERATED_IMAGE_DIR,
  AGENT_SCRATCH_TTL_MS,
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

  test('keeps generated image artifacts out of generic scratch TTL pruning', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-scratch-');
    const now = Date.now();
    const expiredSeconds = (now - AGENT_SCRATCH_TTL_MS - 1000) / 1000;
    const generatedDir = path.join(scratchRoot, AGENT_GENERATED_IMAGE_DIR, 'run-1');
    await mkdir(generatedDir, { recursive: true });
    const generatedPath = path.join(generatedDir, 'image.png');
    await writeFile(generatedPath, 'image bytes');
    await utimes(generatedPath, expiredSeconds, expiredSeconds);

    await pruneAgentScratch(scratchRoot, now);

    expect(await readdir(generatedDir)).toEqual(['image.png']);
  });

  test('pruneAgentScratch is a no-op when the scratch root does not exist', async () => {
    const scratchRoot = path.join(await mkdtempRoot('lin-agent-scratch-'), 'never-created');
    await expect(pruneAgentScratch(scratchRoot)).resolves.toBeUndefined();
  });

  async function mkdtempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
