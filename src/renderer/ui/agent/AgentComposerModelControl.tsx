import { useCallback, useRef, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { useDismissibleOverlay } from '../primitives/useDismissibleOverlay';
import { ICON_SIZE, SettingsIcon } from '../icons';
import { AgentModelEffortSelector } from './AgentModelEffortSelector';

interface AgentComposerModelControlProps {
  settings: AgentProviderSettingsView | null;
  /** The agent's stored model selection (`''`/`inherit` = provider catalog default). */
  model: string;
  /** The agent's stored reasoning effort. */
  effort: string;
  disabled: boolean;
  onModelChange: (next: string) => void;
  onEffortChange: (next: string) => void;
}

// The composer's quick model + reasoning chip. Selecting here edits the single
// assistant's (Neva's) standing profile through the same path as Settings → Agent
// (provider-connection-model-ownership #267 keeps model/effort a profile property);
// the runtime applies the change on the next turn. The chip anchors an in-place
// popover (the wrapper is `position: relative`) hosting the shared capability-driven
// selector — no portal, so outside-pointer dismissal is a single contains() check.
export function AgentComposerModelControl({
  settings,
  model,
  effort,
  disabled,
  onModelChange,
  onEffortChange,
}: AgentComposerModelControlProps) {
  const messages = useT();
  const composer = messages.agent.composer;
  const agentsCopy = messages.settings.agents;
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissibleOverlay(wrapperRef, close, { disabled: !open });

  const modelName = shortModelLabel(model) ?? composer.modelDefault;
  const reasoningKey = effort.trim() === 'xhigh' ? 'max' : effort.trim();
  const reasoning = reasoningKey && reasoningKey !== 'off' && reasoningKey !== 'inherit'
    ? (composer.reasoningLevels as Record<string, string>)[reasoningKey] ?? null
    : null;

  return (
    <div className="agent-composer-model" ref={wrapperRef}>
      <ButtonControl
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={composer.modelControlLabel}
        className="agent-composer-model-button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={composer.modelControlLabel}
      >
        <span className="agent-composer-model-name">{modelName}</span>
        {reasoning ? <span className="agent-composer-reasoning-chip">{reasoning}</span> : null}
        <SettingsIcon size={ICON_SIZE.tiny} />
      </ButtonControl>
      {open ? (
        <div className="agent-composer-model-popover" role="dialog" aria-label={composer.modelControlLabel}>
          <AgentModelEffortSelector
            settings={settings}
            model={model}
            effort={effort}
            disabled={false}
            providerLabel={agentsCopy.providerOverride}
            modelLabel={agentsCopy.modelOverride}
            effortLabel={agentsCopy.thinkingLevel}
            inheritLabel={agentsCopy.effortDefault}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The model's last path segment for the chip, or null for the catalog default. */
function shortModelLabel(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
