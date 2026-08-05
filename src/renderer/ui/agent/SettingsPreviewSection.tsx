import { useEffect, useRef, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { TRANSLATION_LANGUAGES } from '../../../core/translationLanguage';
import type { TranslationLanguage } from '../../../core/translationLanguage';
import { useT } from '../../i18n/I18nProvider';
import { SelectControl } from '../primitives/SelectControl';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { InsetGroup, InsetRow } from './SettingsInsetList';
import { DataMaintenanceRow } from './DataMaintenanceRow';
import {
  setTranslationLanguagePreference,
  useTranslationLanguagePreference,
} from '../preview/translationLanguagePreference';
import {
  setAutoTranslateEpubs,
  setAutoTranslateUrls,
  setTranslationModel,
  useUrlPageTranslationPreferences,
} from '../preview/urlPageTranslationPreferences';
import {
  translationModelGroups,
  translationModelName,
  translationProviderName,
} from '../preview/translationModelChoices';
import { reportPreviewPreferenceWriteError } from '../preview/previewPreferenceErrors';
import { beginKeyedMutation, isCurrentKeyedMutation } from '../keyedMutationGeneration';

interface SettingsPreviewSectionProps {
  onError: (message: string | null) => void;
  onNotice: (message: string | null) => void;
}

/**
 * The Preview category: what the panes that render webpages, books, and files do
 * on your behalf, and the data they accumulate.
 *
 * The four translation preferences here are not copies — they are the same
 * store the Languages popover writes, which already broadcasts across windows.
 * Before this pane they existed only in that popover, so Settings offered a
 * button to clear translations it never let you configure. The popover stays,
 * because acting in context is right; what changes is that the preferences now
 * have a home you can find without a page open.
 *
 * Named Preview rather than Reading because that is the word the app already
 * ships — including in this pane's own website-data copy.
 */
export function SettingsPreviewSection({ onError, onNotice }: SettingsPreviewSectionProps) {
  const t = useT();
  const { language } = useTranslationLanguagePreference();
  const preferences = useUrlPageTranslationPreferences();
  // Only to build the model menu. Read-only and best-effort: a menu that cannot
  // be built falls back to "Agent model", which is also the default.
  const [providerSettings, setProviderSettings] = useState<AgentProviderSettingsView | null>(null);
  const [preferenceErrors, setPreferenceErrors] = useState<Map<string, string>>(new Map());
  const preferenceMutationGenerationsRef = useRef(new Map<string, number>());
  const autoTranslateUrlsIntentRef = useRef(preferences.autoTranslateUrls);
  const autoTranslateEpubsIntentRef = useRef(preferences.autoTranslateEpubs);
  autoTranslateUrlsIntentRef.current = preferences.autoTranslateUrls;
  autoTranslateEpubsIntentRef.current = preferences.autoTranslateEpubs;

  useEffect(() => {
    let active = true;
    void api.agentGetProviderSettings()
      .then((next) => { if (active) setProviderSettings(next); })
      .catch(() => { /* the menu degrades to the default */ });
    return () => { active = false; };
  }, []);

  const modelGroups = translationModelGroups(providerSettings);
  const model = preferences.translationModel;
  const modelsLoaded = providerSettings !== null;
  const modelAvailable = modelGroups.some((group) => group.models.some((entry) => entry.value === model));

  function persistPreference(preference: string, action: () => Promise<void>): void {
    const generation = beginKeyedMutation(preferenceMutationGenerationsRef.current, preference);
    onError(null);
    setPreferenceErrors((current) => withoutMapKey(current, preference));
    void action().catch((error) => {
      reportPreviewPreferenceWriteError(preference, error);
      if (!isCurrentKeyedMutation(
        preferenceMutationGenerationsRef.current,
        preference,
        generation,
      )) return;
      setPreferenceErrors((current) => withMapValue(
        current,
        preference,
        t.shell.filePreview.preferenceSaveFailed,
      ));
    });
  }

  return (
    <section className="agent-settings-section" aria-label={t.settings.preview.sectionAriaLabel}>
      <InsetGroup
        ariaLabel={t.settings.preview.translationAriaLabel}
        id="translation"
        label={t.settings.preview.translationGroup}
      >
        <InsetRow
          feedback={preferenceErrors.get('translation-language') ? (
            <span role="alert">{preferenceErrors.get('translation-language')}</span>
          ) : undefined}
          label={t.settings.preview.targetLanguageLabel}
          sublabel={t.settings.preview.targetLanguageSublabel}
          trailing={(
            <SelectControl
              label={t.settings.preview.targetLanguageLabel}
              onChange={(event) => persistPreference(
                'translation-language',
                () => setTranslationLanguagePreference(event.target.value as TranslationLanguage),
              )}
              value={language}
              variant="popup"
            >
              {TRANSLATION_LANGUAGES.map((entry) => (
                <option key={entry.code} value={entry.code}>{entry.nativeName}</option>
              ))}
            </SelectControl>
          )}
          wrap
        />
        <InsetRow
          feedback={preferenceErrors.get('auto-translate-urls') ? (
            <span role="alert">{preferenceErrors.get('auto-translate-urls')}</span>
          ) : undefined}
          label={t.settings.preview.autoTranslateUrlsLabel}
          sublabel={t.settings.preview.autoTranslateUrlsSublabel}
          trailing={(
            <SwitchControl
              checked={preferences.autoTranslateUrls}
              label={t.settings.preview.autoTranslateUrlsLabel}
              onCheckedChange={() => {
                const enabled = !autoTranslateUrlsIntentRef.current;
                autoTranslateUrlsIntentRef.current = enabled;
                persistPreference('auto-translate-urls', () => setAutoTranslateUrls(enabled));
              }}
            >
              <SwitchMark checked={preferences.autoTranslateUrls} />
            </SwitchControl>
          )}
          wrap
        />
        <InsetRow
          feedback={preferenceErrors.get('auto-translate-epubs') ? (
            <span role="alert">{preferenceErrors.get('auto-translate-epubs')}</span>
          ) : undefined}
          label={t.settings.preview.autoTranslateEpubsLabel}
          sublabel={t.settings.preview.autoTranslateEpubsSublabel}
          trailing={(
            <SwitchControl
              checked={preferences.autoTranslateEpubs}
              label={t.settings.preview.autoTranslateEpubsLabel}
              onCheckedChange={() => {
                const enabled = !autoTranslateEpubsIntentRef.current;
                autoTranslateEpubsIntentRef.current = enabled;
                persistPreference('auto-translate-epubs', () => setAutoTranslateEpubs(enabled));
              }}
            >
              <SwitchMark checked={preferences.autoTranslateEpubs} />
            </SwitchControl>
          )}
          wrap
        />
        <InsetRow
          feedback={preferenceErrors.get('translation-model') ? (
            <span role="alert">{preferenceErrors.get('translation-model')}</span>
          ) : undefined}
          label={t.settings.preview.modelLabel}
          sublabel={t.settings.preview.modelSublabel}
          trailing={(
            <SelectControl
              label={t.settings.preview.modelLabel}
              onChange={(event) => persistPreference(
                'translation-model',
                () => setTranslationModel(event.target.value || null),
              )}
              value={model ?? ''}
              variant="popup"
            >
              <option value="">{t.shell.filePreview.followAgentModel}</option>
              {model && !modelsLoaded ? (
                <option value={model}>{translationModelName(model)}</option>
              ) : null}
              {model && modelsLoaded && !modelAvailable ? (
                <option disabled value={model}>
                  {t.shell.filePreview.translationModelUnavailable({ model: translationModelName(model) })}
                </option>
              ) : null}
              {modelGroups.map((group) => (
                <optgroup key={group.providerId} label={translationProviderName(group.providerId)}>
                  {group.models.map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </optgroup>
              ))}
            </SelectControl>
          )}
          wrap
        />
        <DataMaintenanceRow
          action={() => window.lin?.clearPreviewTranslationCache?.()}
          actionLabel={t.settings.general.translationDataClearAction}
          busyLabel={t.settings.general.translationDataClearing}
          clearedNotice={t.settings.general.translationDataClearedNotice}
          failedMessage={t.settings.general.translationDataClearFailed}
          label={t.settings.general.translationDataLabel}
          onError={onError}
          onNotice={onNotice}
          sublabel={t.settings.general.translationDataSublabel}
          unavailableMessage={t.settings.general.translationDataUnavailable}
        />
      </InsetGroup>

      <InsetGroup
        ariaLabel={t.settings.preview.websitesAriaLabel}
        id="websites"
        label={t.settings.preview.websitesGroup}
      >
        <DataMaintenanceRow
          action={() => window.lin?.clearUrlPreviewData?.()}
          actionLabel={t.settings.general.websiteDataClearAction}
          busyLabel={t.settings.general.websiteDataClearing}
          clearedNotice={t.settings.general.websiteDataClearedNotice}
          failedMessage={t.settings.general.websiteDataClearFailed}
          label={t.settings.general.websiteDataLabel}
          onError={onError}
          onNotice={onNotice}
          sublabel={t.settings.general.websiteDataSublabel}
          unavailableMessage={t.settings.general.websiteDataUnavailable}
        />
      </InsetGroup>
    </section>
  );
}

function withMapValue<K, V>(current: ReadonlyMap<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(current);
  next.set(key, value);
  return next;
}

function withoutMapKey<K, V>(current: ReadonlyMap<K, V>, key: K): Map<K, V> {
  if (!current.has(key)) return current as Map<K, V>;
  const next = new Map(current);
  next.delete(key);
  return next;
}
