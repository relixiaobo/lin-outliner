import { describe, expect, test } from 'bun:test';
import {
  parseChangelogReleases,
  resolveChangelogRelease,
} from '../../src/core/changelog';

describe('changelog release notes', () => {
  test('extracts bracketed releases and removes every Internal section', () => {
    const releases = parseChangelogReleases(`# Changelog

Preamble that is not part of a release.

## [Unreleased]

Tracks main.

### Internal

- Build-only detail.

#### Nested implementation detail

- Still internal.

### Fixed

- User-visible fix.

## [0.1.0] - 2026-08-05

### Added

- First release.

### Internal

- Packaging detail.
`);

    expect(releases).toHaveLength(2);
    expect(releases[0]).toMatchObject({
      version: 'Unreleased',
      date: null,
      label: 'Unreleased',
    });
    expect(releases[0]!.markdown).toContain('Tracks main.');
    expect(releases[0]!.markdown).toContain('### Fixed');
    expect(releases[0]!.markdown).toContain('User-visible fix.');
    expect(releases[0]!.markdown).not.toContain('Internal');
    expect(releases[0]!.markdown).not.toContain('Build-only detail.');
    expect(releases[1]).toEqual({
      version: '0.1.0',
      date: '2026-08-05',
      label: '0.1.0 - 2026-08-05',
      markdown: '### Added\n\n- First release.',
    });
  });

  test('uses Markdown tokens so heading-like code remains visible', () => {
    const [release] = parseChangelogReleases(`## [Unreleased]

### Fixed

\`\`\`markdown
### Internal
\`\`\`
`);

    expect(release?.markdown).toContain('```markdown\n### Internal\n```');
  });

  test('prefers the running version and falls back to Unreleased', () => {
    const releases = parseChangelogReleases(`## [Unreleased]

### Changed

- Next.

## [v0.1.0] - 2026-08-05

### Added

- Current.
`);

    expect(resolveChangelogRelease(releases, '0.1.0')?.version).toBe('v0.1.0');
    expect(resolveChangelogRelease(releases, '9.9.9')?.version).toBe('Unreleased');
    expect(resolveChangelogRelease(releases, null)?.version).toBe('Unreleased');
    expect(resolveChangelogRelease([], '0.1.0')).toBeNull();
  });
});
