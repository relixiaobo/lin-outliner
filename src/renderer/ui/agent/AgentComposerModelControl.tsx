import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import type { AgentModelOption, AgentProviderSettingsView, AgentReasoningLevel } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { MenuItem } from '../primitives/MenuItem';
import { SegmentedControl, type SegmentedControlOption } from '../primitives/SegmentedControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { BrainIcon, CheckIcon, ChevronDownIcon, ICON_SIZE } from '../icons';
import { parseModelSelection } from './AgentModelEffortSelector';
import { isProviderUsable } from './providerUsability';

interface AgentComposerModelControlProps {
  settings: AgentProviderSettingsView | null;
  /** The agent's stored model selection (`''`/`inherit` = provider catalog default). */
  model: string;
  /** The agent's stored reasoning effort (`''` = provider default). */
  effort: string;
  disabled: boolean;
  onModelChange: (next: string) => void;
  onEffortChange: (next: string) => void;
}

// The composer's quick model + reasoning chip. Selecting here edits the single
// assistant's (Neva's) standing profile through the same path as Settings → Agent
// (provider-connection-model-ownership #267 keeps model/effort a profile property);
// the runtime applies the change on the next turn. The interaction follows the nodex
// chat composer: the chip shows the resolved model name and anchors a portaled menu
// (so it never clips against the composer's overflow) listing the active provider's
// models directly, other providers under a "More models" group, and the supported
// reasoning levels below.
export function AgentComposerModelControl({
  settings,
  model,
  effort,
  disabled,
  onModelChange,
  onEffortChange,
}: AgentComposerModelControlProps) {
  const composer = useT().agent.composer;
  const reasoningCopy = composer.reasoningLevels;
  const reasoningLabel = (level: AgentReasoningLevel) => reasoningCopy[level === 'xhigh' ? 'max' : level];

  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const layout = deriveModelLayout(settings, model);
  const { effectiveProviderId, effectiveModelId, effectiveModelOption, featured, more } = layout;

  const overlayStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    placement: 'top-end',
    width: 300,
    maxHeight: 360,
    layoutKey: `${model}:${effort}:${moreOpen ? 1 : 0}`,
  });

  // Portaled surface: dismiss on outside pointer (ignoring the anchor so a click on
  // the chip toggles rather than close-then-reopens) and on Escape. Collapse the
  // "More models" group when the menu closes so it reopens in its default state.
  useEffect(() => {
    if (!open) {
      setMoreOpen(false);
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Chip face: the resolved model name (explicit catalog name, or the active
  // provider's first-ranked model for inherit) plus the reasoning level when set.
  const modelName = effectiveModelOption?.name
    ?? lastModelSegment(effectiveModelId)
    ?? composer.modelDefault;
  const reasoningKey = effort.trim() === 'xhigh' ? 'max' : effort.trim();
  const reasoning = reasoningKey && reasoningKey !== 'off' && reasoningKey !== 'inherit'
    ? (reasoningCopy as Record<string, string>)[reasoningKey] ?? null
    : null;

  // Reasoning options come from the effective model's supported levels, ranked by the
  // shared ladder. A `''` effort (inherit) simply leaves no segment selected.
  const supportedLevels = effectiveModelOption?.supportedThinkingLevels.length
    ? effectiveModelOption.supportedThinkingLevels
    : AGENT_REASONING_LADDER;
  const supportsReasoning = Boolean(effectiveModelOption?.reasoning) || supportedLevels.some((level) => level !== 'off');
  const reasoningOptions: SegmentedControlOption<AgentReasoningLevel>[] = AGENT_REASONING_LADDER
    .filter((level) => supportedLevels.includes(level))
    .map((level) => ({ value: level, label: reasoningLabel(level) }));
  const effortValue = (supportedLevels.includes(effort as AgentReasoningLevel) ? effort : '') as AgentReasoningLevel;

  function selectModel(providerId: string, option: AgentModelOption) {
    const nextLevels = option.supportedThinkingLevels.length ? option.supportedThinkingLevels : AGENT_REASONING_LADDER;
    // Drop an effort the newly-chosen model cannot honour (same reconciliation as the
    // Settings selector) so the stored value never diverges from what can run.
    if (effort && !nextLevels.includes(effort as AgentReasoningLevel)) onEffortChange('');
    onModelChange(composeProviderQualifiedModel(providerId, option.id));
  }

  function renderModelItem(providerId: string, option: AgentModelOption) {
    const selected = providerId === effectiveProviderId && option.id === effectiveModelId;
    return (
      <MenuItem
        key={`${providerId}:${option.id}`}
        active={selected}
        activeClassName="is-selected"
        aria-checked={selected}
        className="agent-composer-model-item"
        icon={(
          <span className="agent-composer-model-check">
            {selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}
          </span>
        )}
        label={option.name || option.id}
        labelClassName="agent-composer-model-item-label"
        onClick={() => selectModel(providerId, option)}
        role="menuitemradio"
      />
    );
  }

  return (
    <div className="agent-composer-model">
      <ButtonControl
        ref={anchorRef}
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
        <ChevronDownIcon size={ICON_SIZE.tiny} />
      </ButtonControl>
      {open
        ? createPortal(
          <div
            ref={menuRef}
            className="agent-composer-model-popover"
            role="dialog"
            aria-label={composer.modelControlLabel}
            style={overlayStyle}
          >
            <div className="agent-composer-model-list" role="menu" aria-label={composer.modelControlLabel}>
              {featured.map((option) => renderModelItem(effectiveProviderId, option))}
              {more.length > 0 ? (
                <>
                  <button
                    aria-expanded={moreOpen}
                    className="agent-composer-model-item agent-composer-model-more"
                    onClick={() => setMoreOpen((value) => !value)}
                    type="button"
                  >
                    <ChevronDownIcon
                      className={`agent-composer-model-more-caret${moreOpen ? ' is-open' : ''}`}
                      size={ICON_SIZE.menu}
                    />
                    <span className="agent-composer-model-item-label">{composer.moreModels}</span>
                  </button>
                  {moreOpen
                    ? more.map((group) => (
                      <div key={group.providerId} className="agent-composer-model-group">
                        <div className="agent-composer-model-group-label">{group.providerId}</div>
                        {group.models.map((option) => renderModelItem(group.providerId, option))}
                      </div>
                    ))
                    : null}
                </>
              ) : null}
            </div>
            {supportsReasoning ? (
              <>
                <div className="agent-composer-model-divider" />
                <div className="agent-composer-model-reasoning">
                  <span className="agent-composer-model-reasoning-label">
                    <BrainIcon size={ICON_SIZE.menu} />
                    {composer.reasoningHeading}
                  </span>
                  <SegmentedControl
                    className="agent-composer-model-reasoning-control"
                    label={composer.reasoningHeading}
                    onChange={(value) => onEffortChange(value)}
                    options={reasoningOptions}
                    value={effortValue}
                  />
                </div>
              </>
            ) : null}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

interface ModelLayout {
  effectiveProviderId: string;
  effectiveModelId: string;
  effectiveModelOption: AgentModelOption | undefined;
  /** The selection's provider models, shown directly (nodex's "featured" tier). */
  featured: AgentModelOption[];
  /** Other usable providers, grouped under "More models". */
  more: Array<{ providerId: string; models: AgentModelOption[] }>;
}

/**
 * Resolve the model menu's layout from the stored selection. The provider that owns
 * the current selection (or the active provider when inherit) is the primary list;
 * its first-ranked model stands in for inherit so the chip and the check mark show
 * the model the runtime actually runs. Every other usable provider is a "More models"
 * group, in catalog order.
 */
function deriveModelLayout(settings: AgentProviderSettingsView | null, model: string): ModelLayout {
  if (!settings) {
    return { effectiveProviderId: '', effectiveModelId: '', effectiveModelOption: undefined, featured: [], more: [] };
  }
  const activeProviderId = settings.activeProviderId ?? '';
  const knownProviderIds = new Set<string>([
    ...settings.availableProviders.map((provider) => provider.providerId),
    ...settings.providers.map((provider) => provider.providerId),
  ]);
  const selection = parseModelSelection(model, activeProviderId, (id) => knownProviderIds.has(id));
  const modelsFor = (providerId: string): AgentModelOption[] => (
    settings.availableProviders.find((provider) => provider.providerId === providerId)?.models ?? []
  );

  const primaryProviderId = selection.providerId || activeProviderId;
  const featured = modelsFor(primaryProviderId);
  const effectiveModelId = selection.modelId || featured[0]?.id || '';
  const effectiveModelOption = featured.find((option) => option.id === effectiveModelId);

  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId);
  const more = usableProviderIds
    .filter((providerId) => providerId !== primaryProviderId)
    .map((providerId) => ({ providerId, models: modelsFor(providerId) }))
    .filter((group) => group.models.length > 0);

  return { effectiveProviderId: primaryProviderId, effectiveModelId, effectiveModelOption, featured, more };
}

/** The model id's last path segment (drops a `provider/` prefix), or null for inherit. */
function lastModelSegment(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}
