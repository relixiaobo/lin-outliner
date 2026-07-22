import { useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  DynamicToolOutputContent,
  ItemExecutionStatus,
  ThreadItem,
  ThreadUserContent,
  UserMessageThreadItem,
} from '../../../../core/agent/protocol';
import { useT } from '../../../i18n/I18nProvider';
import { usePreviewObjectUrl } from '../../../ui/preview/usePreviewObjectUrl';
import { dispatchPreviewTargetOpen } from '../../../ui/preview/previewEvents';
import {
  CheckIcon,
  FileImageIcon,
  GenericToolIcon,
  ICON_SIZE,
  PencilIcon,
  RefreshIcon,
  TerminalIcon,
  UserIcon,
  WarningIcon,
} from '../../../ui/icons';
import { IconButton } from '../../../ui/primitives/IconButton';
import { replaceUserContentText } from '../../threadInput';

interface ThreadItemViewProps {
  readonly item: ThreadItem;
  readonly streaming: boolean;
  readonly onEditUserMessage: (content: readonly ThreadUserContent[]) => Promise<void>;
  readonly onOpenNodeReference: (nodeId: string) => void;
  readonly onRegenerate: () => Promise<void>;
}

export function ThreadItemView(props: ThreadItemViewProps) {
  const t = useT();
  switch (props.item.type) {
    case 'userMessage':
      return <UserMessageItem {...props} item={props.item} />;
    case 'agentMessage':
      return (
        <article className={`thread-item thread-agent-message thread-agent-message-${props.item.phase ?? 'response'}`}>
          <ThreadMarkdown streaming={props.streaming} text={props.item.text} />
          {props.item.memoryCitation ? (
            <div className="thread-memory-citations">
              {props.item.memoryCitation.entries.map((entry) => (
                <button key={entry.nodeId} onClick={() => props.onOpenNodeReference(entry.nodeId)} type="button">
                  {entry.note}
                </button>
              ))}
            </div>
          ) : null}
          {!props.streaming && props.item.phase !== 'commentary' ? (
            <div className="thread-message-actions">
              <IconButton
                icon={RefreshIcon}
                iconSize={ICON_SIZE.tiny}
                label={t.agent.message.regenerateResponse}
                onClick={() => void props.onRegenerate()}
                variant="message"
              />
            </div>
          ) : null}
        </article>
      );
    case 'plan':
      return <TextDisclosure label={t.agent.thread.item.plan} text={props.item.text} />;
    case 'reasoning':
      return (
        <TextDisclosure
          label={t.agent.thread.item.reasoning}
          text={[...props.item.summary, ...props.item.content].join('\n\n')}
        />
      );
    case 'commandExecution':
      return (
        <ToolDisclosure
          icon={<TerminalIcon size={ICON_SIZE.menu} />}
          label={props.item.command || t.agent.thread.item.command}
          status={props.item.status}
        >
          <code className="thread-tool-command">{props.item.command}</code>
          {props.item.aggregatedOutput ? <pre>{props.item.aggregatedOutput}</pre> : null}
          {props.item.exitCode === null ? null : <small>exit {props.item.exitCode}</small>}
        </ToolDisclosure>
      );
    case 'fileChange':
      return (
        <ToolDisclosure
          icon={<GenericToolIcon size={ICON_SIZE.menu} />}
          label={t.agent.thread.item.fileChange}
          status={props.item.status}
        >
          <ul className="thread-file-changes">
            {props.item.changes.map((change, index) => (
              <li key={`${change.path}:${index}`}>
                <span>{change.kind}</span>
                <code>{change.path}</code>
                {change.movedTo ? <code> → {change.movedTo}</code> : null}
                {change.diff ? <pre>{change.diff}</pre> : null}
              </li>
            ))}
          </ul>
        </ToolDisclosure>
      );
    case 'mcpToolCall':
      return (
        <JsonToolDisclosure
          argumentsValue={props.item.arguments}
          error={props.item.error}
          label={`${props.item.server}.${props.item.tool}`}
          result={props.item.result}
          status={props.item.status}
        />
      );
    case 'dynamicToolCall':
      return (
        <ToolDisclosure
          icon={<GenericToolIcon size={ICON_SIZE.menu} />}
          label={[props.item.namespace, props.item.tool].filter(Boolean).join('.')}
          status={props.item.status}
        >
          <JsonBlock label={t.agent.thread.item.arguments} value={props.item.arguments} />
          {props.item.contentItems?.map((content, index) => (
            <DynamicOutput content={content} key={index} />
          ))}
        </ToolDisclosure>
      );
    case 'collabAgentToolCall':
      return (
        <ToolDisclosure
          icon={<GenericToolIcon size={ICON_SIZE.menu} />}
          label={`${t.agent.thread.item.collaboration} · ${props.item.tool}`}
          status={props.item.status}
        >
          {props.item.prompt ? <p>{props.item.prompt}</p> : null}
          <ul className="thread-agent-states">
            {Object.entries(props.item.agentsStates).map(([threadId, status]) => (
              <li key={threadId}><code>{threadId}</code><span>{status}</span></li>
            ))}
          </ul>
        </ToolDisclosure>
      );
    case 'subAgentActivity':
      return (
        <div className="thread-item thread-inline-activity">
          <GenericToolIcon size={ICON_SIZE.menu} />
          <span>{t.agent.thread.item.subagent}</span>
          <code>{props.item.agentPath}</code>
          <small>{props.item.kind}</small>
        </div>
      );
    case 'webSearch':
      return (
        <ToolDisclosure
          icon={<GenericToolIcon size={ICON_SIZE.menu} />}
          label={`${t.agent.thread.item.webSearch} · ${props.item.query}`}
          status={props.item.status}
        >
          {props.item.error ? <p className="thread-inline-error">{props.item.error}</p> : null}
          <ol className="thread-search-results">
            {props.item.results.map((result) => (
              <li key={result.url}>
                <a href={result.url} rel="noreferrer" target="_blank">{result.title}</a>
                {result.snippet ? <p>{result.snippet}</p> : null}
              </li>
            ))}
          </ol>
        </ToolDisclosure>
      );
    case 'imageView':
      return <ImageViewItem path={props.item.path} />;
    case 'contextCompaction':
      return <div className="thread-item thread-compaction"><span>{t.agent.thread.item.compaction}</span></div>;
    default:
      return assertNever(props.item);
  }
}

function UserMessageItem({
  item,
  onEditUserMessage,
  onOpenNodeReference,
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
      <div className="thread-message-role"><UserIcon size={ICON_SIZE.tiny} />{t.agent.message.you}</div>
      {editing ? (
        <div className="thread-message-editor">
          <textarea onChange={(event) => setText(event.target.value)} rows={3} value={text} />
          <div>
            <button className="button button-ghost" onClick={() => setEditing(false)} type="button">{t.agent.message.cancel}</button>
            <button className="button button-primary" disabled={!text.trim() || saving} onClick={() => void save()} type="button">
              {t.agent.message.save}
            </button>
          </div>
        </div>
      ) : (
        <>
          {item.content.map((content, index) => {
            if (content.type === 'text') return <p key={index}>{content.text}</p>;
            if (content.type === 'nodeReference') {
              return (
                <button className="thread-reference" key={index} onClick={() => onOpenNodeReference(content.nodeId)} type="button">
                  {content.note || content.nodeId}
                </button>
              );
            }
            return (
              <div className="thread-attachment" key={content.id}>
                <FileImageIcon size={ICON_SIZE.menu} />
                <span>{content.name}</span>
                <small>{formatBytes(content.sizeBytes)}</small>
              </div>
            );
          })}
          {originalText ? (
            <div className="thread-message-actions">
              <IconButton
                icon={PencilIcon}
                iconSize={ICON_SIZE.tiny}
                label={t.agent.message.editMessage}
                onClick={() => setEditing(true)}
                variant="message"
              />
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function ThreadMarkdown({ text, streaming }: { readonly text: string; readonly streaming: boolean }) {
  const components = useMemo(() => ({
    a({ children, href, ...rest }: ComponentPropsWithoutRef<'a'>) {
      return <a {...rest} href={href} rel="noreferrer" target="_blank">{children}</a>;
    },
  }), []);
  return (
    <div className={`thread-markdown${streaming ? ' is-streaming' : ''}`}>
      <Markdown components={components} remarkPlugins={[remarkGfm]} urlTransform={defaultUrlTransform}>{text}</Markdown>
    </div>
  );
}

function TextDisclosure({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <details className="thread-item thread-text-disclosure">
      <summary>{label}</summary>
      <div className="thread-disclosure-content"><ThreadMarkdown streaming={false} text={text} /></div>
    </details>
  );
}

function ToolDisclosure({
  children,
  icon,
  label,
  status,
}: {
  readonly children: ReactNode;
  readonly icon: ReactNode;
  readonly label: string;
  readonly status: ItemExecutionStatus;
}) {
  const t = useT();
  const StatusIcon = status === 'failed' ? WarningIcon : status === 'completed' ? CheckIcon : GenericToolIcon;
  return (
    <details className={`thread-item thread-tool thread-tool-${status}`} open={status === 'failed'}>
      <summary>
        {icon}
        <span>{label}</span>
        <small><StatusIcon size={ICON_SIZE.tiny} />{t.agent.thread.item.status[status]}</small>
      </summary>
      <div className="thread-tool-body">{children}</div>
    </details>
  );
}

function JsonToolDisclosure({
  argumentsValue,
  error,
  label,
  result,
  status,
}: {
  readonly argumentsValue: unknown;
  readonly error: string | null;
  readonly label: string;
  readonly result: unknown;
  readonly status: ItemExecutionStatus;
}) {
  const t = useT();
  return (
    <ToolDisclosure icon={<GenericToolIcon size={ICON_SIZE.menu} />} label={label} status={status}>
      <JsonBlock label={t.agent.thread.item.arguments} value={argumentsValue} />
      {result === null ? null : <JsonBlock label={t.agent.thread.item.result} value={result} />}
      {error ? <p className="thread-inline-error">{error}</p> : null}
    </ToolDisclosure>
  );
}

function JsonBlock({ label, value }: { readonly label: string; readonly value: unknown }) {
  return (
    <div className="thread-json-block">
      <small>{label}</small>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function DynamicOutput({ content }: { readonly content: DynamicToolOutputContent }) {
  if (content.type === 'text') return <pre>{content.text}</pre>;
  if (content.type === 'json') return <JsonBlock label="JSON" value={content.value} />;
  return <div className="thread-attachment"><FileImageIcon size={ICON_SIZE.menu} /><span>{content.alt || content.imageRef}</span></div>;
}

function ImageViewItem({ path }: { readonly path: string }) {
  const t = useT();
  const target = useMemo(() => ({ kind: 'local-file' as const, path, entryKind: 'file' as const }), [path]);
  const preview = usePreviewObjectUrl(target);
  return (
    <button
      className="thread-item thread-image-view"
      onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })}
      type="button"
    >
      {preview.src ? <img alt={path} src={preview.src} /> : <FileImageIcon size={ICON_SIZE.toolbar} />}
      <span>{t.agent.thread.item.image}</span>
      <code>{path}</code>
    </button>
  );
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ThreadItem: ${JSON.stringify(value)}`);
}
