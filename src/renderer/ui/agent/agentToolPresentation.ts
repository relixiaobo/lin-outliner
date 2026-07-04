import type { ToolCall } from '../../../core/agentTypes';
import {
  BrainIcon,
  FileDeleteToolIcon,
  FileEditToolIcon,
  FileGlobToolIcon,
  FileGrepToolIcon,
  FileReadToolIcon,
  FileWriteToolIcon,
  GenericToolIcon,
  NodeCreateToolIcon,
  NodeDeleteToolIcon,
  NodeEditToolIcon,
  NodeReadToolIcon,
  NodeSearchToolIcon,
  OperationHistoryToolIcon,
  PastChatsToolIcon,
  QuestionToolIcon,
  RestoreIcon,
  RunMessageToolIcon,
  RunSpawnToolIcon,
  RunStatusToolIcon,
  SkillAuthorToolIcon,
  SkillIcon,
  TaskStopToolIcon,
  TerminalIcon,
  WebFetchToolIcon,
  WebSearchToolIcon,
  type AppIcon,
} from '../icons';

export type ToolActivityKind =
  | 'command'
  | 'fileCreate'
  | 'fileEdit'
  | 'fileDelete'
  | 'fileRead'
  | 'fileSearch'
  | 'nodeCreate'
  | 'nodeEdit'
  | 'nodeDelete'
  | 'nodeRestore'
  | 'nodeRead'
  | 'nodeSearch'
  | 'run'
  | 'web'
  | 'memory'
  | 'skill'
  | 'question'
  | 'history'
  | 'other';

export interface AgentToolPresentation {
  activityKind: ToolActivityKind;
  icon: AppIcon;
}

const RUN_STATUS_TOOLS = new Set(['run_status']);
const RUN_MESSAGE_TOOLS = new Set(['run_steer', 'run_amend']);
const RUN_STOP_TOOLS = new Set(['run_stop']);
const RUN_SPAWN_TOOLS = new Set(['spawn_run']);

export function agentToolPresentation(toolCall: ToolCall): AgentToolPresentation {
  const name = toolCall.name;
  if (RUN_SPAWN_TOOLS.has(name)) return { activityKind: 'run', icon: RunSpawnToolIcon };
  if (RUN_STATUS_TOOLS.has(name)) return { activityKind: 'run', icon: RunStatusToolIcon };
  if (RUN_MESSAGE_TOOLS.has(name)) return { activityKind: 'run', icon: RunMessageToolIcon };
  if (RUN_STOP_TOOLS.has(name)) return { activityKind: 'run', icon: TaskStopToolIcon };

  switch (name) {
    case 'bash':
      return { activityKind: 'command', icon: TerminalIcon };
    case 'task_stop':
      return { activityKind: 'command', icon: TaskStopToolIcon };
    case 'file_read':
      return { activityKind: 'fileRead', icon: FileReadToolIcon };
    case 'file_glob':
      return { activityKind: 'fileSearch', icon: FileGlobToolIcon };
    case 'file_grep':
      return { activityKind: 'fileSearch', icon: FileGrepToolIcon };
    case 'file_edit':
      return { activityKind: 'fileEdit', icon: FileEditToolIcon };
    case 'file_write':
      return { activityKind: 'fileCreate', icon: FileWriteToolIcon };
    case 'file_delete':
      return { activityKind: 'fileDelete', icon: FileDeleteToolIcon };
    case 'node_create':
      return { activityKind: 'nodeCreate', icon: NodeCreateToolIcon };
    case 'node_read':
      return { activityKind: 'nodeRead', icon: NodeReadToolIcon };
    case 'node_edit':
      return { activityKind: 'nodeEdit', icon: NodeEditToolIcon };
    case 'node_delete':
      return {
        activityKind: toolCall.arguments.restore === true ? 'nodeRestore' : 'nodeDelete',
        icon: toolCall.arguments.restore === true ? RestoreIcon : NodeDeleteToolIcon,
      };
    case 'node_search':
      return { activityKind: 'nodeSearch', icon: NodeSearchToolIcon };
    case 'operation_history':
      return { activityKind: 'history', icon: OperationHistoryToolIcon };
    case 'web_search':
      return { activityKind: 'web', icon: WebSearchToolIcon };
    case 'web_fetch':
      return { activityKind: 'web', icon: WebFetchToolIcon };
    case 'recall':
    case 'dream':
      return { activityKind: 'memory', icon: BrainIcon };
    case 'past_chats':
      return { activityKind: 'memory', icon: PastChatsToolIcon };
    case 'skill':
      return { activityKind: 'skill', icon: SkillIcon };
    case 'skillify':
      return { activityKind: 'skill', icon: SkillAuthorToolIcon };
    case 'ask_user_question':
      return { activityKind: 'question', icon: QuestionToolIcon };
    default:
      return { activityKind: 'other', icon: GenericToolIcon };
  }
}

export function getToolIcon(toolCall: ToolCall): AppIcon {
  return agentToolPresentation(toolCall).icon;
}
