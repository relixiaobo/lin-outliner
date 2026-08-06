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
      label: 'Unreleased',
      note: 'Tracks main.',
    });
    expect(releases[1]).toEqual({
      version: '0.1.0',
      date: '2026-08-05',
      label: '0.1.0 - 2026-08-05',
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

  test('prefers the running version and falls back to Unreleased', () => {
    const releases = parseChangelogReleases(`## [Unreleased]

Next.

## [v0.1.0] - 2026-08-05

Current.
`);

    expect(resolveChangelogRelease(releases, '0.1.0')?.version).toBe('v0.1.0');
    expect(resolveChangelogRelease(releases, '9.9.9')?.version).toBe('Unreleased');
    expect(resolveChangelogRelease(releases, null)?.version).toBe('Unreleased');
    expect(resolveChangelogRelease([], '0.1.0')).toBeNull();
  });

  test('pins a released section to its tag and an unreleased one to main', () => {
    const releases = parseChangelogReleases(`## [Unreleased]

Next.

## [0.1.0] - 2026-08-05

Current.

## [v0.0.9]

Older, headed with a v.
`);

    expect(changelogSectionPath(releases[0]!)).toBe('main/CHANGELOG.md#unreleased');
    // GitHub drops the brackets and the dots and hyphenates the spaces, so the
    // anchor tracks the heading's own text — including a `v` the tag would add
    // anyway, which is why it is derived rather than assembled from the tag.
    expect(changelogSectionPath(releases[1]!)).toBe('v0.1.0/CHANGELOG.md#010---2026-08-05');
    expect(changelogSectionPath(releases[2]!)).toBe('v0.0.9/CHANGELOG.md#v009');
  });
});
