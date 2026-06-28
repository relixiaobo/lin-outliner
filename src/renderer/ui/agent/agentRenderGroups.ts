import type { ToolCall } from '../../../core/agentTypes';
import type { Messages } from '../../../core/i18n';
import { toolActivityKind, type ToolActivityKind, type ToolStatus } from './AgentToolCallBlock';
import type { AgentTurnProcessItem, AgentTurnToolCallItem } from './agentTurnProjection';

// Render-group splitting for the agent process timeline, mirroring Codex's
// `split-items-into-render-groups`. A run of CONSECUTIVE tool-call items folds
// into one counted "tool activity" group; a reasoning or narration item (Codex:
// reasoning / assistant-message are hard boundaries) breaks the run. Lone runs
// stay un-grouped — Codex does not wrap a single tool in a summary.

export type TimelineRenderGroup =
  | { kind: 'item'; item: AgentTurnProcessItem }
  | { kind: 'toolActivity'; id: string; members: AgentTurnToolCallItem[] };

export function splitTimelineIntoGroups(
  items: readonly AgentTurnProcessItem[],
  breaksToolRun: (item: AgentTurnToolCallItem) => boolean,
): TimelineRenderGroup[] {
  const groups: TimelineRenderGroup[] = [];
  let run: AgentTurnToolCallItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      groups.push({ kind: 'item', item: run[0]! });
    } else {
      groups.push({ kind: 'toolActivity', id: `activity:${run[0]!.toolCall.id}`, members: run });
    }
    run = [];
  };

  for (const item of items) {
    if (item.type === 'toolCall' && !breaksToolRun(item)) {
      run.push(item);
      continue;
    }
    flush();
    groups.push({ kind: 'item', item });
  }
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

// Tools whose count dedupes by subject: editing the same node/file twice reads as
// "Edited a file", not two (Codex counts distinct subjects via Set.size). The arg
// keys are the model's raw wire shape — snake_case (`node_id`, `file_path`), and a
// node tool may carry a `node_ids` array for a batch operation. `fileCreate` is
// intentionally absent: a created node has no stable pre-execution id, so creating
// N nodes under one parent is N distinct creations (count every call), never a
// dedup-by-parent collapse. Commands and web/memory/skill also count every call.
const DEDUP_SUBJECT_KEYS: Partial<Record<ToolActivityKind, readonly string[]>> = {
  fileEdit: ['file_path', 'path', 'node_id', 'node_ids'],
  fileDelete: ['node_id', 'node_ids', 'path'],
  read: ['node_id', 'node_ids', 'file_path', 'path'],
};

// The distinct subjects a single tool call touches, for Set-dedup counting. A
// scalar key yields one subject; a `node_ids` array yields one per id (a batch
// read of 5 nodes counts as 5 distinct reads, Codex-style). Falls back to the
// call id when the tool exposes no subject, so such a call always counts as one.
function subjectKeys(kind: ToolActivityKind, toolCall: ToolCall): string[] {
  const keys = DEDUP_SUBJECT_KEYS[kind];
  if (keys) {
    const subjects: string[] = [];
    for (const key of keys) {
      const value = toolCall.arguments[key];
      if (typeof value === 'string' && value.trim()) {
        subjects.push(`${kind}:${value.trim()}`);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.trim()) subjects.push(`${kind}:${item.trim()}`);
        }
      }
    }
    if (subjects.length > 0) return subjects;
  }
  // No dedup subject (or none present on the call) → unique per call id.
  return [`${kind}:#${toolCall.id}`];
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
    let bucket = buckets.get(kind);
    for (const key of subjectKeys(kind, member.toolCall)) {
      if (seen.has(key)) {
        // Duplicate subject: don't inflate the count, but a still-running
        // duplicate keeps the kind in the running tense.
        if (bucket && running) bucket.running = true;
        continue;
      }
      seen.add(key);
      if (!bucket) {
        bucket = { count: 0, running: false };
        buckets.set(kind, bucket);
      }
      bucket.count += 1;
      bucket.running ||= running;
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
