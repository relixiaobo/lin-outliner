import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_MATERIALIZED_ATTACHMENT_BYTES } from '../../src/core/agentAttachmentLimits';
import {
  AGENT_ATTACHMENT_TTL_MS,
  agentAttachmentDir,
  materializePathBackedAttachment,
  pruneOldAgentAttachments,
} from '../../src/main/agentAttachmentMaterialization';

describe('agent attachment materialization', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('copies trusted out-of-root file attachments under localRoot', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');
    const sourcePath = path.join(sourceRoot, 'report.pdf');
    await writeFile(sourcePath, 'report body');

    const attachment = await materializePathBackedAttachment(localRoot, {
      name: '../report.pdf',
      path: sourcePath,
    });

    expect(attachment.path).toStartWith(agentAttachmentDir(localRoot));
    expect(attachment.path).not.toBe(sourcePath);
    expect(path.basename(attachment.path)).not.toContain('..');
    expect(await readFile(attachment.path, 'utf8')).toBe('report body');
  });

  test('rejects oversized trusted file attachments before copying', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');
    const sourcePath = path.join(sourceRoot, 'huge.bin');
    await writeFile(sourcePath, '');
    await truncate(sourcePath, MAX_MATERIALIZED_ATTACHMENT_BYTES + 1);

    await expect(materializePathBackedAttachment(localRoot, {
      name: 'huge.bin',
      path: sourcePath,
    })).rejects.toThrow('larger');
    await expect(readdir(agentAttachmentDir(localRoot))).rejects.toThrow();
  });

  test('rejects out-of-root directory attachments instead of symlinking them', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const sourceRoot = await mkdtempRoot('lin-agent-attachment-source-');

    await expect(materializePathBackedAttachment(localRoot, {
      name: 'outside-dir',
      path: sourceRoot,
    })).rejects.toThrow('Directory attachments outside the allowed file area');
  });

  test('prunes expired staged attachments', async () => {
    const localRoot = await mkdtempRoot('lin-agent-attachment-root-');
    const attachmentDir = agentAttachmentDir(localRoot);
    await mkdir(attachmentDir, { recursive: true });
    const expiredPath = path.join(attachmentDir, 'expired.txt');
    const freshPath = path.join(attachmentDir, 'fresh.txt');
    await writeFile(expiredPath, 'expired');
    await writeFile(freshPath, 'fresh');
    const now = Date.now();
    const expiredSeconds = (now - AGENT_ATTACHMENT_TTL_MS - 1000) / 1000;
    await utimes(expiredPath, expiredSeconds, expiredSeconds);

    await pruneOldAgentAttachments(localRoot, now);

    expect(await readdir(attachmentDir)).toEqual(['fresh.txt']);
  });

  async function mkdtempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
