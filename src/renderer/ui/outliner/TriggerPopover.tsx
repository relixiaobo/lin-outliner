import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import type { CommandRunner, CommandRunnerOperationResult, TriggerState } from '../shared';
import type { SlashCommandId } from '../interactions/slashCommands';
import { nextMenuIndex, clampMenuIndex } from '../interactions/menuNavigation';
import { resolveTriggerForceCreateIntent } from '../interactions/rowInteractions';
import { tagSelectorItems } from '../interactions/tagSelector';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { useAnchoredOverlay } from '../primitives/useAnchoredOverlay';
import { referenceItems, ReferenceSelector } from './ReferenceSelector';
import { slashCommandItems, SlashCommandMenu } from './SlashCommandMenu';
import { TagSelector } from './TagSelector';
import { PopoverListbox } from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

interface TriggerPopoverProps {
  trigger: NonNullable<TriggerState>;
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
  close: () => void;
  clearTriggerText: () => Promise<void>;
  applyReference?: (target: NodeProjection) => Promise<CommandRunnerOperationResult>;
  applyTag?: (tag: NodeProjection) => Promise<CommandRunnerOperationResult>;
  createTagAndApply?: (name: string) => Promise<CommandRunnerOperationResult>;
  executeSlashCommand?: (commandId: SlashCommandId) => Promise<CommandRunnerOperationResult>;
  enabledSlashCommandIds?: SlashCommandId[];
  treeReferenceParentId?: NodeId | null;
  existingTagIds?: readonly NodeId[];
}

const EMPTY_NODE_IDS: readonly NodeId[] = [];

export function TriggerPopover(props: TriggerPopoverProps) {
  const tf = useT().outliner.field;
  const {
    applyReference,
    applyTag,
    clearTriggerText,
    close,
    createTagAndApply,
    enabledSlashCommandIds,
    executeSlashCommand,
    index,
    nodeId,
    run,
    treeReferenceParentId,
    trigger,
  } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const existingTagIds = props.existingTagIds ?? EMPTY_NODE_IDS;

  const itemCount = useMemo(() => {
    if (trigger.kind === '#') {
      return tagSelectorItems({
        query: trigger.query,
        index,
        existingTagIds,
      }).length;
    }
    if (trigger.kind === '@') {
      return referenceItems({
        query: trigger.query,
        index,
        currentNodeId: nodeId,
        treeReferenceParentId,
        skipTreeReferenceChecks: true,
      }).length;
    }
    if (!executeSlashCommand) return 0;
    return slashCommandItems(trigger.query, enabledSlashCommandIds, tf.slashLabels).length;
  }, [enabledSlashCommandIds, executeSlashCommand, existingTagIds, index, nodeId, tf.slashLabels, treeReferenceParentId, trigger.kind, trigger.query]);
  const anchoredDropStyle = useAnchoredOverlay(menuRef, {
    anchorRect: trigger.anchor ?? null,
    layoutKey: `${trigger.kind}:${trigger.query}:${itemCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 220,
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger.kind, trigger.query, itemCount]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        close();
        return;
      }
      if (
        event.key === 'Enter'
        && (event.metaKey || event.ctrlKey)
      ) {
        const intent = resolveTriggerForceCreateIntent({
          triggerKind: trigger.kind,
          query: trigger.query,
        });
        if (intent === 'hashtag_create') {
          menuRef.current
            ?.querySelector<HTMLButtonElement>('[data-create-tag="true"]')
            ?.click();
        } else if (intent === 'reference_create') {
          menuRef.current
            ?.querySelector<HTMLButtonElement>('[data-create-reference="true"]')
            ?.click();
        }
        return;
      }
      if (itemCount === 0) return;
      if (event.key === 'ArrowDown') {
        setSelectedIndex((current) => nextMenuIndex(current, itemCount, 'down'));
        return;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((current) => nextMenuIndex(current, itemCount, 'up'));
        return;
      }
      const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      buttons?.[clampMenuIndex(selectedIndex, buttons.length)]?.click();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, itemCount, selectedIndex, trigger.kind, trigger.query]);

  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const label = trigger.kind === '#'
    ? tf.tagSuggestions
    : trigger.kind === '@'
      ? tf.referenceSuggestions
      : tf.slashCommands;

  return createPortal(
    <PopoverListbox
      ref={menuRef}
      label={label}
      className="trigger-popover"
      preventMouseDown={false}
      style={anchoredDropStyle}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {trigger.kind === '#' && (
        <TagSelector
          query={trigger.query}
          index={index}
          nodeId={nodeId}
          existingTagIds={existingTagIds}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          run={run}
          close={close}
          clearTriggerText={clearTriggerText}
          applyTag={applyTag}
          createTagAndApply={createTagAndApply}
        />
      )}
      {trigger.kind === '@' && (
        <ReferenceSelector
          query={trigger.query}
          index={index}
          currentNodeId={nodeId}
          treeReferenceParentId={treeReferenceParentId}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          run={run}
          close={close}
          clearTriggerText={clearTriggerText}
          applyReference={applyReference}
        />
      )}
      {trigger.kind === '/' && executeSlashCommand && (
        <SlashCommandMenu
          query={trigger.query}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          enabledSlashCommandIds={enabledSlashCommandIds}
          run={run}
          executeSlashCommand={executeSlashCommand}
          close={close}
        />
      )}
    </PopoverListbox>,
    document.body,
  );
}
