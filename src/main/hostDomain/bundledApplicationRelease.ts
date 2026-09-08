import {
  APPLICATION_DESTINATIONS,
  APPLICATION_RELEASE_NOTE_MAX_LENGTH,
  type BundledApplicationRelease,
} from '../../core/applicationOperations';
import {
  changelogSectionPath,
  normalizedVersion,
  parseChangelogReleases,
  resolveChangelogRelease,
  type ChangelogRelease,
} from '../../core/changelog';

export function createBundledApplicationReleaseResolver(
  source: string,
): (appVersion: string | null | undefined) => BundledApplicationRelease | null {
  const releases = parseChangelogReleases(source);
  return (appVersion) => bundledApplicationRelease(releases, appVersion);
}

function bundledApplicationRelease(
  releases: readonly ChangelogRelease[],
  appVersion: string | null | undefined,
): BundledApplicationRelease | null {
  const release = resolveChangelogRelease(releases, appVersion);
  if (!release) return null;
  const version = normalizedVersion(release.version);
  const changelogUrl = `${APPLICATION_DESTINATIONS.help}/blob/${changelogSectionPath(release)}`;
  if (!version || version.length > 128 || (release.date?.length ?? 0) > 128 || changelogUrl.length > 2_048) return null;
  return {
    version,
    date: release.date,
    note: release.note.slice(0, APPLICATION_RELEASE_NOTE_MAX_LENGTH),
    noteTruncated: release.note.length > APPLICATION_RELEASE_NOTE_MAX_LENGTH,
    changelogUrl,
  };
}
