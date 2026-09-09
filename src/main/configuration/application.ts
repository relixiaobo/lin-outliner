import { DEFAULT_FILE_PREFERENCES, type FilePreferences } from '../../core/filePreferences';
import type { PreferencesApplicationDomain, PreferencesApplicationState } from '../../core/settingsDefinitions';

export type PreferenceApplicationHandlers = Partial<Record<PreferencesApplicationDomain, (preferences: FilePreferences) => Promise<void> | void>>;
const DOMAINS: readonly PreferencesApplicationDomain[] = ['appearance', 'memory', 'updates', 'skills', 'access', 'requests', 'delegation', 'models'];

/** Owners settle independently. A failed Memory operation cannot roll back Appearance. */
export class PreferencesApplication {
  effective: FilePreferences = DEFAULT_FILE_PREFERENCES;
  states: PreferencesApplicationState = {};

  async apply(preferences: FilePreferences, digest: string | null, handlers: PreferenceApplicationHandlers, changed: () => void): Promise<void> {
    this.states = Object.fromEntries(DOMAINS.map((domain) => [domain, { status: 'pending', error: null, digest }]));
    changed();
    await Promise.all(DOMAINS.map(async (domain) => {
      try {
        await handlers[domain]?.(preferences);
        const current = this.effective;
        this.effective = domain === 'appearance' ? { ...current, appearance: preferences.appearance }
          : domain === 'updates' ? { ...current, updates: preferences.updates }
            : domain === 'models' ? { ...current, models: preferences.models }
              : { ...current, agent: { ...current.agent,
                [domain === 'requests' ? 'provider' : domain === 'access' ? 'tools' : domain]:
                  preferences.agent[domain === 'requests' ? 'provider' : domain === 'access' ? 'tools' : domain],
              } };
        this.states = { ...this.states, [domain]: { status: 'applied', error: null, digest } };
      } catch (caught) {
        this.states = { ...this.states, [domain]: { status: 'failed', error: caught instanceof Error ? caught.message : String(caught), digest } };
      }
      changed();
    }));
  }
}
