import { useEffect, useMemo, useState } from 'react';
import type { ThemeMode } from '../../../core/theme';
import { APP_NAME } from '../../../core/brand';
import { formatHotkey } from '../../../core/launcher/commands';
import { SUPPORTED_LOCALES, type Locale } from '../../../core/locale';
import { useI18n } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { SegmentedControl } from '../primitives/SegmentedControl';
import { SelectControl } from '../primitives/SelectControl';
import type { SettingsPageTarget } from '../../../core/settingsWindow';
import { InsetGroup, InsetRow } from './SettingsInsetList';

// Theme segment values; their visible labels are localized at render
// (settings.general.theme*).
const THEME_VALUES: readonly ThemeMode[] = ['system', 'light', 'dark'];

interface SettingsGeneralSectionProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
  onOpenPage: (page: SettingsPageTarget) => void;
  updateAvailable?: boolean;
}

/**
 * The General category. Everything here applies immediately and persists on its
 * own — theme, language, the data groups, diagnostics — so this
 * category has no draft and never participates in the footer Save. That is why
 * all of its state is local to this component and only the shared error/notice
 * surface is passed down.
 */
export function SettingsGeneralSection({
  onError,
  onNotice,
  onOpenPage,
  updateAvailable = false,
}: SettingsGeneralSectionProps) {
  // App-level appearance preference. Independent of the provider/capability save
  // flow: it applies immediately across all windows via the main process
  // (nativeTheme.themeSource) and persists, so there is no Save step.
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<null | 'reveal' | 'export'>(null);
  // The accelerator the global launcher registered under. `null` means no
  // candidate was free — the launcher is then unreachable, which is exactly the
  // fact this row exists to surface. Undefined while the read is in flight.
  const [launcherHotkey, setLauncherHotkey] = useState<string | null | undefined>(undefined);
  // Display language: the picker reads/writes the shared i18n context (seeded before
  // first paint, broadcast across windows), so it applies instantly like the theme.
  const { locale, t, setLocale } = useI18n();

  const themeOptions = useMemo(() => {
    const g = t.settings.general;
    const labels: Record<ThemeMode, string> = { system: g.themeSystem, light: g.themeLight, dark: g.themeDark };
    return THEME_VALUES.map((value) => ({ value, label: labels[value] }));
  }, [t]);

  // Load the current appearance preference once so the segmented control reflects
  // the active theme. Best-effort: if the bridge is unavailable (e.g. a non-Electron
  // dev host) the control stays on its 'system' default.
  useEffect(() => {
    let active = true;
    void window.lin?.getTheme?.()
      .then((mode) => {
        if (active) setThemeMode(mode);
      })
      .catch(() => { /* keep the default */ });
    return () => { active = false; };
  }, []);

  // The launcher's registered accelerator. A failed or absent bridge resolves to
  // `null` — the same "no keystroke to show" state as a failed registration —
  // rather than staying `undefined` forever, which would leave the row claiming
  // the launcher has a shortcut while showing none: the exact silent failure
  // this row exists to eliminate.
  useEffect(() => {
    let active = true;
    const read = window.lin?.getLauncherHotkey?.();
    if (!read) {
      setLauncherHotkey(null);
      return;
    }
    void read
      .then((accelerator) => {
        if (active) setLauncherHotkey(accelerator);
      })
      .catch(() => {
        if (active) setLauncherHotkey(null);
      });
    return () => { active = false; };
  }, []);

  // Apply a theme pick optimistically (instant, no Save) and persist it via main.
  function changeTheme(mode: ThemeMode) {
    setThemeMode(mode);
    void window.lin?.setTheme?.(mode);
  }

  async function revealDiagnosticsLog() {
    setDiagnosticsBusy('reveal');
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.revealDiagnosticsLog?.();
      if (!result) {
        onError(t.settings.general.diagnosticsUnavailable);
      } else if (!result.ok) {
        onError(result.error ?? t.settings.general.diagnosticsRevealFailed);
      } else {
        onNotice(t.settings.general.diagnosticsRevealedNotice);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  async function exportDiagnostics() {
    setDiagnosticsBusy('export');
    onError(null);
    onNotice(null);
    try {
      const result = await window.lin?.exportDiagnostics?.();
      if (!result) {
        onError(t.settings.general.diagnosticsUnavailable);
      } else if (result.canceled) {
        return;
      } else if (!result.ok) {
        onError(result.error ?? t.settings.general.diagnosticsExportFailed);
      } else {
        onNotice(t.settings.general.diagnosticsExportedNotice);
      }
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiagnosticsBusy(null);
    }
  }

  return (
    <section className="agent-settings-section settings-general-section" aria-label={t.settings.categories.general.label}>
      <InsetGroup ariaLabel={t.settings.general.appearanceGroup} label={t.settings.general.appearanceGroup}>
        <InsetRow
          label={t.settings.general.themeLabel}
          sublabel={t.settings.general.themeSublabel}
          trailing={(
            <SegmentedControl
              label={t.settings.general.themeLabel}
              onChange={changeTheme}
              options={themeOptions}
              value={themeMode}
            />
          )}
          wrap
        />
        <InsetRow
          label={t.settings.general.languageLabel}
          sublabel={t.settings.general.languageSublabel}
          trailing={(
            <SelectControl
              label={t.settings.general.languageLabel}
              onChange={(event) => setLocale(event.target.value as Locale)}
              value={locale}
              variant="popup"
            >
              {SUPPORTED_LOCALES.map((entry) => (
                <option key={entry.code} value={entry.code}>{entry.nativeName}</option>
              ))}
            </SelectControl>
          )}
          wrap
        />
      </InsetGroup>
      <InsetGroup ariaLabel={t.settings.general.shortcutsGroup} label={t.settings.general.shortcutsGroup}>
        {/* Read-only: main registers the first free candidate accelerator. When
            none was free the launcher is unreachable, so the row says so — as
            quiet secondary copy in the sublabel, not a red banner: it is
            informational, not destructive. */}
        <InsetRow
          label={t.settings.general.launcherHotkeyLabel}
          sublabel={launcherHotkey === null
            ? t.settings.general.launcherHotkeyUnavailable({ app: APP_NAME })
            : t.settings.general.launcherHotkeySublabel}
          trailing={launcherHotkey
            ? <span className="inset-row-value">{formatHotkey(launcherHotkey)}</span>
            : undefined}
          wrap
        />
      </InsetGroup>
      <InsetGroup
        ariaLabel={t.settings.general.diagnosticsGroup}
        label={t.settings.general.diagnosticsGroup}
      >
        <InsetRow
          label={t.settings.general.revealDiagnosticsLabel}
          sublabel={t.settings.general.revealDiagnosticsSublabel}
          trailing={(
            <Button
              disabled={diagnosticsBusy !== null}
              onClick={() => void revealDiagnosticsLog()}
              variant="secondary"
            >
              {diagnosticsBusy === 'reveal' ? t.settings.general.diagnosticsWorking : t.settings.general.revealDiagnosticsAction}
            </Button>
          )}
          wrap
        />
        <InsetRow
          label={t.settings.general.exportDiagnosticsLabel}
          sublabel={t.settings.general.exportDiagnosticsSublabel}
          trailing={(
            <Button
              disabled={diagnosticsBusy !== null}
              onClick={() => void exportDiagnostics()}
              variant="secondary"
            >
              {diagnosticsBusy === 'export' ? t.settings.general.diagnosticsWorking : t.settings.general.exportDiagnosticsAction}
            </Button>
          )}
          wrap
        />
      </InsetGroup>
      <InsetGroup ariaLabel={t.settings.about.sectionAriaLabel} id="about">
        <InsetRow
          drillsDown
          label={t.settings.about.rowLabel}
          onSelect={() => onOpenPage('about')}
          reserveStatusIndicator
          statusIndicatorLabel={updateAvailable ? t.settings.about.updateAvailableIndicator : undefined}
        />
      </InsetGroup>
    </section>
  );
}
