export const NEW_THREAD_SLASH_COMMAND_ID = 'runtime:new';

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

export function isCompleteNewThreadMenuQuery(
  query: string,
  commands: readonly { readonly id: string; readonly label: string }[],
): boolean {
  const command = commands.find((candidate) => candidate.id === NEW_THREAD_SLASH_COMMAND_ID);
  return Boolean(command && query.toLowerCase() === command.label.slice(1).toLowerCase());
}
