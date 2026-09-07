import type { AgentModelOption, AgentProviderSettingsView } from '../../api/types';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../../core/agentModelId';
import { preferredProviderIndex } from './providerOrder';
import { isProviderUsable } from './providerUsability';

// Model selection, shared by the composer quick-switcher and the Automation
// editor so neither derives its own menu. Deliberately free of any asset/icon
// import (no `import.meta.glob`) — the same constraint `providerUsability`
// documents — so it loads in a plain `bun test`. It therefore returns provider
// IDs and leaves display-name formatting to the rendering component.

/** The stored model field of a Thread configuration or an Automation override. */
export interface ModelSelectionInput {
  readonly modelProvider: string;
  readonly model: string;
}

export interface ModelChoice {
  readonly providerId: string;
  readonly option: AgentModelOption;
  /** Canonical `providerId/modelId` — what a selection persists. */
  readonly value: string;
}

/**
 * Models of one provider. Providers survive as a *truncation* unit (each keeps
 * its own "show all" budget) but not as a *visual* one — the surfaces render
 * groups back to back with no heading, so the list reads as one flat list.
 */
export interface ModelChoiceGroup {
  readonly providerId: string;
  readonly models: readonly ModelChoice[];
}

export interface ModelChoices {
  readonly groups: readonly ModelChoiceGroup[];
  readonly modelCount: number;
  /**
   * True when more than one provider is LISTED, so a row needs its origin shown.
   * Listed, not usable: a Thread pinned to a no-longer-usable provider still
   * contributes a group, and those rows do come from a different connection.
   */
  readonly showProviderLabel: boolean;
  /** True when the selection follows the connection's newest model instead of pinning one. */
  readonly floating: boolean;
  readonly resolvedProviderId: string;
  readonly resolvedModelId: string;
  readonly resolvedOption: AgentModelOption | undefined;
  /**
   * What `inherit` resolves to on THIS Thread's connection, or undefined when
   * that connection lists no models.
   *
   * Keyed on `selection.modelProvider`, not on the resolved provider: the
   * runtime resolves an unpinned model against `thread.modelProvider`
   * (`resolveDefaultRuntime`), and a cross-provider pin makes the two differ.
   * Un-pinning must be offered, clamped, and labelled against this model —
   * never against the model being un-pinned, which is a different one whenever
   * the Thread is pinned at all.
   */
  readonly connectionHead: AgentModelOption | undefined;
}

/**
 * True when the stored model defers to the provider's ranked head rather than
 * naming a model. `inherit` is the built-in profile's default (see
 * `AgentConfigurationLoader`), and main treats it and the empty string alike.
 *
 * This must be asked of the STORED value, never inferred from the resolved
 * model id: a floating selection resolves to the ranked head, which is exactly
 * what an explicit pin to the newest model also resolves to, so the two are
 * indistinguishable after resolution.
 */
export function isFloatingModelSelection(model: string): boolean {
  const trimmed = model.trim();
  return !trimmed || trimmed === 'inherit';
}

export function buildModelChoices(
  settings: AgentProviderSettingsView | null,
  selection: ModelSelectionInput,
): ModelChoices {
  const floating = isFloatingModelSelection(selection.model);
  if (!settings) {
    return {
      groups: [],
      modelCount: 0,
      showProviderLabel: false,
      floating,
      resolvedProviderId: selection.modelProvider,
      resolvedModelId: floating ? '' : lastModelSegment(selection.model) ?? '',
      resolvedOption: undefined,
      connectionHead: undefined,
    };
  }

  const knownProviderIds = new Set([
    ...settings.providers.map((provider) => provider.providerId),
    ...settings.availableProviders.map((provider) => provider.providerId),
  ]);
  const parsed = parseProviderQualifiedModel(selection.model, (id) => knownProviderIds.has(id));
  const resolvedProviderId = parsed?.providerId || selection.modelProvider;
  const modelsFor = (providerId: string): readonly AgentModelOption[] => (
    settings.availableProviders.find((provider) => provider.providerId === providerId)?.models ?? []
  );
  // The ranked head is main's answer to "newest": `providerModelOptions` already
  // sorted these with `compareProviderRankables`, and the runtime resolves an
  // unpinned model through the same head (`resolveProviderCatalogModel`).
  const connectionHead = modelsFor(selection.modelProvider)[0];
  // A pinned value is reported verbatim. An id stored without a `providerId/`
  // qualifier does not parse, and falling back to the head there would name the
  // head while main runs the bare id under this provider — the same show-one-
  // run-another confusion the floating/pinned split exists to remove.
  const resolvedModelId = floating
    ? connectionHead?.id ?? ''
    : parsed?.modelId || selection.model.trim();
  let resolvedOption = modelsFor(resolvedProviderId).find((option) => option.id === resolvedModelId);

  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId)
    .sort((left, right) => (
      preferredProviderIndex(left) - preferredProviderIndex(right) || left.localeCompare(right)
    ));
  // The selection's own provider leads, so the models a Thread can reach without
  // changing connection come first.
  const providerIds = dedupe([resolvedProviderId, ...usableProviderIds].filter(Boolean));

  const groups: ModelChoiceGroup[] = providerIds
    .map((providerId) => ({
      providerId,
      models: modelsFor(providerId).map((option) => toChoice(providerId, option)),
    }))
    .filter((group) => group.models.length > 0);

  // A pinned model the catalog no longer lists still has to be selectable, or
  // opening the menu would silently drop the Thread's current selection.
  if (resolvedModelId && !resolvedOption) {
    resolvedOption = {
      id: resolvedModelId,
      name: lastModelSegment(resolvedModelId) ?? resolvedModelId,
      reasoning: false,
      supportedThinkingLevels: [],
      contextWindow: 0,
      maxTokens: 0,
    };
    const orphan = toChoice(resolvedProviderId, resolvedOption);
    const group = groups.find((candidate) => candidate.providerId === resolvedProviderId);
    if (group) groups[groups.indexOf(group)] = { ...group, models: [orphan, ...group.models] };
    else groups.unshift({ providerId: resolvedProviderId, models: [orphan] });
  }

  return {
    groups,
    modelCount: groups.reduce((total, group) => total + group.models.length, 0),
    showProviderLabel: groups.length > 1,
    floating,
    resolvedProviderId,
    resolvedModelId,
    resolvedOption,
    connectionHead,
  };
}

/** Flatten to a single ordered list, for surfaces that cannot truncate (a native `select`). */
export function flattenModelChoices(choices: ModelChoices): readonly ModelChoice[] {
  return choices.groups.flatMap((group) => group.models);
}

export function modelChoiceAvailable(
  choice: ModelChoice,
  settings: AgentProviderSettingsView | null,
): boolean {
  if (!settings || choice.option.contextWindow <= 0) return false;
  const provider = settings.providers.find((candidate) => candidate.providerId === choice.providerId);
  return provider !== undefined && isProviderUsable(settings, provider);
}

function toChoice(providerId: string, option: AgentModelOption): ModelChoice {
  return { providerId, option, value: composeProviderQualifiedModel(providerId, option.id) };
}

export function lastModelSegment(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
