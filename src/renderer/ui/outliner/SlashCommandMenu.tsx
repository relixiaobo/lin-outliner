import type { ReactNode } from 'react';
import type { CommandOutcome, DocumentProjection } from '../../api/types';
import { api } from '../../api/client';
import {
  AddChildIcon,
  CheckboxIcon,
  ChevronRightIcon,
  ICON_SIZE,
  PlainTextIcon,
  ReferenceIcon,
  SearchIcon,
} from '../icons';
import {
  filterSlashCommands,
  type SlashCommandDefinition,
  type SlashCommandId,
} from '../interactions/slashCommands';
import type { CommandRunner } from '../shared';

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
  if (command.id === 'field') return <ChevronRightIcon size={ICON_SIZE.menu} />;
  if (command.id === 'reference') return <ReferenceIcon size={ICON_SIZE.menu} />;
  if (command.id === 'heading') return <PlainTextIcon size={ICON_SIZE.menu} />;
  if (command.id === 'checkbox') return <CheckboxIcon size={ICON_SIZE.menu} />;
  if (command.id === 'command_palette') return <SearchIcon size={ICON_SIZE.menu} />;
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
  const items = slashCommandItems(props.query, props.enabledSlashCommandIds);

  if (items.length === 0) {
    return <div className="popover-empty">No commands</div>;
  }

  return (
    <>
      {items.map((command, index) => (
        <button
          key={command.id}
          className={`popover-item ${index === props.selectedIndex ? 'active' : ''}`}
          role="option"
          data-selected={index === props.selectedIndex ? 'true' : undefined}
          aria-selected={index === props.selectedIndex}
          onMouseEnter={() => props.setSelectedIndex(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            props.close();
            void props.run(async () => {
              const result = await props.executeSlashCommand(command.id);
              return result ?? api.getProjection();
            });
          }}
        >
          <span className="popover-item-icon">{slashCommandIcon(command)}</span>
          <span className="popover-item-label">
            {command.shortcutHint ? `${command.label}  ${command.shortcutHint}` : command.label}
          </span>
        </button>
      ))}
    </>
  );
}
