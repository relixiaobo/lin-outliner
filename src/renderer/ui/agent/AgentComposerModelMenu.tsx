import {
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentModelOption,
  AgentProviderConfigView,
  AgentReasoningLevel,
} from '../../api/types';
import {
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ICON_SIZE,
} from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { MenuItem } from '../primitives/MenuItem';
import { MenuSurface } from '../primitives/MenuSurface';
import { SwitchControl } from '../primitives/SwitchControl';
import { SwitchMark } from '../primitives/SwitchMark';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';

export const REASONING_LABELS: Record<AgentReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
};

export interface ComposerModelChoice extends AgentModelOption {
  providerId: string;
}

export function AgentComposerModelMenu({
  activeProvider,
  anchorRef,
  configDisabled,
  models,
  moreModelsOpen,
  onClose,
  onModelSelect,
  onMoreModelsOpenChange,
  onReasoningLevelSelect,
  onReasoningMenuOpenChange,
  onReasoningToggle,
  reasoningEnabled,
  reasoningMenuOpen,
  reasoningOptions,
  selectedReasoning,
  supportsReasoning,
}: {
  activeProvider: AgentProviderConfigView | null;
  anchorRef: RefObject<HTMLElement | null>;
  configDisabled: boolean;
  models: ComposerModelChoice[];
  moreModelsOpen: boolean;
  onClose: () => void;
  onModelSelect: (model: ComposerModelChoice) => void;
  onMoreModelsOpenChange: (open: boolean) => void;
  onReasoningLevelSelect: (reasoningLevel: AgentReasoningLevel) => void;
  onReasoningMenuOpenChange: (open: boolean) => void;
  onReasoningToggle: () => void;
  reasoningEnabled: boolean;
  reasoningMenuOpen: boolean;
  reasoningOptions: AgentReasoningLevel[];
  selectedReasoning: AgentReasoningLevel;
  supportsReasoning: boolean;
}) {
  const featuredModels = useMemo(
    () => getFeaturedModelChoices(models, activeProvider),
    [activeProvider, models],
  );
  const featuredIds = useMemo(
    () => new Set(featuredModels.map((model) => modelKey(model))),
    [featuredModels],
  );
  const moreModelGroups = useMemo(
    () => groupModelsByProvider(models.filter((model) => !featuredIds.has(modelKey(model)))),
    [featuredIds, models],
  );
  const layoutKey = `${moreModelsOpen}:${reasoningMenuOpen}:${moreModelGroups.length}:${featuredModels.length}`;

  return (
    <FloatingComposerMenu
      anchorRef={anchorRef}
      layoutKey={layoutKey}
      onClose={onClose}
    >
      <div className="agent-composer-model-list">
        {featuredModels.map((model) => (
          <ModelMenuItem
            activeProvider={activeProvider}
            key={modelKey(model)}
            model={model}
            onSelect={() => onModelSelect(model)}
          />
        ))}
        {moreModelGroups.length > 0 ? (
          <>
            <MenuItem
              aria-expanded={moreModelsOpen}
              className="agent-composer-more-models"
              icon={(
                <ChevronDownIcon
                  className={moreModelsOpen ? 'is-open' : ''}
                  size={ICON_SIZE.menu}
                />
              )}
              label={<span>More models</span>}
              onClick={() => onMoreModelsOpenChange(!moreModelsOpen)}
              role="menuitem"
            />
            {moreModelsOpen ? (
              <div className="agent-composer-more-model-list">
                {moreModelGroups.map(([providerId, providerModels]) => (
                  <div className="agent-composer-more-model-group" key={providerId}>
                    <div className="agent-composer-menu-caption">{formatProviderName(providerId)}</div>
                    {providerModels.map((model) => (
                      <ModelMenuItem
                        activeProvider={activeProvider}
                        key={modelKey(model)}
                        model={model}
                        onSelect={() => onModelSelect(model)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {supportsReasoning ? (
        <div className="agent-composer-thinking-row">
          <BrainIcon size={ICON_SIZE.menu} />
          <span>Thinking</span>
          {reasoningEnabled ? (
            <div className="agent-composer-thinking-level-wrap">
              <ButtonControl
                aria-expanded={reasoningMenuOpen}
                aria-haspopup="menu"
                aria-label="Thinking level"
                className="agent-composer-thinking-level"
                onClick={() => onReasoningMenuOpenChange(!reasoningMenuOpen)}
              >
                {REASONING_LABELS[selectedReasoning]}
                <ChevronDownIcon size={ICON_SIZE.tiny} />
              </ButtonControl>
              {reasoningMenuOpen ? (
                <MenuSurface
                  aria-label="Thinking levels"
                  className="agent-composer-thinking-level-menu"
                  role="menu"
                >
                  {reasoningOptions
                    .filter((level) => level !== 'off')
                    .map((level) => (
                      <MenuItem
                        active={selectedReasoning === level}
                        activeClassName="is-selected"
                        aria-checked={selectedReasoning === level}
                        className="agent-composer-thinking-level-item"
                        key={level}
                        label={REASONING_LABELS[level]}
                        onClick={() => onReasoningLevelSelect(level)}
                        role="menuitemradio"
                      />
                    ))}
                </MenuSurface>
              ) : null}
            </div>
          ) : null}
          <SwitchControl
            className={`agent-composer-thinking-switch ${reasoningEnabled ? 'is-on' : ''}`}
            checked={reasoningEnabled}
            disabled={configDisabled || !reasoningOptions.includes('off')}
            label="Thinking"
            onCheckedChange={onReasoningToggle}
          >
            <SwitchMark checked={reasoningEnabled} />
          </SwitchControl>
        </div>
      ) : null}
    </FloatingComposerMenu>
  );
}

function ModelMenuItem({
  activeProvider,
  model,
  onSelect,
}: {
  activeProvider: AgentProviderConfigView | null;
  model: ComposerModelChoice;
  onSelect: () => void;
}) {
  const selected = model.providerId === activeProvider?.providerId && model.id === activeProvider?.modelId;
  return (
    <MenuItem
      active={selected}
      activeClassName="is-selected"
      className="agent-composer-model-item"
      icon={(
        <span className="agent-composer-menu-check">
          {selected ? <CheckIcon size={ICON_SIZE.menu} /> : null}
        </span>
      )}
      label={model.name || model.id}
      labelClassName="agent-composer-model-item-name"
      onClick={onSelect}
      role="menuitem"
    />
  );
}

function FloatingComposerMenu({
  anchorRef,
  children,
  layoutKey,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  layoutKey: string;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredOverlay(menuRef, {
    anchorRef,
    layoutKey,
    maxHeight: 440,
    placement: 'top-end',
    width: 300,
  });

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <MenuSurface
      ref={menuRef}
      aria-label="Model and reasoning settings"
      className="agent-composer-model-menu"
      role="menu"
      style={style}
    >
      {children}
    </MenuSurface>,
    document.body,
  );
}

function getFeaturedModelChoices(
  models: ComposerModelChoice[],
  activeProvider: AgentProviderConfigView | null,
): ComposerModelChoice[] {
  const featured = models.slice(0, 5);
  if (!activeProvider) return featured;
  const selected = models.find(
    (model) => model.providerId === activeProvider.providerId && model.id === activeProvider.modelId,
  );
  if (!selected || featured.some((model) => modelKey(model) === modelKey(selected))) return featured;
  return [...featured.slice(0, Math.max(0, featured.length - 1)), selected];
}

function modelKey(model: ComposerModelChoice): string {
  return `${model.providerId}:${model.id}`;
}

function groupModelsByProvider(models: ComposerModelChoice[]): [string, ComposerModelChoice[]][] {
  const groups = new Map<string, ComposerModelChoice[]>();
  for (const model of models) {
    const existing = groups.get(model.providerId);
    if (existing) existing.push(model);
    else groups.set(model.providerId, [model]);
  }
  return [...groups.entries()];
}

function formatProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
