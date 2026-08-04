import type { AgentProviderSettingsView } from '../../api/types';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import { isProviderUsable } from '../agent/providerUsability';

// Which models may translate a page, derived once and rendered by both surfaces
// that offer the choice: the preview's Languages popover, where the user acts in
// context, and Settings → Preview → Translation, where the same preference is
// managed away from a page. They read and write one store, so two menus built
// from two derivations would be a way for them to disagree about what is on
// offer while agreeing about what is chosen.

export interface TranslationModelGroup {
  providerId: string;
  models: Array<{ label: string; value: string }>;
}

/** Usable providers first-active, each with the models it can actually reach. */
export function translationModelGroups(settings: AgentProviderSettingsView | null): TranslationModelGroup[] {
  if (!settings) return [];
  const providers = [...settings.providers].sort((left, right) => {
    if (left.providerId === settings.activeProviderId) return -1;
    if (right.providerId === settings.activeProviderId) return 1;
    return left.providerId.localeCompare(right.providerId);
  });
  return providers.flatMap((provider) => {
    if (!isProviderUsable(settings, provider)) return [];
    const models = settings.availableProviders
      .find((entry) => entry.providerId === provider.providerId)
      ?.models.map((model) => ({
        label: model.name,
        value: composeProviderQualifiedModel(provider.providerId, model.id),
      })) ?? [];
    return models.length > 0 ? [{ providerId: provider.providerId, models }] : [];
  });
}

/** The bare model id, without the provider qualifier a stored value carries. */
export function translationModelName(model: string): string {
  const separator = model.indexOf('/');
  return separator >= 0 ? model.slice(separator + 1) : model;
}

export function translationProviderName(providerId: string): string {
  const tokens: Record<string, string> = {
    ai: 'AI',
    api: 'API',
    github: 'GitHub',
    openai: 'OpenAI',
  };
  return providerId
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => tokens[part] ?? `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
