import type { ToolCall } from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import { toolActivityKind, type ToolActivityKind, type ToolStatus } from './AgentToolCallBlock';

export interface ToolActivitySummaryMember {
  status: ToolStatus;
  toolCall: ToolCall;
}

const ACTIVITY_KIND_ORDER: ToolActivityKind[] = [
  'command',
  'fileCreate',
  'fileEdit',
  'fileDelete',
  'read',
  'search',
  'web',
  'memory',
  'skill',
];

export function summarizeToolActivity(
  members: readonly ToolActivitySummaryMember[],
  process: Messages['agent']['process'],
): string {
  if (members.length === 0) return process.usedTools({ count: 0 });

  const counts = new Map<ToolActivityKind, number>();
  for (const member of members) {
    const kind = toolActivityKind(member.toolCall.name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  if (counts.has('other')) return process.usedTools({ count: members.length });

  const kinds = ACTIVITY_KIND_ORDER.filter((kind) => counts.has(kind));
  if (kinds.length === 0 || kinds.length > 2) return process.usedTools({ count: members.length });

  const running = members.some((member) => member.status === 'pending');
  return kinds
    .map((kind, index) => {
      const phrase = toolActivityPhrase(kind, counts.get(kind) ?? 0, running, process.toolActivity);
      return index === 0 ? phrase : phrase.toLowerCase();
    })
    .join(' · ');
}

export function sentenceFragment(text: string): string {
  if (!text) return text;
  return `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

function toolActivityPhrase(
  kind: ToolActivityKind,
  count: number,
  running: boolean,
  labels: Messages['agent']['process']['toolActivity'],
): string {
  switch (kind) {
    case 'command':
      return running ? labels.commandRun({ count }) : labels.command({ count });
    case 'fileCreate':
      return running ? labels.fileCreateRun({ count }) : labels.fileCreate({ count });
    case 'fileEdit':
      return running ? labels.fileEditRun({ count }) : labels.fileEdit({ count });
    case 'fileDelete':
      return running ? labels.fileDeleteRun({ count }) : labels.fileDelete({ count });
    case 'read':
      return running ? labels.readRun({ count }) : labels.read({ count });
    case 'search':
      return running ? labels.searchRun() : labels.search();
    case 'web':
      return running ? labels.webRun() : labels.web();
    case 'memory':
      return running ? labels.memoryRun() : labels.memory();
    case 'skill':
      return running ? labels.skillRun({ count }) : labels.skill({ count });
    case 'other':
      return '';
  }
}
