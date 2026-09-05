/// <reference types="vite/client" />

import { useEffect, useState, type ComponentPropsWithoutRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  changelogSectionPath,
  normalizedVersion,
  parseChangelogReleases,
  resolveChangelogRelease,
  type ChangelogRelease,
} from '../../../core/changelog';
import type { AppUpdateErrorCode, AppUpdateView } from '../../../core/appUpdate';
import { serializeUnknownError, type AppInfo } from '../../../core/errorObservability';
import { api } from '../../api/client';
import { useI18n } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ICON_SIZE, OpenInBrowserIcon } from '../icons';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';

const HELP_URL = 'https://github.com/relixiaobo/lin-outliner';
const ISSUES_URL = 'https://github.com/relixiaobo/lin-outliner/issues';

interface SettingsAboutSectionProps {
  appUpdate?: AppUpdateView | null;
  onAppUpdateChange?: (view: AppUpdateView) => void;
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

function ReleaseNoteImage({ alt }: ComponentPropsWithoutRef<'img'>) {
  return alt ? <span>{alt}</span> : null;
}

const RELEASE_NOTE_COMPONENTS = { a: ReleaseNoteLink, img: ReleaseNoteImage };

function ReleaseNote({ note }: { note: string }) {
  return (
    <div className="settings-about-release-note-row" role="listitem">
      <div className="file-preview-markdown settings-about-release-note">
        <Markdown
          components={RELEASE_NOTE_COMPONENTS}
          remarkPlugins={RELEASE_NOTE_REMARK_PLUGINS}
          skipHtml
        >
          {note}
        </Markdown>
      </div>
    </div>
  );
}

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
 * Nothing here can select that section any more — a build ahead of the last
 * release shows the newest release that has a note.
 *
 * Slots the product has not filled — a contact channel beyond the two GitHub
 * links, the one-paragraph description — are omitted rather than stubbed. An
 * empty row that says nothing is worse than a page that does not claim to.
 */
export function SettingsAboutSection({
  appUpdate = null,
  onAppUpdateChange = () => undefined,
  onError,
  onNotice,
  loadChangelog = loadBundledChangelog,
}: SettingsAboutSectionProps) {
  const { locale, t } = useI18n();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [releases, setReleases] = useState<readonly ChangelogRelease[]>([]);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);

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
  // The heading names the release whose note is shown. For anyone running a
  // published build that is their own version; on a build ahead of the last
  // release the two differ, and naming the release is the honest reading —
  // the identity group directly above states what is installed.
  const releaseVersion = release ? normalizedVersion(release.version) : '';
  const whatsNewLabel = releaseVersion
    ? t.settings.about.whatsNewInVersion({ version: releaseVersion })
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

  async function checkForUpdates(): Promise<void> {
    setUpdateActionError(null);
    try {
      const next = await window.lin?.appUpdate?.check();
      if (!next) throw new Error('App update bridge unavailable.');
      if (next.manualError) {
        setUpdateActionError(updateErrorMessage(next.manualError, t.settings.about));
      }
      onAppUpdateChange({ ...next, manualError: null });
    } catch {
      setUpdateActionError(t.settings.about.updateCheckFailed);
    }
  }

  async function setAutomaticChecksEnabled(enabled: boolean): Promise<void> {
    if (!appUpdate) return;
    setUpdateActionError(null);
    onAppUpdateChange({ ...appUpdate, automaticChecksEnabled: enabled });
    try {
      const next = await window.lin?.appUpdate?.setAutomaticChecksEnabled(enabled);
      if (!next) throw new Error('App update bridge unavailable.');
      onAppUpdateChange(next);
    } catch {
      onAppUpdateChange(appUpdate);
      setUpdateActionError(t.settings.about.updatePreferenceFailed);
    }
  }

  async function openAvailableUpdate(): Promise<void> {
    setUpdateActionError(null);
    try {
      const result = await window.lin?.appUpdate?.open();
      if (!result?.ok) setUpdateActionError(t.settings.about.updateOpenFailed);
    } catch {
      setUpdateActionError(t.settings.about.updateOpenFailed);
    }
  }

  const availableUpdate = appUpdate?.availableRelease ?? null;
  const hasSuccessfulCheck = appUpdate?.lastSuccessfulCheckAt !== null
    && appUpdate?.lastSuccessfulCheckAt !== undefined;
  const lastChecked = appUpdate?.lastSuccessfulCheckAt !== null && appUpdate?.lastSuccessfulCheckAt !== undefined
    ? t.settings.about.updateLastChecked({
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
          .format(new Date(appUpdate.lastSuccessfulCheckAt)),
      })
    : t.settings.about.updateNeverChecked;
  const updateStatusLabel = appUpdate?.phase === 'checking'
    ? t.settings.about.updateChecking
    : availableUpdate
      ? t.settings.about.updateAvailable({ version: availableUpdate.version })
      : hasSuccessfulCheck
        ? t.settings.about.updateCurrent
        : appUpdate?.automaticChecksEnabled
          ? t.settings.about.updateNotChecked
          : t.settings.about.updateAutomaticOff;
  const updateStatusSublabel = availableUpdate
    ? t.settings.about.updateReleased({
        date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
          .format(new Date(availableUpdate.publishedAt)),
      })
    : t.settings.about.updateInstalledVersion({ version: appUpdate?.currentVersion ?? info?.version ?? '' });

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

      {appUpdate ? (
        <InsetGroup ariaLabel={t.settings.about.updateGroup} id="software-update" label={t.settings.about.updateGroup}>
          <InsetRow
            label={updateStatusLabel}
            sublabel={updateStatusSublabel}
            trailing={availableUpdate ? (
              <Button onClick={() => void openAvailableUpdate()} variant="secondary">
                {availableUpdate.downloadAvailable
                  ? t.settings.about.updateDownloadAction
                  : t.settings.about.updateViewReleaseAction}
              </Button>
            ) : undefined}
            wrap
          />
          {availableUpdate?.note ? (
            <ReleaseNote note={availableUpdate.note} />
          ) : null}
          <InsetRow
            feedback={updateActionError
              ? <div className="settings-update-error" role="alert">{updateActionError}</div>
              : undefined}
            label={t.settings.about.updateCheckLabel}
            sublabel={lastChecked}
            trailing={(
              <Button
                disabled={appUpdate.phase === 'checking'}
                onClick={() => void checkForUpdates()}
                variant="secondary"
              >
                {appUpdate.phase === 'checking'
                  ? t.settings.about.updateCheckingAction
                  : t.settings.about.updateCheckAction}
              </Button>
            )}
            wrap
          />
          <InsetRow
            label={t.settings.about.updateAutomaticLabel}
            sublabel={t.settings.about.updateAutomaticSublabel}
            trailing={(
              <SwitchControl
                checked={appUpdate.automaticChecksEnabled}
                label={t.settings.about.updateAutomaticLabel}
                onCheckedChange={(enabled) => void setAutomaticChecksEnabled(enabled)}
              >
                <SwitchMark checked={appUpdate.automaticChecksEnabled} />
              </SwitchControl>
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
            <ReleaseNote note={release.note} />
          ) : null}
          <InsetRow
            label={t.settings.about.fullChangelogAction}
            onSelect={() => void api.openExternalUrl(`${HELP_URL}/blob/${changelogSectionPath(release)}`)}
            trailing={<OpenInBrowserIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
          />
        </InsetGroup>
      ) : null}

      <InsetGroup ariaLabel={t.settings.about.supportGroup} id="support" label={t.settings.about.supportGroup}>
        <InsetRow
          label={t.settings.about.helpAction}
          onSelect={() => void api.openExternalUrl(HELP_URL)}
          trailing={<OpenInBrowserIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
        <InsetRow
          label={t.settings.about.reportIssueAction}
          onSelect={() => void api.openExternalUrl(ISSUES_URL)}
          trailing={<OpenInBrowserIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
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
          trailing={<OpenInBrowserIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
      </InsetGroup>
    </section>
  );
}

function updateErrorMessage(
  code: AppUpdateErrorCode,
  messages: {
    updateCheckFailed: string;
    updateCheckTimedOut: string;
    updateResponseInvalid: string;
  },
): string {
  if (code === 'timeout') return messages.updateCheckTimedOut;
  if (code === 'invalid-response') return messages.updateResponseInvalid;
  return messages.updateCheckFailed;
}
