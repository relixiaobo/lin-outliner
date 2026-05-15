import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { CommandOutcome, DocumentProjection, NodeId, NodeProjection } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import type { CommandRunner, TriggerState } from '../shared';
import type { SlashCommandId } from '../interactions/slashCommands';
import { nextMenuIndex, clampMenuIndex } from '../interactions/menuNavigation';
import { resolveTriggerForceCreateIntent } from '../interactions/rowInteractions';
import { tagSelectorItems } from '../interactions/tagSelector';
import { isImeComposingEvent } from '../interactions/imeKeyboard';
import { referenceItems, ReferenceSelector } from './ReferenceSelector';
import { slashCommandItems, SlashCommandMenu } from './SlashCommandMenu';
import { TagSelector } from './TagSelector';
import { PopoverListbox } from './PopoverList';

interface TriggerPopoverProps {
  trigger: NonNullable<TriggerState>;
  index: DocumentIndex;
  nodeId: NodeId;
  run: CommandRunner;
  close: () => void;
  clearTriggerText: () => Promise<void>;
  applyReference?: (target: NodeProjection) => Promise<CommandOutcome | DocumentProjection | null | void>;
  executeSlashCommand?: (commandId: SlashCommandId) => Promise<CommandOutcome | DocumentProjection | null | void>;
  enabledSlashCommandIds?: SlashCommandId[];
  treeReferenceParentId?: NodeId | null;
  existingTagIds?: readonly NodeId[];
}

export function TriggerPopover(props: TriggerPopoverProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dropStyle, setDropStyle] = useState<CSSProperties | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const existingTagIds = props.existingTagIds ?? [];

  useLayoutEffect(() => {
    const anchor = props.trigger.anchor;
    if (!anchor) {
      setDropStyle(undefined);
      return undefined;
    }
    const update = () => {
      const menuHeight = Math.min(menuRef.current?.offsetHeight ?? 240, 240);
      const gap = 6;
      const spaceBelow = window.innerHeight - anchor.bottom - gap;
      const spaceAbove = anchor.top - gap;
      if (spaceBelow >= menuHeight || spaceBelow >= spaceAbove) {
        setDropStyle({ position: 'fixed', left: anchor.left, top: anchor.bottom + gap });
      } else {
        setDropStyle({ position: 'fixed', left: anchor.left, bottom: window.innerHeight - anchor.top + gap });
      }
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [props.trigger.anchor]);

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
    ? 'Tag suggestions'
    : props.trigger.kind === '@'
      ? 'Reference suggestions'
      : 'Slash commands';

  return (
    <PopoverListbox
      ref={menuRef}
      label={label}
      className="trigger-popover"
      preventMouseDown={false}
      style={dropStyle}
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
    </PopoverListbox>
  );
}
