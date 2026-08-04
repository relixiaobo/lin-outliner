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
    const catalog = settings.availableProviders.find((entry) => entry.providerId === provider.providerId);
    const models = abbreviateModelNames(catalog?.models ?? []).map(({ label, id }) => ({
      label,
      value: composeProviderQualifiedModel(provider.providerId, id),
    }));
    return models.length > 0 ? [{ providerId: provider.providerId, models }] : [];
  });
}

/**
 * Shorten path-style model names to the part that identifies the model.
 *
 * A gateway names its models by route — `Codex / OpenAI_1 / GPT 5.6 Sonnet` —
 * and the leading segments repeat the provider the option is already grouped
 * under. Left whole, the closed menu shows the prefix and truncates the model
 * away, which is exactly backwards: it drops the only part the user was choosing.
 *
 * The abbreviation is per group and only applied when it stays unambiguous. If
 * two routes end at the same model — the same model through two accounts — the
 * shortened names would collide, so that group keeps its full names rather than
 * offering two options that read identically.
 */
function abbreviateModelNames(
  models: readonly { id: string; name: string }[],
): Array<{ id: string; label: string }> {
  const shortened = models.map((model) => {
    const segments = model.name.split('/').map((segment) => segment.trim()).filter(Boolean);
    return { id: model.id, label: segments.at(-1) || model.name, full: model.name };
  });
  const seen = new Set<string>();
  const collides = shortened.some((entry) => {
    if (seen.has(entry.label)) return true;
    seen.add(entry.label);
    return false;
  });
  return collides
    ? shortened.map((entry) => ({ id: entry.id, label: entry.full }))
    : shortened.map((entry) => ({ id: entry.id, label: entry.label }));
}

/**
 * How a STORED value is displayed — the fallback and unavailable rows, which show
 * a model that is not in the menu. Same abbreviation the menu applies, so the two
 * cannot describe one model differently: drop the provider qualifier, then keep
 * the last route segment. It cannot collide with anything, because it is the only
 * thing being shown.
 */
export function translationModelName(model: string): string {
  const separator = model.indexOf('/');
  const withoutProvider = separator >= 0 ? model.slice(separator + 1) : model;
  const segments = withoutProvider.split('/').map((segment) => segment.trim()).filter(Boolean);
  return segments.at(-1) || withoutProvider;
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
