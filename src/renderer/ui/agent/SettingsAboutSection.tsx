import { useEffect, useState } from 'react';
import type { AppInfo } from '../../../core/errorObservability';
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
}

/**
 * About: what this is, what changed, and how to reach us.
 *
 * The native About panel is not a second home for this — the menu item opens
 * this page instead. Two About surfaces would be the duplication this redesign
 * exists to remove, and the OS panel cannot hold release notes or support links.
 *
 * What's new is not here yet. It reads the per-version CHANGELOG section that
 * #480's extractor produces, minus the Internal category — one source of truth,
 * two renderings. Writing a second, hand-authored notes file to fill the gap in
 * the meantime is precisely what that PR argued against.
 *
 * Slots the product has not filled — a contact channel beyond the two GitHub
 * links, the one-paragraph description — are omitted rather than stubbed. An
 * empty row that says nothing is worse than a page that does not claim to.
 */
export function SettingsAboutSection({ onError, onNotice }: SettingsAboutSectionProps) {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    let active = true;
    void window.lin?.appInfo?.()
      .then((next) => { if (active) setInfo(next); })
      .catch(() => { /* the version row simply does not render */ });
    return () => { active = false; };
  }, []);

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
      onError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="agent-settings-section" aria-label={t.settings.about.sectionAriaLabel}>
      <InsetGroup ariaLabel={t.settings.about.sectionAriaLabel} id="version">
        <InsetRow
          label={info?.name ?? ''}
          sublabel={info ? `${t.settings.about.version} ${info.version}` : undefined}
          trailing={info ? (
            <Button onClick={() => void copyVersionInfo()} variant="secondary">
              {t.settings.about.copyVersionInfo}
            </Button>
          ) : undefined}
          wrap
        />
      </InsetGroup>

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
          label={t.settings.about.acknowledgements}
          onSelect={() => void api.openExternalUrl(`${HELP_URL}/blob/main/README.md`)}
          trailing={<OpenIcon size={ICON_SIZE.tiny} aria-hidden="true" />}
        />
      </InsetGroup>
    </section>
  );
}
