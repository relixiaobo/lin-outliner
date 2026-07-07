import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentToolResultPayloadPart, AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderRunEntity } from '../../../core/agentRenderProjection';
import { basenameForPath } from '../../../core/referenceMarkup';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { InlineFileReference } from '../editor/InlineFileReference';
import {
  AddChildIcon,
  CheckIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  LoaderIcon,
  SkillIcon,
  ToolErrorIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';
import { requestInsertFileIntoOutliner } from '../../agent/agentFileInsert';
import {
  AgentInlineReferenceText,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';
import { PlainReadOnlyCodeBlock, ReadOnlyCodeBlock } from '../editor/CodeBlockSurface';
import { AgentToolCallDisclosure } from './AgentToolCallDisclosure';
import { displayRunStatus } from './AgentRunRow';
import { getToolIcon } from './agentToolPresentation';
import { usePreviewObjectUrl } from '../preview/usePreviewObjectUrl';

interface AgentToolCallBlockProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onToggle?: (anchorElement?: HTMLElement | null) => void;
  onOpenRunTranscript?: (runId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  result?: AgentToolResultWithPayloads;
  conversationId?: string | null;
  subRun?: AgentRenderRunEntity;
  toolCall: ToolCall;
  outcome?: AgentToolCallOutcome;
  turnActive?: boolean;
}

// `incomplete` = declared-but-never-settled (no result, no outcome, not running,
// turn over) — e.g. the tail of an interrupted/cancelled tool batch. It is NOT a
// failure: `error` is reserved for a confirmed failure (an error result or a
// failed outcome), so a never-run tool renders neutral, not an alarming red ✕.
export type ToolStatus = 'pending' | 'done' | 'error' | 'incomplete';

type ResultPart =
  | { type: 'imagePlaceholder' }
  | { type: 'persistedOutput'; payloadRef: AgentToolResultPayloadPart; text: string }
  | { type: 'text'; text: string };

const TOOL_OUTPUT_WINDOW_HEAD_CHARS = 12_000;
const TOOL_OUTPUT_WINDOW_TAIL_CHARS = 4_000;

interface LoadedSkillDetails {
  args: string | null;
  skill: string;
}

interface GeneratedImageDetails {
  providerId: string;
  modelId: string;
  modelName: string;
}

export function getToolCallStatus(
  toolCallId: string,
  result: AgentToolResultWithPayloads | undefined,
  pendingToolCallIds: ReadonlySet<string>,
  toolActive: boolean | undefined,
  outcome?: AgentToolCallOutcome,
): ToolStatus {
  if (result) return result.isError ? 'error' : 'done';
  // The settled `outcome` is authoritative even with no result message: some
  // tools complete without emitting a `tool_result.created`, so trust it to stop
  // the spinner rather than waiting on a result that may never arrive.
  if (outcome) return outcome === 'failed' ? 'error' : 'done';
  // Still in the live pending set / the active-turn bridge → running. Otherwise a
  // settled turn left this call with no result and no outcome: it never completed,
  // but that is `incomplete` (neutral), not a failure.
  return pendingToolCallIds.has(toolCallId) || toolActive ? 'pending' : 'incomplete';
}

function pickSubject(args: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

type ToolCallLabels = Messages['agent']['toolCall'];
type ToolVerbForms = { base: string; pending: string; done: string };

function quoteSubject(subject: string, labels: ToolCallLabels): string {
  const trimmed = subject.trim();
  const short = trimmed.length > 72 ? `${trimmed.slice(0, 72)}...` : trimmed;
  if (short.startsWith('http://') || short.startsWith('https://')) return short;
  return labels.quote({ text: short });
}

function verbByStatus(forms: ToolVerbForms, status: ToolStatus, labels: ToolCallLabels): string {
  if (status === 'pending') return forms.pending;
  // `incomplete` reads in the neutral past tense, not "Failed to …" — it never
  // ran, it did not fail.
  if (status === 'done' || status === 'incomplete') return forms.done;
  return labels.failed({ verb: forms.base });
}

function withSubject(verb: string, subject: string | null, labels: ToolCallLabels): string {
  return subject ? labels.withSubject({ verb, subject: quoteSubject(subject, labels) }) : verb;
}

function outlineUndoStackVerb(args: Record<string, unknown>, verbs: ToolCallLabels['verbs']): ToolVerbForms {
  if (args.action === 'undo') return verbs.undoOperation;
  if (args.action === 'redo') return verbs.redoOperation;
  return verbs.checkHistory;
}

function pastChatsVerb(args: Record<string, unknown>, verbs: ToolCallLabels['verbs']): ToolVerbForms {
  if (pickSubject(args, 'query')) return verbs.searchPastChats;
  if (args.recent === true) return verbs.checkRecentChats;
  return verbs.readPastChat;
}

function firstQuestionSubject(args: Record<string, unknown>): string | null {
  const questions = args.questions;
  if (!Array.isArray(questions)) return null;
  for (const item of questions) {
    if (!isRecord(item)) continue;
    const subject = pickSubject(item, 'question', 'header');
    if (subject) return subject;
  }
  return null;
}

export function summarizeToolCall(toolCall: ToolCall, status: ToolStatus, labels: ToolCallLabels): string {
  const verbs = labels.verbs;
  if (toolCall.name === 'spawn_run') {
    const subject = pickSubject(toolCall.arguments, 'description', 'objective', 'runProfile');
    return withSubject(verbByStatus(verbs.runChildAgent, status, labels), subject, labels);
  }
  if (toolCall.name === 'run_status') return verbByStatus(verbs.checkChildAgent, status, labels);
  if (toolCall.name === 'run_steer') return verbByStatus(verbs.messageChildAgent, status, labels);
  if (toolCall.name === 'run_stop') return verbByStatus(verbs.stopChildRun, status, labels);
  if (toolCall.name === 'run_amend') return verbByStatus(verbs.messageChildAgent, status, labels);
  const args = toolCall.arguments;
  if (toolCall.name === 'recall') {
    return withSubject(verbByStatus(verbs.recallMemory, status, labels), pickSubject(args, 'query'), labels);
  }
  if (toolCall.name === 'dream') {
    return verbByStatus(verbs.dreamMemory, status, labels);
  }
  if (toolCall.name === 'node_create') {
    const subject = pickSubject(args, 'parent_id', 'after_id');
    const verb = verbByStatus(verbs.createNode, status, labels);
    return subject ? labels.under({ verb, subject: quoteSubject(subject, labels) }) : verb;
  }
  if (toolCall.name === 'node_read') {
    const subject = pickSubject(args, 'node_id');
    return withSubject(verbByStatus(verbs.readNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_edit') {
    const subject = pickSubject(args, 'node_id');
    return withSubject(verbByStatus(verbs.editNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_delete') {
    const subject = pickSubject(args, 'node_id');
    return withSubject(verbByStatus(args.restore === true ? verbs.restoreNode : verbs.deleteNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_search') {
    const subject = pickSubject(args, 'outline', 'search_node_id');
    return withSubject(verbByStatus(verbs.searchNodes, status, labels), subject, labels);
  }
  if (toolCall.name === 'web_search') {
    const subject = pickSubject(args, 'query');
    return withSubject(verbByStatus(verbs.searchWeb, status, labels), subject, labels);
  }
  if (toolCall.name === 'web_fetch') {
    const subject = pickSubject(args, 'url');
    return withSubject(verbByStatus(verbs.fetchWeb, status, labels), subject, labels);
  }
  if (toolCall.name === 'bash') {
    const command = pickSubject(args, 'command', 'cmd');
    const firstLine = command?.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
    return withSubject(verbByStatus(verbs.runBash, status, labels), firstLine, labels);
  }
  if (toolCall.name === 'bash_stop') {
    return withSubject(verbByStatus(verbs.stopTask, status, labels), pickSubject(args, 'task_id'), labels);
  }
  if (toolCall.name === 'file_read') {
    return withSubject(verbByStatus(verbs.readFile, status, labels), pickSubject(args, 'file_path', 'path'), labels);
  }
  if (toolCall.name === 'file_glob') {
    return withSubject(verbByStatus(verbs.findFiles, status, labels), pickSubject(args, 'pattern', 'glob', 'path'), labels);
  }
  if (toolCall.name === 'file_grep') {
    return withSubject(verbByStatus(verbs.grepFiles, status, labels), pickSubject(args, 'pattern', 'query', 'path'), labels);
  }
  if (toolCall.name === 'file_edit') {
    const subject = pickSubject(args, 'path', 'file_path');
    return withSubject(verbByStatus(verbs.editFile, status, labels), subject, labels);
  }
  if (toolCall.name === 'file_write') {
    const subject = pickSubject(args, 'file_path', 'path');
    return withSubject(verbByStatus(verbs.writeFile, status, labels), subject, labels);
  }
  if (toolCall.name === 'file_delete') {
    return withSubject(verbByStatus(verbs.deleteFile, status, labels), pickSubject(args, 'file_path', 'path'), labels);
  }
  if (toolCall.name === 'outline_undo_stack') {
    return verbByStatus(outlineUndoStackVerb(args, verbs), status, labels);
  }
  if (toolCall.name === 'past_chats') {
    return withSubject(verbByStatus(pastChatsVerb(args, verbs), status, labels), pickSubject(args, 'query', 'message_id'), labels);
  }
  if (toolCall.name === 'skill') {
    return withSubject(verbByStatus(verbs.useSkill, status, labels), pickSubject(args, 'skill'), labels);
  }
  if (toolCall.name === 'skillify') {
    return withSubject(verbByStatus(verbs.authorSkill, status, labels), pickSubject(args, 'skill', 'name'), labels);
  }
  if (toolCall.name === 'ask_user_question') {
    return withSubject(verbByStatus(verbs.askUserQuestion, status, labels), firstQuestionSubject(args), labels);
  }
  // Unknown tools fall back to the raw tool name (an identifier, not translatable);
  // only the trailing pending ellipsis is localized.
  return verbByStatus(
    { base: toolCall.name, pending: labels.unknownPending({ name: toolCall.name }), done: toolCall.name },
    status,
    labels,
  );
}

function isRunControlTool(toolName: string): boolean {
  return toolName === 'spawn_run'
    || toolName === 'run_status'
    || toolName === 'run_steer'
    || toolName === 'run_amend'
    || toolName === 'run_stop';
}

export function runToolStatus(run: AgentRenderRunEntity): ToolStatus {
  const status = displayRunStatus(run);
  if (status === 'running' || status === 'active' || status === 'verifying') return 'pending';
  if (status === 'failed' || status === 'stopped' || status === 'blocked' || status === 'budget_exhausted') return 'error';
  return 'done';
}

function resultText(result: AgentToolResultWithPayloads | undefined): string {
  if (!result) return '';
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function getToolResultCopyText(result: AgentToolResultWithPayloads | undefined): string {
  return resultText(result);
}

function isImagePlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '[Image removed]' || trimmed.startsWith('[Image removed') || trimmed === '<image>';
}

function resultParts(result: AgentToolResultWithPayloads | undefined, expanded: boolean): ResultPart[] {
  if (!result || !expanded) return [];
  return result.content.flatMap((block, contentIndex): ResultPart[] => {
    if (block.type !== 'text') return [];
    const payloadRef = result.payloadRefs?.find((ref) => ref.contentIndex === contentIndex);
    if (payloadRef) {
      if (payloadRef.payload.mimeType.startsWith('image/')) return [];
      return [{ type: 'persistedOutput', payloadRef, text: block.text }];
    }
    return [
      isImagePlaceholder(block.text)
        ? { type: 'imagePlaceholder' }
        : { type: 'text', text: block.text },
    ];
  });
}

function resultImages(result: AgentToolResultWithPayloads | undefined): Array<{ data: string; mimeType: string }> {
  if (!result) return [];
  return result.content
    .filter((block): block is Extract<AgentToolResultWithPayloads['content'][number], { type: 'image' }> =>
      block.type === 'image')
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
}

function resultImagePayloadRefs(result: AgentToolResultWithPayloads | undefined): AgentToolResultPayloadPart[] {
  if (!result?.payloadRefs) return [];
  return result.payloadRefs.filter((ref) => ref.payload.mimeType.startsWith('image/'));
}

function generatedImageDetails(result: AgentToolResultWithPayloads | undefined): GeneratedImageDetails | null {
  if (!result || result.isError) return null;
  const details = result.details;
  if (!isRecord(details) || details.tool !== 'generate_image' || !isRecord(details.data)) return null;
  const data = details.data;
  if (typeof data.providerId !== 'string' || typeof data.modelId !== 'string') return null;
  return {
    providerId: data.providerId,
    modelId: data.modelId,
    modelName: typeof data.modelName === 'string' && data.modelName.trim() ? data.modelName.trim() : data.modelId,
  };
}

function isJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  return <ReadOnlyCodeBlock className="agent-tool-code" code={code} language={lang} />;
}

function HighlightedJson({ code }: { code: string }) {
  return <HighlightedCode code={code} lang="json" />;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface FileToolOutput {
  path: string;
  basename: string;
  // Unified-diff text, ready for Shiki's `diff` grammar; empty when there is no
  // patch to show (e.g. a newly created file).
  diff: string;
}

// A successful file_write / file_edit reports the written path and a structured
// patch in its model-visible content (the persisted text, so this survives a
// reload — `details` does not reach the render projection). Reading it here lets
// the conversation render the produced file as an inspectable chip + diff
// instead of a raw-JSON dump. `text` is the caller's already-computed
// `resultText(result)`, so the content blocks are walked once per render.
function parseFileToolOutput(
  toolCall: ToolCall,
  result: AgentToolResultWithPayloads | undefined,
  text: string,
): FileToolOutput | null {
  if (toolCall.name !== 'file_write' && toolCall.name !== 'file_edit') return null;
  if (!result || result.isError || !text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.data)) return null;
  const data = parsed.data;
  if (typeof data.filePath !== 'string' || !data.filePath) return null;
  return {
    path: data.filePath,
    basename: basenameForPath(data.filePath) || data.filePath,
    diff: unifiedDiff(data.structuredPatch),
  };
}

// Reassemble a unified-diff text from the structured patch so Shiki's `diff`
// grammar can color it — the same code-rendering path used for every other code
// surface, no bespoke diff colors. The `lines` already carry their `+`/`-`
// prefixes; this only re-adds the hunk headers.
function unifiedDiff(structuredPatch: unknown): string {
  if (!Array.isArray(structuredPatch)) return '';
  const blocks: string[] = [];
  for (const hunk of structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue;
    const lines = hunk.lines.filter((line): line is string => typeof line === 'string');
    if (lines.length === 0) continue;
    const header = `@@ -${num(hunk.oldStart)},${num(hunk.oldLines)} +${num(hunk.newStart)},${num(hunk.newLines)} @@`;
    blocks.push([header, ...lines].join('\n'));
  }
  return blocks.join('\n');
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// The produced file, shown as a local-file chip. The app-wide
// `InlineFilePreviewLayer` gives it hover preview + click-to-open into the
// FilePreviewPanel by matching the `data-inline-ref-kind="local-file"` attrs the
// shared `InlineFileReference` emits — the same chip the agent's prose file
// references render, so input and output read identically in the stream.
function ToolResultFileChip({ output }: { output: FileToolOutput }) {
  return (
    // Whether this chip opens in the workspace file-only reader (live transcript) or
    // the normal workspace preview pane (Run details panel) is decided by location, not here: the
    // app-wide inline-file layer routes by a `[data-agent-transcript-chips]` ancestor,
    // which the live transcript message frame sets once (see AgentMessageFrame). In
    // the Run details panel this same block has no such ancestor, so its result
    // chips keep the workspace preview — matching every other meta surface.
    <div className="agent-tool-file-output">
      <InlineFileReference
        className="agent-tool-file-chip"
        file={{
          entryKind: 'file',
          kind: 'file',
          mimeType: 'application/octet-stream',
          name: output.basename,
          path: output.path,
          ref: output.basename,
        }}
      />
      <InsertIntoOutlinerButton path={output.path} />
    </div>
  );
}

// The ingest bridge trigger (agent-file-model F4): promote a working file into the
// outliner as a first-class image/attachment node. The bridge (App) does the
// path->asset ingest + node creation; this only fires the request and shows a
// transient confirmation. Re-clicking inserts again (a fresh copy+freeze) -- the
// document references a snapshot, so "save the newer version" is just another click.
export function InsertIntoOutlinerButton({ path }: { path: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'inserting' | 'inserted'>('idle');
  const resetTimerRef = useRef<number | null>(null);
  // A ref, not `state`, guards re-entry: the `disabled` attribute only lands on the
  // next paint, so two clicks in the same frame both read a stale `state === 'idle'`
  // and would double-insert.
  const insertingRef = useRef(false);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function insert() {
    if (insertingRef.current) return;
    insertingRef.current = true;
    setState('inserting');
    let inserted = false;
    try {
      inserted = await requestInsertFileIntoOutliner(path);
    } catch {
      inserted = false;
    } finally {
      insertingRef.current = false;
    }
    if (!inserted) {
      // Nothing was inserted (file gone / out of root, or the bridge failed): drop
      // back to the actionable state rather than show a false confirmation.
      setState('idle');
      return;
    }
    setState('inserted');
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setState('idle');
      resetTimerRef.current = null;
    }, 1200);
  }

  const label = state === 'inserted'
    ? t.agent.toolCall.insertedIntoOutliner
    : t.agent.toolCall.insertIntoOutliner;
  const StateIcon = state === 'inserted' ? CheckIcon : state === 'inserting' ? LoaderIcon : AddChildIcon;
  return (
    <ButtonControl
      aria-label={label}
      className="agent-tool-file-insert"
      disabled={state === 'inserting'}
      onClick={() => void insert()}
      title={label}
    >
      <StateIcon
        aria-hidden="true"
        className={state === 'inserting' ? 'agent-tool-call-spinner' : undefined}
        size={ICON_SIZE.menu}
      />
    </ButtonControl>
  );
}

// A "loaded" skill renders as a compact glanceable chip (LoadedSkillAffordance),
// not an expandable tool row — so it must NEVER fold into a counted tool-activity
// group (which would bury the chip). Exported for the timeline's grouping break.
export function getLoadedSkillDetails(
  toolCall: ToolCall,
  result: AgentToolResultWithPayloads | undefined,
): LoadedSkillDetails | null {
  if (toolCall.name !== 'skill') return null;
  if (!result || result.isError) return null;
  const details = result?.details;
  const argumentSkill = pickSubject(toolCall.arguments, 'skill');
  if (isRecord(details)) {
    if (details.tool !== 'skill') return null;
    const data = details.data;
    if (!isRecord(data) || data.status !== 'loaded') return null;
    const detailSkill = typeof data.skill === 'string' ? data.skill.trim() : '';
    const skill = detailSkill || argumentSkill;
    if (!skill) return null;
    return {
      args: pickSubject(toolCall.arguments, 'args'),
      skill,
    };
  }
  const launched = /^Launching skill:\s*(.+)$/i.exec(resultText(result));
  if (!launched) return null;
  const launchedSkill = (launched[1] ?? '').trim();
  const skill = launchedSkill || argumentSkill;
  if (!skill) return null;
  return {
    args: pickSubject(toolCall.arguments, 'args'),
    skill,
  };
}

function LoadedSkillAffordance({ details }: { details: LoadedSkillDetails }) {
  return (
    <div className="agent-tool-call is-done">
      <div className="agent-loaded-skill">
        <SkillIcon aria-hidden="true" className="agent-loaded-skill-icon" size={ICON_SIZE.menu} />
        <span className="agent-loaded-skill-name" title={`/${details.skill}`}>/{details.skill}</span>
        {details.args ? (
          <span className="agent-loaded-skill-args" title={details.args}>{details.args}</span>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function outputWindow(
  text: string,
  formatOmitted: (params: { count: string }) => string,
): { text: string; windowed: boolean } {
  const limit = TOOL_OUTPUT_WINDOW_HEAD_CHARS + TOOL_OUTPUT_WINDOW_TAIL_CHARS;
  if (text.length <= limit) return { text, windowed: false };
  const omitted = text.length - limit;
  return {
    text: [
      text.slice(0, TOOL_OUTPUT_WINDOW_HEAD_CHARS),
      '',
      formatOmitted({ count: omitted.toLocaleString() }),
      '',
      text.slice(-TOOL_OUTPUT_WINDOW_TAIL_CHARS),
    ].join('\n'),
    windowed: true,
  };
}

function ToolCopyButton({ ariaLabel, text }: { ariaLabel: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  async function copy() {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1200);
  }

  return (
    <ButtonControl
      aria-label={ariaLabel}
      className="agent-tool-call-copy"
      disabled={!text}
      onClick={() => void copy()}
    >
      <CopyStateIcon size={ICON_SIZE.menu} />
    </ButtonControl>
  );
}

function ToolResultImages({
  conversationId,
  images,
  payloadRefs,
}: {
  conversationId?: string | null;
  images: Array<{ data: string; mimeType: string }>;
  payloadRefs: AgentToolResultPayloadPart[];
}) {
  const t = useT();
  if (images.length === 0 && payloadRefs.length === 0) return null;
  return (
    <div className="agent-tool-image-list">
      {images.map((image, index) => {
        const src = `data:${image.mimeType};base64,${image.data}`;
        return (
          <a href={src} key={`${image.mimeType}-${index}`} rel="noreferrer" target="_blank">
            <img alt={t.agent.toolCall.resultImageAlt({ index: index + 1 })} loading="lazy" src={src} />
          </a>
        );
      })}
      {payloadRefs.map((payloadRef, index) => (
        <PersistedToolImage
          conversationId={conversationId}
          key={payloadRef.payload.id}
          payloadRef={payloadRef}
          fallbackIndex={images.length + index + 1}
        />
      ))}
    </div>
  );
}

function PersistedToolImage({
  conversationId,
  fallbackIndex,
  payloadRef,
}: {
  conversationId?: string | null;
  fallbackIndex: number;
  payloadRef: AgentToolResultPayloadPart;
}) {
  const t = useT();
  const payload = payloadRef.payload;
  const runId = payload.scope?.type === 'run' ? payload.scope.runId : undefined;
  const target = useMemo(() => (
    conversationId
      ? {
          kind: 'agent-payload' as const,
          conversationId,
          ...(runId ? { runId } : {}),
          payloadId: payload.id,
          label: payload.summary || payloadRef.label || t.agent.toolCall.storedOutput,
        }
      : null
  ), [conversationId, payload.id, payload.summary, payloadRef.label, runId, t.agent.toolCall.storedOutput]);
  const preview = usePreviewObjectUrl(target, { enabled: Boolean(target), mimeType: payload.mimeType });
  const alt = payload.summary || payloadRef.label || t.agent.toolCall.resultImageAlt({ index: fallbackIndex });

  function openPreview() {
    if (!target) return;
    dispatchPreviewTargetOpen({ target });
  }

  return (
    <button
      aria-label={alt}
      className="agent-tool-image-preview"
      disabled={!target}
      onClick={openPreview}
      title={alt}
      type="button"
    >
      {preview.src ? (
        <img alt={alt} loading="lazy" src={preview.src} />
      ) : (
        <span className="agent-tool-image-preview-placeholder">
          {preview.error ? t.agent.toolCall.payloadUnavailable : t.common.loading}
        </span>
      )}
    </button>
  );
}

function GeneratedImageMeta({ details }: { details: GeneratedImageDetails | null }) {
  const t = useT();
  if (!details) return null;
  return (
    <div className="agent-tool-image-meta">
      {t.agent.toolCall.generatedWith({
        provider: details.providerId,
        model: details.modelName,
      })}
    </div>
  );
}

function PersistedToolOutput({
  initialText,
  index,
  onNodeReferenceOpen,
  payloadRef,
  conversationId,
}: {
  initialText: string;
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  payloadRef: AgentToolResultPayloadPart;
  conversationId?: string | null;
}) {
  const t = useT();
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const payload = payloadRef.payload;
  const visible = outputWindow(fullText ?? initialText, t.agent.toolCall.charsOmitted);
  const canLoad = !!conversationId && (payload.mimeType.startsWith('text/') || payload.mimeType === 'application/json');

  useEffect(() => () => {
    requestRef.current += 1;
  }, []);

  async function loadFullOutput() {
    if (!conversationId || loading) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setLoadError(null);
    try {
      const text = await api.agentPayloadText(conversationId, payload.id);
      if (requestId !== requestRef.current) return;
      if (text === null) {
        setLoadError(t.agent.toolCall.payloadUnavailable);
        return;
      }
      setFullText(text);
    } catch (caught) {
      if (requestId === requestRef.current) {
        setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }

  function previewOutput() {
    if (!conversationId) return;
    const runId = payload.scope?.type === 'run' ? payload.scope.runId : undefined;
    dispatchPreviewTargetOpen({
      target: {
        kind: 'agent-payload',
        conversationId,
        ...(runId ? { runId } : {}),
        payloadId: payload.id,
        label: payload.summary || t.agent.toolCall.storedOutput,
      },
    });
  }

  return (
    <div className="agent-tool-persisted-output">
      <div className="agent-tool-persisted-meta">
        <FileTextIcon size={ICON_SIZE.menu} />
        <span>{payload.summary || t.agent.toolCall.storedOutput}</span>
        <small>{formatBytes(payload.byteLength)}</small>
      </div>
      <PlainReadOnlyCodeBlock className="agent-tool-code" code={visible.text} copyLabel={t.agent.toolCall.copyFullOutput}>
        <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={visible.text} />
      </PlainReadOnlyCodeBlock>
      <div className="agent-tool-persisted-actions">
        <ButtonControl
          className="agent-tool-persisted-load"
          disabled={!conversationId}
          onClick={previewOutput}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{t.agent.toolCall.previewOutput}</span>
        </ButtonControl>
        <ButtonControl
          className="agent-tool-persisted-load"
          disabled={!canLoad || loading}
          onClick={() => void loadFullOutput()}
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{fullText ? t.agent.toolCall.reloadFullOutput : loading ? t.common.loading : t.agent.toolCall.loadFullOutput}</span>
        </ButtonControl>
        {fullText ? (
          <ToolCopyButton ariaLabel={t.agent.toolCall.copyFullOutput} text={fullText} />
        ) : null}
        {visible.windowed ? (
          <small>{t.agent.toolCall.windowed}</small>
        ) : null}
        {loadError ? (
          <small className="is-error">{loadError}</small>
        ) : null}
      </div>
    </div>
  );
}

export function AgentToolCallBlock({
  defaultExpanded = false,
  expanded,
  index,
  onNodeReferenceOpen,
  onToggle,
  onOpenRunTranscript,
  pendingToolCallIds,
  result,
  conversationId,
  subRun,
  toolCall,
  outcome,
  turnActive,
}: AgentToolCallBlockProps) {
  const t = useT();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const status = subRun ? runToolStatus(subRun) : getToolCallStatus(toolCall.id, result, pendingToolCallIds, turnActive, outcome);
  // Per-step glyph by exception (Codex machine A): a running spinner, a red ✕ on a
  // confirmed failure, otherwise the plain tool-type icon. A successful `done` step
  // gets NO green check — the past-tense verb ("Fetched web …") already reads as
  // success, so a success badge is just noise. `done` and the never-settled
  // `incomplete` both show the neutral tool icon; only a real failure stands out
  // (red ✕ in a danger ring, via the `is-error` CSS).
  const StatusIcon = status === 'error'
    ? ToolErrorIcon
    : status === 'pending'
      ? LoaderIcon
      : getToolIcon(toolCall);
  const isExpanded = expanded ?? internalExpanded;
  const inputText = useMemo(() => jsonText(toolCall.arguments), [toolCall.arguments]);
  const outputText = useMemo(() => resultText(result), [result]);
  const fileOutput = useMemo(
    () => parseFileToolOutput(toolCall, result, outputText),
    [toolCall, result, outputText],
  );
  const images = useMemo(() => resultImages(result), [result]);
  const imagePayloadRefs = useMemo(() => resultImagePayloadRefs(result), [result]);
  const imageDetails = useMemo(() => generatedImageDetails(result), [result]);
  // A file output renders its own chip + diff, so the generic output parts (and
  // their flat-map over content) are only needed when there is no file output.
  const parts = useMemo(
    () => (fileOutput ? [] : resultParts(result, isExpanded)),
    [fileOutput, result, isExpanded],
  );
  const canOpenRunTranscript = Boolean(subRun && onOpenRunTranscript);
  const hasDetails = fileOutput
    ? fileOutput.diff.length > 0 || Boolean(subRun)
    : inputText !== '{}' || outputText.length > 0 || Boolean(subRun);
  const hasOutputDetails = outputText.length > 0;
  const loadedSkillDetails = getLoadedSkillDetails(toolCall, result);

  function toggle(anchorElement?: HTMLElement | null) {
    if (onToggle) {
      onToggle(anchorElement);
      return;
    }
    setInternalExpanded((current) => !current);
  }

  if (loadedSkillDetails) {
    return <LoadedSkillAffordance details={loadedSkillDetails} />;
  }

  return (
    <AgentToolCallDisclosure
      attachments={fileOutput ? <ToolResultFileChip output={fileOutput} /> : null}
      disclosureId={`tool:${toolCall.id}`}
      expanded={isExpanded}
      hasDetails={hasDetails}
      images={(
        <>
          <ToolResultImages conversationId={conversationId} images={images} payloadRefs={imagePayloadRefs} />
          <GeneratedImageMeta details={imageDetails} />
        </>
      )}
      onToggle={toggle}
      status={status}
      statusIcon={StatusIcon}
      statusIconClassName={status === 'pending' ? 'agent-tool-call-spinner' : undefined}
      summary={summarizeToolCall(toolCall, status, t.agent.toolCall)}
    >
      {subRun ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.runTool.heading}</div>
          </div>
          <div className="agent-run-inline-actions">
            <Button
              disabled={!canOpenRunTranscript}
              onClick={() => onOpenRunTranscript?.(subRun.id)}
              size="sm"
              variant="ghost"
            >
              <FileTextIcon size={ICON_SIZE.menu} />
              <span>{t.agent.runTool.viewTranscript}</span>
            </Button>
            <ToolCopyButton ariaLabel={t.agent.runTool.copyId} text={subRun.id} />
          </div>
        </section>
      ) : null}
      {fileOutput && fileOutput.diff ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.toolCall.changes}</div>
          </div>
          <HighlightedCode code={fileOutput.diff} lang="diff" />
        </section>
      ) : null}
      {!fileOutput && inputText !== '{}' ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.toolCall.input}</div>
          </div>
          <HighlightedJson code={inputText} />
        </section>
      ) : null}
      {!fileOutput && result && hasOutputDetails && parts.length > 0 ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              {t.agent.toolCall.output}
              {result.isError ? <span>{t.agent.toolCall.errorBadge}</span> : null}
            </div>
          </div>
          {parts.map((part, partIndex) =>
            part.type === 'imagePlaceholder' ? (
              <div className="agent-tool-image-placeholder" key={`placeholder-${partIndex}`}>
                <FileTextIcon size={ICON_SIZE.menu} />
                <span>{t.agent.toolCall.screenshotCaptured}</span>
              </div>
            ) : part.type === 'persistedOutput' ? (
              <PersistedToolOutput
                initialText={part.text}
                index={index}
                key={`payload-${part.payloadRef.payload.id}`}
                onNodeReferenceOpen={onNodeReferenceOpen}
                payloadRef={part.payloadRef}
                conversationId={conversationId}
              />
            ) : isJsonText(part.text) ? (
              <HighlightedJson code={part.text} key={`text-${partIndex}`} />
            ) : (
              <PlainReadOnlyCodeBlock
                className="agent-tool-code"
                code={part.text}
                copyLabel={t.agent.toolCall.copyOutput}
                key={`text-${partIndex}`}
              >
                <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={part.text} />
              </PlainReadOnlyCodeBlock>
            ),
          )}
        </section>
      ) : null}
    </AgentToolCallDisclosure>
  );
}
