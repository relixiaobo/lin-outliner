import { describe, expect, test } from 'bun:test';
import {
  changelogSectionPath,
  parseChangelogReleases,
  resolveChangelogRelease,
} from '../../src/core/changelog';

describe('changelog release notes', () => {
  test('lifts each release\'s note and leaves every category behind', () => {
    const releases = parseChangelogReleases(`# Changelog

Preamble that is not part of a release.

## [Unreleased]

Tracks main.

### Fixed

- User-visible fix.

### Internal

- Build-only detail.

#### Nested implementation detail

- Still internal.

## [0.1.0] - 2026-08-05

**Welcome to the first build.**

- Outline your thinking.

### Added

- First release.

### Internal

- Packaging detail.
`);

    expect(releases).toHaveLength(2);
    expect(releases[0]).toEqual({
      version: 'Unreleased',
      date: null,
      note: 'Tracks main.',
    });
    expect(releases[1]).toEqual({
      version: '0.1.0',
      date: '2026-08-05',
      note: '**Welcome to the first build.**\n\n- Outline your thinking.',
    });
    // The categories are the engineering ledger. Nothing that reaches a user
    // surface may carry them, Internal least of all.
    for (const release of releases) {
      expect(release.note).not.toContain('###');
      expect(release.note).not.toContain('Internal');
      expect(release.note).not.toContain('Build-only detail.');
      expect(release.note).not.toContain('First release.');
      expect(release.note).not.toContain('User-visible fix.');
    }
  });

  // The categories are written at depth 3 by convention, but a guarantee that
  // holds only while everyone follows the convention is not a guarantee: at
  // `depth === 3` exactly, a section headed with `####` poured its whole ledger —
  // Internal included — into the note the pane renders and the release publishes.
  test('ends the note at any heading depth, not just three', () => {
    const [release] = parseChangelogReleases(`## [0.3.0] - 2026-09-01

The note.

#### Added

- An entry written one level deeper.

#### Internal

- Provenance nobody outside the repo should read.
`);

    expect(release?.note).toBe('The note.');
  });

  test('reports an empty note for a section that predates the convention', () => {
    const [release] = parseChangelogReleases(`## [0.0.9] - 2026-07-01

### Added

- Something old.
`);

    expect(release?.note).toBe('');
  });

  test('uses Markdown tokens so a heading inside a code block stays in the note', () => {
    const [release] = parseChangelogReleases(`## [Unreleased]

Shipping a snippet:

\`\`\`markdown
### Internal
\`\`\`

### Fixed

- A fix.
`);

    expect(release?.note).toContain('```markdown\n### Internal\n```');
    expect(release?.note).not.toContain('A fix.');
  });

  // `Unreleased` opens with the maintainer line naming the train `main` is on.
  // Selecting it put "`main` is the `0.2.0` train; entries here move under the
  // next tag" in front of the user as their What's New, so it is never selected:
  // a build ahead of the last release shows the newest release that has a note.
  test('prefers the running version and falls back past Unreleased to the newest note', () => {
    const releases = parseChangelogReleases(`## [Unreleased]

\`main\` is the 0.3.0 train; entries here move under the next tag.

## [0.2.0] - 2026-09-01

### Added

- A section frozen before the note convention.

## [v0.1.0] - 2026-08-05

Current.
`);

    expect(resolveChangelogRelease(releases, '0.1.0')?.version).toBe('v0.1.0');
    // The running version's own section wins even with no note: it is that
    // build's record, and it degrades to the changelog link rather than
    // borrowing an older release's words.
    expect(resolveChangelogRelease(releases, '0.2.0')?.version).toBe('0.2.0');
    // A dev build ahead of every release skips both Unreleased and the noteless
    // section.
    expect(resolveChangelogRelease(releases, '0.3.0')?.version).toBe('v0.1.0');
    expect(resolveChangelogRelease(releases, null)?.version).toBe('v0.1.0');
    expect(resolveChangelogRelease([], '0.1.0')).toBeNull();
  });

  // Newest-first is a convention, and this file already replaced one
  // convention-dependent test with a robust one. A hotfix appended under the
  // section it patches must not send every dev build to the older note and tag.
  test('falls back by version, not by position in the file', () => {
    const releases = parseChangelogReleases(`## [0.1.0] - 2026-08-05

The minor.

## [0.1.1] - 2026-08-09

The hotfix, written below the section it patches.

## [0.9.0] - 2026-07-01

An out-of-order section that is not the highest.
`);

    expect(resolveChangelogRelease(releases, '5.0.0')?.version).toBe('0.9.0');
  });

  test('a malformed version never outranks a real release', () => {
    const releases = parseChangelogReleases(`## [nightly]

Not a version.

## [0.1.0] - 2026-08-05

A real release.
`);

    expect(resolveChangelogRelease(releases, '9.9.9')?.version).toBe('0.1.0');
  });

  test('has nothing to show when only Unreleased carries prose', () => {
    const releases = parseChangelogReleases(`## [Unreleased]

\`main\` is the 0.2.0 train; entries here move under the next tag.
`);

    expect(resolveChangelogRelease(releases, '0.2.0')).toBeNull();
  });

  test('pins a section to its own tag', () => {
    const releases = parseChangelogReleases(`## [0.1.0] - 2026-08-05

Current.

## [v0.0.9]

Older, headed with a v.
`);

    // GitHub drops the brackets and the dots and hyphenates the spaces, so the
    // anchor tracks the heading's own text — including a `v` the tag would add
    // anyway, which is why it is derived rather than assembled from the tag.
    expect(changelogSectionPath(releases[0]!)).toBe('v0.1.0/CHANGELOG.md#010---2026-08-05');
    expect(changelogSectionPath(releases[1]!)).toBe('v0.0.9/CHANGELOG.md#v009');
  });
});
