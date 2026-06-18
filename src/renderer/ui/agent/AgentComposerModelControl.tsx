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

type OpenSubmenu = 'none' | 'effort' | 'models';

// The composer's quick model + reasoning chip. Selecting here edits the single
// assistant's (Neva's) standing profile through the same path as Settings → Agent
// (provider-connection-model-ownership #267 keeps model/effort a profile property);
// the runtime applies the change on the next turn. The interaction mirrors the
// Claude-desktop / nodex chat composer: the chip opens a compact menu showing the
// recommended model directly, with reasoning and the long tail of models as
// side-anchored flyout submenus (`Effort ›`, `More models ›`). The menu is portaled
// so it never clips against the composer's overflow.
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
  const [submenu, setSubmenu] = useState<OpenSubmenu>('none');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const effortRowRef = useRef<HTMLButtonElement>(null);
  const moreRowRef = useRef<HTMLButtonElement>(null);

  const menu = deriveModelMenu(settings, model);
  const { effectiveProviderId, effectiveModelId, effectiveModelOption, featured, groups } = menu;

  const overlayStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    placement: 'top-end',
    width: 240,
    maxHeight: 360,
    layoutKey: `${model}:${effort}`,
  });
  const submenuAnchor = submenu === 'effort' ? effortRowRef : moreRowRef;
  const submenuStyle = useFlyoutStyle(submenuRef, submenuAnchor, open && submenu !== 'none', 240, `${submenu}:${model}:${effort}`);

  // Portaled surfaces: dismiss on outside pointer (ignoring the anchor so a click on
  // the chip toggles rather than close-then-reopens) and on Escape. Reset the open
  // submenu when the menu closes so it reopens in its default state.
  useEffect(() => {
    if (!open) {
      setSubmenu('none');
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
      setSubmenu((current) => {
        if (current !== 'none') return 'none';
        setOpen(false);
        return 'none';
      });
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Chip face: the resolved model name (explicit catalog name, or the active
  // provider's recommended model for inherit) plus the reasoning level when set.
  const modelName = effectiveModelOption?.name
    ?? lastModelSegment(effectiveModelId)
    ?? composer.modelDefault;
  const reasoningKey = effort.trim() === 'xhigh' ? 'max' : effort.trim();
  const chipReasoning = reasoningKey && reasoningKey !== 'off' && reasoningKey !== 'inherit'
    ? (reasoningCopy as Record<string, string>)[reasoningKey] ?? null
    : null;

  // Reasoning options come from the effective model's supported levels, ranked by the
  // shared ladder; a leading "Default" entry maps back to inherit (`''`).
  const supportedLevels = effectiveModelOption?.supportedThinkingLevels.length
    ? effectiveModelOption.supportedThinkingLevels
    : AGENT_REASONING_LADDER;
  const supportsReasoning = Boolean(effectiveModelOption?.reasoning) || supportedLevels.some((level) => level !== 'off');
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

  function selectEffort(next: string) {
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
            {featured.map((entry) => renderModelItem(entry.providerId, entry.option))}
            {supportsReasoning ? (
              <button
                ref={effortRowRef}
                aria-expanded={submenu === 'effort'}
                aria-haspopup="menu"
                className={`agent-composer-model-item agent-composer-model-row${submenu === 'effort' ? ' is-open' : ''}`}
                onClick={() => setSubmenu((current) => (current === 'effort' ? 'none' : 'effort'))}
                onMouseEnter={() => setSubmenu('effort')}
                role="menuitem"
                type="button"
              >
                <span className="agent-composer-model-item-label">{composer.reasoningHeading}</span>
                <span className="agent-composer-model-item-meta">{effortRowLabel}</span>
                <ChevronRightIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
              </button>
            ) : null}
            {groups.length > 0 ? (
              <button
                ref={moreRowRef}
                aria-expanded={submenu === 'models'}
                aria-haspopup="menu"
                className={`agent-composer-model-item agent-composer-model-row${submenu === 'models' ? ' is-open' : ''}`}
                onClick={() => setSubmenu((current) => (current === 'models' ? 'none' : 'models'))}
                onMouseEnter={() => setSubmenu('models')}
                role="menuitem"
                type="button"
              >
                <span className="agent-composer-model-item-label">{composer.moreModels}</span>
                <ChevronRightIcon className="agent-composer-model-item-caret" size={ICON_SIZE.menu} />
              </button>
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
            <button
              aria-checked={!supportedLevels.includes(effort as AgentReasoningLevel)}
              className={`agent-composer-model-item${!supportedLevels.includes(effort as AgentReasoningLevel) ? ' is-selected' : ''}`}
              onClick={() => selectEffort('')}
              role="menuitemradio"
              type="button"
            >
              <span className="agent-composer-model-item-label">{composer.effortDefault}</span>
              <span className="agent-composer-model-check">
                {!supportedLevels.includes(effort as AgentReasoningLevel) ? <CheckIcon size={ICON_SIZE.menu} /> : null}
              </span>
            </button>
            {AGENT_REASONING_LADDER.filter((level) => supportedLevels.includes(level)).map((level) => {
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
          </div>,
          document.body,
        )
        : null}
      {open && submenu === 'models'
        ? createPortal(
          <div
            ref={submenuRef}
            className="agent-composer-model-popover agent-composer-model-submenu"
            role="menu"
            aria-label={composer.moreModels}
            style={submenuStyle}
          >
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
  /** Models shown directly: the active provider's recommended (top-ranked) model and,
   *  if different, the current selection — so the active model is always visible. */
  featured: Array<{ providerId: string; option: AgentModelOption }>;
  /** The long tail, grouped by provider (header shown only when more than one group). */
  groups: Array<{ providerId: string; models: AgentModelOption[] }>;
}

/**
 * Split the catalog into the recommended model (shown directly) and the long tail
 * (hidden under "More models", grouped by provider). The active provider's first-
 * ranked model is the recommendation; for inherit it also stands in for the chip and
 * check mark, so they show the model the runtime actually runs.
 */
function deriveModelMenu(settings: AgentProviderSettingsView | null, model: string): ModelMenu {
  if (!settings) {
    return { effectiveProviderId: '', effectiveModelId: '', effectiveModelOption: undefined, featured: [], groups: [] };
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

  const featuredKeys = new Set<string>();
  const featured: Array<{ providerId: string; option: AgentModelOption }> = [];
  const pushFeatured = (providerId: string, option: AgentModelOption | undefined) => {
    if (!option) return;
    const key = `${providerId}:${option.id}`;
    if (featuredKeys.has(key)) return;
    featuredKeys.add(key);
    featured.push({ providerId, option });
  };
  // The recommended (latest) model first, then the active selection when it differs.
  pushFeatured(activeProviderId, modelsFor(activeProviderId)[0]);
  pushFeatured(primaryProviderId, effectiveModelOption);

  const usableProviderIds = settings.providers
    .filter((provider) => isProviderUsable(settings, provider))
    .map((provider) => provider.providerId);
  const orderedProviderIds = dedupe([primaryProviderId, activeProviderId, ...usableProviderIds].filter(Boolean));
  const groups = orderedProviderIds
    .map((providerId) => ({
      providerId,
      models: modelsFor(providerId).filter((option) => !featuredKeys.has(`${providerId}:${option.id}`)),
    }))
    .filter((group) => group.models.length > 0);

  return { effectiveProviderId: primaryProviderId, effectiveModelId, effectiveModelOption, featured, groups };
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
