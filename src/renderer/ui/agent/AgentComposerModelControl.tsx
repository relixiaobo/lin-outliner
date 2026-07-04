import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { composeProviderQualifiedModel } from '../../../core/agentModelId';
import { defaultThinkingLevelFor, reasoningLevelLabelKey } from '../../../core/agentReasoning';
import { AGENT_REASONING_LADDER } from '../../../core/types';
import type { AgentModelOption, AgentProviderSettingsView, AgentReasoningLevel } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { ButtonControl } from '../primitives/ButtonControl';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from '../icons';
import { parseModelSelection } from './AgentModelEffortSelector';
import { isProviderUsable, resolveUsableActiveProvider } from './providerUsability';

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

type OpenSubmenu = 'none' | 'effort' | 'model';

// Models shown per provider before the "Show all" expander. The catalog is ranked
// newest-first, so the first few are the current/recommended models; the long tail of
// older models stays one click away.
const RECENT_MODEL_COUNT = 6;

// The composer's quick model + reasoning chip. Selecting here edits the single
// assistant's (Neva's) standing profile through the same path as Settings → Agent
// (provider-connection-model-ownership #267 keeps model/effort a profile property);
// the runtime applies the change on the next turn. The main menu shows only the
// *results* — the current reasoning level and the current model — as two rows that
// each open a side-anchored flyout submenu (the reasoning levels; the full model list,
// grouped by provider with each provider's older models behind a "Show all"). Portaled
// so it never clips against the composer's overflow. Memoized because the composer
// re-renders on every keystroke (draft state); with stable props this control — and
// its catalog derivation — is skipped entirely.
function AgentComposerModelControlImpl({
  settings,
  model,
  effort,
  disabled,
  onModelChange,
  onEffortChange,
}: AgentComposerModelControlProps) {
  const composer = useT().agent.composer;
  const reasoningCopy = composer.reasoningLevels;
  const reasoningLabel = (level: AgentReasoningLevel) => reasoningCopy[reasoningLevelLabelKey(level)];

  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<OpenSubmenu>('none');
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const effortRowRef = useRef<HTMLButtonElement>(null);
  const modelRowRef = useRef<HTMLButtonElement>(null);

  const menu = useMemo(() => deriveModelMenu(settings, model), [settings, model]);
  const { effectiveProviderId, effectiveModelId, effectiveModelOption, groups, modelCount } = menu;

  const overlayStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    placement: 'top-end',
    width: 240,
    maxHeight: 360,
    layoutKey: `${model}:${effort}`,
  });
  const submenuAnchor = submenu === 'effort' ? effortRowRef : modelRowRef;
  const expandedKey = [...expandedProviders].join(',');
  const submenuStyle = useFlyoutStyle(submenuRef, submenuAnchor, open && submenu !== 'none', 260, `${submenu}:${model}:${effort}:${expandedKey}`);
  // The Escape handler (bound once per open) reads the live submenu through a ref so it
  // stays a pure state setter rather than a side-effecting updater.
  const submenuStateRef = useRef<OpenSubmenu>('none');
  submenuStateRef.current = submenu;

  // Portaled surfaces: dismiss on outside pointer (ignoring the anchor so a click on
  // the chip toggles rather than close-then-reopens) and on Escape. Reset transient
  // state when the menu closes so it reopens fresh.
  useEffect(() => {
    if (!open) {
      setSubmenu('none');
      setExpandedProviders(new Set());
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
      if (submenuStateRef.current !== 'none') setSubmenu('none');
      else setOpen(false);
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
  const trimmedEffort = effort.trim();
  const chipReasoning = trimmedEffort && trimmedEffort !== 'off' && trimmedEffort !== 'inherit'
    ? reasoningLabel(trimmedEffort as AgentReasoningLevel)
    : null;

  // Reasoning options come from the effective model's supported levels, ranked by the
  // shared ladder; `defaultLevel` is the level inherit resolves to (badged "Default").
  // Only an in-catalog model contributes levels — an unknown/out-of-catalog selection
  // has no declared levels, so the Reasoning row is hidden rather than offering (and
  // persisting) levels the model may reject (the runtime would coerce them anyway).
  const supportedLevels = effectiveModelOption?.supportedThinkingLevels ?? [];
  const reasoningLevels = AGENT_REASONING_LADDER.filter((level) => supportedLevels.includes(level));
  const supportsReasoning = reasoningLevels.some((level) => level !== 'off');
  const defaultLevel = defaultThinkingLevelFor(reasoningLevels);
  // The reasoning row's value: the chosen level, or "Default" for inherit.
  const effortRowLabel = supportedLevels.includes(effort as AgentReasoningLevel)
    ? reasoningLabel(effort as AgentReasoningLevel)
    : composer.effortDefault;

  function close() {
    setOpen(false);
    setSubmenu('none');
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

  function toggleSubmenu(next: Exclude<OpenSubmenu, 'none'>) {
    setSubmenu((current) => (current === next ? 'none' : next));
  }

  function expandProvider(providerId: string) {
    setExpandedProviders((current) => new Set(current).add(providerId));
  }

  function collapseProvider(providerId: string) {
    setExpandedProviders((current) => {
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
  }

  function renderModelItem(providerId: string, option: AgentModelOption) {
    const selected = providerId === effectiveProviderId && option.id === effectiveModelId;
    return (
      <ButtonControl
        key={`${providerId}:${option.id}`}
        aria-checked={selected}
        className={`agent-composer-model-item${selected ? ' is-selected' : ''}`}
        onClick={() => selectModel(providerId, option)}
        role="menuitemradio"
      >
        <span className="agent-composer-model-item-label">{option.name || option.id}</span>
        <span className="agent-composer-model-spacer" />
        <span className="agent-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
      </ButtonControl>
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
              <ButtonControl
                ref={effortRowRef}
                aria-expanded={submenu === 'effort'}
                aria-haspopup="menu"
                className={`agent-composer-model-item agent-composer-model-row${submenu === 'effort' ? ' is-open' : ''}`}
                onClick={() => toggleSubmenu('effort')}
                onMouseEnter={() => setSubmenu('effort')}
                role="menuitem"
              >
                <span className="agent-composer-model-item-label">{composer.reasoningHeading}</span>
                <span className="agent-composer-model-spacer" />
                <span className="agent-composer-model-item-meta">{effortRowLabel}</span>
                <ChevronRightIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
              </ButtonControl>
            ) : null}
            {modelCount > 0 ? (
              <ButtonControl
                ref={modelRowRef}
                aria-expanded={submenu === 'model'}
                aria-haspopup="menu"
                className={`agent-composer-model-item agent-composer-model-row${submenu === 'model' ? ' is-open' : ''}`}
                onClick={() => toggleSubmenu('model')}
                onMouseEnter={() => setSubmenu('model')}
                role="menuitem"
              >
                <span className="agent-composer-model-item-label">{modelName}</span>
                <span className="agent-composer-model-spacer" />
                <ChevronRightIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
              </ButtonControl>
            ) : null}
          </div>,
          document.body,
        )
        : null}
      {open && submenu === 'effort'
        ? createPortal(
          <div
            ref={submenuRef}
            className="agent-composer-model-popover agent-composer-model-submenu"
            role="menu"
            aria-label={composer.reasoningHeading}
            style={submenuStyle}
          >
            <div className="agent-composer-model-section-hint" role="presentation">{composer.reasoningHint}</div>
            {reasoningLevels.map((level) => {
              const selected = effort === level;
              return (
                <ButtonControl
                  key={level}
                  aria-checked={selected}
                  className={`agent-composer-model-item${selected ? ' is-selected' : ''}`}
                  onClick={() => selectEffort(level)}
                  role="menuitemradio"
                >
                  <span className="agent-composer-model-item-label">{reasoningLabel(level)}</span>
                  {level === defaultLevel ? (
                    <span className="agent-composer-model-badge">{composer.effortDefault}</span>
                  ) : null}
                  <span className="agent-composer-model-spacer" />
                  <span className="agent-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
                </ButtonControl>
              );
            })}
          </div>,
          document.body,
        )
        : null}
      {open && submenu === 'model' && modelCount > 0
        ? createPortal(
          <div
            ref={submenuRef}
            className="agent-composer-model-popover agent-composer-model-submenu"
            role="menu"
            aria-label={composer.modelHeading}
            style={submenuStyle}
          >
            <div className="agent-composer-model-section-label" role="presentation">{composer.modelHeading}</div>
            {groups.map((group) => {
              const expanded = expandedProviders.has(group.providerId);
              const visible = visibleModels(group, expanded, effectiveProviderId, effectiveModelId);
              return (
                <div key={group.providerId} className="agent-composer-model-group" role="presentation">
                  {groups.length > 1 ? (
                    <div className="agent-composer-model-group-label" role="presentation">{group.providerId}</div>
                  ) : null}
                  {visible.map((option) => renderModelItem(group.providerId, option))}
                  {group.models.length > visible.length ? (
                    <ButtonControl
                      className="agent-composer-model-item agent-composer-model-expander"
                      onClick={() => expandProvider(group.providerId)}
                    >
                      <span className="agent-composer-model-item-label">{composer.showAllModels({ count: group.models.length })}</span>
                      <span className="agent-composer-model-spacer" />
                      <ChevronDownIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
                    </ButtonControl>
                  ) : null}
                  {expanded && group.models.length > RECENT_MODEL_COUNT ? (
                    <ButtonControl
                      className="agent-composer-model-item agent-composer-model-expander"
                      onClick={() => collapseProvider(group.providerId)}
                    >
                      <span className="agent-composer-model-item-label">{composer.showFewerModels}</span>
                    </ButtonControl>
                  ) : null}
                </div>
              );
            })}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

export const AgentComposerModelControl = memo(AgentComposerModelControlImpl);

interface ModelGroup {
  providerId: string;
  models: AgentModelOption[];
}

interface ModelMenu {
  effectiveProviderId: string;
  effectiveModelId: string;
  effectiveModelOption: AgentModelOption | undefined;
  /** Every usable provider's models, grouped (active provider first, header shown
   *  only when more than one group). The full list lives in the model submenu. */
  groups: ModelGroup[];
  modelCount: number;
}

/**
 * The models shown for a provider before "Show all": the first `RECENT_MODEL_COUNT`
 * (the catalog is ranked newest-first), plus the current selection when it falls in
 * the older tail so the active model is never hidden.
 */
function visibleModels(
  group: ModelGroup,
  expanded: boolean,
  effectiveProviderId: string,
  effectiveModelId: string,
): AgentModelOption[] {
  if (expanded) return group.models;
  const recent = group.models.slice(0, RECENT_MODEL_COUNT);
  if (group.providerId === effectiveProviderId && !recent.some((option) => option.id === effectiveModelId)) {
    const selected = group.models.find((option) => option.id === effectiveModelId);
    if (selected) return [...recent, selected];
  }
  return recent;
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
  const activeProviderId = resolveUsableActiveProvider(settings)?.providerId ?? '';
  const knownProviderIds = new Set<string>([
    ...settings.availableProviders.map((provider) => provider.providerId),
    ...settings.providers.map((provider) => provider.providerId),
  ]);
  const selection = parseModelSelection(model, activeProviderId, (id) => knownProviderIds.has(id));
  const modelsFor = (providerId: string): AgentModelOption[] => (
    settings.availableProviders.find((provider) => provider.providerId === providerId)?.models ?? []
  );
  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId);

  const selectionProviderUsable = Boolean(selection.providerId && usableProviderIds.includes(selection.providerId));
  const primaryProviderId = selectionProviderUsable
    ? selection.providerId
    : activeProviderId || usableProviderIds[0] || '';
  const effectiveModelId = selectionProviderUsable && selection.modelId
    ? selection.modelId
    : modelsFor(primaryProviderId)[0]?.id || '';
  const effectiveModelOption = modelsFor(primaryProviderId).find((option) => option.id === effectiveModelId);

  const orderedProviderIds = dedupe([primaryProviderId, ...usableProviderIds].filter(Boolean));
  const groups: ModelGroup[] = orderedProviderIds
    .map((providerId) => ({ providerId, models: modelsFor(providerId) }))
    .filter((group) => group.models.length > 0);

  // A saved model the catalog no longer lists (catalog changed, or a custom connection)
  // would otherwise be invisible and unchecked. Surface it in its provider's group so it
  // shows and stays selected — its empty `supportedThinkingLevels` keeps the Reasoning
  // row hidden, so no unsupported effort is offered for it.
  if (effectiveModelId && !effectiveModelOption) {
    const synthetic: AgentModelOption = {
      id: effectiveModelId,
      name: lastModelSegment(effectiveModelId) ?? effectiveModelId,
      reasoning: false,
      supportedThinkingLevels: [],
      contextWindow: 0,
      maxTokens: 0,
    };
    const group = groups.find((candidate) => candidate.providerId === primaryProviderId);
    if (group) group.models = [synthetic, ...group.models];
    else groups.unshift({ providerId: primaryProviderId, models: [synthetic] });
  }
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
