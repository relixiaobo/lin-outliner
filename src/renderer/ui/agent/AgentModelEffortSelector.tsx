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
// never a display label.

const REASONING_ORDER: readonly AgentReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

interface ModelSelection {
  providerId: string;
  modelId: string;
}

// `''`/`inherit` → use the provider catalog default. `providerId/modelId` (or the
// `:` form skills emit) → an explicit cross-provider choice. A bare id is treated
// as belonging to the active provider.
export function parseModelSelection(model: string, activeProviderId: string): ModelSelection {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return { providerId: '', modelId: '' };
  const separator = trimmed.includes('/') ? '/' : trimmed.includes(':') ? ':' : '';
  if (!separator) return { providerId: activeProviderId, modelId: trimmed };
  const [providerId, ...rest] = trimmed.split(separator);
  return { providerId: providerId.trim(), modelId: rest.join(separator).trim() };
}

function composeModel(providerId: string, modelId: string): string {
  const id = modelId.trim();
  if (!id) return '';
  return providerId ? `${providerId}/${id}` : id;
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
  const selection = parseModelSelection(model, activeProviderId);

  // Providers the agent can actually run on: configured + credentialed connections.
  const usableProviders = (settings?.providers ?? [])
    .filter((provider) => isProviderUsable(settings!, provider))
    .map((provider) => ({
      providerId: provider.providerId,
      models: settings?.availableProviders.find((option) => option.providerId === provider.providerId)?.models ?? [],
    }));

  // Keep an already-saved provider visible even if it is not currently usable, so an
  // existing selection never silently disappears from the dropdown.
  if (selection.providerId && !usableProviders.some((provider) => provider.providerId === selection.providerId)) {
    usableProviders.push({
      providerId: selection.providerId,
      models: settings?.availableProviders.find((option) => option.providerId === selection.providerId)?.models ?? [],
    });
  }

  const selectedProvider = usableProviders.find((provider) => provider.providerId === selection.providerId);
  const catalogModels = selectedProvider?.models ?? [];
  const selectedModelOption = catalogModels.find((option) => option.id === selection.modelId);
  // Catalog providers list ranked models; a custom OpenAI-compatible connection has
  // no catalog, so its model is entered as free text.
  const useFreeTextModel = Boolean(selection.providerId) && catalogModels.length === 0;

  const supportedLevels = selectedModelOption?.supportedThinkingLevels.length
    ? selectedModelOption.supportedThinkingLevels
    // No catalog capability info (inherit, or a custom model): offer the full ladder.
    : REASONING_ORDER;

  function changeProvider(nextProviderId: string) {
    if (!nextProviderId) {
      onModelChange('');
      return;
    }
    const nextModels = usableProviders.find((provider) => provider.providerId === nextProviderId)?.models ?? [];
    const nextModelId = nextModels.some((option) => option.id === selection.modelId)
      ? selection.modelId
      : nextModels[0]?.id ?? '';
    onModelChange(composeModel(nextProviderId, nextModelId));
  }

  return (
    <>
      <Field as="label" className="settings-sheet-row" label={providerLabel} labelClassName="settings-sheet-row-label">
        <SelectControl
          className="settings-sheet-row-input"
          disabled={disabled}
          label={providerLabel}
          onChange={(event) => changeProvider(event.target.value)}
          value={selection.providerId}
          variant="popup"
        >
          <option value="">{inheritLabel}</option>
          {usableProviders.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>{provider.providerId}</option>
          ))}
        </SelectControl>
      </Field>

      {selection.providerId ? (
        <Field as="label" className="settings-sheet-row" label={modelLabel} labelClassName="settings-sheet-row-label">
          {useFreeTextModel ? (
            <Input
              className="settings-sheet-row-input"
              disabled={disabled}
              label={modelLabel}
              onChange={(event) => onModelChange(composeModel(selection.providerId, event.target.value))}
              placeholder="model-id"
              value={selection.modelId}
              variant="bare"
            />
          ) : (
            <SelectControl
              className="settings-sheet-row-input"
              disabled={disabled}
              label={modelLabel}
              onChange={(event) => onModelChange(composeModel(selection.providerId, event.target.value))}
              value={selection.modelId}
              variant="popup"
            >
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
          {REASONING_ORDER.filter((level) => supportedLevels.includes(level)).map((level) => (
            <option key={level} value={level}>{reasoningLabel(level)}</option>
          ))}
        </SelectControl>
      </Field>
    </>
  );
}
