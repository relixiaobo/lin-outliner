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
  SearchIcon,
  SendIcon,
  NodeCreateToolIcon,
  NodeDeleteToolIcon,
  NodeEditToolIcon,
  NodeReadToolIcon,
  NodeSearchToolIcon,
  OutlineUndoStackToolIcon,
  PastChatsToolIcon,
  PlayIcon,
  QuestionToolIcon,
  RestoreIcon,
  RunStatusToolIcon,
  SkillAuthorToolIcon,
  SkillIcon,
  BashStopToolIcon,
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
  | 'web'
  | 'memory'
  | 'skill'
  | 'question'
  | 'history'
  | 'issue'
  | 'session'
  | 'other';

export interface AgentToolPresentation {
  activityKind: ToolActivityKind;
  icon: AppIcon;
}

export function agentToolPresentation(toolCall: ToolCall): AgentToolPresentation {
  const name = toolCall.name;

  switch (name) {
    case 'issue_search':
      return { activityKind: 'issue', icon: SearchIcon };
    case 'issue_read':
      return { activityKind: 'issue', icon: NodeReadToolIcon };
    case 'issue_create':
      return { activityKind: 'issue', icon: NodeCreateToolIcon };
    case 'issue_update':
      return { activityKind: 'issue', icon: NodeEditToolIcon };
    case 'agent_session_start':
      return { activityKind: 'session', icon: PlayIcon };
    case 'agent_session_read':
      return { activityKind: 'session', icon: RunStatusToolIcon };
    case 'agent_session_send_message':
      return { activityKind: 'session', icon: SendIcon };
    case 'agent_session_stop':
      return { activityKind: 'session', icon: BashStopToolIcon };
    case 'bash':
      return { activityKind: 'command', icon: TerminalIcon };
    case 'bash_stop':
      return { activityKind: 'command', icon: BashStopToolIcon };
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
    case 'outline_undo_stack':
      return { activityKind: 'history', icon: OutlineUndoStackToolIcon };
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
