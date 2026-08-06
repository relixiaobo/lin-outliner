/// <reference types="vite/client" />

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  parseChangelogReleases,
  resolveChangelogRelease,
  type ChangelogRelease,
} from '../../../core/changelog';
import { serializeUnknownError, type AppInfo } from '../../../core/errorObservability';
import { api } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { SelectControl } from '../primitives/SelectControl';
import { ICON_SIZE, OpenIcon } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';

const HELP_URL = 'https://github.com/relixiaobo/lin-outliner';
const ISSUES_URL = 'https://github.com/relixiaobo/lin-outliner/issues';

interface SettingsAboutSectionProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  loadChangelog?: () => Promise<string>;
}

const RELEASE_NOTES_REMARK_PLUGINS = [remarkGfm];

async function loadBundledChangelog(): Promise<string> {
  const module = await import('../../../../CHANGELOG.md?raw');
  return module.default;
}

function ReleaseNotesLink({ children, href, ...props }: ComponentPropsWithoutRef<'a'>) {
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

const RELEASE_NOTES_COMPONENTS = { a: ReleaseNotesLink };

/**
 * About: what this is, what changed, and how to reach us.
 *
 * The native About panel is not a second home for this — the menu item opens
 * this page instead. Two About surfaces would be the duplication this redesign
 * exists to remove, and the OS panel cannot hold release notes or support links.
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
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [releaseNotesExpanded, setReleaseNotesExpanded] = useState(false);

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

  const selectedRelease = releases.find((release) => release.version === selectedVersion)
    ?? resolveChangelogRelease(releases, info?.version);
  const selectedReleaseLabel = selectedRelease?.version.toLowerCase() === 'unreleased' && info
    ? t.settings.about.developmentReleaseLabel({ version: info.version })
    : selectedRelease?.label;

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

      {selectedRelease ? (
        <InsetGroup ariaLabel={t.settings.about.whatsNewGroup} id="whats-new" label={t.settings.about.whatsNewGroup}>
          {releases.length > 1 ? (
            <InsetRow
              label={t.settings.about.releaseLabel}
              trailing={(
                <SelectControl
                  label={t.settings.about.releasePickerLabel}
                  onChange={(event) => {
                    setSelectedVersion(event.currentTarget.value);
                    setReleaseNotesExpanded(false);
                  }}
                  value={selectedRelease.version}
                  variant="popup"
                >
                  {releases.map((release) => (
                    <option key={release.version} value={release.version}>
                      {release.version.toLowerCase() === 'unreleased' && info
                        ? t.settings.about.developmentReleaseLabel({ version: info.version })
                        : release.label}
                    </option>
                  ))}
                </SelectControl>
              )}
            />
          ) : null}
          <InsetRow
            ariaControls="settings-about-release-notes"
            disclosure={releaseNotesExpanded ? 'expanded' : 'collapsed'}
            label={t.settings.about.releaseNotesLabel}
            onSelect={() => setReleaseNotesExpanded((expanded) => !expanded)}
            sublabel={selectedReleaseLabel}
          />
          {releaseNotesExpanded ? (
            <div className="settings-about-release-notes-row" role="listitem">
              <div
                aria-label={t.settings.about.releaseNotesAriaLabel({ version: selectedReleaseLabel ?? selectedRelease.version })}
                className="file-preview-markdown settings-about-release-notes"
                id="settings-about-release-notes"
                role="region"
                tabIndex={0}
              >
                <Markdown
                  components={RELEASE_NOTES_COMPONENTS}
                  remarkPlugins={RELEASE_NOTES_REMARK_PLUGINS}
                  skipHtml
                >
                  {selectedRelease.markdown}
                </Markdown>
              </div>
            </div>
          ) : null}
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
