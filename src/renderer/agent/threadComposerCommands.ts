import type { AgentSlashCommandView, SkillDefinition } from '../api/types';

export const NEW_THREAD_SLASH_COMMAND_ID = 'runtime:new';

export interface RuntimeSlashCommandLabels {
  readonly compactDescription: string;
  readonly clearDescription: string;
  readonly newThreadDescription: string;
}

interface NewThreadCommandDraft {
  readonly content: readonly { readonly type: string }[];
  readonly fileRefs: readonly unknown[];
  readonly text: string;
}

export type NewThreadCommandState =
  | 'ordinary'
  | 'ready'
  | 'blockedByStructuredContent';

export function classifyNewThreadCommand(draft: NewThreadCommandDraft): NewThreadCommandState {
  if (draft.text.trim() !== '/new') return 'ordinary';
  return draft.fileRefs.length > 0 || draft.content.some((part) => part.type !== 'text')
    ? 'blockedByStructuredContent'
    : 'ready';
}

export function isExactSlashCommandMenuQuery(
  query: string,
  commands: readonly Pick<AgentSlashCommandView, 'insertText' | 'label'>[],
): boolean {
  const token = `/${query}`;
  return commands.some((command) => command.label === token && command.insertText === token);
}

export function runtimeSlashCommands(labels: RuntimeSlashCommandLabels): AgentSlashCommandView[] {
  return [
    {
      id: 'runtime:compact',
      kind: 'runtime',
      label: '/compact',
      description: labels.compactDescription,
      insertText: '/compact ',
    },
    {
      id: 'runtime:clear',
      kind: 'runtime',
      label: '/clear',
      description: labels.clearDescription,
      insertText: '/clear',
    },
    {
      id: NEW_THREAD_SLASH_COMMAND_ID,
      kind: 'runtime',
      label: '/new',
      description: labels.newThreadDescription,
      insertText: '/new',
    },
  ];
}

export function slashCommandsFromSkills(
  skills: readonly SkillDefinition[],
  labels: RuntimeSlashCommandLabels,
): AgentSlashCommandView[] {
  const runtimeCommands = runtimeSlashCommands(labels);
  const reservedLabels = new Set(runtimeCommands.map((command) => command.label.toLowerCase()));
  const skillCommands = skills
    .filter((skill) => (
      skill.userInvocable
      && !reservedLabels.has(`/${skill.name}`.toLowerCase())
    ))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: 'skill' as const,
      label: `/${skill.name}`,
      description: slashCommandDescription(skill),
      insertText: `/${skill.name} `,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return [...runtimeCommands, ...skillCommands];
}

function slashCommandDescription(skill: SkillDefinition): string {
  const detail = skill.description.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  if (!skill.displayName || skill.displayName === detail) return detail;
  return detail ? `${skill.displayName} - ${detail}` : skill.displayName;
}
