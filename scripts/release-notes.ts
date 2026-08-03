#!/usr/bin/env bun
/**
 * release-notes — lifts one version's section out of CHANGELOG.md.
 *
 * The release body is the changelog section, not a second hand-written summary:
 * two descriptions of one release drift, and the one nobody edits is the one
 * users read. This reads the file that already has to be right.
 *
 * Usage: bun scripts/release-notes.ts 0.1.0
 * Exits 1 when the version has no section — a release whose notes would be empty
 * is a mistake worth stopping for, not a blank body to publish.
 */

const version = process.argv[2]?.replace(/^v/, '');
if (!version) {
  console.error('usage: release-notes <version>');
  process.exit(1);
}

const lines = (await Bun.file(new URL('../CHANGELOG.md', import.meta.url)).text()).split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}. Add it before tagging.`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## ['));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (!body) {
  console.error(`The ${version} section is empty.`);
  process.exit(1);
}

// The build is unsigned and un-notarized (`mac.identity: null`), so first launch
// is blocked by Gatekeeper until the user right-clicks Open. Saying so here is
// not boilerplate: without it the download reads as broken.
console.log([
  body,
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
