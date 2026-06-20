import type { ToolCall } from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import type { AgentProcessSegmentBlock } from './agentProcessTypes';
import { toolActivityKind, type ToolActivityKind, type ToolStatus } from './AgentToolCallBlock';

// Render-group splitting for the agent process timeline, mirroring Codex's
// `split-items-into-render-groups`. A run of CONSECUTIVE tool-call blocks folds
// into one counted "tool activity" group; a thinking or narration block (Codex:
// reasoning / assistant-message are hard boundaries) breaks the run, as does a
// child-run tool call (it carries rich inline content we must not hide). Lone
// runs stay un-grouped — Codex does not wrap a single tool in a summary.

type ToolCallBlock = Extract<AgentProcessSegmentBlock, { kind: 'toolCall' }>;

export type TimelineRenderGroup =
  | { kind: 'block'; block: AgentProcessSegmentBlock; index: number }
  | { kind: 'toolActivity'; id: string; members: ToolCallBlock[] };

export function splitTimelineIntoGroups(
  blocks: readonly AgentProcessSegmentBlock[],
  isChildRun: (block: ToolCallBlock) => boolean,
): TimelineRenderGroup[] {
  const groups: TimelineRenderGroup[] = [];
  let run: ToolCallBlock[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      groups.push({ kind: 'block', block: run[0]!, index: -1 });
    } else {
      groups.push({ kind: 'toolActivity', id: `activity:${run[0]!.toolCall.id}`, members: run });
    }
    run = [];
  };

  blocks.forEach((block, index) => {
    if (block.kind === 'toolCall' && !isChildRun(block)) {
      run.push(block);
      return;
    }
    flush();
    groups.push({ kind: 'block', block, index });
  });
  flush();
  return groups;
}

// ── Counted summary ─────────────────────────────────────────────────────────

export interface ToolActivitySummaryMember {
  status: ToolStatus;
  toolCall: ToolCall;
}

const KIND_ORDER: ToolActivityKind[] = [
  'command',
  'fileCreate',
  'fileEdit',
  'fileDelete',
  'read',
  'search',
  'web',
  'memory',
  'skill',
  'other',
];

// Tools whose count dedupes by subject path: editing the same file twice reads
// as "Edited a file", not two (Codex counts distinct paths via Set.size). Tools
// without a stable subject (commands, web/memory/skill) count every call.
const DEDUP_SUBJECT_KEYS: Partial<Record<ToolActivityKind, readonly string[]>> = {
  fileCreate: ['file_path', 'path', 'parentId'],
  fileEdit: ['file_path', 'path', 'nodeId'],
  fileDelete: ['nodeId', 'path'],
  read: ['nodeId', 'file_path', 'path'],
};

function dedupKey(kind: ToolActivityKind, toolCall: ToolCall): string {
  const keys = DEDUP_SUBJECT_KEYS[kind];
  if (keys) {
    for (const key of keys) {
      const value = toolCall.arguments[key];
      if (typeof value === 'string' && value.trim()) return `${kind}:${value.trim()}`;
    }
  }
  // No dedup subject → unique per call id, so it counts every occurrence.
  return `${kind}:#${toolCall.id}`;
}

interface Bucket {
  count: number;
  running: boolean;
}

// Lowercase the first character so a phrase reads as a mid-sentence fragment when
// joined after a leading (capitalized) phrase: "Ran 2 commands · read 3 nodes".
export function sentenceFragment(text: string): string {
  if (!text) return text;
  return `${text[0]!.toLowerCase()}${text.slice(1)}`;
}

export function summarizeToolActivity(
  members: readonly ToolActivitySummaryMember[],
  process: Messages['agent']['process'],
): string {
  const buckets = new Map<ToolActivityKind, Bucket>();
  const seen = new Set<string>();
  for (const member of members) {
    const kind = toolActivityKind(member.toolCall.name);
    const running = member.status === 'pending';
    const key = dedupKey(kind, member.toolCall);
    const bucket = buckets.get(kind);
    if (seen.has(key)) {
      // Duplicate subject: don't inflate the count, but a still-running duplicate
      // keeps the kind in the running tense.
      if (bucket && running) bucket.running = true;
      continue;
    }
    seen.add(key);
    if (bucket) {
      bucket.count += 1;
      bucket.running ||= running;
    } else {
      buckets.set(kind, { count: 1, running });
    }
  }

  const kinds = KIND_ORDER.filter((kind) => buckets.has(kind));
  if (kinds.length === 0) return process.usedTools({ count: members.length });
  return kinds
    .map((kind, index) => {
      const bucket = buckets.get(kind)!;
      const phrase = toolActivityPhrase(kind, bucket.count, bucket.running, process.toolActivity);
      return index === 0 ? phrase : sentenceFragment(phrase);
    })
    .join(' · ');
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
      return running ? labels.otherRun({ count }) : labels.other({ count });
  }
}
