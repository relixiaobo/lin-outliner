import { Lexer } from 'marked';

export interface ChangelogRelease {
  /** The value inside the Keep a Changelog heading brackets. */
  version: string;
  /** Optional date suffix from `## [version] - date`. */
  date: string | null;
  /** Human-readable option label for a release picker. */
  label: string;
  /** This release's Markdown body, with its Internal section removed. */
  markdown: string;
}

const RELEASE_HEADING = /^\[([^\]\r\n]+)\](?:\s+-\s+(.+))?$/;

/**
 * Extract Keep a Changelog release sections without treating headings inside
 * code blocks as structure. Internal is intentionally absent from the returned
 * Markdown because those notes describe implementation work, not product changes.
 */
export function parseChangelogReleases(source: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: {
    version: string;
    date: string | null;
    chunks: string[];
  } | null = null;
  let insideInternalSection = false;

  function finishCurrentRelease(): void {
    if (!current) return;
    releases.push({
      version: current.version,
      date: current.date,
      label: current.date ? `${current.version} - ${current.date}` : current.version,
      markdown: current.chunks.join('').trim(),
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
      insideInternalSection = false;
      continue;
    }

    if (!current) continue;
    if (token.type === 'heading' && token.depth < 2) {
      finishCurrentRelease();
      current = null;
      insideInternalSection = false;
      continue;
    }
    if (token.type === 'heading' && token.depth === 3) {
      insideInternalSection = token.text.trim().toLowerCase() === 'internal';
    }
    if (!insideInternalSection) current.chunks.push(token.raw);
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

function normalizedVersion(version: string | null | undefined): string {
  return version?.trim().replace(/^v(?=\d)/i, '') ?? '';
}
