import {
  useLayoutEffect,
  useMemo,
  useRef,
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
import { usePopoverSelection } from './usePopoverSelection';

interface TriggerPopoverProps {
  trigger: NonNullable<TriggerState>;
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
  close: () => void;
  applyReference: (target: NodeProjection) => Promise<CommandRunnerOperationResult>;
  applyTag: (tag: NodeProjection) => Promise<CommandRunnerOperationResult>;
  createTagAndApply: (name: string) => Promise<CommandRunnerOperationResult>;
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const existingTagIds = props.existingTagIds ?? EMPTY_NODE_IDS;

  const itemKeys = useMemo(() => {
    if (trigger.kind === '#') {
      return tagSelectorItems({
        query: trigger.query,
        index,
        existingTagIds,
      }).map((item) => item.type === 'existing' ? `tag:${item.tag.id}` : `tag:create:${item.name}`);
    }
    if (trigger.kind === '@') {
      return referenceItems({
        query: trigger.query,
        index,
        currentNodeId: nodeId,
        treeReferenceParentId,
        skipTreeReferenceChecks: true,
      }).map((item) => {
        if (item.type === 'node') return `node:${item.id}`;
        return `create:${item.label}`;
      });
    }
    if (!executeSlashCommand) return [];
    return slashCommandItems(trigger.query, enabledSlashCommandIds, tf.slashLabels)
      .map((command) => `slash:${command.id}`);
  }, [enabledSlashCommandIds, executeSlashCommand, existingTagIds, index, nodeId, tf.slashLabels, treeReferenceParentId, trigger.kind, trigger.query]);
  const itemCount = itemKeys.length;
  const anchoredDropStyle = useAnchoredOverlay(menuRef, {
    anchorRect: trigger.anchor ?? null,
    layoutKey: `${trigger.kind}:${trigger.query}:${itemCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 220,
  });
  const [selectedIndex, setSelectedIndex] = usePopoverSelection({
    itemCount,
    listRef: menuRef,
    selectionKey: `${trigger.kind}:${trigger.query}:${itemKeys.join('|')}`,
  });
  const stateRef = useRef({ close, itemCount, selectedIndex, trigger });
  stateRef.current = { close, itemCount, selectedIndex, trigger };

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const state = stateRef.current;

      if (event.key === 'Escape') {
        state.close();
        return;
      }
      if (
        event.key === 'Enter'
        && (event.metaKey || event.ctrlKey)
      ) {
        const intent = resolveTriggerForceCreateIntent({
          triggerKind: state.trigger.kind,
          query: state.trigger.query,
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
      if (state.itemCount === 0) return;
      if (event.key === 'ArrowDown') {
        setSelectedIndex((current) => nextMenuIndex(current, state.itemCount, 'down'));
        return;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((current) => nextMenuIndex(current, state.itemCount, 'up'));
        return;
      }
      const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
      buttons?.[clampMenuIndex(state.selectedIndex, buttons.length)]?.click();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setSelectedIndex]);

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
          existingTagIds={existingTagIds}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          close={close}
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
          applyReference={applyReference}
        />
      )}
      {trigger.kind === '/' && executeSlashCommand && (
        <SlashCommandMenu
          query={trigger.query}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          enabledSlashCommandIds={enabledSlashCommandIds}
          executeSlashCommand={executeSlashCommand}
          close={close}
        />
      )}
    </PopoverListbox>,
    document.body,
  );
}
