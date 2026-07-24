import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_GENERATED_IMAGE_DIR } from '../../src/main/agent/capabilities/agentAttachmentMaterialization';
import { resolveGeneratedImageReadPath } from '../../src/main/generatedImagePaths';

describe('generated image paths', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('resolves generated-image scratch paths to canonical local files', async () => {
    const scratchRoot = await mkdtempRoot('lin-generated-images-scratch-');
    const generatedDir = path.join(scratchRoot, AGENT_GENERATED_IMAGE_DIR, 'run-a');
    await mkdir(generatedDir, { recursive: true });
    const filePath = path.join(generatedDir, 'image-0.png');
    await writeFile(filePath, 'image bytes');

    await expect(resolveGeneratedImageReadPath(
      { scratchRoot },
      'generated-images/run-a/image-0.png',
    )).resolves.toBe(await realpath(filePath));
  });

  test('returns null for non-generated-image paths', async () => {
    const scratchRoot = await mkdtempRoot('lin-generated-images-scratch-');

    await expect(resolveGeneratedImageReadPath({ scratchRoot }, 'images/source.png')).resolves.toBeNull();
    await expect(resolveGeneratedImageReadPath({ scratchRoot }, path.join(scratchRoot, 'generated-images/run-a/image-0.png'))).resolves.toBeNull();
  });

  test('rejects generated-image symlinks that escape the generated-image directory', async () => {
    const scratchRoot = await mkdtempRoot('lin-generated-images-scratch-');
    const outsideRoot = await mkdtempRoot('lin-generated-images-outside-');
    const generatedDir = path.join(scratchRoot, AGENT_GENERATED_IMAGE_DIR, 'run-a');
    await mkdir(generatedDir, { recursive: true });
    const outsidePath = path.join(outsideRoot, 'outside.png');
    await writeFile(outsidePath, 'outside image bytes');
    await symlink(outsidePath, path.join(generatedDir, 'escape.png'));

    await expect(resolveGeneratedImageReadPath(
      { scratchRoot },
      'generated-images/run-a/escape.png',
    )).rejects.toThrow('Generated image path is not readable');
  });

  async function mkdtempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
