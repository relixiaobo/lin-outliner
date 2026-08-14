import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { Lexer, type Token, type Tokens } from 'marked';
import type {
  AgentTaskToolName,
  DynamicToolOutputContent,
  ItemExecutionStatus,
  JsonValue,
  RendererUserViewHints,
  ThreadAttachmentContent,
  ThreadItem,
  ThreadUserContent,
  UserMessageThreadItem,
} from '../../../../core/agent/protocol';
import type { Messages } from '../../../../core/i18n';
import { useT } from '../../../i18n/I18nProvider';
import type { DocumentIndex } from '../../../state/document';
import type { DocumentIndexStore } from '../../../state/documentIndexStore';
import { usePreviewObjectUrl } from '../../../ui/preview/usePreviewObjectUrl';
import { dispatchPreviewTargetOpen } from '../../../ui/preview/previewEvents';
import {
  AgentIcon,
  AddChildIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileDeleteToolIcon,
  FileEditToolIcon,
  FileGlobToolIcon,
  FileGrepToolIcon,
  FileImageIcon,
  FileReadToolIcon,
  FileWriteToolIcon,
  GenericToolIcon,
  ICON_SIZE,
  InfoIcon,
  LoaderIcon,
  McpToolIcon,
  NodeCreateToolIcon,
  NodeDeleteToolIcon,
  NodeEditToolIcon,
  NodeReadToolIcon,
  NodeSearchToolIcon,
  OutlineUndoStackToolIcon,
  PencilIcon,
  PlanToolIcon,
  QuestionToolIcon,
  RestoreIcon,
  SkillIcon,
  StopIcon,
  TerminalIcon,
  WebFetchToolIcon,
  WebSearchToolIcon,
} from '../../../ui/icons';
import { ReadOnlyCodeBlock } from '../../../ui/editor/CodeBlockSurface';
import { SubagentRunDetail } from '../SubagentRunDetail';
import { IconButton } from '../../../ui/primitives/IconButton';
import { ButtonControl } from '../../../ui/primitives/ButtonControl';
import { WorkingText } from '../../../ui/primitives/WorkingText';
import { canEditUserContentText, replaceUserContentText } from '../../threadInput';
import {
  threadNodeReferenceDisplayLabel,
  threadNodeReferenceHref,
  threadNodeReferenceOpenOptionsFromClick,
  threadNodeReferenceStyle,
  type ThreadNodeReferenceOpenHandler,
} from '../../threadReferences';
import { basenameForPath, splitReferenceMarkers } from '../../../../core/referenceMarkup';
import {
  boundedToolArgumentsForDisplay,
  modelCallArgumentSource,
  modelCallDisplayArguments,
} from '../../../../core/agent/modelCallHistory';
import { ThreadMarkdown } from '../ThreadMarkdown';
import { InlineFileReference } from '../../../ui/editor/InlineFileReference';
import { requestAddPreviewTargetToOutline } from '../../../ui/preview/previewIngest';
import { ToolCodeBlock } from '../ToolCodeBlock';
import type { DisclosureScrollAnchorHold } from '../../../ui/interactions/disclosureScrollAnchor';
import { userFacingAgentError } from '../../threadErrorMessage';
import { formatSubagentDuration, useSubagentElapsedMs } from '../subagentElapsed';
import {
  collaborationResultSnapshot,
  collaborationThreadIds,
  presentationFromActivity,
  presentationFromSnapshot,
  type SubagentPresentation,
} from '../../subagentPresentation';

export type ThreadToolItem = Extract<ThreadItem, {
  type:
    | 'commandExecution'
    | 'fileChange'
    | 'mcpToolCall'
    | 'dynamicToolCall'
    | 'collabAgentToolCall'
    | 'webSearch';
}>;

interface ThreadItemViewProps {
  readonly active: boolean;
  readonly agentResponseTail: ReactNode;
  readonly canEditUserMessage: boolean;
  readonly defaultReasoningExpanded: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly getUserView: () => RendererUserViewHints;
  readonly index: DocumentIndex;
  readonly indexStore: DocumentIndexStore;
  readonly item: ThreadItem;
  /** This user-role Item was authored by the host, as proven by its Turn. */
  readonly hostAuthoredEvent?: boolean;
  readonly showMessageActions: boolean;
  readonly streaming: boolean;
  readonly subagents?: ReadonlyMap<string, SubagentPresentation>;
  readonly threadId: string;
  readonly threadCwd: string;
  /** False while this Turn is blocked or recovering. The same phrases remain
   *  mounted as static text, but must not claim that work is advancing. */
  readonly workingTextEnabled: boolean;
  readonly onEditUserMessage: (content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onAgentMessageContextMenu?: MouseEventHandler<HTMLElement>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenTurnDetails?: () => void;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  /** Absent where no Stop belongs — a read-only or historical rendering. */
  readonly onInterruptThread?: (threadId: string) => Promise<void>;
  /** Turn Details for a Thread other than this one — a delegated child's. */
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  /** Present only inside a run detail: swap that container, do not nest one. */
  readonly onSubagentDrill?: (threadId: string) => void;
  readonly onReadToolArguments: (item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onReadToolOutput: (item: ThreadToolItem) => Promise<string | null>;
}

export interface ThreadDisclosureState {
  readonly captureAnchor: (anchorElement: HTMLElement | null) => void;
  readonly holdAnchorUntilSettled: () => DisclosureScrollAnchorHold | null;
  readonly isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
  readonly restoreAnchor: () => void;
  readonly toggle: (id: string, currentlyExpanded: boolean, anchorElement?: HTMLElement | null) => void;
}

export function isThreadToolItem(item: ThreadItem): item is ThreadToolItem {
  return item.type === 'commandExecution'
    || item.type === 'fileChange'
    || item.type === 'mcpToolCall'
    || item.type === 'dynamicToolCall'
    || item.type === 'collabAgentToolCall'
    || item.type === 'webSearch';
}

export function ThreadItemView(props: ThreadItemViewProps) {
  const t = useT();
  switch (props.item.type) {
    case 'userMessage':
      return <UserMessageItem {...props} item={props.item} />;
    case 'agentMessage':
      if (props.item.phase === 'commentary' && !props.item.text.trim()) return null;
      return (
        <article
          className={`thread-item thread-agent-message thread-agent-message-${props.item.phase ?? 'response'}`}
          onContextMenu={props.onAgentMessageContextMenu}
        >
          <div className="thread-agent-message-body">
            <ThreadMarkdown
              index={props.index}
              onNodeReferenceOpen={props.onOpenNodeReference}
              streaming={props.streaming}
              text={props.item.text}
            />
          </div>
          {props.item.phase === 'final_answer' || props.item.phase === null
            ? props.agentResponseTail
            : null}
        </article>
      );
    case 'reasoning':
      return (
        <ReasoningDisclosure
          defaultExpanded={props.defaultReasoningExpanded}
          disclosureId={`reasoning:${props.item.id}`}
          expandState={props.expandState}
          index={props.index}
          onOpenNodeReference={props.onOpenNodeReference}
          parts={[...props.item.summary, ...props.item.content]}
          streaming={props.streaming}
          workingTextEnabled={props.workingTextEnabled}
        />
      );
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
    case 'webSearch':
      return (
        <ToolItemDisclosure
          expandState={props.expandState}
          index={props.index}
          item={props.item}
          onReadArguments={props.onReadToolArguments}
          onReadOutput={props.onReadToolOutput}
          onOpenThread={props.onOpenThread}
          subagents={props.subagents}
          threadId={props.threadId}
          threadCwd={props.threadCwd}
          workingTextEnabled={props.workingTextEnabled}
        />
      );
    case 'subAgentActivity': {
      return <SubagentActivityItem {...props} item={props.item} />;
    }
    case 'imageView':
      return <ImageViewItem path={props.item.path} />;
    case 'contextEvidence':
      return null;
    case 'contextReset':
      return (
        <div className="thread-item thread-compaction">
          <span>{t.agent.thread.item.contextCleared}</span>
          {props.onOpenTurnDetails ? (
            <IconButton
              icon={InfoIcon}
              label={t.agent.message.details}
              onClick={props.onOpenTurnDetails}
              variant="message"
            />
          ) : null}
        </div>
      );
    case 'contextCompaction':
      return (
        <div className="thread-item thread-compaction">
          <span>{t.agent.thread.item.compaction}</span>
          {props.onOpenTurnDetails ? (
            <IconButton
              icon={InfoIcon}
              label={t.agent.message.details}
              onClick={props.onOpenTurnDetails}
              variant="message"
            />
          ) : null}
        </div>
      );
    default:
      return assertNever(props.item);
  }
}

export function ThreadToolActivityGroup({
  expandState,
  index,
  items,
  onReadToolOutput,
  onReadToolArguments,
  onOpenThread,
  subagents,
  threadId,
  threadCwd,
  workingTextEnabled,
}: {
  readonly expandState: ThreadDisclosureState;
  readonly index?: DocumentIndex;
  readonly items: readonly ThreadToolItem[];
  readonly onReadToolArguments: (item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onReadToolOutput: (item: ThreadToolItem) => Promise<string | null>;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly subagents?: ReadonlyMap<string, SubagentPresentation>;
  readonly threadId: string;
  readonly threadCwd: string;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const disclosureId = `tools:${items[0]?.id ?? 'empty'}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const status = groupStatus(items);
  const collaborationIds = subagents ? collaborationThreadIds(subagents) : undefined;
  const segments = threadToolActivitySegments(items, t.agent.thread.activity, index, {
    collaborationThreadIds: collaborationIds,
  });
  // The tooltip re-derives the summary with no elision, so the names the row
  // could not fit are still reachable.
  const title = summarizeThreadToolActivity(
    items, t.agent.thread.activity, index, {
      collaborationThreadIds: collaborationIds,
      subjectLimit: Number.POSITIVE_INFINITY,
    },
  );
  return (
    <div className={`thread-item thread-tool-activity-group thread-tool-${status}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="thread-tool-activity-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <DisclosureIndicator expanded={expanded} status={groupGlyph(items)} />
        <ToolSummaryText
          className="thread-tool-activity-summary"
          segments={segments}
          title={title}
          working={workingTextEnabled && status === 'inProgress' && !expanded}
        />
      </ButtonControl>
      {expanded ? (
        <div className="thread-tool-activity-members">
          {items.map((item) => (
            <ToolItemDisclosure
              expandState={expandState}
              index={index}
              item={item}
              key={item.id}
              onReadArguments={onReadToolArguments}
              onReadOutput={onReadToolOutput}
              onOpenThread={onOpenThread}
              subagents={subagents}
              threadId={threadId}
              threadCwd={threadCwd}
              workingTextEnabled={workingTextEnabled}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UserMessageItem({
  canEditUserMessage,
  expandState,
  index,
  indexStore,
  item,
  hostAuthoredEvent = false,
  onEditUserMessage,
  onOpenNodeReference,
  showMessageActions,
  threadId,
}: Omit<ThreadItemViewProps, 'item'> & { readonly item: UserMessageThreadItem }) {
  const t = useT();
  const textEditable = canEditUserContentText(item.content);
  const textParts = item.content.flatMap((content) => content.type === 'text' ? [content.text] : []);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(textParts[0] ?? '');
  const [saving, setSaving] = useState(false);
  const copyMessage = useCallback(async () => {
    const text = userMessageCopyText(item.content, indexStore.getCurrent());
    if (text) await navigator.clipboard.writeText(text);
  }, [indexStore, item.content]);

  async function save() {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await onEditUserMessage(replaceUserContentText(item.content, text));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`thread-item ${hostAuthoredEvent ? 'thread-host-event' : 'thread-user-message'}`}>
      {hostAuthoredEvent ? (
        <div className="thread-host-event-label">
          <AgentIcon aria-hidden size={ICON_SIZE.rowGlyph} />
          <span>{t.agent.thread.agentEvent}</span>
        </div>
      ) : null}
      {editing ? (
        <div className="thread-message-editor">
          <textarea
            autoFocus
            aria-label={t.agent.message.editMessage}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void save();
            }}
            rows={3}
            value={text}
          />
          <div>
            <button className="button button-ghost" onClick={() => setEditing(false)} type="button">
              {t.agent.message.cancel}
            </button>
            <button className="button button-primary" disabled={!text.trim() || saving} onClick={() => void save()} type="button">
              {t.agent.message.save}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="thread-user-content-sequence">
            {renderUserContent(
              item.content,
              index,
              onOpenNodeReference,
              threadId,
              item.id,
              expandState,
            )}
          </div>
          <div className="thread-message-actions-slot">
            {showMessageActions ? (
              <div className="thread-message-actions">
                {!hostAuthoredEvent && canEditUserMessage && textEditable ? (
                  <IconButton
                    icon={PencilIcon}
                    iconSize={ICON_SIZE.menu}
                    label={t.agent.message.editMessage}
                    onClick={() => setEditing(true)}
                    variant="message"
                  />
                ) : null}
                <ThreadMessageCopyButton
                  iconSize={ICON_SIZE.menu}
                  label={t.agent.message.copyMessage}
                  onCopy={copyMessage}
                  text=""
                />
              </div>
            ) : null}
          </div>
        </>
      )}
    </article>
  );
}

function userMessageCopyText(
  content: readonly ThreadUserContent[],
  index: DocumentIndex,
): string {
  return content.map((part, contentIndex) => {
    const separator = hasAdjacentAttachmentBefore(content, contentIndex) ? ' ' : '';
    if (part.type === 'text') return part.text;
    if (part.type === 'attachment') return `${separator}${part.name}`;
    return threadNodeReferenceDisplayLabel(part.note ?? '', part.nodeId, index, part.nodeId);
  }).join('');
}

function hasAdjacentAttachmentBefore(
  content: readonly ThreadUserContent[],
  contentIndex: number,
): boolean {
  return contentIndex > 0
    && content[contentIndex]?.type === 'attachment'
    && content[contentIndex - 1]?.type === 'attachment';
}

function renderUserContent(
  content: readonly ThreadUserContent[],
  index: DocumentIndex,
  onOpenNodeReference: ThreadNodeReferenceOpenHandler,
  threadId: string,
  itemId: string,
  expandState: ThreadDisclosureState,
): ReactNode[] {
  const images: ThreadAttachmentContent[] = [];
  const narrative: ReactNode[] = [];
  content.forEach((part, contentIndex) => {
    if (hasAdjacentAttachmentBefore(content, contentIndex)) narrative.push(' ');
    if (part.type === 'attachment' && part.mimeType.startsWith('image/')) {
      images.push(part);
      narrative.push(
        <ThreadInlineAttachment
          content={part}
          key={`attachment-${contentIndex}`}
          threadId={threadId}
        />,
      );
      return;
    }
    if (part.type === 'text') {
      narrative.push(<span key={`text-${contentIndex}`}>{part.text}</span>);
      return;
    }
    if (part.type === 'nodeReference') {
      narrative.push(
        <a
          className="inline-ref thread-message-inline-ref"
          href={threadNodeReferenceHref(part.nodeId)}
          key={`node-${contentIndex}`}
          onClick={(event) => {
            event.preventDefault();
            onOpenNodeReference(part.nodeId, threadNodeReferenceOpenOptionsFromClick(event));
          }}
          style={threadNodeReferenceStyle(part.nodeId, index)}
        >
          {threadNodeReferenceDisplayLabel(part.note ?? '', part.nodeId, index, part.nodeId)}
        </a>,
      );
      return;
    }
    narrative.push(
      <ThreadInlineAttachment
        content={part}
        key={`attachment-${contentIndex}`}
        threadId={threadId}
      />,
    );
  });
  const rendered: ReactNode[] = [];
  if (images.length > 0) {
    rendered.push(
      <ThreadImageGallery
        contents={images}
        expandState={expandState}
        key="images"
        threadId={threadId}
      />,
    );
  }
  if (narrative.length > 0) {
    rendered.push(
      <UserMessageCollapsibleContent
        key="narrative"
        measureKey={`${itemId}:narrative`}
        expandState={expandState}
      >
        <div className="thread-user-inline-content">{narrative}</div>
      </UserMessageCollapsibleContent>,
    );
  }
  return rendered;
}

const USER_MESSAGE_COLLAPSED_LINES = 5;
const USER_MESSAGE_COLLAPSED_EXTRA_PX = 16;

function UserMessageCollapsibleContent({
  children,
  expandState,
  measureKey,
}: {
  readonly children: ReactNode;
  readonly expandState: ThreadDisclosureState;
  readonly measureKey: string;
}) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const captureDisclosureAnchor = useLocalDisclosureAnchor(expanded, expandState);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [measureKey]);

  const measure = useCallback(() => {
    const element = contentRef.current;
    if (!element) return;
    const style = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || 26;
    const collapsedHeight = lineHeight * USER_MESSAGE_COLLAPSED_LINES + USER_MESSAGE_COLLAPSED_EXTRA_PX;
    const nextCanCollapse = element.scrollHeight > collapsedHeight + 1;
    setCanCollapse((current) => current === nextCanCollapse ? current : nextCanCollapse);
  }, []);

  useLayoutEffect(() => {
    measure();
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, measureKey]);

  const collapsed = canCollapse && !expanded;
  return (
    <div className="thread-user-content-shell">
      <div
        className={`thread-user-content-body${collapsed ? ' is-collapsed' : ''}`}
        ref={contentRef}
      >
        {children}
      </div>
      {canCollapse ? (
        <ButtonControl
          aria-expanded={expanded}
          className="thread-user-expand-button"
          onClick={(event) => {
            captureDisclosureAnchor(event.currentTarget);
            setExpanded((current) => !current);
          }}
        >
          <span>{expanded ? t.agent.message.showLess : t.agent.message.showMore}</span>
          <ChevronDownIcon
            aria-hidden
            className={`thread-user-expand-chevron${expanded ? ' is-expanded' : ''}`}
            size={ICON_SIZE.tiny}
          />
        </ButtonControl>
      ) : null}
    </div>
  );
}

function ReasoningDisclosure({
  defaultExpanded,
  disclosureId,
  expandState,
  index,
  onOpenNodeReference,
  parts,
  streaming,
  workingTextEnabled,
}: {
  readonly defaultExpanded: boolean;
  readonly disclosureId: string;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly parts: readonly string[];
  readonly streaming: boolean;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const summaryRef = useRef<HTMLSpanElement | null>(null);
  const summaryMeasureFrameRef = useRef<number | null>(null);
  const summaryMeasuredRef = useRef(false);
  const [summaryOverflow, setSummaryOverflow] = useState(false);
  const text = parts.join('\n\n');
  const trimmed = text.trim();
  const hasText = trimmed.length > 0;
  const presentation = reasoningPresentation(trimmed);
  const expanded = expandState.isExpanded(disclosureId, defaultExpanded);
  const measureSummary = useCallback(() => {
    const element = summaryRef.current;
    if (!element) return;
    const nextOverflow = element.scrollWidth > element.clientWidth + 1;
    setSummaryOverflow((current) => current === nextOverflow ? current : nextOverflow);
  }, []);

  const cancelScheduledSummaryMeasure = useCallback(() => {
    if (summaryMeasureFrameRef.current === null) return;
    window.cancelAnimationFrame(summaryMeasureFrameRef.current);
    summaryMeasureFrameRef.current = null;
  }, []);

  const scheduleSummaryMeasure = useCallback(() => {
    if (summaryMeasureFrameRef.current !== null) return;
    summaryMeasureFrameRef.current = window.requestAnimationFrame(() => {
      summaryMeasureFrameRef.current = null;
      measureSummary();
    });
  }, [measureSummary]);

  useLayoutEffect(() => {
    if (!hasText) return;
    const discoveringExpandedOverflow = expanded
      && !presentation.details
      && !summaryOverflow;
    if (expanded && !discoveringExpandedOverflow) return;
    if (streaming && summaryMeasuredRef.current) scheduleSummaryMeasure();
    else {
      cancelScheduledSummaryMeasure();
      measureSummary();
      summaryMeasuredRef.current = true;
    }
  }, [
    cancelScheduledSummaryMeasure,
    expanded,
    hasText,
    measureSummary,
    presentation.details,
    presentation.summary,
    scheduleSummaryMeasure,
    streaming,
    summaryOverflow,
  ]);

  const canExpand = Boolean(presentation.details) || summaryOverflow;

  useLayoutEffect(() => {
    if (!hasText || expanded) return undefined;
    const element = summaryRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measureSummary);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canExpand, disclosureId, expanded, hasText, measureSummary]);

  useEffect(() => () => cancelScheduledSummaryMeasure(), [cancelScheduledSummaryMeasure]);

  if (!hasText) {
    // Same class set as the populated branch: the first token must not change
    // the element's classes underneath the reader.
    return streaming
      ? (
          <div className="thread-item thread-reasoning is-thinking">
            {workingTextEnabled
              ? <WorkingText text={t.agent.thinking.thinking} />
              : <span>{t.agent.thinking.thinking}</span>}
          </div>
        )
      : null;
  }
  if (!canExpand) {
    return (
      <div className="thread-item thread-reasoning">
        <span className="thread-reasoning-summary" ref={summaryRef} title={presentation.summary}>
          {presentation.summary}
        </span>
      </div>
    );
  }
  return (
    <div className="thread-item thread-reasoning">
      <ButtonControl
        aria-expanded={expanded}
        className={`thread-reasoning-toggle${expanded ? ' is-expanded' : ''}`}
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <span className="thread-reasoning-summary" ref={summaryRef} title={presentation.summary}>
          {presentation.summary}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={`thread-reasoning-chevron${expanded ? ' is-expanded' : ''}`}
          size={ICON_SIZE.menu}
        />
      </ButtonControl>
      {expanded && presentation.details ? (
        <div className="thread-reasoning-body">
          <ThreadMarkdown
            index={index}
            onNodeReferenceOpen={onOpenNodeReference}
            streaming={streaming}
            text={presentation.details}
          />
        </div>
      ) : null}
    </div>
  );
}

function ToolItemDisclosure({
  expandState,
  index,
  item,
  onReadArguments,
  onReadOutput,
  onOpenThread,
  subagents,
  threadId,
  threadCwd,
  workingTextEnabled,
}: {
  readonly expandState: ThreadDisclosureState;
  readonly index?: DocumentIndex;
  readonly item: ThreadToolItem;
  readonly onReadArguments: (item: ThreadToolItem) => Promise<JsonValue | null>;
  readonly onReadOutput: (item: ThreadToolItem) => Promise<string | null>;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly subagents?: ReadonlyMap<string, SubagentPresentation>;
  readonly threadId: string;
  readonly threadCwd: string;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const disclosureId = `tool:${item.id}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const argumentRefId = toolArgumentPayloadId(item);
  const outputRefId = item.type === 'collabAgentToolCall' ? null : item.outputRef?.id ?? null;
  const itemRef = useRef(item);
  itemRef.current = item;
  const [loadedOutput, setLoadedOutput] = useState<{
    readonly outputRefId: string;
    readonly text: string | null;
  } | null>(null);
  const outputLoaded = loadedOutput?.outputRefId === outputRefId;
  const [loadedArguments, setLoadedArguments] = useState<{
    readonly argumentRefId: string;
    readonly value: JsonValue | null;
  } | null>(null);
  const argumentsLoaded = loadedArguments?.argumentRefId === argumentRefId;
  const fallbackArguments = useMemo(
    () => modelCallDisplayArguments(item.modelCall),
    [item.modelCall],
  );
  const outputAnchorHoldRef = useRef<DisclosureScrollAnchorHold | null>(null);
  const holdAnchorUntilSettled = expandState.holdAnchorUntilSettled;
  useEffect(() => {
    const needsOutput = Boolean(outputRefId && !outputLoaded);
    const needsArguments = Boolean(argumentRefId && !argumentsLoaded);
    if (!expanded || (!needsOutput && !needsArguments)) return undefined;
    let cancelled = false;
    const anchorHold = outputAnchorHoldRef.current ?? holdAnchorUntilSettled();
    outputAnchorHoldRef.current = anchorHold;
    const settleAnchorHold = () => {
      anchorHold?.settle();
      if (outputAnchorHoldRef.current === anchorHold) outputAnchorHoldRef.current = null;
    };
    const outputRead = needsOutput
      ? onReadOutput(itemRef.current).catch(() => null)
      : Promise.resolve(undefined);
    const argumentsRead = needsArguments
      ? onReadArguments(itemRef.current).catch(() => null)
      : Promise.resolve(undefined);
    void Promise.all([outputRead, argumentsRead])
      .then(([text, value]) => {
        if (cancelled) return;
        if (needsOutput && outputRefId) setLoadedOutput({ outputRefId, text: text ?? null });
        if (needsArguments && argumentRefId) {
          setLoadedArguments({
            argumentRefId,
            value: value === null || value === undefined
              ? null
              : boundedToolArgumentsForDisplay(value),
          });
        }
      })
      .finally(settleAnchorHold);
    return () => {
      cancelled = true;
      settleAnchorHold();
    };
  }, [
    argumentRefId,
    argumentsLoaded,
    expanded,
    holdAnchorUntilSettled,
    onReadArguments,
    onReadOutput,
    outputLoaded,
    outputRefId,
  ]);
  const argumentsValue = argumentsLoaded && loadedArguments.value !== null
    ? loadedArguments.value
    : fallbackArguments;
  const detail = toolDetail(
    item,
    t,
    onOpenThread,
    threadId,
    subagents,
    argumentsValue,
    workingTextEnabled,
  );
  const detailInput = detail.input;
  const output = (outputLoaded ? loadedOutput.text : undefined) ?? detail.output;
  const segments = threadToolItemSegments(item, t.agent.thread.activity, index);
  // A caller-authored description replaces the shell text in the label, so the
  // tooltip has to keep the command itself visible without expanding the row —
  // the description is a claim, the command is the fact.
  const title = item.type === 'commandExecution' && item.description
    ? `${item.description}\n${item.command}`
    : summarizeThreadToolItem(item, t.agent.thread.activity, index, {
      subjectLimit: Number.POSITIVE_INFINITY,
    });
  const expandedSubagentOwnsWorking = expanded
    && item.type === 'collabAgentToolCall'
    && item.receiverThreadIds.some((receiverThreadId) => (
      isSubagentWorkingStatus(collaborationPresentation(item, receiverThreadId, subagents).status)
    ));
  return (
    <div className={`thread-item thread-tool thread-tool-${item.status}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="thread-tool-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => {
          expandState.toggle(disclosureId, expanded, event.currentTarget);
          if (!expanded && ((outputRefId && !outputLoaded) || (argumentRefId && !argumentsLoaded))) {
            outputAnchorHoldRef.current = holdAnchorUntilSettled();
          }
        }}
      >
        <DisclosureIndicator expanded={expanded} status={toolIcon(item)} />
        <ToolSummaryText
          className="thread-tool-label"
          segments={segments}
          title={title}
          working={workingTextEnabled && item.status === 'inProgress' && !expandedSubagentOwnsWorking}
        />
      </ButtonControl>
      {expanded ? (
        <div className="thread-tool-body">
          {detailInput ? (
            <ToolDetailSection label={t.agent.thread.item.arguments}>
              <ToolCodeBlock
                code={detailInput}
                copyLabel={t.agent.thread.item.copyArguments}
                cwd={threadCwd}
                language={detail.inputLanguage}
              />
            </ToolDetailSection>
          ) : null}
          {detail.body}
          {/*
            No output, no section — including for a failure. The exit code rides
            this heading and so depends on there being output to hang it on,
            which holds because the executor writes `aggregatedOutput` and
            `exitCode` into the same object literal
            (`PiTurnExecutor.completedToolItem`) from a tool envelope that is
            never empty: a code cannot outlive the output beside it. The one
            reachable failure with neither is an Item closed by
            `finishOpenItems('failed')` when its Turn was interrupted or
            crashed, and that call was cut off rather than silent — printing
            `No output` under it would assert something we do not know.
          */}
          {output ? (
            <ToolDetailSection failed={detail.outcome.failed} label={detail.outcome.label}>
              <ToolCodeBlock
                code={output}
                copyLabel={t.agent.thread.item.copyOutput}
                cwd={threadCwd}
                language={outputLoaded && loadedOutput.text
                  ? outputLanguage(loadedOutput.text)
                  : detail.outputLanguage}
              />
            </ToolDetailSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ToolDetailSection({
  children,
  failed = false,
  label,
}: {
  readonly children: ReactNode;
  readonly failed?: boolean;
  readonly label: string;
}) {
  return (
    <section className={`thread-tool-section${failed ? ' is-failed' : ''}`}>
      <header><span>{label}</span></header>
      {children}
    </section>
  );
}

/**
 * A tool summary as a flex row: the act ellipsizes, the status tally never
 * does. A trailing "· failed" that could truncate away would leave the row
 * asserting the act succeeded.
 */
function ToolSummaryText({
  className,
  segments,
  title,
  working,
}: {
  readonly className: string;
  readonly segments: readonly ToolActivitySegment[];
  readonly title: string;
  readonly working: boolean;
}) {
  const act = segments.filter((segment) => segment.tone === 'neutral').map((segment) => segment.text).join(' · ');
  const tallies = segments.filter((segment) => segment.tone !== 'neutral');
  return (
    <span className={className} title={title}>
      {working
        ? <WorkingText className="thread-tool-summary-act" text={act} truncate />
        : <span className="thread-tool-summary-act">{act}</span>}
      {tallies.map((segment, index) => (
        <span className={`thread-tool-activity-count-${segment.tone}`} key={`${segment.tone}-${index}`}>
          {` · ${segment.text}`}
        </span>
      ))}
    </span>
  );
}

function DisclosureIndicator({ expanded, status }: { readonly expanded: boolean; readonly status: ReactNode }) {
  // The status layer always keeps the row's semantic tool glyph across its
  // execution lifecycle. Both layers are decorative: the label names status in
  // words and the toggle carries aria-expanded, so announcing either would only
  // duplicate them.
  return (
    <span aria-hidden className={`thread-disclosure-indicator${expanded ? ' is-expanded' : ''}`}>
      <span className="thread-disclosure-status">{status}</span>
      <span className="thread-disclosure-chevron"><ChevronRightIcon size={ICON_SIZE.tiny} /></span>
    </span>
  );
}

export function ThreadMessageCopyButton({
  iconSize = ICON_SIZE.tiny,
  label,
  onCopy,
  text,
}: {
  readonly iconSize?: number;
  readonly label: string;
  readonly onCopy?: () => Promise<void>;
  readonly text: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (onCopy) await onCopy();
    else if (text) await navigator.clipboard.writeText(text);
    else return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };
  return (
    <IconButton
      disabled={!text && !onCopy}
      icon={copied ? CheckIcon : CopyIcon}
      iconSize={iconSize}
      label={label}
      onClick={() => void copy()}
      variant="message"
    />
  );
}

/**
 * The heading of the section that holds what the tool produced, and whether
 * producing it failed. The label names the CONTENT — `Output` for shell
 * streams, `Result` for a returned value, `Error` only where the content
 * genuinely is an error payload — while `failed` carries the status colour. A
 * failed collaboration call therefore reads `Result` in danger red, which is
 * accurate: its content is a state snapshot, not an error, and the colour is
 * what says the call failed. `Error` in neutral ink is the combination that
 * would contradict itself, and no case produces it.
 *
 * A failure is stated exactly once per place it belongs: the folded row says
 * THAT the tool failed, this heading says the produced value is a failure and
 * qualifies it with the shell's exit code, and the section body holds what the
 * tool actually returned. Nothing restates a neighbour.
 */
interface ToolOutcome {
  readonly label: string;
  readonly failed: boolean;
}

interface ToolDetail {
  readonly input: string | null;
  // The input section is headed `Arguments` for every tool, including `bash`.
  // It holds what the model REQUESTED — sourced only from the `modelCall`
  // envelope — and that provenance is the load-bearing fact about it; a heading
  // naming the content instead would read as the host's own record of what ran.
  // Rendering shell text with bash highlighting is the documented exception to
  // JSON arguments, and an exception in rendering is not one in provenance.
  readonly inputLanguage: string;
  readonly output: string | null;
  readonly outputLanguage: string;
  readonly outcome: ToolOutcome;
  readonly body: ReactNode;
}

function toolDetail(
  item: ThreadToolItem,
  t: Messages,
  onOpenThread: (threadId: string) => Promise<void>,
  threadId: string,
  subagents: ReadonlyMap<string, SubagentPresentation> | undefined,
  argumentsValue: JsonValue,
  workingTextEnabled: boolean,
): ToolDetail {
  const empty = {
    input: null,
    inputLanguage: 'text',
    output: null,
    outputLanguage: 'text',
    outcome: { label: t.agent.thread.item.output, failed: false },
    body: null,
  };
  switch (item.type) {
    case 'commandExecution': {
      const command = canonicalCommandArgument(argumentsValue);
      // A non-zero exit code qualifies the output it explains, so it rides that
      // section's heading rather than becoming a sentence of its own. A zero
      // code is what the completed row already reports, and a failure that
      // never produced one — a timeout, a kill — gets no invented number: the
      // row's own failed segment is the statement that it failed.
      const exitCode = item.exitCode !== null && item.exitCode !== 0
        ? t.agent.thread.item.exitCode({ code: item.exitCode })
        : null;
      return {
        ...empty,
        input: command ?? jsonText(argumentsValue),
        inputLanguage: command === null ? 'json' : 'bash',
        output: item.aggregatedOutput,
        outcome: {
          label: exitCode ? `${t.agent.thread.item.output} · ${exitCode}` : t.agent.thread.item.output,
          failed: item.status === 'failed',
        },
      };
    }
    case 'fileChange':
      return {
        ...empty,
        input: argumentsValue === null ? null : jsonText(argumentsValue),
        inputLanguage: 'json',
        body: (
          <ul className="thread-file-changes">
            {item.changes.map((change, index) => (
              <li key={`${change.path}:${index}`}>
                <span>{change.kind}</span>
                <ToolFileResult path={change.path} removable={change.kind !== 'delete'} />
                {change.movedTo ? <code>{change.movedTo}</code> : null}
                {change.diff ? <ReadOnlyCodeBlock code={change.diff} language="diff" /> : null}
              </li>
            ))}
          </ul>
        ),
      };
    case 'mcpToolCall':
      // A failed call's message IS what it produced, so it fills the
      // produced-value section instead of trailing it as a second voice. The
      // executor persists that same text as this Item's output payload, and the
      // payload wins at the render site once it loads — error-first is the only
      // precedence that shows the same thing before and after that read. Turn
      // copy already reads it this way too.
      return {
        ...empty,
        input: jsonText(argumentsValue),
        inputLanguage: 'json',
        output: item.error ?? (item.result === null ? null : jsonText(item.result)),
        outputLanguage: item.error === null ? 'json' : 'text',
        outcome: item.error === null
          ? { label: t.agent.thread.item.result, failed: false }
          : { label: t.agent.thread.item.error, failed: true },
      };
    case 'dynamicToolCall': {
      const textOutput = (item.contentItems ?? []).flatMap((content) => (
        content.type === 'text' ? [content.text] : content.type === 'json' ? [jsonText(content.value)] : []
      )).join('\n');
      const images = (item.contentItems ?? []).filter((content): content is Extract<DynamicToolOutputContent, { type: 'image' }> => (
        content.type === 'image'
      ));
      const failed = item.success === false;
      return {
        ...empty,
        input: jsonText(argumentsValue),
        inputLanguage: 'json',
        output: textOutput || null,
        outputLanguage: isJsonText(textOutput) ? 'json' : 'text',
        // Failure prose is an error, not a "Result".
        outcome: {
          label: failed ? t.agent.thread.item.error : t.agent.thread.item.result,
          failed,
        },
        body: images.length > 0 ? (
          <div className="thread-tool-images">
            {images.map((image) => (
              <ToolOutputImage image={image} key={toolOutputImageKey(image)} threadId={threadId} />
            ))}
          </div>
        ) : null,
      };
    }
    case 'collabAgentToolCall':
      return {
        ...empty,
        input: jsonText(argumentsValue),
        inputLanguage: 'json',
        output: jsonText(collaborationResultSnapshot(item)),
        outputLanguage: 'json',
        outcome: { label: t.agent.thread.item.result, failed: item.status === 'failed' },
        body: item.receiverThreadIds.length > 0 ? (
          <ul className="thread-agent-states">
            {item.receiverThreadIds.map((receiverThreadId) => (
              <SubagentStateItem
                key={receiverThreadId}
                onOpenThread={onOpenThread}
                presentation={collaborationPresentation(item, receiverThreadId, subagents)}
                workingTextEnabled={workingTextEnabled}
              />
            ))}
          </ul>
        ) : null,
      };
    case 'webSearch':
      // Error-first for the same reason as `mcpToolCall`, though not for the
      // same mechanism: `results` is parsed unconditionally here and can in
      // principle survive an error, but the executor still persists the error
      // text as this Item's output payload, and that payload replaces whatever
      // this returns as soon as it loads. Preferring parsed results would show
      // them for one frame and then swap them for the error.
      return {
        ...empty,
        input: jsonText(argumentsValue),
        inputLanguage: 'json',
        output: item.error ?? (item.results.length > 0 ? jsonText(item.results) : null),
        outputLanguage: item.error === null ? 'json' : 'text',
        outcome: item.error === null
          ? { label: t.agent.thread.item.result, failed: false }
          : { label: t.agent.thread.item.error, failed: true },
      };
    default:
      return assertNever(item);
  }
}

function collaborationPresentation(
  item: Extract<ThreadToolItem, { type: 'collabAgentToolCall' }>,
  receiverThreadId: string,
  subagents: ReadonlyMap<string, SubagentPresentation> | undefined,
): SubagentPresentation {
  return subagents?.get(receiverThreadId)
    ?? presentationFromSnapshot(receiverThreadId, item.agentsStates[receiverThreadId]);
}

/**
 * One delegated child, for its whole life: the same row, in the same slot,
 * while it runs and after it settles. It reads name-first with the status as a
 * trailing segment — the shape the tool rows beside it already use — so a
 * delegation is scanned as one more thing the Turn did rather than as an event
 * announced in its own vocabulary.
 *
 * Live it also carries the two affordances only a running child can offer: a
 * working status phrase, and a Stop that reaches this child alone. Interrupting
 * from here leaves the request open (the delegator may legitimately delegate
 * again); the composer's Stop is the one that closes it.
 */
function SubagentActivityItem({
  active,
  expandState,
  getUserView,
  indexStore,
  item,
  onInterruptThread,
  onOpenNodeReference,
  onOpenThread,
  onOpenSubagentTurnDetails,
  onSubagentDrill,
  subagents,
  workingTextEnabled,
}: {
  readonly active: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly getUserView: () => RendererUserViewHints;
  readonly indexStore: DocumentIndexStore;
  readonly item: Extract<ThreadItem, { type: 'subAgentActivity' }>;
  readonly onInterruptThread?: (threadId: string) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly onOpenSubagentTurnDetails?: (threadId: string, turnId: string) => void;
  readonly onSubagentDrill?: (threadId: string) => void;
  readonly subagents?: ReadonlyMap<string, SubagentPresentation>;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const presentation = subagents?.get(item.agentThreadId) ?? presentationFromActivity(item);
  const elapsedMs = useSubagentElapsedMs(presentation);
  const name = presentation.displayName;
  const status = subagentStatusLabel(presentation, elapsedMs, t);
  const error = presentation.status === 'errored' && presentation.error
    ? userFacingAgentError(presentation.error, t.agent.thread.resourceLimitReached)
    : null;
  const openLabel = t.agent.thread.openSubagentThread({ id: name });
  const FormIcon = presentation.form === 'isolatedSkill' ? SkillIcon : AgentIcon;
  // Only where there is a Turn to stop: a child that has not started one yet
  // has nothing `turn/interrupt` can address.
  const running = presentation.status === 'running' && onInterruptThread !== undefined;
  const disclosureId = `subagent:${item.agentThreadId}`;
  // Inside a run detail this row drills that container instead of opening one
  // of its own: one viewport, one scroll region, depth said in the header.
  const drill = onSubagentDrill;
  const expanded = drill === undefined && expandState.isExpanded(disclosureId, false);
  return (
    <div className={`thread-item thread-delegation-row thread-subagent-${presentation.status}`}>
      <div className="thread-delegation-row-line">
      <ButtonControl
        {...(drill ? {} : { 'aria-expanded': expanded })}
        aria-label={`${openLabel}. ${status}${error ? `. ${error}` : ''}`}
        className="thread-delegation-row-open"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => (drill
          ? drill(item.agentThreadId)
          : expandState.toggle(disclosureId, expanded, event.currentTarget))}
        title={error ?? `${name} · ${status}`}
      >
        <ChevronRightIcon
          aria-hidden
          className={`thread-delegation-row-chevron${expanded ? ' is-expanded' : ''}`}
          size={ICON_SIZE.rowGlyph}
        />
        <FormIcon aria-hidden size={ICON_SIZE.rowGlyph} />
        <span className="thread-delegation-row-name">{name}</span>
        {workingTextEnabled && isSubagentWorkingStatus(presentation.status)
          ? <WorkingText className="thread-delegation-row-status" text={status} />
          : <span className="thread-delegation-row-status">{status}</span>}
      </ButtonControl>
        {running ? (
          <IconButton
            icon={StopIcon}
            iconSize={ICON_SIZE.tiny}
            label={t.agent.thread.stopSubagent({ name })}
            onClick={() => void onInterruptThread(presentation.agentThreadId)}
            variant="message"
          />
        ) : null}
      </div>
      {/* Its own line, wrapping in full: a failure the row had to truncate is a
          failure the reader cannot act on. */}
      {error ? <small className="thread-delegation-row-error">{error}</small> : null}
      {expanded ? (
        <SubagentRunDetail
          active={active}
          getUserView={getUserView}
          indexStore={indexStore}
          {...(onInterruptThread ? { onInterruptThread } : {})}
          onOpenNodeReference={onOpenNodeReference}
          onOpenThread={onOpenThread}
          {...(onOpenSubagentTurnDetails ? { onOpenTurnDetails: onOpenSubagentTurnDetails } : {})}
          rootThreadId={item.agentThreadId}
        />
      ) : null}
    </div>
  );
}

function SubagentStateItem({
  onOpenThread,
  presentation,
  workingTextEnabled,
}: {
  readonly onOpenThread: (threadId: string) => Promise<void>;
  readonly presentation: SubagentPresentation;
  readonly workingTextEnabled: boolean;
}) {
  const t = useT();
  const elapsedMs = useSubagentElapsedMs(presentation);
  const status = t.agent.thread.subagentStatuses[presentation.status];
  const statusWithDuration = elapsedMs !== null && elapsedMs >= 1_000
    ? `${status} · ${formatSubagentDuration(elapsedMs)}`
    : status;
  const error = presentation.status === 'errored' && presentation.error
    ? userFacingAgentError(presentation.error, t.agent.thread.resourceLimitReached)
    : null;
  const identity = presentation.taskPath ?? presentation.displayName;
  return (
    <li className={`thread-agent-state thread-subagent-${presentation.status}`}>
      <button
        aria-label={`${t.agent.thread.openSubagentThread({ id: identity })}. ${statusWithDuration}${error ? `. ${error}` : ''}`}
        onClick={() => void onOpenThread(presentation.agentThreadId)}
        title={error ?? identity}
        type="button"
      >
        <AgentIcon size={ICON_SIZE.menu} />
        <code>{identity}</code>
        {workingTextEnabled && isSubagentWorkingStatus(presentation.status)
          ? <WorkingText text={statusWithDuration} />
          : <span>{error ?? statusWithDuration}</span>}
      </button>
    </li>
  );
}

/**
 * Time and status, never a token quantity — the delegation surfaces owe the
 * user no budget judgement (Delegation Contract §3), and that holds for the
 * title and accessible label this feeds as much as for the visible text.
 */
function subagentStatusLabel(
  presentation: SubagentPresentation,
  elapsedMs: number | null,
  t: Messages,
): string {
  const status = t.agent.thread.subagentStatuses[presentation.status];
  // Running children measure from their start; a settled one has no clock left,
  // so its own Turn's recorded span is the only duration there is.
  const durationMs = elapsedMs ?? presentation.durationMs;
  return durationMs !== null && durationMs >= 1_000
    ? `${status} · ${formatSubagentDuration(durationMs)}`
    : status;
}

function isSubagentWorkingStatus(status: SubagentPresentation['status']): boolean {
  return status === 'pendingInit' || status === 'running';
}


/**
 * One shape for every row: **what it did**, then — only when something went
 * wrong — the outcome as an annotation. Six per-kind failure phrasings used to
 * compete here ("Command failed · x", "Failed to change 2 files", "x failed"),
 * which made a scanning user re-learn the pattern per tool.
 */
export function summarizeThreadToolItem(
  item: ThreadToolItem,
  labels: Messages['agent']['thread']['activity'],
  index?: DocumentIndex,
  options: ToolSummaryOptions = {},
): string {
  return joinSegmentText(threadToolItemSegments(item, labels, index, options));
}

/**
 * The act and its outcome are separate segments so the outcome can be rendered
 * unshrinkable: a trailing "· failed" that ellipsizes away would leave the row
 * asserting the act succeeded.
 */
export function threadToolItemSegments(
  item: ThreadToolItem,
  labels: Messages['agent']['thread']['activity'],
  index?: DocumentIndex,
  options: ToolSummaryOptions = {},
): readonly ToolActivitySegment[] {
  const act: ToolActivitySegment = {
    text: toolItemAct(item, labels, index, options.subjectLimit ?? NAMED_SUBJECT_LIMIT),
    tone: 'neutral',
  };
  if (item.status === 'failed') return [act, { text: labels.statusFailed, tone: 'failed' }];
  if (item.status === 'interrupted') return [act, { text: labels.statusInterrupted, tone: 'interrupted' }];
  return [act];
}

function toolItemAct(
  item: ThreadToolItem,
  labels: Messages['agent']['thread']['activity'],
  index: DocumentIndex | undefined,
  limit: number,
): string {
  const running = item.status === 'inProgress';
  switch (item.type) {
    case 'commandExecution': {
      // The caller's own description is the only thing that can tell three
      // `python3 - <<'PY'` heredocs apart; the shell text stays one expand away.
      if (item.description) return item.description;
      const command = quoteSubject(commandDisplayText(item.command, item.cwd));
      return running ? labels.runningCommand({ command }) : labels.ranCommand({ command });
    }
    case 'fileChange': {
      const count = item.changes.length;
      // A change set spans add/update/delete, so the verb stays "changed"; the
      // paths are what the user actually wants to see.
      const names = item.changes.map((change) => basenameForPath(change.path) || change.path);
      if (names.length > 0) {
        const subjects = joinSubjects(names, labels, limit);
        return running ? labels.changingNamed({ subjects }) : labels.changedNamed({ subjects });
      }
      return running ? labels.changingFiles({ count }) : labels.changedFiles({ count });
    }
    case 'mcpToolCall':
      // An MCP tool's own name really is the most informative thing known about
      // it — there is no activity vocabulary to map an arbitrary server tool on.
      return namedToolAct(`${item.server}.${item.tool}`, running, labels);
    case 'dynamicToolCall': {
      // Built-in tools say what they did, in the same words a group of them
      // uses. The identifier survives only for a tool we cannot map, where it
      // genuinely is the best available description.
      const kind = dynamicToolActivityKind(item);
      const name = [item.namespace, item.tool].filter(Boolean).join('.');
      if (kind === 'tool') return namedToolAct(name, running, labels);
      const subjects = dynamicToolSubjects(item, kind, index);
      return toolActivityPhrase(kind, subjects.keys.length, subjects.names, running, labels, limit);
    }
    case 'collabAgentToolCall':
      return collaborationAct(item, running, labels);
    case 'webSearch': {
      // The Item's own fallback for a call the model made without a query is
      // the empty string, and `Searching the web for ""` names nothing. The
      // subject-less copy already exists for exactly this.
      if (!item.query.trim()) return running ? labels.searchingWebActivity : labels.searchedWebActivity;
      const query = quoteSubject(item.query);
      return running ? labels.searchingWeb({ query }) : labels.searchedWeb({ query });
    }
    default:
      return assertNever(item);
  }
}

function namedToolAct(
  name: string,
  running: boolean,
  labels: Messages['agent']['thread']['activity'],
): string {
  return running ? labels.usingTool({ name }) : labels.usedTool({ name });
}

/** The collaboration tools are a closed set, so each one gets real copy rather
 *  than leaking model-facing identifiers into the transcript. */
function collaborationAct(
  item: Extract<ThreadToolItem, { readonly type: 'collabAgentToolCall' }>,
  running: boolean,
  labels: Messages['agent']['thread']['activity'],
): string {
  if (item.tool === 'agent_message' && item.summary) return item.summary;
  switch (item.tool) {
    case 'agent': return running ? labels.startingAgent : labels.startedAgent;
    case 'agent_message': return running ? labels.messagingAgent : labels.messagedAgent;
    case 'task_stop': return running ? labels.stoppingTask : labels.stoppedTask;
    default: return assertNever(item.tool);
  }
}

function toolIcon(item: ThreadToolItem): ReactNode {
  switch (item.type) {
    case 'commandExecution': return <TerminalIcon size={ICON_SIZE.menu} />;
    case 'fileChange': {
      const kinds = new Set(item.changes.map((change) => change.kind));
      if (kinds.size === 1 && kinds.has('add')) return <FileWriteToolIcon size={ICON_SIZE.menu} />;
      if (kinds.size === 1 && kinds.has('delete')) return <FileDeleteToolIcon size={ICON_SIZE.menu} />;
      return <FileEditToolIcon size={ICON_SIZE.menu} />;
    }
    case 'webSearch': return <WebSearchToolIcon size={ICON_SIZE.menu} />;
    case 'collabAgentToolCall': return <AgentIcon size={ICON_SIZE.menu} />;
    case 'mcpToolCall': return <McpToolIcon size={ICON_SIZE.menu} />;
    case 'dynamicToolCall': return dynamicToolIcon(item);
    default: return assertNever(item);
  }
}

function dynamicToolIcon(item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>): ReactNode {
  const identity = normalizedToolIdentity(item.namespace, item.tool);
  const Icon = identity === 'file_write' ? FileWriteToolIcon
    : identity === 'file_edit' ? FileEditToolIcon
      : identity === 'file_delete' ? FileDeleteToolIcon
        : identity === 'file_read' ? FileReadToolIcon
          : identity === 'file_glob' ? FileGlobToolIcon
            : identity === 'file_grep' ? FileGrepToolIcon
              : identity === 'node_create' ? NodeCreateToolIcon
                : identity === 'node_edit' ? NodeEditToolIcon
                  : identity === 'node_delete'
                    ? dynamicToolArgument(item, 'restore') === true ? RestoreIcon : NodeDeleteToolIcon
                    : identity === 'node_read' ? NodeReadToolIcon
                      : identity === 'node_search' ? NodeSearchToolIcon
                        : identity === 'web_search' ? WebSearchToolIcon
                          : identity === 'web_fetch' ? WebFetchToolIcon
                            : identity === 'update_plan' ? PlanToolIcon
                              : identity === 'skill' ? SkillIcon
                                : identity === 'request_user_input' ? QuestionToolIcon
                                  : identity === 'outline_undo_stack' ? OutlineUndoStackToolIcon
                                    : GenericToolIcon;
  return <Icon size={ICON_SIZE.menu} />;
}

/**
 * A group of six file reads showed a generic wrench while every row inside it
 * showed the file-read glyph. When the members agree on one tool, the group
 * wears that tool's icon; the wrench is for genuinely mixed groups.
 */
function groupGlyph(items: readonly ThreadToolItem[]): ReactNode {
  const first = items[0];
  // Same slot, same size: the shared-tool path renders at ICON_SIZE.menu, so
  // the mixed fallback must too or the group glyph visibly changes size.
  if (first === undefined) return <GenericToolIcon size={ICON_SIZE.menu} />;
  const shared = items.every((item) => item.type === first.type
    && (item.type !== 'dynamicToolCall' || dynamicToolActivityKind(item) === dynamicToolActivityKind(
      first as Extract<ThreadToolItem, { type: 'dynamicToolCall' }>,
    )));
  return shared ? toolIcon(first) : <GenericToolIcon size={ICON_SIZE.menu} />;
}

function groupStatus(items: readonly ThreadToolItem[]): ItemExecutionStatus {
  if (items.some((item) => item.status === 'inProgress')) return 'inProgress';
  if (items.some((item) => item.status === 'failed')) return 'failed';
  if (items.some((item) => item.status === 'interrupted')) return 'interrupted';
  return 'completed';
}

type ToolActivityKind =
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
  | 'plan'
  | 'web'
  | 'webFetch'
  | 'collaboration'
  | 'skill'
  | 'question'
  | 'history'
  | 'tool';

const TOOL_ACTIVITY_ORDER: readonly ToolActivityKind[] = [
  'command',
  'fileCreate',
  'fileEdit',
  'fileDelete',
  'fileRead',
  'fileSearch',
  'nodeCreate',
  'nodeEdit',
  'nodeDelete',
  'nodeRestore',
  'nodeRead',
  'nodeSearch',
  'plan',
  'web',
  'webFetch',
  'collaboration',
  'skill',
  'question',
  'history',
  'tool',
];

interface ToolActivityBucket {
  /** Insertion-ordered subject keys. */
  readonly subjects: Set<string>;
  /** Display name per subject key, when the call carried one. */
  readonly names: Map<string, string>;
  readonly runningSubjects: Set<string>;
}

export interface ToolActivitySegment {
  readonly text: string;
  readonly tone: 'neutral' | 'failed' | 'interrupted';
}

export function summarizeThreadToolActivity(
  items: readonly ThreadToolItem[],
  labels: Messages['agent']['thread']['activity'],
  index?: DocumentIndex,
  options: ToolSummaryOptions = {},
): string {
  return joinSegmentText(threadToolActivitySegments(items, labels, index, options));
}

function joinSegmentText(segments: readonly ToolActivitySegment[]): string {
  return segments.map((segment) => segment.text).join(' · ');
}

/**
 * The group summary is split so only the tally of what went wrong carries the
 * status colour. Tinting the whole line red would say "all of this failed" when
 * one call out of six did.
 */
export function threadToolActivitySegments(
  items: readonly ThreadToolItem[],
  labels: Messages['agent']['thread']['activity'],
  index?: DocumentIndex,
  options: ToolSummaryOptions = {},
): readonly ToolActivitySegment[] {
  const limit = options.subjectLimit ?? NAMED_SUBJECT_LIMIT;
  const buckets = new Map<ToolActivityKind, ToolActivityBucket>();
  const add = (kind: ToolActivityKind, subject: string, running: boolean, name?: string) => {
    const bucket = buckets.get(kind)
      ?? { subjects: new Set<string>(), names: new Map<string, string>(), runningSubjects: new Set<string>() };
    if (name !== undefined) bucket.names.set(subject, name);
    bucket.subjects.add(subject);
    if (running) bucket.runningSubjects.add(subject);
    buckets.set(kind, bucket);
  };

  for (const item of items) {
    const running = item.status === 'inProgress';
    switch (item.type) {
      case 'commandExecution':
        add('command', item.id, running);
        break;
      case 'fileChange':
        for (const change of item.changes) {
          const kind = change.kind === 'add'
            ? 'fileCreate'
            : change.kind === 'delete'
              ? 'fileDelete'
              : 'fileEdit';
          add(kind, change.path, running, basenameForPath(change.path) || change.path);
        }
        break;
      case 'webSearch':
        add('web', item.query || item.id, running, item.query ? quoteSubject(item.query) : undefined);
        break;
      case 'collabAgentToolCall':
        for (const threadId of options.collaborationThreadIds ?? item.receiverThreadIds) {
          add('collaboration', threadId, running);
        }
        break;
      case 'mcpToolCall':
        add('tool', item.id, running);
        break;
      case 'dynamicToolCall': {
        const kind = dynamicToolActivityKind(item);
        const subjects = dynamicToolSubjects(item, kind, index);
        subjects.keys.forEach((key, position) => add(kind, key, running, subjects.names[position]));
        break;
      }
      default:
        assertNever(item);
    }
  }

  const segments: ToolActivitySegment[] = TOOL_ACTIVITY_ORDER.flatMap((kind) => {
    const bucket = buckets.get(kind);
    if (!bucket || bucket.subjects.size === 0) return [];
    // Report what finished in the past tense and what is still in flight
    // separately: "Read 5 files · reading 1", never "Reading 6 files".
    const keys = [...bucket.subjects];
    const settledKeys = keys.filter((key) => !bucket.runningSubjects.has(key));
    const runningKeys = keys.filter((key) => bucket.runningSubjects.has(key));
    const namesFor = (subset: readonly string[]): readonly string[] => {
      const named = subset.flatMap((key) => {
        const name = bucket.names.get(key);
        return name === undefined ? [] : [name];
      });
      return named.length === subset.length ? named : [];
    };
    return [settledKeys, runningKeys].flatMap((subset, position) => (
      subset.length === 0 ? [] : [{
        text: toolActivityPhrase(kind, subset.length, namesFor(subset), position === 1, labels, limit),
        tone: 'neutral' as const,
      }]
    ));
  });
  if (segments.length === 0) {
    segments.push({ text: labels.ranTools({ count: items.length }), tone: 'neutral' });
  }
  // What went wrong is stated in words as well as colour — colour alone is not
  // a state (design-system patterns.md).
  const failed = items.filter((item) => item.status === 'failed').length;
  const interrupted = items.filter((item) => item.status === 'interrupted').length;
  if (failed > 0) segments.push({ text: labels.failedCount({ count: failed }), tone: 'failed' });
  if (interrupted > 0) {
    segments.push({ text: labels.interruptedCount({ count: interrupted }), tone: 'interrupted' });
  }
  return segments.map((segment, index) => index === 0
    ? segment
    : { ...segment, text: sentenceFragment(segment.text) });
}

type ActivityLabels = Messages['agent']['thread']['activity'];

/** The activity keys that take a rendered subject list, derived from the message
 *  tree so a mistyped key cannot reach `namedSubjectPhrase`. */
type SubjectPhraseKey = {
  [K in keyof ActivityLabels]: ActivityLabels[K] extends (values: { subjects: string }) => string ? K : never
}[keyof ActivityLabels];

/** Verbs shared by the file and node families: with a subject named, the phrase
 *  does not need to repeat the noun — "Read intro.xhtml" already says it is a
 *  file. Kinds absent here have no subject a person would recognise. One map
 *  holds both tenses so the pair cannot drift apart. */
const SUBJECT_VERBS: Partial<Record<
  ToolActivityKind,
  { readonly past: SubjectPhraseKey; readonly present: SubjectPhraseKey }
>> = {
  fileCreate: { past: 'createdNamed', present: 'creatingNamed' },
  fileEdit: { past: 'editedNamed', present: 'editingNamed' },
  fileDelete: { past: 'deletedNamed', present: 'deletingNamed' },
  fileRead: { past: 'readNamed', present: 'readingNamed' },
  fileSearch: { past: 'searchedNamed', present: 'searchingNamed' },
  nodeCreate: { past: 'createdNamed', present: 'creatingNamed' },
  nodeEdit: { past: 'editedNamed', present: 'editingNamed' },
  nodeDelete: { past: 'deletedNamed', present: 'deletingNamed' },
  nodeRestore: { past: 'restoredNamed', present: 'restoringNamed' },
  nodeRead: { past: 'readNamed', present: 'readingNamed' },
  nodeSearch: { past: 'searchedNamed', present: 'searchingNamed' },
  webFetch: { past: 'fetchedNamed', present: 'fetchingNamed' },
  skill: { past: 'usedSkillNamed', present: 'usingSkillNamed' },
};

/** How many subjects a summary names before eliding (PM-ratified 2026-07-30).
 *  The row's `title` re-derives the same summary with no limit, so the full
 *  list is one hover away. */
const NAMED_SUBJECT_LIMIT = 2;

/** Display uses the elided form; `title` passes Infinity for the full list. */
export interface ToolSummaryOptions {
  readonly subjectLimit?: number;
  readonly collaborationThreadIds?: readonly string[];
}

function toolActivityPhrase(
  kind: ToolActivityKind,
  count: number,
  names: readonly string[],
  running: boolean,
  labels: Messages['agent']['thread']['activity'],
  limit: number = NAMED_SUBJECT_LIMIT,
): string {
  // Only name subjects when every one of them is nameable; a partly-named bucket
  // would silently drop the work it could not name.
  if (names.length === count && names.length > 0) {
    const named = namedSubjectPhrase(kind, names, running, labels, limit);
    if (named !== null) return named;
  }
  switch (kind) {
    case 'command': return running ? labels.runningCommands({ count }) : labels.ranCommands({ count });
    case 'fileCreate': return running ? labels.creatingFiles({ count }) : labels.createdFiles({ count });
    case 'fileEdit': return running ? labels.editingFiles({ count }) : labels.editedFiles({ count });
    case 'fileDelete': return running ? labels.deletingFiles({ count }) : labels.deletedFiles({ count });
    case 'fileRead': return running ? labels.readingFiles({ count }) : labels.readFiles({ count });
    case 'fileSearch': return running ? labels.searchingFiles : labels.searchedFiles;
    case 'nodeCreate': return running ? labels.creatingNodes({ count }) : labels.createdNodes({ count });
    case 'nodeEdit': return running ? labels.editingNodes({ count }) : labels.editedNodes({ count });
    case 'nodeDelete': return running ? labels.deletingNodes({ count }) : labels.deletedNodes({ count });
    case 'nodeRestore': return running ? labels.restoringNodes({ count }) : labels.restoredNodes({ count });
    case 'nodeRead': return running ? labels.readingNodes({ count }) : labels.readNodes({ count });
    case 'nodeSearch': return running ? labels.searchingNodes : labels.searchedNodes;
    case 'plan': return running ? labels.updatingPlan : labels.updatedPlan({ count });
    case 'web': return running ? labels.searchingWebActivity : labels.searchedWebActivity;
    case 'webFetch': return running ? labels.fetchingPages({ count }) : labels.fetchedPages({ count });
    case 'collaboration': return running ? labels.collaborating({ count }) : labels.collaborated({ count });
    case 'skill': return running ? labels.usingSkills({ count }) : labels.usedSkills({ count });
    case 'question': return running ? labels.askingQuestions({ count }) : labels.askedQuestions({ count });
    case 'history': return running ? labels.checkingHistory : labels.checkedHistory;
    case 'tool': return running ? labels.usingTools({ count }) : labels.usedTools({ count });
    default: return assertNever(kind);
  }
}

function namedSubjectPhrase(
  kind: ToolActivityKind,
  names: readonly string[],
  running: boolean,
  labels: Messages['agent']['thread']['activity'],
  limit: number,
): string | null {
  // The web-search family already ships subject-bearing phrasing of its own.
  if (kind === 'web') {
    const query = joinSubjects(names, labels, limit);
    return running ? labels.searchingWeb({ query }) : labels.searchedWeb({ query });
  }
  // "Used the dataviz, run skill" is not a sentence; past one, count instead.
  if (kind === 'skill' && names.length > 1) return null;
  const verbs = SUBJECT_VERBS[kind];
  if (verbs === undefined) return null;
  const key = running ? verbs.present : verbs.past;
  return labels[key]({ subjects: joinSubjects(names, labels, limit) });
}

function joinSubjects(
  names: readonly string[],
  labels: Messages['agent']['thread']['activity'],
  limit: number,
): string {
  const shown = names.slice(0, limit).join(', ');
  const remaining = names.length - limit;
  return remaining > 0 ? labels.subjectsWithMore({ subjects: shown, more: remaining }) : shown;
}

function sentenceFragment(value: string): string {
  if (!value) return value;
  return `${value[0]!.toLowerCase()}${value.slice(1)}`;
}

function dynamicToolActivityKind(item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>): ToolActivityKind {
  const identity = normalizedToolIdentity(item.namespace, item.tool);
  switch (identity) {
    case 'file_write': return 'fileCreate';
    case 'file_edit': return 'fileEdit';
    case 'file_delete': return 'fileDelete';
    case 'file_read': return 'fileRead';
    case 'file_glob':
    case 'file_grep': return 'fileSearch';
    case 'node_create': return 'nodeCreate';
    case 'node_edit': return 'nodeEdit';
    case 'node_delete': return dynamicToolArgument(item, 'restore') === true ? 'nodeRestore' : 'nodeDelete';
    case 'node_read': return 'nodeRead';
    case 'node_search': return 'nodeSearch';
    case 'web_fetch': return 'webFetch';
    case 'web_search': return 'web';
    case 'update_plan': return 'plan';
    case 'skill': return 'skill';
    case 'request_user_input': return 'question';
    case 'outline_undo_stack': return 'history';
    default: return 'tool';
  }
}

/**
 * A tool call's subjects: `keys` dedupe and count the work, `names` are what the
 * user is shown. `names` is empty when the arguments carry nothing a person
 * would recognise, and the caller then falls back to counting — a half-named
 * bucket would read as if the unnamed work did not happen.
 */
interface ToolActivitySubjects {
  readonly keys: readonly string[];
  readonly names: readonly string[];
}

const SUBJECT_ARGUMENT_KEYS: Partial<Record<ToolActivityKind, readonly string[]>> = {
  fileCreate: ['file_path', 'path'],
  fileEdit: ['file_path', 'path'],
  fileDelete: ['file_path', 'path'],
  fileRead: ['file_path', 'path'],
  fileSearch: ['pattern'],
  nodeCreate: ['node_id', 'node_ids'],
  nodeEdit: ['node_id', 'node_ids'],
  nodeDelete: ['node_id', 'node_ids'],
  nodeRestore: ['node_id', 'node_ids'],
  nodeRead: ['node_id', 'node_ids'],
  nodeSearch: ['query'],
  web: ['query'],
  webFetch: ['url'],
  skill: ['skill', 'name'],
};

function dynamicToolSubjects(
  item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>,
  kind: ToolActivityKind,
  index: DocumentIndex | undefined,
): ToolActivitySubjects {
  const keys = dynamicToolSubjectValues(item, kind);
  if (keys.length === 0) return { keys: [item.id], names: [] };
  return { keys, names: keys.map((value) => subjectDisplayName(kind, value, index)) };
}

function dynamicToolSubjectValues(
  item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>,
  kind: ToolActivityKind,
): readonly string[] {
  const values = (SUBJECT_ARGUMENT_KEYS[kind] ?? []).flatMap((key) => {
    const value = dynamicToolArgument(item, key);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
  });
  // `SUBJECT_ARGUMENT_KEYS` reads both singular and plural argument spellings,
  // so the same subject can arrive twice; the grouped path dedupes through its
  // bucket Set and the single-row path has to match it.
  return [...new Set(values)];
}

export function threadToolReferencedNodeIds(item: ThreadToolItem): readonly string[] {
  if (item.type !== 'dynamicToolCall') return [];
  const kind = dynamicToolActivityKind(item);
  if (
    kind !== 'nodeCreate'
    && kind !== 'nodeEdit'
    && kind !== 'nodeDelete'
    && kind !== 'nodeRestore'
    && kind !== 'nodeRead'
  ) return [];
  return dynamicToolSubjectValues(item, kind);
}

function subjectDisplayName(
  kind: ToolActivityKind,
  value: string,
  index: DocumentIndex | undefined,
): string {
  // Search kinds first: `nodeSearch` starts with "node" but its subject is a
  // query string, not an id — resolving it as a Node would rename the query.
  if (kind === 'fileSearch' || kind === 'nodeSearch' || kind === 'web') return quoteSubject(value);
  if (kind === 'webFetch') return quoteSubject(value);
  if (kind.startsWith('node')) {
    // The same title resolution user-message Node references use, so the
    // transcript never shows a raw id where it can show a title.
    return quoteSubject(threadNodeReferenceDisplayLabel('', value, index, value));
  }
  return basenameForPath(value) || value;
}

function normalizedToolIdentity(namespace: string | null, tool: string): string {
  return [namespace, tool]
    .filter((part): part is string => Boolean(part))
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function dynamicToolArgument(
  item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>,
  key: string,
): unknown {
  // Activity subjects are presentation-only. Runtime admission already bounds
  // and redacts this display projection; provider history never reads it.
  if (typeof item.arguments !== 'object' || item.arguments === null || Array.isArray(item.arguments)) return undefined;
  return (item.arguments as { readonly [argument: string]: unknown })[key];
}

function ToolOutputImage({
  image,
  threadId,
}: {
  readonly image: Extract<DynamicToolOutputContent, { type: 'image' }>;
  readonly threadId: string;
}) {
  const label = image.alt || toolOutputImageLabel(image);
  const target = useMemo(() => ({
    kind: 'local-file' as const,
    path: image.artifactRef.id,
    entryKind: 'file' as const,
    label,
    threadId,
    imageArtifactRef: image.artifactRef,
  }), [image.artifactRef, label, threadId]);
  const preview = usePreviewObjectUrl(target, { mimeType: 'image/*' });
  return (
    <button
      aria-label={label}
      className="thread-tool-image"
      onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })}
      type="button"
    >
      {preview.src ? <img alt={image.alt || ''} loading="lazy" src={preview.src} /> : <FileImageIcon size={ICON_SIZE.toolbar} />}
    </button>
  );
}

function toolOutputImageKey(image: Extract<DynamicToolOutputContent, { type: 'image' }>): string {
  return `artifact:${image.artifactRef.id}`;
}

function toolOutputImageLabel(image: Extract<DynamicToolOutputContent, { type: 'image' }>): string {
  return image.artifactRef.observation.fileName;
}

function ImageViewItem({ path }: { readonly path: string }) {
  const t = useT();
  const target = useMemo(() => ({ kind: 'local-file' as const, path, entryKind: 'file' as const }), [path]);
  const preview = usePreviewObjectUrl(target);
  return (
    <button className="thread-item thread-image-view" onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })} type="button">
      {preview.src ? <img alt={path} src={preview.src} /> : <FileImageIcon size={ICON_SIZE.toolbar} />}
      <span>{t.agent.thread.item.image}</span>
      <code>{path}</code>
    </button>
  );
}

function ThreadInlineAttachment({
  content,
  threadId,
}: {
  readonly content: ThreadAttachmentContent;
  readonly threadId: string;
}) {
  const entryKind = content.mimeType === 'inode/directory' ? 'directory' as const : 'file' as const;
  const filePath = content.source.kind === 'localFile' ? content.source.path : content.name;
  return (
    <InlineFileReference
      className="thread-message-file-ref"
      file={{
        entryKind,
        mimeType: content.mimeType,
        name: content.name,
        path: filePath,
        ref: content.name,
        sizeBytes: content.sizeBytes,
        threadId,
        attachmentId: content.id,
      }}
    />
  );
}

const MAX_COLLAPSED_GALLERY_IMAGES = 4;

function useLocalDisclosureAnchor(
  expanded: boolean,
  expandState: ThreadDisclosureState,
) {
  const pendingRestoreRef = useRef(false);
  const captureAnchor = expandState.captureAnchor;
  const restoreAnchor = expandState.restoreAnchor;
  useLayoutEffect(() => {
    if (!pendingRestoreRef.current) return;
    pendingRestoreRef.current = false;
    restoreAnchor();
  }, [expanded, restoreAnchor]);
  return useCallback((anchorElement: HTMLElement | null) => {
    pendingRestoreRef.current = true;
    captureAnchor(anchorElement);
  }, [captureAnchor]);
}

function ThreadImageGallery({
  contents,
  expandState,
  threadId,
}: {
  readonly contents: readonly ThreadAttachmentContent[];
  readonly expandState: ThreadDisclosureState;
  readonly threadId: string;
}) {
  const t = useT();
  const galleryRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const captureDisclosureAnchor = useLocalDisclosureAnchor(expanded, expandState);
  const collapsed = !expanded && contents.length > MAX_COLLAPSED_GALLERY_IMAGES;
  const visible = collapsed ? contents.slice(0, MAX_COLLAPSED_GALLERY_IMAGES) : contents;
  const hiddenCount = contents.length - visible.length;
  const layout = visible.length > MAX_COLLAPSED_GALLERY_IMAGES ? 'many' : String(visible.length);
  return (
    <div
      aria-label={t.agent.message.imageGallery({ count: contents.length })}
      className="thread-image-gallery"
      data-layout-count={layout}
      ref={galleryRef}
      role="group"
    >
      <div className="thread-image-gallery-grid">
        {visible.map((content, index) => {
          const showMore = hiddenCount > 0 && index === visible.length - 1;
          return (
            <div className="thread-image-gallery-tile" key={content.id}>
              <ThreadImageAttachment content={content} threadId={threadId} />
              {showMore ? (
                <ButtonControl
                  aria-expanded="false"
                  aria-label={t.agent.message.showAllImages({ count: contents.length })}
                  className="thread-image-gallery-more"
                  onClick={() => {
                    captureDisclosureAnchor(galleryRef.current);
                    setExpanded(true);
                  }}
                >
                  +{hiddenCount}
                </ButtonControl>
              ) : null}
            </div>
          );
        })}
      </div>
      {expanded && contents.length > MAX_COLLAPSED_GALLERY_IMAGES ? (
        <IconButton
          aria-expanded="true"
          className="thread-image-gallery-collapse"
          icon={ChevronDownIcon}
          iconSize={ICON_SIZE.tiny}
          label={t.agent.message.showFewerImages}
          onClick={() => {
            captureDisclosureAnchor(galleryRef.current);
            setExpanded(false);
          }}
          variant="message"
        />
      ) : null}
    </div>
  );
}

function ThreadImageAttachment({
  content,
  threadId,
}: {
  readonly content: ThreadAttachmentContent;
  readonly threadId: string;
}) {
  const target = useMemo(() => {
    return {
      kind: 'local-file' as const,
      path: content.source.kind === 'localFile' ? content.source.path : content.name,
      entryKind: 'file' as const,
      label: content.name,
      threadId,
      attachmentId: content.id,
    };
  }, [content.id, content.name, content.source, threadId]);
  const preview = usePreviewObjectUrl(target, { mimeType: content.mimeType });
  return (
    <button
      aria-label={content.name}
      className="thread-attachment thread-image-gallery-preview"
      onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })}
      title={content.name}
      type="button"
    >
      {preview.src
        ? <img alt={content.name} loading="lazy" src={preview.src} />
        : <FileImageIcon size={ICON_SIZE.toolbar} />}
    </button>
  );
}

function ToolFileResult({ path, removable }: { readonly path: string; readonly removable: boolean }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'adding' | 'added'>('idle');
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  const add = async () => {
    if (state === 'adding') return;
    setState('adding');
    const added = await requestAddPreviewTargetToOutline({
      target: { kind: 'local-file', path, entryKind: 'file', label: name },
    }).catch(() => false);
    setState(added ? 'added' : 'idle');
  };
  return (
    <span className="thread-tool-file-result">
      <InlineFileReference
        className="thread-tool-file-chip"
        file={{ entryKind: 'file', mimeType: 'application/octet-stream', name, path, ref: name }}
      />
      {removable ? (
        <IconButton
          disabled={state === 'adding'}
          icon={state === 'added' ? CheckIcon : state === 'adding' ? LoaderIcon : AddChildIcon}
          iconSize={ICON_SIZE.tiny}
          label={state === 'added' ? t.agent.filePreview.addedToToday : t.agent.filePreview.addToToday}
          onClick={() => void add()}
          variant="message"
        />
      ) : null}
    </span>
  );
}

function outputLanguage(text: string): string {
  return isJsonText(text) ? 'json' : 'text';
}

function reasoningPresentation(text: string): { readonly summary: string; readonly details: string } {
  try {
    const tokens = Lexer.lex(text);
    const firstIndex = tokens.findIndex(isVisibleMarkdownToken);
    const first = tokens[firstIndex];
    if (!first) return { summary: '', details: '' };
    const paragraph = first.type === 'paragraph' ? first as Tokens.Paragraph : null;
    const plainParagraph = paragraph?.tokens.every(isPlainMarkdownTextToken) ?? false;
    const summary = plainParagraph
      ? compactReasoningText(paragraph?.text ?? first.raw)
      : reasoningTokenSummary(first);
    const firstOffset = tokens
      .slice(0, firstIndex)
      .reduce((length, token) => length + token.raw.length, 0);
    const remainder = text.slice(firstOffset + first.raw.length).trim();
    const details = isSummarizedInFull(first)
      ? hasVisibleMarkdown(remainder) ? remainder : ''
      : text;
    return {
      summary: summary || compactReasoningText(first.raw) || text,
      details,
    };
  } catch {
    return { summary: compactReasoningText(firstLine(text)), details: text };
  }
}

function isVisibleMarkdownToken(token: Token): boolean {
  return token.type !== 'space' && token.type !== 'def';
}

/**
 * Whether the one-line summary carries this leading block whole, so the body
 * can start after it instead of printing the headline a second time.
 *
 * A paragraph or heading survives flattening: emphasis and inline code lose
 * their marks, never their words. A structural block does not — its summary is
 * one line OF it, a fence's first code line or a list's first item — so the
 * body still owes the complete source.
 *
 * Links, images, and Node references are the exception inside a paragraph: what
 * flattening drops there is the TARGET, which a plain summary line can neither
 * show nor open. Those blocks stay in the body, headline duplication and all,
 * because a reachable URL beats a tidy one.
 */
function isSummarizedInFull(token: Token): boolean {
  if (token.type !== 'paragraph' && token.type !== 'heading') return false;
  if (splitReferenceMarkers(token.raw).some((segment) => segment.type !== 'text')) return false;
  return carriesNoTarget(token);
}

function carriesNoTarget(token: Token): boolean {
  if (token.type === 'link' || token.type === 'image' || token.type === 'html') return false;
  if (!('tokens' in token) || !Array.isArray(token.tokens)) return true;
  return token.tokens.every(carriesNoTarget);
}

function hasVisibleMarkdown(text: string): boolean {
  if (!text) return false;
  try {
    return Lexer.lex(text).some(isVisibleMarkdownToken);
  } catch {
    return true;
  }
}

function isPlainMarkdownTextToken(token: Token): boolean {
  return token.type === 'text'
    && (!token.tokens || token.tokens.every(isPlainMarkdownTextToken));
}

function reasoningTokenSummary(token: Token): string {
  if (token.type === 'code') return compactReasoningText(firstLine(token.text));
  if (token.type === 'list') return compactReasoningText(token.items[0]?.text ?? firstLine(token.raw));
  if (token.type === 'table') {
    const table = token as Tokens.Table;
    return compactReasoningText(table.header.map((cell) => markdownTokenText(cell.tokens)).join(' | '));
  }
  if ('tokens' in token && Array.isArray(token.tokens)) {
    const tokenText = compactReasoningText(markdownTokenText(token.tokens));
    if (tokenText) return tokenText;
  }
  if ('text' in token && typeof token.text === 'string') {
    const tokenText = compactReasoningText(firstLine(token.text));
    if (tokenText) return tokenText;
  }
  return compactReasoningText(firstLine(token.raw));
}

function markdownTokenText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (token.type === 'br') return ' ';
    if ('tokens' in token && Array.isArray(token.tokens)) return markdownTokenText(token.tokens);
    if ('text' in token && typeof token.text === 'string') return token.text;
    return token.raw;
  }).join('');
}

function compactReasoningText(text: string): string {
  return splitReferenceMarkers(text)
    .map((segment) => segment.type === 'text' ? segment.text : segment.label)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? text;
}

/**
 * Fallback for a command whose caller gave no description. It does not try to
 * understand the command — it only removes the parts that are provably not the
 * point, so the 72-character budget is spent on the operative text:
 *
 *   `cd /long/path && swift build`     → `swift build`
 *   `python3 - <<'PY' … PY`            → `python3 -`
 *   `<threadCwd>/scripts/build.sh`     → `scripts/build.sh`
 */
function commandDisplayText(command: string, cwd: string): string {
  let text = firstLine(command);
  // Only a real heredoc opener: `<<WORD` / `<<-'WORD'`. Not `<<<` (here-string)
  // and not `1<<20` (bit shift), both of which would truncate mid-command.
  const heredoc = /<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/.exec(text);
  // In `cat <<< hello` the delimiter match starts on the SECOND `<`, so looking
  // forward for `<<<` is not enough — the character before it has to be checked
  // too, or a bare-word here-string truncates to `cat <`.
  const hereString = heredoc !== null
    && (text.startsWith('<<<', heredoc.index) || text[heredoc.index - 1] === '<');
  if (heredoc && heredoc.index > 0 && !hereString) {
    text = text.slice(0, heredoc.index).trim();
  }
  // A leading `cd X &&` is scaffolding for the command that follows it.
  const chained = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/.exec(text);
  if (chained?.[1]) text = chained[1].trim();
  // Shorten paths inside the Thread's own working directory. A root cwd has no
  // prefix worth stripping — doing it anyway would delete every slash.
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return prefix.length > 1 ? text.split(prefix).join('') : text;
}

function quoteSubject(value: string): string {
  const trimmed = value.length > 72 ? `${value.slice(0, 72)}...` : value;
  return trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `"${trimmed}"`;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function canonicalCommandArgument(argumentsValue: JsonValue): string | null {
  if (
    argumentsValue !== null
    && typeof argumentsValue === 'object'
    && !Array.isArray(argumentsValue)
  ) {
    const command = (argumentsValue as Readonly<Record<string, unknown>>).command;
    if (typeof command === 'string') return command;
  }
  return null;
}

function toolArgumentPayloadId(item: ThreadToolItem): string | null {
  if (item.modelCall.disposition === 'evidenceOnly') return null;
  const source = modelCallArgumentSource(item.modelCall);
  return source.storage === 'payload' ? source.ref.id : null;
}

function isJsonText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Thread Item: ${JSON.stringify(value)}`);
}
