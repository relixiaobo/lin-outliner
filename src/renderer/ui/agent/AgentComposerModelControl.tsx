import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import type { AgentModelOption, AgentProviderSettingsView, AgentReasoningLevel } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from '../icons';
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
// the runtime applies the change on the next turn. The interaction mirrors the Codex
// chat composer: the main menu lists the reasoning levels directly and a single row
// for the *current* model; the full model list is a side-anchored flyout submenu off
// that row. Portaled so it never clips against the composer's overflow.
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
  const [modelSubmenuOpen, setModelSubmenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const modelRowRef = useRef<HTMLButtonElement>(null);

  const menu = deriveModelMenu(settings, model);
  const { effectiveProviderId, effectiveModelId, effectiveModelOption, groups, modelCount } = menu;

  const overlayStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    placement: 'top-end',
    width: 240,
    maxHeight: 360,
    layoutKey: `${model}:${effort}`,
  });
  const submenuStyle = useFlyoutStyle(submenuRef, modelRowRef, open && modelSubmenuOpen, 240, `${model}`);

  // Portaled surfaces: dismiss on outside pointer (ignoring the anchor so a click on
  // the chip toggles rather than close-then-reopens) and on Escape. Collapse the model
  // submenu when the menu closes so it reopens in its default state.
  useEffect(() => {
    if (!open) {
      setModelSubmenuOpen(false);
      return undefined;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape steps out of the submenu first, then closes the whole menu.
      setModelSubmenuOpen((submenuOpen) => {
        if (submenuOpen) return false;
        setOpen(false);
        return false;
      });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Chip face + the current-model row: the resolved model name (explicit catalog
  // name, or the active provider's recommended model for inherit) plus the level.
  const modelName = effectiveModelOption?.name
    ?? lastModelSegment(effectiveModelId)
    ?? composer.modelDefault;
  const reasoningKey = effort.trim() === 'xhigh' ? 'max' : effort.trim();
  const chipReasoning = reasoningKey && reasoningKey !== 'off' && reasoningKey !== 'inherit'
    ? (reasoningCopy as Record<string, string>)[reasoningKey] ?? null
    : null;

  // Reasoning options come from the effective model's supported levels, ranked by the
  // shared ladder. A `''` effort (inherit) simply leaves no level checked.
  const supportedLevels = effectiveModelOption?.supportedThinkingLevels.length
    ? effectiveModelOption.supportedThinkingLevels
    : AGENT_REASONING_LADDER;
  const reasoningLevels = AGENT_REASONING_LADDER.filter((level) => supportedLevels.includes(level));
  const supportsReasoning = Boolean(effectiveModelOption?.reasoning) || reasoningLevels.some((level) => level !== 'off');

  function close() {
    setOpen(false);
    setModelSubmenuOpen(false);
  }

  function selectModel(providerId: string, option: AgentModelOption) {
    const nextLevels = option.supportedThinkingLevels.length ? option.supportedThinkingLevels : AGENT_REASONING_LADDER;
    // Drop an effort the newly-chosen model cannot honour (same reconciliation as the
    // Settings selector) so the stored value never diverges from what can run.
    if (effort && !nextLevels.includes(effort as AgentReasoningLevel)) onEffortChange('');
    onModelChange(composeProviderQualifiedModel(providerId, option.id));
    close();
  }

  function selectEffort(next: AgentReasoningLevel) {
    onEffortChange(next);
    close();
  }

  function renderModelItem(providerId: string, option: AgentModelOption) {
    const selected = providerId === effectiveProviderId && option.id === effectiveModelId;
    return (
      <button
        key={`${providerId}:${option.id}`}
        aria-checked={selected}
        className={`agent-composer-model-item${selected ? ' is-selected' : ''}`}
        onClick={() => selectModel(providerId, option)}
        role="menuitemradio"
        type="button"
      >
        <span className="agent-composer-model-item-label">{option.name || option.id}</span>
        <span className="agent-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
      </button>
    );
  }

  return (
    <div className="agent-composer-model">
      <ButtonControl
        ref={anchorRef}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={composer.modelControlLabel}
        className="agent-composer-model-button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={composer.modelControlLabel}
      >
        <span className="agent-composer-model-name">{modelName}</span>
        {chipReasoning ? <span className="agent-composer-reasoning-chip">{chipReasoning}</span> : null}
        <ChevronDownIcon size={ICON_SIZE.tiny} />
      </ButtonControl>
      {open
        ? createPortal(
          <div
            ref={menuRef}
            className="agent-composer-model-popover"
            role="menu"
            aria-label={composer.modelControlLabel}
            style={overlayStyle}
          >
            {supportsReasoning ? (
              <>
                <div className="agent-composer-model-section-label">{composer.reasoningHeading}</div>
                {reasoningLevels.map((level) => {
                  const selected = effort === level;
                  return (
                    <button
                      key={level}
                      aria-checked={selected}
                      className={`agent-composer-model-item${selected ? ' is-selected' : ''}`}
                      onClick={() => selectEffort(level)}
                      role="menuitemradio"
                      type="button"
                    >
                      <span className="agent-composer-model-item-label">{reasoningLabel(level)}</span>
                      <span className="agent-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
                    </button>
                  );
                })}
              </>
            ) : null}
            {modelCount > 0 ? (
              <>
                {supportsReasoning ? <div className="agent-composer-model-divider" /> : null}
                <button
                  ref={modelRowRef}
                  aria-expanded={modelSubmenuOpen}
                  aria-haspopup="menu"
                  className={`agent-composer-model-item agent-composer-model-row${modelSubmenuOpen ? ' is-open' : ''}`}
                  onClick={() => setModelSubmenuOpen((value) => !value)}
                  onMouseEnter={() => setModelSubmenuOpen(true)}
                  role="menuitem"
                  type="button"
                >
                  <span className="agent-composer-model-item-label">{modelName}</span>
                  <ChevronRightIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
                </button>
              </>
            ) : null}
          </div>,
          document.body,
        )
        : null}
      {open && modelSubmenuOpen && modelCount > 0
        ? createPortal(
          <div
            ref={submenuRef}
            className="agent-composer-model-popover agent-composer-model-submenu"
            role="menu"
            aria-label={composer.modelHeading}
            style={submenuStyle}
          >
            <div className="agent-composer-model-section-label">{composer.modelHeading}</div>
            {groups.map((group) => (
              <div key={group.providerId} className="agent-composer-model-group">
                {groups.length > 1 ? (
                  <div className="agent-composer-model-group-label">{group.providerId}</div>
                ) : null}
                {group.models.map((option) => renderModelItem(group.providerId, option))}
              </div>
            ))}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

interface ModelMenu {
  effectiveProviderId: string;
  effectiveModelId: string;
  effectiveModelOption: AgentModelOption | undefined;
  /** Every usable provider's models, grouped (active provider first, header shown
   *  only when more than one group). The full list lives in the model submenu. */
  groups: Array<{ providerId: string; models: AgentModelOption[] }>;
  modelCount: number;
}

/**
 * Resolve the effective selection and the full grouped model list. The provider that
 * owns the current selection (or the active provider when inherit) leads; its first-
 * ranked model stands in for inherit, so the chip and the current-model row show the
 * model the runtime actually runs.
 */
function deriveModelMenu(settings: AgentProviderSettingsView | null, model: string): ModelMenu {
  if (!settings) {
    return { effectiveProviderId: '', effectiveModelId: '', effectiveModelOption: undefined, groups: [], modelCount: 0 };
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
  const effectiveModelId = selection.modelId || modelsFor(primaryProviderId)[0]?.id || '';
  const effectiveModelOption = modelsFor(primaryProviderId).find((option) => option.id === effectiveModelId);

  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId);
  const orderedProviderIds = dedupe([primaryProviderId, activeProviderId, ...usableProviderIds].filter(Boolean));
  const groups = orderedProviderIds
    .map((providerId) => ({ providerId, models: modelsFor(providerId) }))
    .filter((group) => group.models.length > 0);
  const modelCount = groups.reduce((total, group) => total + group.models.length, 0);

  return { effectiveProviderId: primaryProviderId, effectiveModelId, effectiveModelOption, groups, modelCount };
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/** The model id's last path segment (drops a `provider/` prefix), or null for inherit. */
function lastModelSegment(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'inherit') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

const finite = (value: number, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(finite(value), max));

/**
 * Position a flyout submenu beside its trigger row: to the left of the parent menu
 * (the row spans the menu, so the row's left edge is the menu's left edge), flipping
 * to the right when there isn't room. Vertically aligned to the row, clamped to the
 * viewport. Self-contained (the shared `useAnchoredOverlay` only does top/bottom).
 */
function useFlyoutStyle(
  ref: RefObject<HTMLDivElement | null>,
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
  layoutKey: string,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -9999, top: -9999, width });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const el = ref.current;
      if (!anchor || !el) return;
      const margin = 8;
      const gap = 4;
      const viewportWidth = finite(window.innerWidth);
      const viewportHeight = finite(window.innerHeight);
      const anchorLeft = finite(anchor.left);
      const anchorRight = finite(anchor.right);
      const anchorTop = finite(anchor.top);
      const height = finite(el.offsetHeight);
      const fitsLeft = anchorLeft - gap - width >= margin;
      const left = fitsLeft
        ? Math.max(margin, anchorLeft - gap - width)
        : clamp(anchorRight + gap, margin, Math.max(margin, viewportWidth - width - margin));
      const top = clamp(anchorTop - margin, margin, Math.max(margin, viewportHeight - height - margin));
      setStyle({ position: 'fixed', left, top, width, maxHeight: Math.max(0, viewportHeight - 2 * margin) });
    };
    update();
    const requestFrame = window.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0));
    const cancelFrame = window.cancelAnimationFrame ?? ((handle: number) => window.clearTimeout(handle));
    const frame = requestFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      cancelFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, width, layoutKey, ref, anchorRef]);
  return style;
}
