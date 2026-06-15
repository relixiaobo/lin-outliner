import { useEffect, useState } from 'react';
import { composeProviderQualifiedModel, parseProviderQualifiedModel } from '../../../core/agentModelId';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import type { AgentProviderSettingsView, AgentReasoningLevel } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { Field } from '../primitives/Field';
import { Input } from '../primitives/Input';
import { SelectControl } from '../primitives/SelectControl';
import { isProviderUsable } from './providerUsability';

// Capability-driven model + effort picker for an agent profile (provider-connection-
// model-ownership #256). A provider is a connection; the model/effort that runs is
// chosen HERE, on the profile. Select a provider, then a model; the effort options
// are derived from that model's supported thinking levels. The saved value is the
// canonical model id from the catalog surface (provider-qualified `providerId/modelId`),
// never a display label. Effort ordering comes from the shared `AGENT_REASONING_LADDER`
// (core/types), the single source the runtime also ranks/coerces against.

interface ModelSelection {
  providerId: string;
  modelId: string;
}

// `''`/`inherit` → use the provider catalog default. A `providerId/modelId` (or the
// `:` form skills emit, only when the prefix is a known provider) → an explicit
// cross-provider choice. A bare id — including one that contains `:` like a Bedrock
// `amazon.nova-lite-v1:0` — is treated as belonging to the active provider. The
// split lives in `core/agentModelId`, shared with the runtime so both sides agree.
export function parseModelSelection(
  model: string,
  activeProviderId: string,
  isKnownProvider: (providerId: string) => boolean,
): ModelSelection {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return { providerId: '', modelId: '' };
  const parsed = parseProviderQualifiedModel(trimmed, isKnownProvider);
  if (parsed) return parsed;
  return { providerId: activeProviderId, modelId: trimmed };
}

interface AgentModelEffortSelectorProps {
  settings: AgentProviderSettingsView | null;
  model: string;
  effort: string;
  disabled: boolean;
  providerLabel: string;
  modelLabel: string;
  effortLabel: string;
  inheritLabel: string;
  onModelChange: (next: string) => void;
  onEffortChange: (next: string) => void;
}

export function AgentModelEffortSelector({
  settings,
  model,
  effort,
  disabled,
  providerLabel,
  modelLabel,
  effortLabel,
  inheritLabel,
  onModelChange,
  onEffortChange,
}: AgentModelEffortSelectorProps) {
  const t = useT();
  const reasoningCopy = t.agent.composer.reasoningLevels;
  const reasoningLabel = (level: AgentReasoningLevel) => reasoningCopy[level === 'xhigh' ? 'max' : level];

  const activeProviderId = settings?.activeProviderId ?? '';
  // A provider id is "known" (eligible for the `:` qualifier split) when it is a
  // catalog or configured provider — so a bare colon-bearing model id is not
  // mis-read as a provider/model pair.
  const knownProviderIds = new Set<string>([
    ...(settings?.availableProviders ?? []).map((provider) => provider.providerId),
    ...(settings?.providers ?? []).map((provider) => provider.providerId),
  ]);
  const isKnownProvider = (providerId: string) => knownProviderIds.has(providerId);
  const selection = parseModelSelection(model, activeProviderId, isKnownProvider);

  // A custom (no-catalog) provider takes a free-text model id, so until one is typed
  // the saved `model` is empty and `selection.providerId` is blank. Remember the chosen
  // provider locally so the control keeps it selected (and the free-text input reachable)
  // instead of collapsing back to Inherit. A saved/qualified id always wins.
  const [pendingProvider, setPendingProvider] = useState('');
  const providerId = selection.providerId || pendingProvider;

  // Providers the agent can actually run on: configured + credentialed connections.
  const usableProviders = (settings?.providers ?? [])
    .filter((provider) => isProviderUsable(settings!, provider))
    .map((provider) => ({
      providerId: provider.providerId,
      models: settings?.availableProviders.find((option) => option.providerId === provider.providerId)?.models ?? [],
    }));

  // Keep an already-saved provider visible even if it is not currently usable, so an
  // existing selection never silently disappears from the dropdown.
  if (providerId && !usableProviders.some((provider) => provider.providerId === providerId)) {
    usableProviders.push({
      providerId,
      models: settings?.availableProviders.find((option) => option.providerId === providerId)?.models ?? [],
    });
  }

  const selectedProvider = usableProviders.find((provider) => provider.providerId === providerId);
  const catalogModels = selectedProvider?.models ?? [];
  const selectedModelOption = catalogModels.find((option) => option.id === selection.modelId);
  // Catalog providers list ranked models; a custom OpenAI-compatible connection has
  // no catalog, so its model is entered as free text.
  const useFreeTextModel = Boolean(providerId) && catalogModels.length === 0;
  // A saved model the catalog no longer lists must still appear (and stay selected),
  // or the <select> would silently render an unrelated first option as if chosen.
  const savedModelMissing = Boolean(selection.modelId)
    && !catalogModels.some((option) => option.id === selection.modelId);

  const supportedLevelsFor = (option?: { supportedThinkingLevels: AgentReasoningLevel[] }): readonly AgentReasoningLevel[] => (
    option?.supportedThinkingLevels.length ? option.supportedThinkingLevels : AGENT_REASONING_LADDER
  );
  const supportedLevels = supportedLevelsFor(selectedModelOption);

  // Clear an effort the newly-chosen model cannot honour, so the stored value never
  // silently diverges from what the effort control can display.
  function reconcileEffort(nextModelOption?: { supportedThinkingLevels: AgentReasoningLevel[] }) {
    if (effort && !supportedLevelsFor(nextModelOption).includes(effort as AgentReasoningLevel)) {
      onEffortChange('');
    }
  }

  // Reconcile a stale effort on mount too: a saved model+effort pair can arrive with an
  // effort the model no longer supports (e.g. the model's levels changed). The effort
  // control already displays Inherit in that case, so persist that — otherwise Save
  // would write back the hidden, unsupported value. Only act when the model is a known
  // catalog option (a free-text/custom model has no declared levels to validate against).
  useEffect(() => {
    if (effort && selectedModelOption && !supportedLevelsFor(selectedModelOption).includes(effort as AgentReasoningLevel)) {
      onEffortChange('');
    }
    // `onEffortChange` is intentionally excluded: it is a fresh closure each render and
    // including it would re-fire the effect in a loop.
  }, [model, effort, selectedModelOption?.id]);

  function changeProvider(nextProviderId: string) {
    if (!nextProviderId) {
      setPendingProvider('');
      onModelChange('');
      return;
    }
    const nextModels = usableProviders.find((provider) => provider.providerId === nextProviderId)?.models ?? [];
    if (nextModels.length === 0) {
      // A custom connection has no catalog: remember the provider and clear the model so
      // the free-text input appears, instead of emitting an empty (→ Inherit) value.
      setPendingProvider(nextProviderId);
      reconcileEffort(undefined);
      onModelChange('');
      return;
    }
    setPendingProvider('');
    const nextModelId = nextModels.some((option) => option.id === selection.modelId)
      ? selection.modelId
      : nextModels[0]?.id ?? '';
    reconcileEffort(nextModels.find((option) => option.id === nextModelId));
    onModelChange(composeProviderQualifiedModel(nextProviderId, nextModelId));
  }

  function changeModel(nextModelId: string) {
    reconcileEffort(catalogModels.find((option) => option.id === nextModelId));
    onModelChange(composeProviderQualifiedModel(providerId, nextModelId));
  }

  return (
    <>
      <Field as="label" className="settings-sheet-row" label={providerLabel} labelClassName="settings-sheet-row-label">
        <SelectControl
          className="settings-sheet-row-input"
          disabled={disabled}
          label={providerLabel}
          onChange={(event) => changeProvider(event.target.value)}
          value={providerId}
          variant="popup"
        >
          <option value="">{inheritLabel}</option>
          {usableProviders.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>{provider.providerId}</option>
          ))}
        </SelectControl>
      </Field>

      {providerId ? (
        <Field as="label" className="settings-sheet-row" label={modelLabel} labelClassName="settings-sheet-row-label">
          {useFreeTextModel ? (
            <Input
              className="settings-sheet-row-input"
              disabled={disabled}
              label={modelLabel}
              onChange={(event) => changeModel(event.target.value)}
              placeholder="model-id"
              value={selection.modelId}
              variant="bare"
            />
          ) : (
            <SelectControl
              className="settings-sheet-row-input"
              disabled={disabled}
              label={modelLabel}
              onChange={(event) => changeModel(event.target.value)}
              value={selection.modelId}
              variant="popup"
            >
              {savedModelMissing ? (
                <option value={selection.modelId}>{selection.modelId}</option>
              ) : null}
              {catalogModels.map((option) => (
                <option key={option.id} value={option.id}>{option.name || option.id}</option>
              ))}
            </SelectControl>
          )}
        </Field>
      ) : null}

      <Field as="label" className="settings-sheet-row" label={effortLabel} labelClassName="settings-sheet-row-label">
        <SelectControl
          className="settings-sheet-row-input"
          disabled={disabled}
          label={effortLabel}
          onChange={(event) => onEffortChange(event.target.value)}
          value={supportedLevels.includes(effort as AgentReasoningLevel) ? effort : ''}
          variant="popup"
        >
          <option value="">{inheritLabel}</option>
          {AGENT_REASONING_LADDER.filter((level) => supportedLevels.includes(level)).map((level) => (
            <option key={level} value={level}>{reasoningLabel(level)}</option>
          ))}
        </SelectControl>
      </Field>
    </>
  );
}
