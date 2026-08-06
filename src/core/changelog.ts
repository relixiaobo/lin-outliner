import { Lexer } from 'marked';

export interface ChangelogRelease {
  /** The value inside the Keep a Changelog heading brackets. */
  version: string;
  /** Optional date suffix from `## [version] - date`. */
  date: string | null;
  /**
   * The release's user-register note: everything between the version heading and
   * its first category heading. Empty for a section written before the
   * convention, which callers must degrade around rather than substitute for.
   */
  note: string;
}

const RELEASE_HEADING = /^\[([^\]\r\n]+)\](?:\s+-\s+(.+))?$/;

/**
 * Extract each Keep a Changelog release's opening user note.
 *
 * One section serves two audiences at two altitudes. The note answers "what
 * changed for me"; the `### Added` … `### Internal` categories below it are the
 * engineering ledger, read on GitHub. Only the note is parsed out, so no amount
 * of category detail — Internal included — can reach a user surface by accident.
 *
 * ANY heading below the version heading ends the note, not `###` exactly. The
 * convention writes categories at depth 3, but a section that reaches for `####`
 * would otherwise leave `insideCategories` unset and pour the entire ledger into
 * the note — the pane rendering it inline and the release body publishing
 * Internal. A depth test that only holds while everyone follows the convention is
 * not the guarantee this doc comment claims.
 *
 * Tokenized rather than line-scanned so a `###` inside a fenced code block does
 * not read as the end of the note.
 */
export function parseChangelogReleases(source: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: {
    version: string;
    date: string | null;
    chunks: string[];
  } | null = null;
  let insideCategories = false;

  function finishCurrentRelease(): void {
    if (!current) return;
    releases.push({
      version: current.version,
      date: current.date,
      note: current.chunks.join('').trim(),
    });
  }

  for (const token of Lexer.lex(source)) {
    if (token.type === 'heading' && token.depth === 2) {
      finishCurrentRelease();
      const match = RELEASE_HEADING.exec(token.text.trim());
      current = match ? {
        version: match[1]!.trim(),
        date: match[2]?.trim() || null,
        chunks: [],
      } : null;
      insideCategories = false;
      continue;
    }

    if (!current) continue;
    if (token.type === 'heading' && token.depth < 2) {
      finishCurrentRelease();
      current = null;
      insideCategories = false;
      continue;
    }
    if (token.type === 'heading' && token.depth >= 3) insideCategories = true;
    if (!insideCategories) current.chunks.push(token.raw);
  }

  finishCurrentRelease();
  return releases;
}

/**
 * Select the release whose note this build should show.
 *
 * A section matching the running version wins, note or not — it is that build's
 * own record, and one written before the convention degrades to the changelog
 * link rather than borrowing an older release's words.
 *
 * A build running ahead of the last release — a dev build, or any build before
 * the next freeze — falls back to the HIGHEST-VERSIONED release that HAS a note.
 * By version, not by file position: newest-first ordering is a convention, and a
 * `0.1.1` hotfix section appended under `## [0.1.0]` would otherwise make every
 * such build show the older note and link to the older tag. `Unreleased` is never
 * it — its opening block is the maintainer bookkeeping naming the train `main` is
 * on, not a note; rendering it as one put "`main` is the `0.2.0` train; entries
 * here move under the next tag" in front of the user as their What's New.
 */
export function resolveChangelogRelease(
  releases: readonly ChangelogRelease[],
  appVersion: string | null | undefined,
): ChangelogRelease | null {
  const expected = normalizedVersion(appVersion);
  if (expected) {
    const matching = releases.find((release) => normalizedVersion(release.version) === expected);
    if (matching) return matching;
  }
  return releases
    .filter((release) => !isUnreleased(release) && release.note)
    .reduce<ChangelogRelease | null>(
      (highest, release) => (highest && compareVersions(release, highest) <= 0 ? highest : release),
      null,
    );
}

/** `Unreleased` is a heading, not a version — it never wins the comparison. */
function isUnreleased(release: ChangelogRelease): boolean {
  return release.version.trim().toLowerCase() === 'unreleased';
}

/**
 * Numeric dotted-segment order, longest run wins ties (`0.1.1` > `0.1`). A
 * segment that is not a number sorts below every one that is, so a malformed
 * heading loses rather than silently outranking a real release.
 */
function compareVersions(a: ChangelogRelease, b: ChangelogRelease): number {
  const left = versionSegments(a.version);
  const right = versionSegments(b.version);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionSegments(version: string): number[] {
  return normalizedVersion(version)
    .split('.')
    .map((segment) => {
      const parsed = Number.parseInt(segment, 10);
      return Number.isNaN(parsed) ? -1 : parsed;
    });
}

/**
 * Where a release's full section lives, as a `blob/` path: the tag it shipped
 * under plus GitHub's own anchor for the version heading.
 *
 * Pinned to the tag rather than `main` so an old build's "full changelog" link
 * lands on the section as that build shipped it — on `main` the heading, its
 * date, and therefore its anchor keep moving.
 *
 * Every release this can be called with is a real version: the pane never selects
 * `Unreleased`, and the release script refuses it. There is no `main` branch here
 * for that reason — one existed, unreachable, while the spec and this comment both
 * described a link neither surface could produce.
 *
 * The app cannot tell a published version from a frozen-but-untagged one: both
 * are a dated section whose version matches the running build. So between the
 * freeze commit and the tag push, an unpublished build links to a tag that does
 * not exist yet. That window belongs to whoever is cutting the release, never to
 * a user — every build a user has was published, so its tag resolves.
 */
export function changelogSectionPath(release: ChangelogRelease): string {
  const heading = `[${release.version}]${release.date ? ` - ${release.date}` : ''}`;
  return `v${normalizedVersion(release.version)}/CHANGELOG.md#${headingAnchor(heading)}`;
}

/**
 * GitHub's heading slug: lowercase, punctuation dropped, spaces hyphenated. So
 * `## [0.1.0] - 2026-08-06` anchors at `#010---2026-08-06`.
 */
function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]+/g, '')
    .replace(/ /g, '-');
}

/**
 * The one spelling rule for a version. Exported because `scripts/release-notes.ts`
 * looks the same section up from the tag name: two copies of this drifted once
 * already, and a `## [V0.1.0]` the pane resolved would fail the tag push with
 * "no section for 0.1.0".
 */
export function normalizedVersion(version: string | null | undefined): string {
  return version?.trim().replace(/^v(?=\d)/i, '') ?? '';
}
