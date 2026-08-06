/// <reference types="vite/client" />

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  changelogSectionPath,
  parseChangelogReleases,
  resolveChangelogRelease,
  type ChangelogRelease,
} from '../../../core/changelog';
import { serializeUnknownError, type AppInfo } from '../../../core/errorObservability';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ICON_SIZE, OpenIcon } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';

const HELP_URL = 'https://github.com/relixiaobo/lin-outliner';
const ISSUES_URL = 'https://github.com/relixiaobo/lin-outliner/issues';

interface SettingsAboutSectionProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  loadChangelog?: () => Promise<string>;
}

const RELEASE_NOTE_REMARK_PLUGINS = [remarkGfm];

async function loadBundledChangelog(): Promise<string> {
  const module = await import('../../../../CHANGELOG.md?raw');
  return module.default;
}

function ReleaseNoteLink({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void api.openExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const RELEASE_NOTE_COMPONENTS = { a: ReleaseNoteLink };

/**
 * About: what this is, what changed, and how to reach us.
 *
 * The native About panel is not a second home for this — the menu item opens
 * this page instead. Two About surfaces would be the duplication this redesign
 * exists to remove, and the OS panel cannot hold release notes or support links.
 *
 * What's New shows the running version's user note and nothing else. The
 * changelog's `### Added` … `### Internal` categories are an engineering ledger —
 * hundreds of entries per release, most about work no user experiences — so they
 * stay on GitHub behind one link rather than being rendered here, collapsed or
 * not. There is no version picker either: browsing other releases' notes is a
 * maintainer's errand, and the control existed mainly to surface `Unreleased`,
 * which is the repo's word for itself and meant nothing to the person reading it.
 *
 * Slots the product has not filled — a contact channel beyond the two GitHub
 * links, the one-paragraph description — are omitted rather than stubbed. An
 * empty row that says nothing is worse than a page that does not claim to.
 */
export function SettingsAboutSection({
  onError,
  onNotice,
  loadChangelog = loadBundledChangelog,
}: SettingsAboutSectionProps) {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [releases, setReleases] = useState<readonly ChangelogRelease[]>([]);

  useEffect(() => {
    let active = true;
    void window.lin?.appInfo?.()
      .then((next) => { if (active) setInfo(next); })
      .catch(() => { /* the version row simply does not render */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void loadChangelog()
      .then((source) => {
        if (active) setReleases(parseChangelogReleases(source));
      })
      .catch(() => {
        if (active) onError(t.settings.about.releaseNotesUnavailable);
      });
    return () => { active = false; };
  }, [loadChangelog, onError, t.settings.about.releaseNotesUnavailable]);

  const release = resolveChangelogRelease(releases, info?.version);
  // The heading names the version the person is running, never the changelog's
  // own bookkeeping for it. `Unreleased` and "development train" are how the repo
  // talks to itself: what a user has is 0.2.0, and this is what is new in it.
  // Without app info there is no version to name, so the heading simply does not
  // claim one.
  const whatsNewLabel = info
    ? t.settings.about.whatsNewInVersion({ version: info.version })
    : t.settings.about.whatsNewGroup;

  // The triple a bug report needs, in the order a person reads it back.
  async function copyVersionInfo(): Promise<void> {
    if (!info) return;
    onError(null);
    onNotice(null);
    const text = [
      `${info.name} ${info.version}`,
      `${info.platform} ${info.arch}`,
      `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onNotice(t.settings.about.copiedNotice);
    } catch (caught) {
      window.lin?.reportRendererError?.({
        domain: 'persistence',
        severity: 'error',
        code: 'settings-about-copy-version-failed',
        message: 'Failed to copy app version information.',
        error: serializeUnknownError(caught),
      });
      onError(t.settings.about.copyFailed);
    }
  }

  return (
    <section className="agent-settings-section" aria-label={t.settings.about.sectionAriaLabel}>
      {info ? (
        <InsetGroup ariaLabel={t.settings.about.sectionAriaLabel} id="version">
          <InsetRow
            label={info.name}
            sublabel={`${t.settings.about.version} ${info.version}`}
            trailing={(
              <Button onClick={() => void copyVersionInfo()} variant="secondary">
                {t.settings.about.copyVersionInfo}
              </Button>
            )}
            wrap
          />
        </InsetGroup>
      ) : null}

      {release ? (
        <InsetGroup ariaLabel={whatsNewLabel} id="whats-new" label={whatsNewLabel}>
          {/* A section written before the note convention degrades to the link
              alone — better an honest pointer than a dump of category detail. */}
          {release.note ? (
            <div className="settings-about-release-note-row" role="listitem">
              <div className="file-preview-markdown settings-about-release-note">
                <Markdown
                  components={RELEASE_NOTE_COMPONENTS}
                  remarkPlugins={RELEASE_NOTE_REMARK_PLUGINS}
                  skipHtml
                >
                  {release.note}
                </Markdown>
              </div>
            </div>
          ) : null}
          <InsetRow
            label={t.settings.about.fullChangelogAction}
            onSelect={() => void api.openExternalUrl(`${HELP_URL}/blob/${changelogSectionPath(release)}`)}
            trailing={<OpenIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
          />
        </InsetGroup>
      ) : null}

      <InsetGroup ariaLabel={t.settings.about.supportGroup} id="support" label={t.settings.about.supportGroup}>
        <InsetRow
          label={t.settings.about.helpAction}
          onSelect={() => void api.openExternalUrl(HELP_URL)}
          trailing={<OpenIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
        <InsetRow
          label={t.settings.about.reportIssueAction}
          onSelect={() => void api.openExternalUrl(ISSUES_URL)}
          trailing={<OpenIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.about.legalGroup}
        footnote={t.settings.about.privacyNote}
        id="legal"
        label={t.settings.about.legalGroup}
      >
        <InsetRow
          label={t.settings.about.license}
          onSelect={() => void api.openExternalUrl(`${HELP_URL}/blob/main/LICENSE`)}
          trailing={<OpenIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
      </InsetGroup>
    </section>
  );
}
