import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  DynamicToolOutputContent,
  ItemExecutionStatus,
  ThreadAttachmentContent,
  ThreadItem,
  ThreadUserContent,
  UserMessageThreadItem,
} from '../../../../core/agent/protocol';
import type { Messages } from '../../../../core/i18n';
import { useT } from '../../../i18n/I18nProvider';
import type { DocumentIndex } from '../../../state/document';
import { usePreviewObjectUrl } from '../../../ui/preview/usePreviewObjectUrl';
import { dispatchPreviewTargetOpen } from '../../../ui/preview/previewEvents';
import { openUrlPreviewFromClick } from '../../../ui/preview/urlPreviewRouting';
import {
  AgentIcon,
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
  FileTextIcon,
  FileWriteToolIcon,
  FolderIcon,
  GenericToolIcon,
  ICON_SIZE,
  LoaderIcon,
  NodeCreateToolIcon,
  NodeDeleteToolIcon,
  NodeEditToolIcon,
  NodeReadToolIcon,
  NodeSearchToolIcon,
  OutlineUndoStackToolIcon,
  PencilIcon,
  QuestionToolIcon,
  RestoreIcon,
  SkillIcon,
  StopIcon,
  TerminalIcon,
  ToolErrorIcon,
  WebFetchToolIcon,
  WebSearchToolIcon,
} from '../../../ui/icons';
import { ReadOnlyCodeBlock, useCodeBlockCopy } from '../../../ui/editor/CodeBlockSurface';
import { IconButton } from '../../../ui/primitives/IconButton';
import { ButtonControl } from '../../../ui/primitives/ButtonControl';
import { replaceUserContentText } from '../../threadInput';
import {
  threadNodeReferenceDisplayLabel,
  threadNodeReferenceHref,
  threadNodeReferenceOpenOptionsFromClick,
  threadNodeReferenceStyle,
  type ThreadNodeReferenceOpenHandler,
} from '../../threadReferences';
import { ThreadMarkdown } from '../ThreadMarkdown';

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
  readonly agentResponseTail: ReactNode;
  readonly defaultReasoningExpanded: boolean;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly item: ThreadItem;
  readonly showMessageActions: boolean;
  readonly streaming: boolean;
  readonly onDisclosureToggle: () => void;
  readonly onEditUserMessage: (content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly onOpenThread: (threadId: string) => Promise<void>;
}

export interface ThreadDisclosureState {
  readonly isExpanded: (id: string, defaultExpanded?: boolean) => boolean;
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

export function isCompactLoadedSkillItem(item: ThreadToolItem): boolean {
  return loadedSkillDetails(item) !== null;
}

export function ThreadItemView(props: ThreadItemViewProps) {
  const t = useT();
  switch (props.item.type) {
    case 'userMessage':
      return <UserMessageItem {...props} item={props.item} />;
    case 'agentMessage':
      return (
        <article className={`thread-item thread-agent-message thread-agent-message-${props.item.phase ?? 'response'}`}>
          <div className="thread-agent-message-body">
            <ThreadMarkdown
              index={props.index}
              onNodeReferenceOpen={props.onOpenNodeReference}
              streaming={props.streaming}
              text={props.item.text}
            />
            {props.item.memoryCitation ? (
              <div className="thread-memory-citations">
                {props.item.memoryCitation.entries.map((entry) => (
                  <a
                    href={threadNodeReferenceHref(entry.nodeId)}
                    key={entry.nodeId}
                    onClick={(event) => {
                      event.preventDefault();
                      props.onOpenNodeReference(entry.nodeId, threadNodeReferenceOpenOptionsFromClick(event));
                    }}
                    style={threadNodeReferenceStyle(entry.nodeId, props.index)}
                  >
                    {entry.note}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
          {props.item.phase !== 'commentary' ? props.agentResponseTail : null}
        </article>
      );
    case 'plan':
      return (
        <TextDisclosure
          disclosureId={`plan:${props.item.id}`}
          expandState={props.expandState}
          index={props.index}
          label={t.agent.thread.item.plan}
          onOpenNodeReference={props.onOpenNodeReference}
          text={props.item.text}
        />
      );
    case 'reasoning':
      return (
        <ReasoningDisclosure
          defaultExpanded={props.defaultReasoningExpanded}
          disclosureId={`reasoning:${props.item.id}`}
          expandState={props.expandState}
          index={props.index}
          onOpenNodeReference={props.onOpenNodeReference}
          streaming={props.streaming}
          text={[...props.item.summary, ...props.item.content].join('\n\n')}
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
          item={props.item}
          onOpenThread={props.onOpenThread}
        />
      );
    case 'subAgentActivity': {
      const item = props.item;
      return (
        <button
          aria-label={t.agent.thread.openSubagentThread({ id: item.agentPath })}
          className="thread-item thread-inline-activity"
          onClick={() => void props.onOpenThread(item.agentThreadId)}
          type="button"
        >
          <AgentIcon size={ICON_SIZE.menu} />
          <span>{t.agent.thread.item.subagent}</span>
          <code>{item.agentPath}</code>
          <small>{t.agent.thread.subagentStatuses[subagentActivityStatus(item.kind)]}</small>
        </button>
      );
    }
    case 'imageView':
      return <ImageViewItem path={props.item.path} />;
    case 'contextCompaction':
      return <div className="thread-item thread-compaction"><span>{t.agent.thread.item.compaction}</span></div>;
    default:
      return assertNever(props.item);
  }
}

export function ThreadToolActivityGroup({
  expandState,
  items,
  onOpenThread,
}: {
  readonly expandState: ThreadDisclosureState;
  readonly items: readonly ThreadToolItem[];
  readonly onOpenThread: (threadId: string) => Promise<void>;
}) {
  const t = useT();
  const disclosureId = `tools:${items[0]?.id ?? 'empty'}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const status = groupStatus(items);
  const StatusIcon = executionStatusIcon(status);
  const label = summarizeThreadToolActivity(items, t.agent.thread.activity);
  return (
    <div className={`thread-item thread-tool-activity-group thread-tool-${status}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="thread-tool-activity-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <DisclosureIndicator expanded={expanded} status={<StatusIcon size={ICON_SIZE.tiny} />} />
        <span className="thread-tool-activity-summary">{label}</span>
      </ButtonControl>
      {expanded ? (
        <div className="thread-tool-activity-members">
          {items.map((item) => (
            <ToolItemDisclosure
              expandState={expandState}
              item={item}
              key={item.id}
              onOpenThread={onOpenThread}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UserMessageItem({
  index,
  item,
  onDisclosureToggle,
  onEditUserMessage,
  onOpenNodeReference,
  showMessageActions,
}: Omit<ThreadItemViewProps, 'item'> & { readonly item: UserMessageThreadItem }) {
  const t = useT();
  const originalText = item.content.flatMap((content) => content.type === 'text' ? [content.text] : []).join('\n');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(originalText);
  const [saving, setSaving] = useState(false);

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
    <article className="thread-item thread-user-message">
      {editing ? (
        <div className="thread-message-editor">
          <textarea
            aria-label={t.agent.message.editMessage}
            onChange={(event) => setText(event.target.value)}
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
          <UserMessageCollapsibleContent
            measureKey={item.id}
            onDisclosureToggle={onDisclosureToggle}
          >
            {renderUserContent(item.content, index, onOpenNodeReference)}
          </UserMessageCollapsibleContent>
          {showMessageActions ? (
            <div className="thread-message-actions">
              {originalText ? (
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
                text={originalText}
              />
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function renderUserContent(
  content: readonly ThreadUserContent[],
  index: DocumentIndex,
  onOpenNodeReference: ThreadNodeReferenceOpenHandler,
): ReactNode[] {
  const rendered: ReactNode[] = [];
  let inline: ReactNode[] = [];
  let groupIndex = 0;
  const flushInline = () => {
    if (inline.length === 0) return;
    rendered.push(<div className="thread-user-inline-content" key={`inline-${groupIndex}`}>{inline}</div>);
    inline = [];
    groupIndex += 1;
  };
  content.forEach((part, contentIndex) => {
    if (part.type === 'text') {
      inline.push(<span key={`text-${contentIndex}`}>{part.text}</span>);
      return;
    }
    if (part.type === 'nodeReference') {
      inline.push(
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
    flushInline();
    rendered.push(<ThreadAttachment content={part} key={part.id} />);
  });
  flushInline();
  return rendered;
}

const USER_MESSAGE_COLLAPSED_LINES = 5;
const USER_MESSAGE_COLLAPSED_EXTRA_PX = 16;

function UserMessageCollapsibleContent({
  children,
  measureKey,
  onDisclosureToggle,
}: {
  readonly children: ReactNode;
  readonly measureKey: string;
  readonly onDisclosureToggle: () => void;
}) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

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
          onClick={() => {
            onDisclosureToggle();
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
  streaming,
  text,
}: {
  readonly defaultExpanded: boolean;
  readonly disclosureId: string;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly streaming: boolean;
  readonly text: string;
}) {
  const t = useT();
  const trimmed = text.trim();
  if (!trimmed) return streaming ? <div className="thread-reasoning is-thinking">{t.agent.thinking.thinking}</div> : null;
  const expanded = expandState.isExpanded(disclosureId, defaultExpanded || streaming);
  const gist = expanded ? '' : reasoningGist(trimmed);
  return (
    <div className="thread-item thread-reasoning">
      <ButtonControl
        aria-expanded={expanded}
        className="thread-reasoning-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <span className="thread-reasoning-headline">
          {streaming ? t.agent.thinking.thinking : t.agent.thinking.thought}
        </span>
        {gist ? <span className="thread-reasoning-gist" title={gist}>· {gist}</span> : null}
        <ChevronRightIcon
          className={`thread-reasoning-chevron${expanded ? ' is-expanded' : ''}`}
          size={ICON_SIZE.menu}
        />
      </ButtonControl>
      {expanded ? (
        <div className="thread-reasoning-body">
          <ThreadMarkdown
            index={index}
            onNodeReferenceOpen={onOpenNodeReference}
            streaming={streaming}
            text={trimmed}
          />
        </div>
      ) : null}
    </div>
  );
}

function TextDisclosure({
  disclosureId,
  expandState,
  index,
  label,
  onOpenNodeReference,
  text,
}: {
  readonly disclosureId: string;
  readonly expandState: ThreadDisclosureState;
  readonly index: DocumentIndex;
  readonly label: string;
  readonly onOpenNodeReference: ThreadNodeReferenceOpenHandler;
  readonly text: string;
}) {
  const expanded = expandState.isExpanded(disclosureId, false);
  return (
    <div className="thread-item thread-text-disclosure">
      <ButtonControl
        aria-expanded={expanded}
        className="thread-text-disclosure-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <DisclosureIndicator expanded={expanded} status={<GenericToolIcon size={ICON_SIZE.tiny} />} />
        <span>{label}</span>
      </ButtonControl>
      {expanded ? (
        <div className="thread-disclosure-content">
          <ThreadMarkdown index={index} onNodeReferenceOpen={onOpenNodeReference} text={text} />
        </div>
      ) : null}
    </div>
  );
}

function ToolItemDisclosure({
  expandState,
  item,
  onOpenThread,
}: {
  readonly expandState: ThreadDisclosureState;
  readonly item: ThreadToolItem;
  readonly onOpenThread: (threadId: string) => Promise<void>;
}) {
  const t = useT();
  const loadedSkill = loadedSkillDetails(item);
  if (loadedSkill) return <LoadedSkillAffordance details={loadedSkill} />;
  const disclosureId = `tool:${item.id}`;
  const expanded = expandState.isExpanded(disclosureId, false);
  const StatusIcon = executionStatusIcon(item.status);
  const detail = toolDetail(item, t, onOpenThread);
  return (
    <div className={`thread-item thread-tool thread-tool-${item.status}`}>
      <ButtonControl
        aria-expanded={expanded}
        className="thread-tool-toggle"
        data-thread-disclosure-id={disclosureId}
        onClick={(event) => expandState.toggle(disclosureId, expanded, event.currentTarget)}
      >
        <DisclosureIndicator expanded={expanded} status={<StatusIcon size={ICON_SIZE.tiny} />} />
        <span className="thread-tool-icon">{toolIcon(item)}</span>
        <span className="thread-tool-label">{summarizeThreadToolItem(item, t.agent.thread.activity)}</span>
      </ButtonControl>
      {expanded ? (
        <div className="thread-tool-body">
          {detail.input ? (
            <ToolDetailSection copyLabel={t.agent.thread.item.copyArguments} label={t.agent.thread.item.arguments} text={detail.input}>
              <ReadOnlyCodeBlock code={detail.input} language={detail.inputLanguage} />
            </ToolDetailSection>
          ) : null}
          {detail.body}
          {detail.output ? (
            <ToolDetailSection copyLabel={t.agent.thread.item.copyOutput} label={t.agent.thread.item.output} text={detail.output}>
              <ReadOnlyCodeBlock code={detail.output} language={detail.outputLanguage} />
            </ToolDetailSection>
          ) : null}
          {detail.error ? <p className="thread-inline-error">{detail.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

interface LoadedSkillDetails {
  readonly args: string | null;
  readonly skill: string;
}

function loadedSkillDetails(item: ThreadToolItem): LoadedSkillDetails | null {
  if (item.type !== 'dynamicToolCall'
    || normalizedToolIdentity(item.namespace, item.tool) !== 'skill'
    || item.status !== 'completed'
    || item.success !== true) return null;
  const text = (item.contentItems ?? [])
    .flatMap((content) => content.type === 'text' ? [content.text] : [])
    .join('\n');
  const launched = /^Launching skill:\s*(.+)$/im.exec(text);
  if (!launched) return null;
  const argumentSkill = dynamicToolArgument(item, 'skill');
  const skill = (launched[1] ?? '').trim()
    || (typeof argumentSkill === 'string' ? argumentSkill.trim() : '');
  if (!skill) return null;
  const argumentArgs = dynamicToolArgument(item, 'args');
  return {
    args: typeof argumentArgs === 'string' && argumentArgs.trim() ? argumentArgs.trim() : null,
    skill,
  };
}

function LoadedSkillAffordance({ details }: { readonly details: LoadedSkillDetails }) {
  return (
    <div className="thread-item thread-loaded-skill">
      <SkillIcon aria-hidden="true" className="thread-loaded-skill-icon" size={ICON_SIZE.menu} />
      <span className="thread-loaded-skill-name" title={`/${details.skill}`}>/{details.skill}</span>
      {details.args ? (
        <span className="thread-loaded-skill-args" title={details.args}>{details.args}</span>
      ) : null}
    </div>
  );
}

function ToolDetailSection({
  children,
  copyLabel,
  label,
  text,
}: {
  readonly children: ReactNode;
  readonly copyLabel: string;
  readonly label: string;
  readonly text: string;
}) {
  return (
    <section className="thread-tool-section">
      <header><span>{label}</span><ThreadMessageCopyButton label={copyLabel} text={text} /></header>
      {children}
    </section>
  );
}

function DisclosureIndicator({ expanded, status }: { readonly expanded: boolean; readonly status: ReactNode }) {
  return (
    <span className={`thread-disclosure-indicator${expanded ? ' is-expanded' : ''}`}>
      <span className="thread-disclosure-status">{status}</span>
      <span className="thread-disclosure-chevron"><ChevronRightIcon size={ICON_SIZE.tiny} /></span>
    </span>
  );
}

export function ThreadMessageCopyButton({
  iconSize = ICON_SIZE.tiny,
  label,
  text,
}: {
  readonly iconSize?: number;
  readonly label: string;
  readonly text: string;
}) {
  const { copied, copyCode } = useCodeBlockCopy(text);
  return (
    <IconButton
      disabled={!text}
      icon={copied ? CheckIcon : CopyIcon}
      iconSize={iconSize}
      label={label}
      onClick={copyCode}
      variant="message"
    />
  );
}

interface ToolDetail {
  readonly input: string | null;
  readonly inputLanguage: string;
  readonly output: string | null;
  readonly outputLanguage: string;
  readonly error: string | null;
  readonly body: ReactNode;
}

function toolDetail(
  item: ThreadToolItem,
  t: Messages,
  onOpenThread: (threadId: string) => Promise<void>,
): ToolDetail {
  const empty = { input: null, inputLanguage: 'text', output: null, outputLanguage: 'text', error: null, body: null };
  switch (item.type) {
    case 'commandExecution':
      return {
        ...empty,
        input: item.command,
        inputLanguage: 'bash',
        output: item.aggregatedOutput,
        body: item.exitCode === null ? null : <small className="thread-tool-exit">exit {item.exitCode}</small>,
      };
    case 'fileChange':
      return {
        ...empty,
        body: (
          <ul className="thread-file-changes">
            {item.changes.map((change, index) => (
              <li key={`${change.path}:${index}`}>
                <span>{change.kind}</span>
                <code>{change.path}</code>
                {change.movedTo ? <code>{change.movedTo}</code> : null}
                {change.diff ? <ReadOnlyCodeBlock code={change.diff} language="diff" /> : null}
              </li>
            ))}
          </ul>
        ),
      };
    case 'mcpToolCall':
      return {
        ...empty,
        input: jsonText(item.arguments),
        inputLanguage: 'json',
        output: item.result === null ? null : jsonText(item.result),
        outputLanguage: 'json',
        error: item.error,
      };
    case 'dynamicToolCall': {
      const textOutput = (item.contentItems ?? []).flatMap((content) => (
        content.type === 'text' ? [content.text] : content.type === 'json' ? [jsonText(content.value)] : []
      )).join('\n');
      const images = (item.contentItems ?? []).filter((content): content is Extract<DynamicToolOutputContent, { type: 'image' }> => (
        content.type === 'image'
      ));
      return {
        ...empty,
        input: jsonText(item.arguments),
        inputLanguage: 'json',
        output: textOutput || null,
        outputLanguage: isJsonText(textOutput) ? 'json' : 'text',
        error: item.success === false && !textOutput ? t.agent.thread.item.status.failed : null,
        body: images.length > 0 ? (
          <div className="thread-tool-images">
            {images.map((image) => <ToolOutputImage image={image} key={image.imageRef} />)}
          </div>
        ) : null,
      };
    }
    case 'collabAgentToolCall':
      return {
        ...empty,
        input: jsonText({
          tool: item.tool,
          receiverThreadIds: item.receiverThreadIds,
          prompt: item.prompt,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
        }),
        inputLanguage: 'json',
        body: item.receiverThreadIds.length > 0 ? (
          <ul className="thread-agent-states">
            {item.receiverThreadIds.map((threadId) => {
              const shortId = shortThreadId(threadId);
              const status = item.agentsStates[threadId] ?? 'notFound';
              return (
                <li key={threadId}>
                  <button
                    aria-label={t.agent.thread.openSubagentThread({ id: shortId })}
                    onClick={() => void onOpenThread(threadId)}
                    title={threadId}
                    type="button"
                  >
                    <AgentIcon size={ICON_SIZE.menu} />
                    <code>{shortId}</code>
                    <span>{t.agent.thread.subagentStatuses[status]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null,
      };
    case 'webSearch':
      return {
        ...empty,
        input: item.query,
        error: item.error,
        body: item.results.length > 0 ? (
          <ol className="thread-search-results">
            {item.results.map((result) => (
              <li key={result.url}>
                <a
                  href={result.url}
                  onClick={(event) => {
                    if (!openUrlPreviewFromClick(event.nativeEvent, result.url, result.title)) return;
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  rel="noreferrer"
                  target="_blank"
                >
                  {result.title}
                </a>
                {result.snippet ? <p>{result.snippet}</p> : null}
              </li>
            ))}
          </ol>
        ) : null,
      };
    default:
      return assertNever(item);
  }
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `${threadId.slice(0, 8)}...${threadId.slice(-4)}` : threadId;
}

function subagentActivityStatus(
  kind: Extract<ThreadItem, { type: 'subAgentActivity' }>['kind'],
): keyof Messages['agent']['thread']['subagentStatuses'] {
  if (kind === 'started') return 'running';
  return kind === 'errored' ? 'errored' : kind;
}

export function summarizeThreadToolItem(
  item: ThreadToolItem,
  labels: Messages['agent']['thread']['activity'],
): string {
  switch (item.type) {
    case 'commandExecution': {
      const command = quoteSubject(firstLine(item.command));
      if (item.status === 'inProgress') return labels.runningCommand({ command });
      if (item.status === 'failed') return labels.commandFailed({ command });
      return labels.ranCommand({ command });
    }
    case 'fileChange':
      if (item.status === 'inProgress') return labels.changingFiles({ count: item.changes.length });
      if (item.status === 'failed') return labels.fileChangeFailed({ count: item.changes.length });
      return labels.changedFiles({ count: item.changes.length });
    case 'mcpToolCall':
      return namedToolSummary(`${item.server}.${item.tool}`, item.status, labels);
    case 'dynamicToolCall':
      return namedToolSummary([item.namespace, item.tool].filter(Boolean).join('.'), item.status, labels);
    case 'collabAgentToolCall':
      return namedToolSummary(item.tool, item.status, labels);
    case 'webSearch': {
      const query = quoteSubject(item.query);
      if (item.status === 'inProgress') return labels.searchingWeb({ query });
      if (item.status === 'failed') return labels.searchFailed({ query });
      return labels.searchedWeb({ query });
    }
    default:
      return assertNever(item);
  }
}

function namedToolSummary(
  name: string,
  status: ItemExecutionStatus,
  labels: Messages['agent']['thread']['activity'],
): string {
  if (status === 'inProgress') return labels.usingTool({ name });
  if (status === 'failed') return labels.toolFailed({ name });
  return labels.usedTool({ name });
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
    case 'mcpToolCall': return <GenericToolIcon size={ICON_SIZE.menu} />;
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
                            : identity === 'skill' ? SkillIcon
                              : identity === 'request_user_input' ? QuestionToolIcon
                                : identity === 'outline_undo_stack' ? OutlineUndoStackToolIcon
                                  : GenericToolIcon;
  return <Icon size={ICON_SIZE.menu} />;
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
  | 'web'
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
  'web',
  'collaboration',
  'skill',
  'question',
  'history',
  'tool',
];

interface ToolActivityBucket {
  readonly subjects: Set<string>;
  running: boolean;
}

export function summarizeThreadToolActivity(
  items: readonly ThreadToolItem[],
  labels: Messages['agent']['thread']['activity'],
): string {
  const buckets = new Map<ToolActivityKind, ToolActivityBucket>();
  const add = (kind: ToolActivityKind, subject: string, running: boolean) => {
    const bucket = buckets.get(kind) ?? { subjects: new Set<string>(), running: false };
    bucket.subjects.add(subject);
    bucket.running ||= running;
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
          add(kind, change.path, running);
        }
        break;
      case 'webSearch':
        add('web', item.query || item.id, running);
        break;
      case 'collabAgentToolCall':
        for (const threadId of item.receiverThreadIds.length > 0 ? item.receiverThreadIds : [item.id]) {
          add('collaboration', threadId, running);
        }
        break;
      case 'mcpToolCall':
        add('tool', item.id, running);
        break;
      case 'dynamicToolCall': {
        const kind = dynamicToolActivityKind(item);
        for (const subject of dynamicToolSubjects(item, kind)) add(kind, subject, running);
        break;
      }
      default:
        assertNever(item);
    }
  }

  const fragments = TOOL_ACTIVITY_ORDER.flatMap((kind) => {
    const bucket = buckets.get(kind);
    if (!bucket || bucket.subjects.size === 0) return [];
    return [toolActivityPhrase(kind, bucket.subjects.size, bucket.running, labels)];
  });
  if (fragments.length === 0) return labels.ranTools({ count: items.length });
  return fragments.map((fragment, index) => index === 0 ? fragment : sentenceFragment(fragment)).join(' · ');
}

function toolActivityPhrase(
  kind: ToolActivityKind,
  count: number,
  running: boolean,
  labels: Messages['agent']['thread']['activity'],
): string {
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
    case 'web': return running ? labels.searchingWebActivity : labels.searchedWebActivity;
    case 'collaboration': return running ? labels.collaborating({ count }) : labels.collaborated({ count });
    case 'skill': return running ? labels.usingSkills({ count }) : labels.usedSkills({ count });
    case 'question': return running ? labels.askingQuestions({ count }) : labels.askedQuestions({ count });
    case 'history': return running ? labels.checkingHistory : labels.checkedHistory;
    case 'tool': return running ? labels.usingTools({ count }) : labels.usedTools({ count });
    default: return assertNever(kind);
  }
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
    case 'web_fetch':
    case 'web_search': return 'web';
    case 'skill': return 'skill';
    case 'request_user_input': return 'question';
    case 'outline_undo_stack': return 'history';
    default: return 'tool';
  }
}

function dynamicToolSubjects(
  item: Extract<ThreadToolItem, { type: 'dynamicToolCall' }>,
  kind: ToolActivityKind,
): string[] {
  const keys = kind === 'fileRead' || kind === 'fileEdit' || kind === 'fileDelete'
    ? ['file_path', 'path']
    : kind === 'nodeRead' || kind === 'nodeEdit' || kind === 'nodeDelete' || kind === 'nodeRestore'
      ? ['node_id', 'node_ids']
      : [];
  const subjects = keys.flatMap((key) => {
    const value = dynamicToolArgument(item, key);
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()));
  });
  return subjects.length > 0 ? subjects : [item.id];
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
  if (typeof item.arguments !== 'object' || item.arguments === null || Array.isArray(item.arguments)) return undefined;
  return (item.arguments as { readonly [argument: string]: unknown })[key];
}

function executionStatusIcon(status: ItemExecutionStatus) {
  if (status === 'inProgress') return LoaderIcon;
  if (status === 'failed') return ToolErrorIcon;
  if (status === 'interrupted') return StopIcon;
  return CheckIcon;
}

function ToolOutputImage({ image }: { readonly image: Extract<DynamicToolOutputContent, { type: 'image' }> }) {
  const target = useMemo(() => ({
    kind: 'local-file' as const,
    path: image.imageRef,
    entryKind: 'file' as const,
    label: image.alt || image.imageRef,
  }), [image.alt, image.imageRef]);
  const preview = usePreviewObjectUrl(target, { mimeType: 'image/*' });
  return (
    <button
      aria-label={image.alt || image.imageRef}
      className="thread-tool-image"
      onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })}
      type="button"
    >
      {preview.src ? <img alt={image.alt || ''} loading="lazy" src={preview.src} /> : <FileImageIcon size={ICON_SIZE.toolbar} />}
    </button>
  );
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

function ThreadAttachment({ content }: { readonly content: ThreadAttachmentContent }) {
  const target = useMemo(() => {
    if (content.source.kind === 'localFile') {
      return {
        kind: 'local-file' as const,
        path: content.source.path,
        entryKind: content.mimeType === 'inode/directory' ? 'directory' as const : 'file' as const,
      };
    }
    if (content.source.kind === 'asset') return { kind: 'asset' as const, assetId: content.source.assetId };
    return null;
  }, [content.source]);
  const preview = usePreviewObjectUrl(content.mimeType.startsWith('image/') ? target : null, { mimeType: content.mimeType });
  const imageSource = content.mimeType.startsWith('image/')
    ? content.source.kind === 'inline'
      ? `data:${content.mimeType};base64,${content.source.dataBase64}`
      : preview.src
    : null;
  const body = imageSource ? (
    <img alt={content.name} loading="lazy" src={imageSource} />
  ) : (
    <span className="thread-attachment-chip">
      {content.mimeType === 'inode/directory'
        ? <FolderIcon size={ICON_SIZE.menu} />
        : <FileTextIcon size={ICON_SIZE.menu} />}
      <span>{content.name}</span>
      <small>{formatBytes(content.sizeBytes)}</small>
    </span>
  );
  if (!target) return <div className="thread-attachment">{body}</div>;
  return <button className="thread-attachment" onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })} type="button">{body}</button>;
}

function reasoningGist(text: string): string {
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.replace(/^#+\s*/, '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? text;
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
