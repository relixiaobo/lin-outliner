import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The GitHub Release body. Its failure modes are asymmetric: publishing the
 * wrong thing is loud and cheap to notice, publishing *nothing* — or the whole
 * engineering ledger — is what actually shipped before. So the cases here are
 * "the note and only the note" and "refuse rather than publish blank".
 */
const RELEASE_NOTES = join(import.meta.dir, '../../scripts/release-notes.ts');

function run(changelog: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'release-notes-')), 'CHANGELOG.md');
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

  test('accepts the tag spelling the workflow passes', () => {
    expect(run(CHANGELOG, 'v0.1.0').stdout).toContain('**Welcome to Tenon 0.1.**');
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
});
