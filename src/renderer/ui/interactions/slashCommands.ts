import { textMatchRank } from './candidateRanking';

export type SlashCommandId =
  | 'field'
  | 'reference'
  | 'heading'
  | 'checkbox'
  | 'code'
  | 'image'
  | 'command'
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
    id: 'command',
    label: 'Command',
    keywords: ['command', 'routine', 'schedule', 'agent', 'task', 'cron'],
    enabled: true,
  },
  {
    id: 'command_palette',
    label: 'Command palette',
    keywords: ['palette', 'search'],
    shortcutHint: 'Cmd+K',
    enabled: true,
  },
] as const;

// `localizedLabels` (id → display label) lets the menu match the user's typed query
// against the localized label too; the static English `label` + keywords stay as a
// locale-independent matching base (and the default when no labels are supplied).
export function filterSlashCommands(
  query: string,
  localizedLabels?: Record<SlashCommandId, string>,
): SlashCommandDefinition[] {
  const normalized = query.trim();
  const enabled = SLASH_COMMANDS.filter((command) => command.enabled);
  if (!normalized) return enabled;
  return enabled.filter((command) => {
    const localized = localizedLabels?.[command.id];
    return (
      textMatchRank(command.label, normalized) !== null
      || (localized !== undefined && textMatchRank(localized, normalized) !== null)
      || command.keywords.some((keyword) => textMatchRank(keyword, normalized) !== null)
    );
  });
}
