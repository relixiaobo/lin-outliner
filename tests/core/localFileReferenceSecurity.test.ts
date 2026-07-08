import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSafeLocalFileOpenTarget,
  resolveTrustedLocalFileReference,
} from '../../src/main/localFileReferenceSecurity';

describe('local file reference security', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  test('accepts regular files under an allowed root after canonicalization', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const nested = path.join(root, 'nested');
    await mkdir(nested);
    const filePath = path.join(nested, 'note.txt');
    await writeFile(filePath, 'trusted');

    const reference = await resolveTrustedLocalFileReference(
      path.join(nested, '..', 'nested', 'note.txt'),
      [root],
    );

    expect(reference?.entryKind).toBe('file');
    expect(reference?.path).toBe(await realpath(filePath));
    expect(reference && isSafeLocalFileOpenTarget(reference)).toBe(true);
  });

  test('accepts relative generated-image references under generated roots only', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const scratch = await mkdtempRoot('lin-local-file-scratch-');
    const workspaceGeneratedDir = path.join(root, 'generated-images', 'run-123');
    const generatedDir = path.join(scratch, 'generated-images', 'run-123');
    await mkdir(workspaceGeneratedDir, { recursive: true });
    await mkdir(generatedDir, { recursive: true });
    await writeFile(path.join(workspaceGeneratedDir, 'image-0.png'), 'workspace image');
    const generatedPath = path.join(generatedDir, 'image-0.png');
    await writeFile(generatedPath, 'image');

    const reference = await resolveTrustedLocalFileReference(
      'generated-images/run-123/image-0.png',
      [root, scratch],
      { relativeGeneratedImageRoots: [scratch] },
    );

    expect(reference?.entryKind).toBe('file');
    expect(reference?.path).toBe(await realpath(generatedPath));
    await expect(resolveTrustedLocalFileReference(
      'generated-images/run-123/image-0.png',
      [root, scratch],
    )).resolves.toBeNull();
    await writeFile(path.join(root, 'notes.md'), 'note');
    await expect(resolveTrustedLocalFileReference('notes.md', [root, scratch])).resolves.toBeNull();
    await expect(resolveTrustedLocalFileReference('../secret.png', [root, scratch])).resolves.toBeNull();
  });

  test('rejects files outside all allowed roots', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const outsideRoot = await mkdtempRoot('lin-local-file-outside-');
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    await writeFile(outsideFile, 'secret');

    await expect(resolveTrustedLocalFileReference(outsideFile, [root])).resolves.toBeNull();
  });

  test('rejects filesystem root as a trusted root', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const filePath = path.join(root, 'note.txt');
    await writeFile(filePath, 'trusted');

    await expect(resolveTrustedLocalFileReference(filePath, [path.parse(root).root])).resolves.toBeNull();
  });

  test('rejects symlinks inside the root when they resolve outside it', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const outsideRoot = await mkdtempRoot('lin-local-file-outside-');
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    const symlinkPath = path.join(root, 'secret-link.txt');
    await writeFile(outsideFile, 'secret');
    await symlink(outsideFile, symlinkPath);

    await expect(resolveTrustedLocalFileReference(symlinkPath, [root])).resolves.toBeNull();
  });

  test('blocks executable and bundle-like targets from shell open', async () => {
    const root = await mkdtempRoot('lin-local-file-root-');
    const commandPath = path.join(root, 'payload.command');
    const executableTextPath = path.join(root, 'run.txt');
    const appBundlePath = path.join(root, 'Payload.app');
    await writeFile(commandPath, 'echo payload');
    await writeFile(executableTextPath, 'echo payload');
    await chmod(executableTextPath, 0o755);
    await mkdir(appBundlePath);

    const commandRef = await resolveTrustedLocalFileReference(commandPath, [root]);
    const executableTextRef = await resolveTrustedLocalFileReference(executableTextPath, [root]);
    const appBundleRef = await resolveTrustedLocalFileReference(appBundlePath, [root]);

    expect(commandRef && isSafeLocalFileOpenTarget(commandRef)).toBe(false);
    expect(executableTextRef && isSafeLocalFileOpenTarget(executableTextRef)).toBe(false);
    expect(appBundleRef && isSafeLocalFileOpenTarget(appBundleRef)).toBe(false);
  });

  test('blocks location/shortcut files that resolve outside the trusted root', async () => {
    // These are plain, non-executable files that live INSIDE the root (so path
    // confinement passes), but shell.openPath would follow their embedded
    // URL/bookmark to an arbitrary target outside the root. They must be denied
    // by extension since the executable-bit check cannot catch them.
    const root = await mkdtempRoot('lin-local-file-root-');
    const locationExtensions = ['.fileloc', '.inetloc', '.url', '.webloc', '.desktop'];
    for (const extension of locationExtensions) {
      const filePath = path.join(root, `redirect${extension}`);
      await writeFile(filePath, 'redirect');
      const reference = await resolveTrustedLocalFileReference(filePath, [root]);
      expect(reference?.entryKind).toBe('file');
      expect(reference && isSafeLocalFileOpenTarget(reference)).toBe(false);
    }

    // Script/automation bundles are directories (the exec-bit check is skipped
    // for directories), so they too must be denied by extension.
    const scriptBundlePath = path.join(root, 'macro.scptd');
    await mkdir(scriptBundlePath);
    const scriptBundleRef = await resolveTrustedLocalFileReference(scriptBundlePath, [root]);
    expect(scriptBundleRef?.entryKind).toBe('directory');
    expect(scriptBundleRef && isSafeLocalFileOpenTarget(scriptBundleRef)).toBe(false);
  });

  async function mkdtempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
