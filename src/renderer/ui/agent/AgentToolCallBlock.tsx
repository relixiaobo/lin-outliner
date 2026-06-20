import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentToolResultPayloadPart, AgentToolResultWithPayloads, ToolCall } from '../../../core/agentTypes';
import type { AgentToolCallOutcome } from '../../../core/agentEventLog';
import type { AgentRenderChildRunEntity } from '../../../core/agentRenderProjection';
import { basenameForPath } from '../../../core/referenceMarkup';
import { formatRunDuration } from './agentProcessTypes';
import type { DocumentIndex } from '../../state/document';
import { api } from '../../api/client';
import { InlineFileReference } from '../editor/InlineFileReference';
import {
  AgentIcon,
  AddChildIcon,
  BrainIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  FileTextIcon,
  ICON_SIZE,
  LoaderIcon,
  NodeCreateToolIcon,
  NodeEditToolIcon,
  RestoreIcon,
  SearchIcon,
  SkillIcon,
  TerminalIcon,
  TrashIcon,
  UrlIcon,
  WarningIcon,
} from '../icons';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import type { Messages } from '../../../core/i18n';
import { highlightCode, plainCodeHtml } from '../editor/shikiHighlighter';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';
import { requestInsertFileIntoOutliner } from '../../agent/agentFileInsert';
import {
  AgentInlineReferenceText,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';
import { AgentToolCallDisclosure } from './AgentToolCallDisclosure';

interface AgentToolCallBlockProps {
  defaultExpanded?: boolean;
  expanded?: boolean;
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onToggle?: (anchorElement?: HTMLElement | null) => void;
  onOpenChildRunTranscript?: (childRunId: string) => void;
  pendingToolCallIds: ReadonlySet<string>;
  result?: AgentToolResultWithPayloads;
  conversationId?: string | null;
  childRun?: AgentRenderChildRunEntity;
  toolCall: ToolCall;
  outcome?: AgentToolCallOutcome;
  turnActive?: boolean;
}

export type ToolStatus = 'pending' | 'done' | 'error';

// Activity bucket for the counted tool-activity summary (Codex's
// "Ran 3 commands · read 2 files"). Maps our tool names onto Codex's verb
// families; `other` is the catch-all (unknown tools contribute a generic
// "used a tool" fragment, they never blank the whole summary).
export type ToolActivityKind =
  | 'command'
  | 'fileCreate'
  | 'fileEdit'
  | 'fileDelete'
  | 'read'
  | 'search'
  | 'web'
  | 'memory'
  | 'skill'
  | 'other';

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
  return pendingToolCallIds.has(toolCallId) || toolActive ? 'pending' : 'error';
}

// The `Agent*` family are child-run tools (rich inline content); they are never
// folded into a tool-activity group, so they do not need a bucket here.
export function toolActivityKind(name: string): ToolActivityKind {
  switch (name) {
    case 'bash':
      return 'command';
    case 'file_write':
    case 'node_create':
      return 'fileCreate';
    case 'file_edit':
    case 'node_edit':
      return 'fileEdit';
    case 'node_delete':
      return 'fileDelete';
    case 'node_read':
      return 'read';
    case 'node_search':
      return 'search';
    case 'web_search':
    case 'web_fetch':
      return 'web';
    case 'recall':
    case 'dream':
      return 'memory';
    case 'skill':
      return 'skill';
    default:
      return 'other';
  }
}

export function getToolIcon(toolCall: ToolCall) {
  if (
    toolCall.name === 'Agent'
    || toolCall.name === 'AgentStatus'
    || toolCall.name === 'AgentSend'
    || toolCall.name === 'AgentStop'
  ) return AgentIcon;
  if (toolCall.name === 'node_create') return NodeCreateToolIcon;
  if (toolCall.name === 'node_read') return FileTextIcon;
  if (toolCall.name === 'node_edit') return NodeEditToolIcon;
  if (toolCall.name === 'recall') return BrainIcon;
  if (toolCall.name === 'dream') return BrainIcon;
  if (toolCall.name === 'node_search' || toolCall.name === 'web_search') return SearchIcon;
  if (toolCall.name === 'node_delete') {
    return toolCall.arguments.restore === true ? RestoreIcon : TrashIcon;
  }
  if (toolCall.name === 'web_fetch') return UrlIcon;
  if (toolCall.name === 'bash') return TerminalIcon;
  if (toolCall.name === 'file_edit') return NodeEditToolIcon;
  if (toolCall.name === 'file_write') return NodeCreateToolIcon;
  return WarningIcon;
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
  if (status === 'done') return forms.done;
  return labels.failed({ verb: forms.base });
}

function withSubject(verb: string, subject: string | null, labels: ToolCallLabels): string {
  return subject ? labels.withSubject({ verb, subject: quoteSubject(subject, labels) }) : verb;
}

export function summarizeToolCall(toolCall: ToolCall, status: ToolStatus, labels: ToolCallLabels): string {
  const verbs = labels.verbs;
  if (toolCall.name === 'Agent') {
    const subject = pickSubject(toolCall.arguments, 'description', 'agent_type');
    return withSubject(verbByStatus(verbs.runChildAgent, status, labels), subject, labels);
  }
  if (toolCall.name === 'AgentStatus') return verbByStatus(verbs.checkChildAgent, status, labels);
  if (toolCall.name === 'AgentSend') return verbByStatus(verbs.messageChildAgent, status, labels);
  if (toolCall.name === 'AgentStop') return verbByStatus(verbs.stopChildRun, status, labels);
  const args = toolCall.arguments;
  if (toolCall.name === 'recall') {
    return withSubject(verbByStatus(verbs.recallMemory, status, labels), pickSubject(args, 'query'), labels);
  }
  if (toolCall.name === 'dream') {
    return verbByStatus(verbs.dreamMemory, status, labels);
  }
  if (toolCall.name === 'node_create') {
    const subject = pickSubject(args, 'parentId', 'afterId');
    const verb = verbByStatus(verbs.createNode, status, labels);
    return subject ? labels.under({ verb, subject: quoteSubject(subject, labels) }) : verb;
  }
  if (toolCall.name === 'node_read') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.readNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_edit') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.editNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_delete') {
    const subject = pickSubject(args, 'nodeId');
    return withSubject(verbByStatus(verbs.deleteNode, status, labels), subject, labels);
  }
  if (toolCall.name === 'node_search') {
    const subject = pickSubject(args, 'query', 'rules');
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
  if (toolCall.name === 'file_edit') {
    const subject = pickSubject(args, 'path', 'file_path');
    return withSubject(verbByStatus(verbs.editFile, status, labels), subject, labels);
  }
  if (toolCall.name === 'file_write') {
    const subject = pickSubject(args, 'file_path', 'path');
    return withSubject(verbByStatus(verbs.writeFile, status, labels), subject, labels);
  }
  // Unknown tools fall back to the raw tool name (an identifier, not translatable);
  // only the trailing pending ellipsis is localized.
  return verbByStatus(
    { base: toolCall.name, pending: labels.unknownPending({ name: toolCall.name }), done: toolCall.name },
    status,
    labels,
  );
}

export function childRunToolStatus(childRun: AgentRenderChildRunEntity): ToolStatus {
  if (childRun.status === 'running') return 'pending';
  if (childRun.status === 'failed' || childRun.status === 'stopped') return 'error';
  return 'done';
}

function formatChildRunMode(childRun: AgentRenderChildRunEntity): string {
  return `${childRun.contextMode} · ${childRun.agentType}`;
}

function formatChildRunDuration(childRun: AgentRenderChildRunEntity): string {
  // Same wall-clock ladder as the "Worked for …" process header — one source of
  // truth so the child-run row never drifts from it.
  return formatRunDuration((childRun.completedAt ?? childRun.updatedAt) - childRun.startedAt);
}

function childRunSummary(childRun: AgentRenderChildRunEntity, labels: Messages['agent']['childRun']): string {
  const description = childRun.description.trim() || childRun.name || childRun.id;
  return labels.summary({ description });
}

function previewText(text: string | undefined, maxLength = 520): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trim()}...` : normalized;
}

function ChildRunInlineDetails({
  index,
  onNodeReferenceOpen,
  onOpenTranscript,
  childRun,
}: {
  index?: DocumentIndex;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  onOpenTranscript?: (childRunId: string) => void;
  childRun: AgentRenderChildRunEntity;
}) {
  const t = useT();
  const result = previewText(childRun.result);
  const error = previewText(childRun.error);
  const prompt = previewText(childRun.prompt);
  const canOpenTranscript = !!onOpenTranscript;

  return (
    <div className="agent-child-run-inline">
      <dl className="agent-child-run-meta-grid">
        <div>
          <dt>{t.agent.childRun.status}</dt>
          <dd>{childRun.status}</dd>
        </div>
        <div>
          <dt>{t.agent.childRun.mode}</dt>
          <dd>{formatChildRunMode(childRun)}</dd>
        </div>
        <div>
          <dt>{t.agent.childRun.duration}</dt>
          <dd>{formatChildRunDuration(childRun)}</dd>
        </div>
      </dl>
      {childRun.name ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.childRun.name}</div>
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={childRun.name} />
          </pre>
        </section>
      ) : null}
      {prompt ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.childRun.prompt}</div>
            <ToolCopyButton ariaLabel={t.agent.childRun.copyPrompt} text={childRun.prompt} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={prompt} />
          </pre>
        </section>
      ) : null}
      {result ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.childRun.result}</div>
            <ToolCopyButton ariaLabel={t.agent.childRun.copyResult} text={childRun.result ?? ''} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={result} />
          </pre>
        </section>
      ) : null}
      {error ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              {t.agent.childRun.error}
              <span>{t.agent.toolCall.errorBadge}</span>
            </div>
            <ToolCopyButton ariaLabel={t.agent.childRun.copyError} text={childRun.error ?? ''} />
          </div>
          <pre>
            <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={error} />
          </pre>
        </section>
      ) : null}
      <div className="agent-child-run-inline-actions">
        <Button
          disabled={!canOpenTranscript}
          onClick={() => onOpenTranscript?.(childRun.id)}
          size="sm"
          variant="ghost"
        >
          <FileTextIcon size={ICON_SIZE.menu} />
          <span>{t.agent.childRun.viewTranscript}</span>
        </Button>
        <ToolCopyButton ariaLabel={t.agent.childRun.copyId} text={childRun.id} />
      </div>
    </div>
  );
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

// Read-only highlighted code surface for tool input/output. Renders plain text
// first, then upgrades to the shared Shiki highlight once the grammar resolves
// (json is preloaded; diff loads lazily on first file-tool render).
function HighlightedCode({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState(() => plainCodeHtml(code));
  useEffect(() => {
    let cancelled = false;
    void highlightCode(code, lang).then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return <div className="agent-tool-code" dangerouslySetInnerHTML={{ __html: html }} />;
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
    // Whether this chip opens with the OS default app (live transcript) or the in-app
    // preview pane (child-run details panel) is decided by location, not here: the
    // app-wide inline-file layer routes by a `[data-agent-transcript-chips]` ancestor,
    // which the live assistant message body sets once (see AgentAssistantContent). In
    // the child-run-details panel this same block has no such ancestor, so its result
    // chips keep the in-app preview — matching every other meta surface.
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

function ToolResultImages({ images }: { images: Array<{ data: string; mimeType: string }> }) {
  const t = useT();
  if (images.length === 0) return null;
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
      <pre>
        <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={visible.text} />
      </pre>
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
  onOpenChildRunTranscript,
  pendingToolCallIds,
  result,
  conversationId,
  childRun,
  toolCall,
  outcome,
  turnActive,
}: AgentToolCallBlockProps) {
  const t = useT();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const status = childRun ? childRunToolStatus(childRun) : getToolCallStatus(toolCall.id, result, pendingToolCallIds, turnActive, outcome);
  // Codex's per-step status glyph (machine A): a running spinner, a green check
  // on done, a red ✕ on failed — NOT the tool-type icon (the row's verb already
  // carries the type). The ring color comes from the `is-{status}` CSS.
  const StatusIcon = status === 'done' ? CheckIcon : status === 'error' ? CloseIcon : LoaderIcon;
  const isExpanded = expanded ?? internalExpanded;
  const inputText = useMemo(() => jsonText(toolCall.arguments), [toolCall.arguments]);
  const outputText = useMemo(() => resultText(result), [result]);
  const fileOutput = useMemo(
    () => parseFileToolOutput(toolCall, result, outputText),
    [toolCall, result, outputText],
  );
  const images = useMemo(() => resultImages(result), [result]);
  // A file output renders its own chip + diff, so the generic output parts (and
  // their flat-map over content) are only needed when there is no file output.
  const parts = useMemo(
    () => (fileOutput ? [] : resultParts(result, isExpanded)),
    [fileOutput, result, isExpanded],
  );
  const hasChildRunDetails = Boolean(childRun);
  const hasDetails = fileOutput
    ? hasChildRunDetails || fileOutput.diff.length > 0
    : hasChildRunDetails || inputText !== '{}' || outputText.length > 0;
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
      expanded={isExpanded}
      hasDetails={hasDetails}
      images={<ToolResultImages images={images} />}
      onToggle={toggle}
      status={status}
      statusIcon={StatusIcon}
      statusIconClassName={status === 'pending' ? 'agent-tool-call-spinner' : undefined}
      summary={childRun ? childRunSummary(childRun, t.agent.childRun) : summarizeToolCall(toolCall, status, t.agent.toolCall)}
    >
      {childRun ? (
        <ChildRunInlineDetails
          index={index}
          onNodeReferenceOpen={onNodeReferenceOpen}
          onOpenTranscript={onOpenChildRunTranscript}
          childRun={childRun}
        />
      ) : null}
      {!hasChildRunDetails && fileOutput && fileOutput.diff ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.toolCall.changes}</div>
            <ToolCopyButton ariaLabel={t.agent.toolCall.copyChanges} text={fileOutput.diff} />
          </div>
          <HighlightedCode code={fileOutput.diff} lang="diff" />
        </section>
      ) : null}
      {!hasChildRunDetails && !fileOutput && inputText !== '{}' ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">{t.agent.toolCall.input}</div>
            <ToolCopyButton ariaLabel={t.agent.toolCall.copyInput} text={inputText} />
          </div>
          <HighlightedJson code={inputText} />
        </section>
      ) : null}
      {!hasChildRunDetails && !fileOutput && result && hasOutputDetails ? (
        <section className="agent-tool-call-section">
          <div className="agent-tool-call-section-header">
            <div className="agent-tool-call-section-title">
              {t.agent.toolCall.output}
              {result.isError ? <span>{t.agent.toolCall.errorBadge}</span> : null}
            </div>
            <ToolCopyButton ariaLabel={t.agent.toolCall.copyOutput} text={outputText} />
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
              <pre key={`text-${partIndex}`}>
                <AgentInlineReferenceText index={index} onNodeReferenceOpen={onNodeReferenceOpen} text={part.text} />
              </pre>
            ),
          )}
        </section>
      ) : null}
    </AgentToolCallDisclosure>
  );
}
