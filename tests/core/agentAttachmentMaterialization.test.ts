import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_MATERIALIZED_ATTACHMENT_BYTES } from '../../src/core/agentAttachmentLimits';
import {
  AGENT_ATTACHMENT_TTL_MS,
  AGENT_SCRATCH_TTL_MS,
  agentAttachmentDir,
  materializePathBackedAttachment,
  pruneAgentScratch,
  pruneOldAgentAttachments,
} from '../../src/main/agentAttachmentMaterialization';

describe('agent attachment materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('copies trusted out-of-root file attachments into the scratch root, not the workdir', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');
    const sourcePath = path.join(sourceRoot, 'report.pdf');
    await writeFile(sourcePath, 'report body');

    const attachment = await materializePathBackedAttachment(localRoot, scratchRoot, {
      name: '../report.pdf',
      path: sourcePath,
    });

    // Lands in scratch (a sibling of the workdir), never inside the agent's file area.
    expect(attachment.path).toStartWith(agentAttachmentDir(scratchRoot));
    expect(attachment.path).not.toStartWith(path.resolve(localRoot));
    expect(attachment.path).not.toBe(sourcePath);
    expect(path.basename(attachment.path)).not.toContain('..');
    expect(await readFile(attachment.path, 'utf8')).toBe('report body');
  });

  test('returns an already-in-workdir source as-is without copying into scratch', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    const sourcePath = path.join(localRoot, 'inside.txt');
    await writeFile(sourcePath, 'inside body');

    const attachment = await materializePathBackedAttachment(localRoot, scratchRoot, {
      name: 'inside.txt',
      path: sourcePath,
    });

    // The source is already readable in the workdir, so it is returned in place (as its real
    // path) and nothing is copied into scratch.
    expect(attachment.path).toBe(await realpath(sourcePath));
    expect(attachment.path).not.toStartWith(path.resolve(scratchRoot));
    await expect(readdir(agentAttachmentDir(scratchRoot))).rejects.toThrow();
  });

  test('returns an already-in-scratch source as-is without copying it again', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    // A user-staged attachment already lives in the scratch attachment dir.
    const stagedDir = agentAttachmentDir(scratchRoot);
    await mkdir(stagedDir, { recursive: true });
    const stagedPath = path.join(stagedDir, 'staged.txt');
    await writeFile(stagedPath, 'staged body');

    const attachment = await materializePathBackedAttachment(localRoot, scratchRoot, {
      name: 'staged.txt',
      path: stagedPath,
    });

    expect(attachment.path).toBe(await realpath(stagedPath));
    // No second copy was made alongside the original.
    expect(await readdir(stagedDir)).toEqual(['staged.txt']);
  });

  test('rejects oversized trusted file attachments before copying', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');
    const sourcePath = path.join(sourceRoot, 'huge.bin');
    await writeFile(sourcePath, '');
    await truncate(sourcePath, MAX_MATERIALIZED_ATTACHMENT_BYTES + 1);

    await expect(materializePathBackedAttachment(localRoot, scratchRoot, {
      name: 'huge.bin',
      path: sourcePath,
    })).rejects.toThrow('larger');
    await expect(readdir(agentAttachmentDir(scratchRoot))).rejects.toThrow();
  });

  test('rejects out-of-root directory attachments instead of symlinking them', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');

    await expect(materializePathBackedAttachment(localRoot, scratchRoot, {
      name: 'outside-dir',
      path: sourceRoot,
    })).rejects.toThrow('Directory attachments outside the allowed file area');
  });

  test('prunes expired staged attachments', async () => {
    const scratchRoot = await mkdtempRoot('lin-agent-attachment-scratch-');
    const attachmentDir = agentAttachmentDir(scratchRoot);
    await mkdir(attachmentDir, { recursive: true });
    const expiredPath = path.join(attachmentDir, 'expired.txt');
    const freshPath = path.join(attachmentDir, 'fresh.txt');
    await writeFile(expiredPath, 'expired');
    await writeFile(freshPath, 'fresh');
    const now = Date.now();
    const expiredSeconds = (now - AGENT_ATTACHMENT_TTL_MS - 1000) / 1000;
    await utimes(expiredPath, expiredSeconds, expiredSeconds);

    await pruneOldAgentAttachments(scratchRoot, now);

    expect(await readdir(attachmentDir)).toEqual(['fresh.txt']);
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
