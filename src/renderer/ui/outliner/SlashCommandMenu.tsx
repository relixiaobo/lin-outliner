import type { ReactNode } from 'react';
import type { CommandOutcome, DocumentProjection } from '../../api/types';
import { api } from '../../api/client';
import {
  AddChildIcon,
  CheckboxIcon,
  CodeIcon,
  CommandIcon,
  FieldIcon,
  HeadingIcon,
  ICON_SIZE,
  ImageIcon,
  ReferenceIcon,
} from '../icons';
import {
  filterSlashCommands,
  type SlashCommandDefinition,
  type SlashCommandId,
} from '../interactions/slashCommands';
import type { CommandRunner } from '../shared';
import { PopoverEmpty, PopoverListItem } from './PopoverList';
import { useT } from '../../i18n/I18nProvider';

interface SlashCommandMenuProps {
  query: string;
  selectedIndex: number;
  setSelectedIndex: (index: number | ((current: number) => number)) => void;
  enabledSlashCommandIds?: SlashCommandId[];
  run: CommandRunner;
  executeSlashCommand: (commandId: SlashCommandId) => Promise<CommandOutcome | DocumentProjection | null | void>;
  close: () => void;
}

function slashCommandIcon(command: SlashCommandDefinition): ReactNode {
  if (command.id === 'field') return <FieldIcon size={ICON_SIZE.menu} />;
  if (command.id === 'reference') return <ReferenceIcon size={ICON_SIZE.menu} />;
  if (command.id === 'heading') return <HeadingIcon size={ICON_SIZE.menu} />;
  if (command.id === 'checkbox') return <CheckboxIcon size={ICON_SIZE.menu} />;
  if (command.id === 'code') return <CodeIcon size={ICON_SIZE.menu} />;
  if (command.id === 'image') return <ImageIcon size={ICON_SIZE.menu} />;
  if (command.id === 'command_palette') return <CommandIcon size={ICON_SIZE.menu} />;
  return <AddChildIcon size={ICON_SIZE.menu} />;
}

export function slashCommandItems(
  query: string,
  enabledSlashCommandIds?: SlashCommandId[],
): SlashCommandDefinition[] {
  const enabled = enabledSlashCommandIds ? new Set(enabledSlashCommandIds) : null;
  return filterSlashCommands(query).filter((command) => !enabled || enabled.has(command.id));
}

export function SlashCommandMenu(props: SlashCommandMenuProps) {
  const tf = useT().outliner.field;
  const items = slashCommandItems(props.query, props.enabledSlashCommandIds);

  if (items.length === 0) {
    return <PopoverEmpty>{tf.noCommands}</PopoverEmpty>;
  }

  return (
    <>
      {items.map((command, index) => (
        <PopoverListItem
          key={command.id}
          active={index === props.selectedIndex}
          icon={slashCommandIcon(command)}
          iconClassName="popover-item-icon"
          label={command.shortcutHint ? `${command.label}  ${command.shortcutHint}` : command.label}
          onMouseEnter={() => props.setSelectedIndex(index)}
          onClick={() => {
            props.close();
            void props.run(async () => {
              const result = await props.executeSlashCommand(command.id);
              return result ?? api.getProjection();
            });
          }}
        />
      ))}
    </>
  );
}
