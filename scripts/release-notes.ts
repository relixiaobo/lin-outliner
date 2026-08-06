#!/usr/bin/env bun
/**
 * release-notes — lifts one version's user note out of CHANGELOG.md.
 *
 * The release body is the changelog's own note, not a second hand-written
 * summary: two descriptions of one release drift, and the one nobody edits is
 * the one users read. This reads the file that already has to be right, through
 * the same parser the in-app What's New pane uses — so the two user surfaces
 * cannot disagree about what a release says.
 *
 * The `### Added` … `### Internal` categories under the note stay behind: they
 * are the engineering ledger, read on GitHub in the file itself, and shipping
 * hundreds of them as the release body is what buried the note in the first
 * place. The body links to them rather than reprinting them, so "left behind"
 * never means "unreachable".
 *
 * Usage: bun scripts/release-notes.ts 0.1.0 [path/to/CHANGELOG.md]
 * Exits 1 when the version has no section or its note is missing — a release
 * whose notes would be empty is a mistake worth stopping for, not a blank body
 * to publish.
 */

import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { changelogSectionPath, normalizedVersion, parseChangelogReleases } from '../src/core/changelog';

const REPO_URL = 'https://github.com/relixiaobo/lin-outliner';

const version = normalizedVersion(process.argv[2]);
if (!version) {
  console.error('usage: release-notes <version> [changelog-path]');
  process.exit(1);
}

// Resolved as a path, never interpolated into a URL: a clone directory holding
// `#`, `?`, or `%` would otherwise be parsed as URL syntax and the script would
// die on an unhandled ENOENT instead of reaching either error message below.
const changelogPath = process.argv[3]
  ? (isAbsolute(process.argv[3]) ? process.argv[3] : resolve(process.cwd(), process.argv[3]))
  : fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

const releases = parseChangelogReleases(await Bun.file(changelogPath).text());
const release = releases.find((entry) => normalizedVersion(entry.version) === version);
if (!release) {
  console.error(`CHANGELOG.md has no section for ${version}. Add it before tagging.`);
  process.exit(1);
}
if (!release.note) {
  console.error(
    `The ${version} section has no user note. Write one above its first "###" heading `
    + '— it is both the release body and What\'s New.',
  );
  process.exit(1);
}

// The entries themselves still have to be reachable. Publishing the note alone
// would leave a release page whose forty-odd fixes and additions appear nowhere
// and are pointed at by nothing — the categories are read on GitHub, so the body
// carries the same link the About pane grew, built by the same helper so the two
// surfaces cannot point at different places. The tag exists by now: this runs
// from the workflow the tag push triggers.
console.log([
  release.note,
  '',
  `**[Full changelog](${REPO_URL}/blob/${changelogSectionPath(release)})** — every entry in this release.`,
  '',
  '---',
  '',
  '### Installing',
  '',
  'Drag **Tenon.app** to `/Applications`. The build is **unsigned and not notarized**,',
  'so macOS blocks it on first launch — **right-click the app and choose Open**, then',
  'confirm. This is only needed once. A signed build needs an Apple Developer account;',
  'until then this is the trade.',
  '',
  '**Apple silicon (arm64) only.** `build.mac` in `package.json` sets no `arch`, so',
  'electron-builder produces the host architecture and the runner is arm64. Intel',
  'support is a deliberate open question, not an oversight — say so if you need it.',
].join('\n'));
