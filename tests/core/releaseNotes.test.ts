import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The GitHub Release body. Its failure modes are asymmetric: publishing the
 * wrong thing is loud and cheap to notice, publishing *nothing* — or the whole
 * engineering ledger — is what actually shipped before. So the cases here are
 * "the note and only the note" and "refuse rather than publish blank".
 */
const RELEASE_NOTES = join(import.meta.dir, '../../scripts/release-notes.ts');

// One directory for the file, removed at the end. Minting one per `run()` and
// never removing it left a dozen `release-notes-*` strays in the system temp
// directory per `test:core`.
let workspace = '';
beforeAll(() => { workspace = mkdtempSync(join(tmpdir(), 'release-notes-')); });
afterAll(() => { rmSync(workspace, { recursive: true, force: true }); });

function run(changelog: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const path = join(workspace, 'CHANGELOG.md');
  writeFileSync(path, changelog);
  const result = Bun.spawnSync(['bun', RELEASE_NOTES, ...args, path]);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

const CHANGELOG = `# Changelog

## [Unreleased]

Tracks main.

## [0.1.0] - 2026-08-05

**Welcome to Tenon 0.1.**

- Outline your thinking.

### Added

- Some engineering entry (PR #1, agent).

### Internal

- Packaging detail.

## [0.0.9] - 2026-07-01

### Added

- A section written before the note convention.
`;

describe('release-notes', () => {
  test('publishes the note plus the installing footer, and no category', () => {
    const { code, stdout } = run(CHANGELOG, '0.1.0');

    expect(code).toBe(0);
    expect(stdout).toContain('**Welcome to Tenon 0.1.**');
    expect(stdout).toContain('- Outline your thinking.');
    expect(stdout).toContain('### Installing');
    expect(stdout).toContain('unsigned and not notarized');
    expect(stdout).not.toContain('### Added');
    expect(stdout).not.toContain('Some engineering entry');
    expect(stdout).not.toContain('Packaging detail');
    // The next release's section must not bleed into this one's body.
    expect(stdout).not.toContain('Tracks main.');
  });

  // Leaving the entries out of the body is only acceptable while the body points
  // at them; without this the release page is a note and a dead end.
  test('points at the entries it leaves behind, at the same place the pane does', () => {
    expect(run(CHANGELOG, '0.1.0').stdout).toContain(
      '[Full changelog](https://github.com/relixiaobo/lin-outliner/blob/v0.1.0/CHANGELOG.md#010---2026-08-05)',
    );
  });

  test('accepts the tag spellings a heading or a tag push can carry', () => {
    expect(run(CHANGELOG, 'v0.1.0').stdout).toContain('**Welcome to Tenon 0.1.**');
    // A `## [V0.1.0]` heading resolves in the pane, so it must not fail the tag
    // push here — one normalization rule, shared with the renderer.
    expect(run(CHANGELOG.replace('## [0.1.0]', '## [V0.1.0]'), '0.1.0').code).toBe(0);
  });

  test('reads a changelog path through a directory with URL punctuation', () => {
    const awkward = mkdtempSync(join(tmpdir(), 'release-notes-#?%-'));
    try {
      const path = join(awkward, 'CHANGELOG.md');
      writeFileSync(path, CHANGELOG);
      const result = Bun.spawnSync(['bun', RELEASE_NOTES, '0.1.0', path]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('**Welcome to Tenon 0.1.**');
    } finally {
      rmSync(awkward, { recursive: true, force: true });
    }
  });

  test('refuses a version with no section', () => {
    const { code, stderr } = run(CHANGELOG, '9.9.9');

    expect(code).toBe(1);
    expect(stderr).toContain('no section for 9.9.9');
  });

  test('refuses a section whose note was never written', () => {
    const { code, stdout, stderr } = run(CHANGELOG, '0.0.9');

    expect(code).toBe(1);
    expect(stderr).toContain('no user note');
    expect(stdout).not.toContain('A section written before the note convention');
  });

  test('refuses to run without a version', () => {
    const result = Bun.spawnSync(['bun', RELEASE_NOTES]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('usage:');
  });

  test('refuses to publish Unreleased', () => {
    const { code, stderr } = run(CHANGELOG, 'Unreleased');

    expect(code).toBe(1);
    expect(stderr).toContain('not a release');
  });

  // The freeze renames `## [Unreleased]` to `## [X.Y.Z] - <date>` and opens a
  // fresh Unreleased above it. That motion carries the train line down into the
  // released section, where it is no longer recognizable by heading and reads as
  // a perfectly non-empty note — so the emptiness check alone would publish
  // "`main` is the 0.2.0 train…" as the entire body, and show it in the pane.
  test('refuses a section still opening with the Unreleased train line', () => {
    const frozen = `# Changelog

## [Unreleased]

\`main\` is the 0.3.0 train; entries here move under the next tag.

## [0.2.0] - 2026-09-01

\`main\` is the \`0.2.0\` train; entries here move under the next tag.

### Fixed

- A real entry nobody would ever read in the body.
`;
    const { code, stdout, stderr } = run(frozen, '0.2.0');

    expect(code).toBe(1);
    expect(stderr).toContain('train line');
    expect(stdout).not.toContain('train');
  });
});
