import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureReview, commitReview, previewPublication, pushPublication, readGitBaseline, gitCli, createPublicationPr } from '../../src/main/agent/gitReview/gitReviewGit';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
async function fixture(unborn = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-git-review-')); roots.push(root);
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.com'); git(root, 'config', 'commit.gpgSign', 'false');
  if (!unborn) { await writeFile(path.join(root, 'one.txt'), 'one\n'); await writeFile(path.join(root, 'two.txt'), 'two\n'); git(root, 'add', '.'); git(root, 'commit', '-m', 'Initial'); }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
test('reviewed commit selects exact working files and preserves unrelated staged content', async () => {
  const cwd = await fixture();
  await writeFile(path.join(cwd, 'one.txt'), 'selected\n'); await writeFile(path.join(cwd, 'two.txt'), 'unrelated staged\n'); git(cwd, 'add', 'two.txt');
  await writeFile(path.join(cwd, 'two.txt'), 'unrelated unstaged\n');
  const review = await captureReview(cwd);
  const result = await commitReview(cwd, review, ['one.txt'], 'Selected');
  expect({ outcome: result.outcome, message: result.message }).toMatchObject({ outcome: 'succeeded' });
  expect(git(cwd, 'show', 'HEAD:one.txt')).toBe('selected'); expect(git(cwd, 'show', 'HEAD:two.txt')).toBe('two');
  expect(git(cwd, 'show', ':two.txt')).toBe('unrelated staged'); expect(await readFile(path.join(cwd, 'two.txt'), 'utf8')).toBe('unrelated unstaged\n');
});
test('untracked binary review is digest-verified and can be explicitly committed', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'new.bin'), Buffer.from([0, 1, 2]));
  const review = await captureReview(cwd); expect(review.paths[0]?.binary).toBe(true);
  await writeFile(path.join(cwd, 'new.bin'), Buffer.from([0, 2, 1]));
  await expect(commitReview(cwd, review, ['new.bin'], 'Binary')).rejects.toThrow('changed');
  const refreshed = await captureReview(cwd); expect((await commitReview(cwd, refreshed, ['new.bin'], 'Binary')).outcome).toBe('succeeded');
});
test('same-OID branch switch rejects a historical review', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'one.txt'), 'change'); const review = await captureReview(cwd);
  git(cwd, 'switch', '-c', 'other'); await expect(commitReview(cwd, review, ['one.txt'], 'Wrong branch')).rejects.toThrow('changed');
});
test('new HEAD with the same tree, detached transition, and selected index changes require review', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'one.txt'), 'change'); const review = await captureReview(cwd);
  git(cwd, 'commit', '--allow-empty', '-m', 'Empty'); await expect(commitReview(cwd, review, ['one.txt'], 'Old')).rejects.toThrow('changed');
  const next = await captureReview(cwd); git(cwd, 'checkout', '--detach'); await expect(commitReview(cwd, next, ['one.txt'], 'Old')).rejects.toThrow('changed');
  const detached = await captureReview(cwd); git(cwd, 'add', 'one.txt'); await expect(commitReview(cwd, detached, ['one.txt'], 'Old')).rejects.toThrow('changed');
  expect((await commitReview(cwd, await captureReview(cwd), ['one.txt'], 'Detached')).outcome).toBe('succeeded');
});
test('unborn branch commits explicit untracked files', async () => {
  const cwd = await fixture(true); await writeFile(path.join(cwd, 'new.txt'), 'new'); const review = await captureReview(cwd);
  expect(review.baseline?.head).toBeNull(); expect((await commitReview(cwd, review, ['new.txt'], 'First')).outcome).toBe('succeeded');
});
test('rename, deletion, symlinks and literal pathspec names are reviewed explicitly', async () => {
  const cwd = await fixture(); await rename(path.join(cwd, 'one.txt'), path.join(cwd, 'renamed.txt')); git(cwd, 'add', '-A');
  await rm(path.join(cwd, 'two.txt')); await symlink('renamed.txt', path.join(cwd, 'link')); await writeFile(path.join(cwd, ':(glob)*'), 'literal');
  const review = await captureReview(cwd);
  expect(review.paths.find((entry) => entry.path === 'renamed.txt')?.previousPath).toBe('one.txt');
  await expect(commitReview(cwd, review, ['renamed.txt'], 'Rename')).rejects.toThrow('both sides');
  const result = await commitReview(cwd, review, review.paths.map((entry) => entry.path), 'All selected'); expect({ outcome: result.outcome, message: result.message }).toMatchObject({ outcome: 'succeeded' });
});
test('non-Git review supports explicit files and rejects publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tenon-non-git-')); roots.push(root); await writeFile(path.join(root, 'file.txt'), 'text');
  const review = await captureReview(root, ['file.txt']); expect(review.baseline).toBeNull(); expect(review.paths[0]?.diff).toBe('text');
  await expect(commitReview(root, review, ['file.txt'], 'No')).rejects.toThrow('Git review');
  await expect(previewPublication(root, { remote: 'origin', base: 'main' })).rejects.toThrow('requires a Git branch');
});
test('failed baseline queries do not use optional discovery', async () => {
  const root = await fixture(); const cli = gitCli(root);
  await expect(readGitBaseline(root, async (executable, args, ...rest) => args[0] === 'symbolic-ref' ? { code: 128, stdout: Buffer.alloc(0) } : cli(executable, args, ...rest))).rejects.toThrow('attachment');
});
test('local remote preview, push and repeated uncertain result reconcile exact refs', async () => {
  const cwd = await fixture(); const remote = await mkdtemp(path.join(tmpdir(), 'tenon-git-remote-')); roots.push(remote); git(remote, 'init', '--bare');
  git(cwd, 'remote', 'add', 'origin', remote); git(cwd, 'push', 'origin', 'main'); git(cwd, 'switch', '-c', 'feature');
  await writeFile(path.join(cwd, 'one.txt'), 'publish'); expect((await commitReview(cwd, await captureReview(cwd), ['one.txt'], 'Publish')).outcome).toBe('succeeded');
  const preview = await previewPublication(cwd, { remote: 'origin', base: 'main' }); expect(preview.preview?.commits.length).toBe(1);
  const cli = gitCli(cwd);
  const first = await pushPublication(cwd, preview, async (executable, args, ...rest) => { const result = await cli(executable, args, ...rest); return args[0] === 'push' ? { ...result, code: 1 } : result; });
  expect(first.outcome).toBe('reconciled');
  let pushes = 0; const again = await pushPublication(cwd, preview, async (executable, args, ...rest) => { if (args[0] === 'push') pushes++; return cli(executable, args, ...rest); });
  expect(again.outcome).toBe('reconciled'); expect(pushes).toBe(0);
});

test('baseline changes during capture discard the snapshot', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'one.txt'), 'change'); const cli = gitCli(cwd); let reads = 0;
  await expect(captureReview(cwd, undefined, async (executable, args, ...rest) => {
    if (args[0] === 'symbolic-ref' && ++reads === 2) git(cwd, 'switch', '-c', 'changed-during-review');
    return cli(executable, args, ...rest);
  })).rejects.toThrow('during capture');
});
test('signing preparation cannot bypass the last baseline validation', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'one.txt'), 'change'); const review = await captureReview(cwd); const cli = gitCli(cwd); let updates = 0;
  const result = await commitReview(cwd, review, ['one.txt'], 'Race', async (executable, args, ...rest) => {
    const output = await cli(executable, args, ...rest);
    if (args[0] === 'commit-tree') git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/race');
    if (args[0] === 'update-ref') updates++;
    return output;
  });
  expect(result.outcome).toBe('rejected'); expect(updates).toBe(0);
});
test('external ref movement at mutation is uncertain and never updates the newly selected branch', async () => {
  const cwd = await fixture(); git(cwd, 'branch', 'other'); await writeFile(path.join(cwd, 'one.txt'), 'change'); const review = await captureReview(cwd); const cli = gitCli(cwd); const old = git(cwd, 'rev-parse', 'other'); let updates = 0;
  const result = await commitReview(cwd, review, ['one.txt'], 'Race', async (executable, args, ...rest) => {
    if (args[0] === 'update-ref') { updates++; git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/other'); }
    return cli(executable, args, ...rest);
  });
  expect(result.outcome).toBe('uncertain'); expect(updates).toBe(1); expect(git(cwd, 'rev-parse', 'other')).toBe(old);
});
test('linked worktree identity is recorded and a sibling address cannot reuse its review', async () => {
  const cwd = await fixture(); const sibling = path.join(cwd, 'linked'); git(cwd, 'worktree', 'add', '-b', 'linked', sibling);
  await writeFile(path.join(sibling, 'one.txt'), 'linked change'); const review = await captureReview(sibling);
  expect(review.baseline?.commonDirectory).not.toBe(review.baseline?.gitDirectory);
  await expect(commitReview(cwd, review, ['one.txt'], 'Wrong address')).rejects.toThrow('different execution address');
  expect((await commitReview(sibling, review, ['one.txt'], 'Linked')).outcome).toBe('succeeded');
});
test('configured clean filters require ordinary Bash even for untracked selections', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=replace\n');
  git(cwd, 'config', 'filter.replace.clean', 'printf transformed'); await writeFile(path.join(cwd, 'new.txt'), 'reviewed bytes');
  await expect(captureReview(cwd, ['new.txt'])).rejects.toThrow('Executable Git filters');
});
for (const source of ['include', 'environment']) test(`filter preflight includes ${source} configuration`, async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=probe\n');
  await writeFile(path.join(cwd, 'one.txt'), 'changed');
  const command = 'printf ran > filter-ran; cat'; const cli = gitCli(cwd);
  const env = source === 'environment' ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.probe.clean', GIT_CONFIG_VALUE_0: command } : {};
  if (source === 'include') {
    await writeFile(path.join(cwd, '.git', 'filters.config'), `[filter "probe"]\nclean = "${command}"\n`);
    git(cwd, 'config', 'include.path', 'filters.config');
  }
  await expect(captureReview(cwd, ['one.txt'], (executable, args, input, extraEnv) => cli(executable, args, input, { ...env, ...extraEnv })))
    .rejects.toThrow('Executable Git filters');
  expect(await access(path.join(cwd, 'filter-ran')).then(() => true, () => false)).toBe(false);
});
test('inspection reports changed gitlinks without executing submodule worktree extensions', async () => {
  const cwd = await fixture(); const source = await fixture();
  git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'nested'); git(cwd, 'commit', '-m', 'Submodule');
  const nested = path.join(cwd, 'nested');
  const head = git(nested, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Advanced');
  git(nested, 'update-ref', 'HEAD', head);
  await writeFile(path.join(nested, '.gitattributes'), '*.txt filter=probe\n');
  await writeFile(path.join(nested, 'one.txt'), 'dirty');
  git(nested, 'config', 'filter.probe.clean', 'printf ran > filter-ran; cat');
  const script = path.join(nested, 'monitor.sh');
  await writeFile(script, '#!/bin/sh\nprintf ran > monitor-ran\nprintf "token\\0"\n', { mode: 0o700 });
  git(nested, 'config', 'core.fsmonitor', script);
  const review = await captureReview(cwd, ['nested']);
  expect(review.paths[0]?.status).toContain('M');
  expect(await access(path.join(nested, 'filter-ran')).then(() => true, () => false)).toBe(false);
  expect(await access(path.join(nested, 'monitor-ran')).then(() => true, () => false)).toBe(false);
  await expect(commitReview(cwd, review, ['nested'], 'Unsupported')).rejects.toThrow('submodules');
});
test('path escapes, unreviewed selections, unresolved indexes, and incomplete baselines fail closed', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'one.txt'), 'changed');
  await expect(captureReview(cwd, ['../outside'])).rejects.toThrow('exact');
  const review = await captureReview(cwd, ['one.txt']); await expect(commitReview(cwd, review, ['two.txt'], 'Unreviewed')).rejects.toThrow('not reviewed');
  git(cwd, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
  await expect(commitReview(cwd, review, ['one.txt'], 'Changed')).rejects.toThrow('changed');
});

test('GitHub lost creation reply reconciles exact head/base without duplicating a PR', async () => {
  const cwd = await fixture(); git(cwd, 'switch', '-c', 'feature');
  await writeFile(path.join(cwd, 'one.txt'), 'pr'); await commitReview(cwd, await captureReview(cwd), ['one.txt'], 'PR');
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/example/review-fixture.git');
  const head = git(cwd, 'rev-parse', 'HEAD'); const base = git(cwd, 'rev-parse', 'main'); const cli = gitCli(cwd);
  let created = false; let creates = 0;
  const hosted: typeof cli = async (executable, args, ...rest) => {
    if (executable === 'git' && args[0] === 'ls-remote') return { code: 0, stdout: Buffer.from(`${args.at(-1) === 'refs/heads/main' ? base : head}\t${args.at(-1)}\n`) };
    if (executable === 'gh') {
      if (args[1] === 'create') { creates++; created = true; return { code: 1, stdout: Buffer.alloc(0) }; }
      return { code: 0, stdout: Buffer.from(JSON.stringify(created ? [{ number: 7, url: 'https://github.com/example/review-fixture/pull/7', headRefOid: head, headRefName: 'feature', baseRefName: 'main', state: 'OPEN', isCrossRepository: false }] : [])) };
    }
    return cli(executable, args, ...rest);
  };
  const preview = await previewPublication(cwd, { remote: 'origin', base: 'main' }, hosted);
  const first = await createPublicationPr(cwd, preview, { title: 'Title', body: 'Body' }, hosted);
  expect(first.outcome).toBe('succeeded'); expect(first.pullRequest).toContain('/pull/7');
  const again = await createPublicationPr(cwd, preview, { title: 'Title', body: 'Body' }, hosted);
  expect(again.outcome).toBe('reconciled'); expect(creates).toBe(1);
  let attempts = 0;
  const incomplete = await createPublicationPr(cwd, preview, { title: 'Title', body: 'Body' }, async (executable, args, ...rest) => {
    if (executable === 'gh') { if (args[1] === 'create') attempts++; return { code: 1, stdout: Buffer.alloc(0) }; }
    return hosted(executable, args, ...rest);
  });
  expect(incomplete.outcome).toBe('rejected'); expect(attempts).toBe(0);
});

test('recreated worktree registration at the same canonical path invalidates review', async () => {
  const cwd = await fixture(); const sibling = path.join(cwd, 'linked'); git(cwd, 'worktree', 'add', '-b', 'linked', sibling);
  await writeFile(path.join(sibling, 'one.txt'), 'linked'); const review = await captureReview(sibling);
  const registration = path.join(sibling, '.git'); const content = await readFile(registration);
  await rename(registration, `${registration}.old`); await writeFile(registration, content);
  await expect(commitReview(sibling, review, ['one.txt'], 'Replaced identity')).rejects.toThrow('changed');
});

test('unmerged index stages are reviewed but cannot become a selected-file commit', async () => {
  const cwd = await fixture(); const blob = git(cwd, 'rev-parse', 'HEAD:one.txt');
  execFileSync('git', ['update-index', '--index-info'], { cwd, input: `0 ${'0'.repeat(40)}\tone.txt\n100644 ${blob} 1\tone.txt\n100644 ${blob} 2\tone.txt\n`, stdio: ['pipe', 'pipe', 'pipe'] });
  const review = await captureReview(cwd, ['one.txt']); expect(review.paths[0]?.index).toContain(' 1\t');
  await expect(commitReview(cwd, review, ['one.txt'], 'Unmerged')).rejects.toThrow('unmerged');
});

test('deleted binary files retain binary classification without publishing an encoded patch', async () => {
  const cwd = await fixture(); await writeFile(path.join(cwd, 'binary.bin'), Buffer.from([0, 1, 2, 3])); git(cwd, 'add', 'binary.bin'); git(cwd, 'commit', '-m', 'Binary');
  await rm(path.join(cwd, 'binary.bin')); const review = await captureReview(cwd);
  expect(review.paths[0]).toMatchObject({ path: 'binary.bin', kind: 'deleted', bytes: 0, binary: true, diff: '' });
  expect((await commitReview(cwd, review, ['binary.bin'], 'Delete binary')).outcome).toBe('succeeded');
});
