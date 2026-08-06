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
 * place.
 *
 * Usage: bun scripts/release-notes.ts 0.1.0 [path/to/CHANGELOG.md]
 * Exits 1 when the version has no section or its note is missing — a release
 * whose notes would be empty is a mistake worth stopping for, not a blank body
 * to publish.
 */

import { parseChangelogReleases } from '../src/core/changelog';

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: release-notes <version> [changelog-path]');
  process.exit(1);
}

const changelogPath = process.argv[3]
  ? new URL(process.argv[3], `file://${process.cwd()}/`)
  : new URL('../CHANGELOG.md', import.meta.url);

const releases = parseChangelogReleases(await Bun.file(changelogPath).text());
const release = releases.find((entry) => entry.version.replace(/^v/, '') === version);
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

// The build is unsigned and un-notarized (`mac.identity: null`), so first launch
// is blocked by Gatekeeper until the user right-clicks Open. Saying so here is
// not boilerplate: without it the download reads as broken.
console.log([
  release.note,
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
