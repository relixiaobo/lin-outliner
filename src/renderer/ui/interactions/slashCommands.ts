import { textMatchRank } from './candidateRanking';

export type SlashCommandId =
  | 'field'
  | 'reference'
  | 'heading'
  | 'checkbox'
  | 'code'
  | 'image'
  | 'command_palette';

export interface SlashCommandDefinition {
  id: SlashCommandId;
  label: string;
  keywords: string[];
  enabled: boolean;
  shortcutHint?: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    id: 'field',
    label: 'Field',
    keywords: ['field', 'attribute', 'property', '>'],
    shortcutHint: '>',
    enabled: true,
  },
  {
    id: 'reference',
    label: 'Reference',
    keywords: ['reference', 'ref', '@', 'mention'],
    shortcutHint: '@',
    enabled: true,
  },
  {
    id: 'heading',
    label: 'Heading',
    keywords: ['heading', 'title', 'h1', '!'],
    enabled: true,
  },
  {
    id: 'checkbox',
    label: 'Checkbox',
    keywords: ['checkbox', 'todo', 'done', 'check'],
    shortcutHint: 'Cmd+Enter',
    enabled: true,
  },
  {
    id: 'code',
    label: 'Code block',
    keywords: ['code', 'codeblock', 'snippet', 'pre', 'monospace'],
    enabled: true,
  },
  {
    id: 'image',
    label: 'Image',
    keywords: ['image', 'picture', 'photo', 'img', 'media'],
    enabled: true,
  },
  {
    id: 'command_palette',
    label: 'Command palette',
    keywords: ['command', 'palette', 'search'],
    shortcutHint: 'Cmd+K',
    enabled: true,
  },
] as const;

export function filterSlashCommands(query: string): SlashCommandDefinition[] {
  const normalized = query.trim();
  const enabled = SLASH_COMMANDS.filter((command) => command.enabled);
  if (!normalized) return enabled;
  return enabled.filter((command) => (
    textMatchRank(command.label, normalized) !== null
    || command.keywords.some((keyword) => textMatchRank(keyword, normalized) !== null)
  ));
}
