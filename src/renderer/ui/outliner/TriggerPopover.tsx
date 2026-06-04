import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { CommandOutcome, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
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
  applyReference?: (target: NodeProjection) => Promise<CommandOutcome | DocumentProjection | null | void>;
  applyTag?: (tag: NodeProjection) => Promise<CommandOutcome | DocumentProjection | null | void>;
  createTagAndApply?: (name: string) => Promise<CommandOutcome | DocumentProjection | null | void>;
  executeSlashCommand?: (commandId: SlashCommandId) => Promise<CommandOutcome | DocumentProjection | null | void>;
  enabledSlashCommandIds?: SlashCommandId[];
  treeReferenceParentId?: NodeId | null;
  existingTagIds?: readonly NodeId[];
}

export function TriggerPopover(props: TriggerPopoverProps) {
  const tf = useT().outliner.field;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const existingTagIds = props.existingTagIds ?? [];

  const itemCount = useMemo(() => {
    if (props.trigger.kind === '#') {
      return tagSelectorItems({
        query: props.trigger.query,
        index: props.index,
        existingTagIds,
      }).length;
    }
    if (props.trigger.kind === '@') {
      return referenceItems({
        query: props.trigger.query,
        index: props.index,
        currentNodeId: props.nodeId,
        treeReferenceParentId: props.treeReferenceParentId,
      }).length;
    }
    if (!props.executeSlashCommand) return 0;
    return slashCommandItems(props.trigger.query, props.enabledSlashCommandIds).length;
  }, [props, existingTagIds]);
  const anchoredDropStyle = useAnchoredOverlay(menuRef, {
    anchorRect: props.trigger.anchor ?? null,
    layoutKey: `${props.trigger.kind}:${props.trigger.query}:${itemCount}`,
    maxHeight: 240,
    placement: 'bottom-start',
    width: 220,
  });

  useEffect(() => {
    setSelectedIndex(0);
  }, [props.trigger.kind, props.trigger.query, itemCount]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isImeComposingEvent(event)) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        props.close();
        return;
      }
      if (
        event.key === 'Enter'
        && (event.metaKey || event.ctrlKey)
      ) {
        const intent = resolveTriggerForceCreateIntent({
          triggerKind: props.trigger.kind,
          query: props.trigger.query,
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
  }, [itemCount, props, selectedIndex]);

  useEffect(() => {
    menuRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const label = props.trigger.kind === '#'
    ? tf.tagSuggestions
    : props.trigger.kind === '@'
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
      {props.trigger.kind === '#' && (
        <TagSelector
          query={props.trigger.query}
          index={props.index}
          nodeId={props.nodeId}
          existingTagIds={existingTagIds}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          run={props.run}
          close={props.close}
          clearTriggerText={props.clearTriggerText}
          applyTag={props.applyTag}
          createTagAndApply={props.createTagAndApply}
        />
      )}
      {props.trigger.kind === '@' && (
        <ReferenceSelector
          query={props.trigger.query}
          index={props.index}
          currentNodeId={props.nodeId}
          treeReferenceParentId={props.treeReferenceParentId}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          run={props.run}
          close={props.close}
          clearTriggerText={props.clearTriggerText}
          applyReference={props.applyReference}
        />
      )}
      {props.trigger.kind === '/' && props.executeSlashCommand && (
        <SlashCommandMenu
          query={props.trigger.query}
          selectedIndex={selectedIndex}
          setSelectedIndex={setSelectedIndex}
          enabledSlashCommandIds={props.enabledSlashCommandIds}
          run={props.run}
          executeSlashCommand={props.executeSlashCommand}
          close={props.close}
        />
      )}
    </PopoverListbox>,
    document.body,
  );
}
