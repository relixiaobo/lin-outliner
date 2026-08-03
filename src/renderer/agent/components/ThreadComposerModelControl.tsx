import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { defaultThinkingLevelFor } from '../../../core/agentReasoning';
import { REASONING_EFFORTS, type ReasoningEffort } from '../../../core/agent/configuration';
import type { ThreadConfigurationSummary } from '../../../core/agent/protocol';
import type { AgentModelOption, AgentProviderSettingsView } from '../../api/types';
import { useT } from '../../i18n/I18nProvider';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ICON_SIZE } from '../../ui/icons';
import { ButtonControl } from '../../ui/primitives/ButtonControl';
import { useAnchoredOverlay } from '../../ui/primitives/useAnchoredOverlay';
import { useMenuKeyboard } from '../../ui/primitives/useMenuKeyboard';
import { formatProviderName } from '../../ui/agent/providerNames';
import {
  buildModelChoices,
  lastModelSegment,
  type ModelChoice,
  type ModelChoiceGroup,
} from '../../ui/agent/modelChoices';

interface ThreadComposerModelControlProps {
  readonly configuration: ThreadConfigurationSummary;
  readonly disabled: boolean;
  readonly settings: AgentProviderSettingsView | null;
  readonly onChange: (next: ThreadConfigurationSummary) => Promise<void>;
}

type OpenSubmenu = 'none' | 'effort' | 'model';

const RECENT_MODEL_COUNT = 6;

function ThreadComposerModelControlImpl({
  configuration,
  disabled,
  onChange,
  settings,
}: ThreadComposerModelControlProps) {
  const composer = useT().agent.composer;
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<OpenSubmenu>('none');
  const [saving, setSaving] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const effortRowRef = useRef<HTMLButtonElement>(null);
  const modelRowRef = useRef<HTMLButtonElement>(null);
  const submenuStateRef = useRef<OpenSubmenu>('none');
  submenuStateRef.current = submenu;

  const menu = useMemo(
    () => buildModelChoices(settings, configuration),
    [configuration, settings],
  );
  const {
    connectionHead,
    floating,
    groups,
    modelCount,
    resolvedModelId,
    resolvedOption: effectiveModelOption,
    resolvedProviderId: effectiveProviderId,
    showProviderLabel,
  } = menu;
  const effectiveModelId = resolvedModelId;
  // The pill and the parent row always name the model that will actually run,
  // floating or pinned. Only the check mark distinguishes the two.
  const modelName = effectiveModelOption?.name
    ?? lastModelSegment(effectiveModelId)
    ?? composer.modelDefault;
  const supportedLevels = effectiveModelOption?.supportedThinkingLevels ?? [];
  const reasoningLevels = REASONING_EFFORTS.filter((level) => supportedLevels.includes(level));
  const supportsReasoning = reasoningLevels.some((level) => level !== 'off');
  const defaultLevel = defaultThinkingLevelFor(reasoningLevels);
  const effortLabel = reasoningLabel(configuration.reasoningEffort, effectiveModelOption, composer.reasoningLevels);

  const overlayStyle = useAnchoredOverlay(menuRef, {
    anchorRef,
    disabled: !open,
    placement: 'top-end',
    width: 240,
    maxHeight: 360,
    layoutKey: `${configuration.model}:${configuration.reasoningEffort}`,
  });
  const submenuAnchor = submenu === 'effort' ? effortRowRef : modelRowRef;
  const expandedKey = [...expandedProviders].join(',');
  const submenuStyle = useFlyoutStyle(
    submenuRef,
    submenuAnchor,
    open && submenu !== 'none',
    260,
    `${submenu}:${configuration.model}:${configuration.reasoningEffort}:${expandedKey}`,
  );

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

  function close() {
    setOpen(false);
    setSubmenu('none');
  }

  const { onKeyDown: onMenuKeyDown } = useMenuKeyboard({
    surfaceRef: menuRef,
    onClose: close,
    kind: 'menu',
    active: open,
    getRestoreTarget: () => anchorRef.current,
    initialFocus: 'surface',
    focusKey: `${configuration.model}:${configuration.reasoningEffort}:${submenu}`,
  });
  const { onKeyDown: onSubmenuKeyDown } = useMenuKeyboard({
    surfaceRef: submenuRef,
    onClose: () => setSubmenu('none'),
    kind: 'menu',
    active: open && submenu !== 'none',
    getRestoreTarget: () => submenuAnchor.current ?? anchorRef.current,
    initialFocus: 'surface',
    focusKey: `${submenu}:${configuration.model}:${configuration.reasoningEffort}:${expandedKey}`,
  });

  async function commit(next: ThreadConfigurationSummary) {
    if (saving) return;
    setSaving(true);
    try {
      await onChange(next);
      close();
    } catch {
      // The composer surface owns the visible error; keep the menu open for retry.
    } finally {
      setSaving(false);
    }
  }

  /** Keep the current effort when the target model supports it, else fall back to its default. */
  function effortFor(option: AgentModelOption | undefined): ReasoningEffort {
    const supported = option?.supportedThinkingLevels.length
      ? option.supportedThinkingLevels
      : REASONING_EFFORTS;
    return supported.includes(configuration.reasoningEffort)
      ? configuration.reasoningEffort
      : defaultThinkingLevelFor(supported);
  }

  function selectModel(choice: ModelChoice) {
    void commit({
      modelProvider: choice.providerId,
      model: choice.value,
      reasoningEffort: effortFor(choice.option),
    });
  }

  /**
   * Follow this connection's newest model. Only the model field is written —
   * `modelProvider` is left alone, so selecting this never moves a Thread to a
   * different connection.
   *
   * The effort is clamped against `connectionHead`, the model the sentinel will
   * resolve to — NOT against the model being un-pinned. Main validates the
   * sentinel by resolving it and rejects an unsupported effort
   * (`validateAgentModelSelection`); clamping against the outgoing model lets a
   * level through that the head does not support, main throws, `commit` swallows
   * it, and the Thread can never be un-pinned at all.
   */
  function selectFloatingModel() {
    void commit({
      ...configuration,
      model: 'inherit',
      reasoningEffort: effortFor(connectionHead),
    });
  }

  function selectEffort(reasoningEffort: ReasoningEffort) {
    void commit({ ...configuration, reasoningEffort });
  }

  function renderModelItem(choice: ModelChoice) {
    const { option, providerId } = choice;
    // A floating selection resolves to the ranked head, so without this guard the
    // check mark would land on that model and read as an explicit pin to it.
    const selected = !floating && providerId === effectiveProviderId && option.id === effectiveModelId;
    return (
      <ButtonControl
        aria-checked={selected}
        className={`thread-composer-model-item${selected ? ' is-selected' : ''}`}
        disabled={saving}
        key={choice.value}
        onClick={() => selectModel(choice)}
        role="menuitemradio"
      >
        <span className="thread-composer-model-item-label">{option.name || option.id}</span>
        {showProviderLabel ? (
          <span className="thread-composer-model-item-origin">{formatProviderName(providerId)}</span>
        ) : null}
        <span className="thread-composer-model-spacer" />
        <span className="thread-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
      </ButtonControl>
    );
  }

  return (
    <div className="thread-composer-model-control">
      <ButtonControl
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={composer.modelControlLabel}
        className="thread-composer-model-button"
        disabled={disabled || !settings || saving}
        onClick={() => setOpen((value) => !value)}
        ref={anchorRef}
        title={composer.modelControlLabel}
      >
        <span className="thread-composer-model-name">{modelName}</span>
        {configuration.reasoningEffort !== 'off' ? (
          <span className="thread-composer-reasoning-chip">{effortLabel}</span>
        ) : null}
        <ChevronDownIcon size={ICON_SIZE.tiny} />
      </ButtonControl>
      {open ? createPortal(
        <div
          aria-label={composer.modelControlLabel}
          className="thread-composer-model-popover"
          onKeyDown={onMenuKeyDown}
          ref={menuRef}
          role="menu"
          style={overlayStyle}
        >
          {supportsReasoning ? (
            <ButtonControl
              aria-expanded={submenu === 'effort'}
              aria-haspopup="menu"
              className={`thread-composer-model-item thread-composer-model-row${submenu === 'effort' ? ' is-open' : ''}`}
              onClick={() => setSubmenu('effort')}
              onMouseEnter={() => setSubmenu('effort')}
              ref={effortRowRef}
              role="menuitem"
            >
              <span className="thread-composer-model-item-label">{composer.reasoningHeading}</span>
              <span className="thread-composer-model-spacer" />
              <span className="thread-composer-model-item-meta">{effortLabel}</span>
              <ChevronRightIcon className="thread-composer-model-item-caret" size={ICON_SIZE.menu} />
            </ButtonControl>
          ) : null}
          {modelCount > 0 ? (
            <ButtonControl
              aria-expanded={submenu === 'model'}
              aria-haspopup="menu"
              className={`thread-composer-model-item thread-composer-model-row${submenu === 'model' ? ' is-open' : ''}`}
              onClick={() => setSubmenu('model')}
              onMouseEnter={() => setSubmenu('model')}
              ref={modelRowRef}
              role="menuitem"
            >
              <span className="thread-composer-model-item-label">{modelName}</span>
              <span className="thread-composer-model-spacer" />
              <ChevronRightIcon className="thread-composer-model-item-caret" size={ICON_SIZE.menu} />
            </ButtonControl>
          ) : null}
        </div>,
        document.body,
      ) : null}
      {open && submenu === 'effort' ? createPortal(
        <div
          aria-label={composer.reasoningHeading}
          className="thread-composer-model-popover thread-composer-model-submenu"
          onKeyDown={onSubmenuKeyDown}
          ref={submenuRef}
          role="menu"
          style={submenuStyle}
        >
          <div className="thread-composer-model-section-hint" role="presentation">{composer.reasoningHint}</div>
          {reasoningLevels.map((level) => {
            const selected = configuration.reasoningEffort === level;
            return (
              <ButtonControl
                aria-checked={selected}
                className={`thread-composer-model-item${selected ? ' is-selected' : ''}`}
                disabled={saving}
                key={level}
                onClick={() => selectEffort(level)}
                role="menuitemradio"
              >
                <span className="thread-composer-model-item-label">
                  {reasoningLabel(level, effectiveModelOption, composer.reasoningLevels)}
                </span>
                {level === defaultLevel ? (
                  <span className="thread-composer-model-badge">{composer.effortDefault}</span>
                ) : null}
                <span className="thread-composer-model-spacer" />
                <span className="thread-composer-model-check">{selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
              </ButtonControl>
            );
          })}
        </div>,
        document.body,
      ) : null}
      {open && submenu === 'model' && modelCount > 0 ? createPortal(
        <div
          aria-label={composer.modelHeading}
          className="thread-composer-model-popover thread-composer-model-submenu"
          onKeyDown={onSubmenuKeyDown}
          ref={submenuRef}
          role="menu"
          style={submenuStyle}
        >
          <div className="thread-composer-model-section-label" role="presentation">{composer.modelHeading}</div>
          {/* Only offered when this connection actually resolves a model. Without
              the guard the row still renders off the aggregate model count, and
              committing the sentinel against a connection that lists none makes
              main throw from a row that looked applicable. */}
          {connectionHead ? (
            <ButtonControl
              aria-checked={floating}
              className={`thread-composer-model-item${floating ? ' is-selected' : ''}`}
              disabled={saving}
              onClick={selectFloatingModel}
              role="menuitemradio"
            >
              <span className="thread-composer-model-item-label">{composer.modelAlwaysNewest}</span>
              {/* The head, not the pinned model: this names what selecting the row
                  would switch TO. */}
              <span className="thread-composer-model-item-origin">{connectionHead.name || connectionHead.id}</span>
              <span className="thread-composer-model-spacer" />
              <span className="thread-composer-model-check">{floating ? <CheckIcon size={ICON_SIZE.menu} /> : null}</span>
            </ButtonControl>
          ) : null}
          {/* Providers stay a truncation unit but not a visual one: no heading, so
              the models read as one flat list with provider shown per row. */}
          {groups.map((group) => {
            const expanded = expandedProviders.has(group.providerId);
            const visible = visibleModels(group, expanded, floating ? '' : effectiveProviderId, effectiveModelId);
            return (
              <div className="thread-composer-model-group" key={group.providerId} role="presentation">
                {visible.map((choice) => renderModelItem(choice))}
                {group.models.length > visible.length ? (
                  <ButtonControl
                    className="thread-composer-model-item thread-composer-model-expander"
                    onClick={() => setExpandedProviders((current) => new Set(current).add(group.providerId))}
                  >
                    <span className="thread-composer-model-item-label">
                      {composer.showAllModels({ count: group.models.length })}
                    </span>
                    {/* Truncation is still per provider, so with the group heading
                        gone the expander has to say whose models it expands. */}
                    {showProviderLabel ? (
                      <span className="thread-composer-model-item-origin">{formatProviderName(group.providerId)}</span>
                    ) : null}
                    <span className="thread-composer-model-spacer" />
                    <ChevronDownIcon className="thread-composer-model-item-caret" size={ICON_SIZE.menu} />
                  </ButtonControl>
                ) : null}
                {expanded && group.models.length > RECENT_MODEL_COUNT ? (
                  <ButtonControl
                    className="thread-composer-model-item thread-composer-model-expander"
                    onClick={() => setExpandedProviders((current) => {
                      const next = new Set(current);
                      next.delete(group.providerId);
                      return next;
                    })}
                  >
                    <span className="thread-composer-model-item-label">{composer.showFewerModels}</span>
                    {showProviderLabel ? (
                      <span className="thread-composer-model-item-origin">{formatProviderName(group.providerId)}</span>
                    ) : null}
                  </ButtonControl>
                ) : null}
              </div>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export const ThreadComposerModelControl = memo(ThreadComposerModelControlImpl);

/**
 * The first `RECENT_MODEL_COUNT` of a provider, plus the pinned model when it
 * falls outside that window — a selection must never be invisible in the menu
 * that owns it. `effectiveProviderId` is passed empty while floating, since
 * then no row is pinned and nothing needs rescuing.
 */
function visibleModels(
  group: ModelChoiceGroup,
  expanded: boolean,
  effectiveProviderId: string,
  effectiveModelId: string,
): readonly ModelChoice[] {
  if (expanded) return group.models;
  const recent = group.models.slice(0, RECENT_MODEL_COUNT);
  if (group.providerId !== effectiveProviderId || recent.some((choice) => choice.option.id === effectiveModelId)) {
    return recent;
  }
  const selected = group.models.find((choice) => choice.option.id === effectiveModelId);
  return selected ? [...recent, selected] : recent;
}

function reasoningLabel(
  level: ReasoningEffort,
  model: AgentModelOption | undefined,
  copy: Record<ReasoningEffort, string>,
): string {
  const providerLabel = model?.thinkingLevelLabels?.[level]?.trim();
  if (!providerLabel) return copy[level];
  const normalized = providerLabel.toLowerCase();
  if (normalized === 'xhigh') return 'XHigh';
  if (normalized === 'max') return 'Max';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

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
      const element = ref.current;
      if (!anchor || !element) return;
      const margin = 8;
      const gap = 4;
      const fitsLeft = anchor.left - gap - width >= margin;
      const left = fitsLeft
        ? Math.max(margin, anchor.left - gap - width)
        : clamp(anchor.right + gap, margin, Math.max(margin, window.innerWidth - width - margin));
      const top = clamp(
        anchor.top - margin,
        margin,
        Math.max(margin, window.innerHeight - element.offsetHeight - margin),
      );
      setStyle({
        position: 'fixed',
        left,
        top,
        width,
        maxHeight: Math.max(0, window.innerHeight - 2 * margin),
      });
    };
    update();
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchorRef, layoutKey, open, ref, width]);
  return style;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Number.isFinite(value) ? value : 0, max));
}
