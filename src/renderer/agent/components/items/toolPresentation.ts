import type { ThreadItem } from '../../projectionTypes';
import {
  FileCreateToolIcon, FileDeleteToolIcon, FileEditToolIcon,
  FileGlobToolIcon, FileGrepToolIcon, FileReadToolIcon, FileWriteToolIcon,
  GenericToolIcon, McpToolIcon, MoveToIcon,
  PlanToolIcon, QuestionToolIcon, SkillIcon, TerminalIcon,
  WebFetchToolIcon, WebSearchToolIcon, type AppIcon,
} from '../../../ui/icons';

export type ThreadToolItem = Extract<ThreadItem, {
  type: 'commandExecution' | 'fileChange' | 'mcpToolCall'
    | 'dynamicToolCall' | 'webSearch';
}>;

type ToolOperation =
  | 'command' | 'fileCreate' | 'fileWrite' | 'fileEdit' | 'fileDelete' | 'fileMove'
  | 'fileRead' | 'filePathSearch' | 'fileContentSearch' | 'webSearch' | 'webFetch'
  | 'plan' | 'skill' | 'question' | 'agent' | 'agentMessage' | 'taskStatus'
  | 'taskStop' | 'mcp' | 'unknown';

interface ToolPresentation {
  readonly operation: ToolOperation;
  readonly Icon: AppIcon;
}

const UNKNOWN: ToolPresentation = { operation: 'unknown', Icon: GenericToolIcon };
const DYNAMIC_OPERATIONS: Readonly<Record<string, ToolPresentation>> = {
  file_write: { operation: 'fileWrite', Icon: FileWriteToolIcon },
  file_edit: { operation: 'fileEdit', Icon: FileEditToolIcon },
  file_delete: { operation: 'fileDelete', Icon: FileDeleteToolIcon },
  file_read: { operation: 'fileRead', Icon: FileReadToolIcon },
  file_glob: { operation: 'filePathSearch', Icon: FileGlobToolIcon },
  file_grep: { operation: 'fileContentSearch', Icon: FileGrepToolIcon },
  web_search: { operation: 'webSearch', Icon: WebSearchToolIcon },
  web_fetch: { operation: 'webFetch', Icon: WebFetchToolIcon },
  update_plan: { operation: 'plan', Icon: PlanToolIcon },
  skill: { operation: 'skill', Icon: SkillIcon },
  request_user_input: { operation: 'question', Icon: QuestionToolIcon },
};

export function normalizedToolIdentity(namespace: string | null, tool: string): string {
  return [namespace, tool]
    .filter((part): part is string => Boolean(part))
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function toolPresentation(item: ThreadToolItem): ToolPresentation {
  switch (item.type) {
    case 'commandExecution': return { operation: 'command', Icon: TerminalIcon };
    case 'fileChange': {
      const kinds = new Set(item.changes.map((change) => change.kind));
      if (kinds.size !== 1) return UNKNOWN;
      switch (item.changes[0]?.kind) {
        case 'add': return { operation: 'fileCreate', Icon: FileCreateToolIcon };
        case 'delete': return { operation: 'fileDelete', Icon: FileDeleteToolIcon };
        case 'update': return { operation: 'fileEdit', Icon: FileEditToolIcon };
        case 'move': return { operation: 'fileMove', Icon: MoveToIcon };
        default: return UNKNOWN;
      }
    }
    case 'webSearch': return { operation: 'webSearch', Icon: WebSearchToolIcon };
    case 'mcpToolCall': return { operation: 'mcp', Icon: McpToolIcon };
    case 'dynamicToolCall': {
      const identity = normalizedToolIdentity(item.namespace, item.tool);
      return Object.hasOwn(DYNAMIC_OPERATIONS, identity) ? DYNAMIC_OPERATIONS[identity]! : UNKNOWN;
    }
    default: {
      const unexpected: never = item;
      console.warn('Unknown tool presentation', unexpected);
      return UNKNOWN;
    }
  }
}

export function toolGroupPresentation(items: readonly ThreadToolItem[]): ToolPresentation {
  const first = items[0];
  if (!first) return UNKNOWN;
  const presentation = toolPresentation(first);
  return items.every((item) => toolPresentation(item).operation === presentation.operation)
    ? presentation
    : UNKNOWN;
}
