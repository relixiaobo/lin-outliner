import type { ToolCall, ToolResultMessage } from '../../agent/types';
import {
  AddIcon,
  CodeIcon,
  ICON_SIZE,
  RestoreIcon,
  SearchIcon,
  TrashIcon,
  WarningIcon,
} from '../icons';

interface AgentToolCallBlockProps {
  result?: ToolResultMessage;
  toolCall: ToolCall;
}

type ToolStatus = 'pending' | 'done' | 'error';

function getStatus(result?: ToolResultMessage): ToolStatus {
  if (!result) return 'pending';
  return result.isError ? 'error' : 'done';
}

function getToolIcon(toolCall: ToolCall) {
  if (toolCall.name === 'node_create') return AddIcon;
  if (toolCall.name === 'node_search' || toolCall.name === 'web_search') return SearchIcon;
  if (toolCall.name === 'node_delete') {
    return toolCall.arguments.restore === true ? RestoreIcon : TrashIcon;
  }
  if (toolCall.name === 'bash' || toolCall.name === 'file_edit') return CodeIcon;
  return WarningIcon;
}

function pickSubject(args: Record<string, unknown>): string | null {
  const keys = ['query', 'name', 'path', 'url', 'nodeId'];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function statusVerb(base: string, status: ToolStatus): string {
  if (status === 'pending') return `${base}...`;
  if (status === 'done') return base;
  return `Failed: ${base}`;
}

function summarize(toolCall: ToolCall, status: ToolStatus): string {
  const subject = pickSubject(toolCall.arguments);
  const target = subject ? ` ${subject}` : '';
  if (toolCall.name === 'node_create') return statusVerb(`Create node${target}`, status);
  if (toolCall.name === 'node_read') return statusVerb(`Read node${target}`, status);
  if (toolCall.name === 'node_edit') return statusVerb(`Edit node${target}`, status);
  if (toolCall.name === 'node_delete') return statusVerb(`Delete node${target}`, status);
  if (toolCall.name === 'node_search') return statusVerb(`Search nodes${target}`, status);
  if (toolCall.name === 'web_search') return statusVerb(`Search web${target}`, status);
  if (toolCall.name === 'web_fetch') return statusVerb(`Fetch web${target}`, status);
  if (toolCall.name === 'bash') return statusVerb(`Run bash${target}`, status);
  if (toolCall.name === 'file_edit') return statusVerb(`Edit file${target}`, status);
  return statusVerb(toolCall.name, status);
}

function renderResultText(result: ToolResultMessage | undefined): string {
  if (!result) return '';
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function AgentToolCallBlock({ result, toolCall }: AgentToolCallBlockProps) {
  const status = getStatus(result);
  const Icon = getToolIcon(toolCall);
  const resultText = renderResultText(result);

  return (
    <div className={`agent-tool-call is-${status}`}>
      <div className="agent-tool-call-header">
        <Icon size={ICON_SIZE.menu} />
        <span>{summarize(toolCall, status)}</span>
      </div>
      {resultText ? (
        <pre className="agent-tool-call-result">{resultText}</pre>
      ) : null}
    </div>
  );
}
