import { Lexer } from 'marked';

export interface ChangelogRelease {
  /** The value inside the Keep a Changelog heading brackets. */
  version: string;
  /** Optional date suffix from `## [version] - date`. */
  date: string | null;
  /** Human-readable option label for a release picker. */
  label: string;
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
      label: current.date ? `${current.version} - ${current.date}` : current.version,
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
    if (token.type === 'heading' && token.depth === 3) insideCategories = true;
    if (!insideCategories) current.chunks.push(token.raw);
  }

  finishCurrentRelease();
  return releases;
}

/** Select the running app's release, falling back to the live Unreleased notes. */
export function resolveChangelogRelease(
  releases: readonly ChangelogRelease[],
  appVersion: string | null | undefined,
): ChangelogRelease | null {
  const expected = normalizedVersion(appVersion);
  if (expected) {
    const matching = releases.find((release) => normalizedVersion(release.version) === expected);
    if (matching) return matching;
  }
  return releases.find((release) => release.version.toLowerCase() === 'unreleased') ?? null;
}

/**
 * Where a release's full section lives, as a `blob/` path: the tag it shipped
 * under plus GitHub's own anchor for the version heading.
 *
 * Pinned to the tag rather than `main` so an old build's "full changelog" link
 * lands on the section as that build shipped it — on `main` the heading, its
 * date, and therefore its anchor keep moving. An unreleased dev build has no tag
 * to pin to, so it reads the live file.
 */
export function changelogSectionPath(release: ChangelogRelease): string {
  const isUnreleased = release.version.toLowerCase() === 'unreleased';
  const ref = isUnreleased ? 'main' : `v${normalizedVersion(release.version)}`;
  const heading = `[${release.version}]${release.date ? ` - ${release.date}` : ''}`;
  return `${ref}/CHANGELOG.md#${headingAnchor(heading)}`;
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

function normalizedVersion(version: string | null | undefined): string {
  return version?.trim().replace(/^v(?=\d)/i, '') ?? '';
}
