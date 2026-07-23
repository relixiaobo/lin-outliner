import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Lexer } from 'marked';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remend from 'remend';
import remarkGfm from 'remark-gfm';
import { basenameForPath, splitReferenceMarkers } from '../../../core/referenceMarkup';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import { InlineFileReference } from '../../ui/editor/InlineFileReference';
import {
  localFileReferenceFromHref,
  localFileReferenceHref,
} from '../../ui/editor/inlineFilePreviewData';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import { openUrlPreviewFromClick } from '../../ui/preview/urlPreviewRouting';
import { dispatchPreviewTargetOpen } from '../../ui/preview/previewEvents';
import { usePreviewObjectUrl } from '../../ui/preview/usePreviewObjectUrl';
import {
  threadNodeIdFromReferenceHref,
  threadNodeReferenceDisplayLabel,
  threadNodeReferenceHref,
  threadNodeReferenceOpenOptionsFromClick,
  threadNodeReferenceStyle,
  type ThreadNodeReferenceOpenHandler,
} from '../threadReferences';

interface ThreadMarkdownProps {
  readonly index?: DocumentIndex;
  readonly onNodeReferenceOpen?: ThreadNodeReferenceOpenHandler;
  readonly streaming?: boolean;
  readonly text: string;
}

interface MarkdownAstNode {
  children?: MarkdownAstNode[];
  title?: string | null;
  type?: string;
  url?: string;
  value?: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkThreadReferences];
const STREAMING_MARKDOWN_THROTTLE_MS = 80;

export function ThreadMarkdown({
  index,
  onNodeReferenceOpen,
  streaming = false,
  text,
}: ThreadMarkdownProps) {
  const visibleText = useStreamingMarkdownText(text, streaming);
  const repairedText = useMemo(() => streaming ? remend(visibleText) : visibleText, [streaming, visibleText]);
  const blocks = useMemo(() => splitMarkdownBlocks(repairedText), [repairedText]);
  const components = useMarkdownComponents(index, onNodeReferenceOpen);
  return (
    <div className={`thread-markdown${streaming ? ' is-streaming' : ''}`}>
      {blocks.map((block, indexValue) => {
        const key = `markdown-block-${indexValue}`;
        if (streaming && indexValue === blocks.length - 1) {
          return (
            <Markdown
              components={components}
              key={key}
              remarkPlugins={REMARK_PLUGINS}
              urlTransform={threadMarkdownUrlTransform}
            >
              {block}
            </Markdown>
          );
        }
        return (
          <MemoizedMarkdownBlock
            index={index}
            key={key}
            markdown={block}
            onNodeReferenceOpen={onNodeReferenceOpen}
          />
        );
      })}
    </div>
  );
}

function remarkThreadReferences() {
  return (tree: MarkdownAstNode) => transformReferenceText(tree);
}

function transformReferenceText(node: MarkdownAstNode): void {
  if (!node.children || node.type === 'code' || node.type === 'inlineCode') return;
  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && node.type !== 'link') {
      nextChildren.push(...referenceMarkdownNodes(child.value));
      continue;
    }
    transformReferenceText(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function referenceMarkdownNodes(text: string): MarkdownAstNode[] {
  return splitReferenceMarkers(text).map((segment) => {
    if (segment.type === 'text') return { type: 'text', value: segment.text };
    if (segment.target.kind === 'local-file') {
      const label = segment.label || basenameForPath(segment.target.path) || segment.target.path;
      return {
        children: [{ type: 'text', value: label }],
        title: segment.target.entryKind,
        type: 'link',
        url: localFileReferenceHref(segment.target.path, segment.target.entryKind),
      };
    }
    return {
      children: [{ type: 'text', value: segment.label }],
      title: null,
      type: 'link',
      url: threadNodeReferenceHref(segment.target.nodeId),
    };
  });
}

function useMarkdownComponents(
  index: DocumentIndex | undefined,
  onNodeReferenceOpen: ThreadNodeReferenceOpenHandler | undefined,
) {
  const t = useT();
  return useMemo(() => ({
    a({ children, href, ...rest }: ComponentPropsWithoutRef<'a'>) {
      const fileRef = localFileReferenceFromHref(href);
      if (fileRef) {
        const label = reactNodeText(children) || basenameForPath(fileRef.path) || fileRef.path;
        return (
          <InlineFileReference
            className="thread-message-inline-ref"
            file={{
              entryKind: fileRef.entryKind,
              kind: 'file',
              mimeType: fileRef.entryKind === 'directory' ? 'inode/directory' : 'application/octet-stream',
              name: label,
              path: fileRef.path,
              ref: label,
            }}
          />
        );
      }

      const nodeId = threadNodeIdFromReferenceHref(href);
      if (nodeId) {
        const label = threadNodeReferenceDisplayLabel(
          reactNodeText(children),
          nodeId,
          index,
          t.agent.message.referencedNode,
        );
        const style = threadNodeReferenceStyle(nodeId, index);
        if (!onNodeReferenceOpen) {
          return <span className="inline-ref thread-message-inline-ref" style={style}>{label}</span>;
        }
        return (
          <a
            className="inline-ref thread-message-inline-ref"
            data-inline-ref={nodeId}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(nodeId, threadNodeReferenceOpenOptionsFromClick(event));
            }}
            style={style}
          >
            {label}
          </a>
        );
      }

      return (
        <a
          href={href}
          onClick={(event) => {
            if (!href || !openUrlPreviewFromClick(event.nativeEvent, href, reactNodeText(children))) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          rel="noreferrer"
          target="_blank"
          {...rest}
        >
          {children}
        </a>
      );
    },
    code({ children, className }: ComponentPropsWithoutRef<'code'>) {
      const rawCode = String(children);
      const language = className?.match(/language-(\S+)/)?.[1] ?? '';
      if (language || rawCode.includes('\n')) {
        return <ReadOnlyCodeBlock code={rawCode.replace(/\n$/, '')} language={language || 'text'} />;
      }
      return <code className="thread-inline-code">{children}</code>;
    },
    img(props: ComponentPropsWithoutRef<'img'>) {
      return <ThreadMarkdownImage {...props} />;
    },
    input(props: ComponentPropsWithoutRef<'input'>) {
      return <input {...props} disabled />;
    },
    pre({ children }: ComponentPropsWithoutRef<'pre'>) {
      return <>{children}</>;
    },
    table({ children, ...rest }: ComponentPropsWithoutRef<'table'>) {
      return <div className="thread-markdown-table-wrap"><table {...rest}>{children}</table></div>;
    },
  }), [index, onNodeReferenceOpen, t.agent.message.referencedNode]);
}

function ThreadMarkdownImage({ alt, src, title }: ComponentPropsWithoutRef<'img'>) {
  const t = useT();
  const localImage = markdownLocalImageFromSrc(src);
  const localPath = localImage?.path ?? null;
  const label = alt || localImage?.label || src || t.agent.message.imageUnavailable;
  const target = useMemo(() => localPath ? ({
    kind: 'local-file' as const,
    path: localPath,
    entryKind: 'file' as const,
    label,
  }) : null, [label, localPath]);
  const preview = usePreviewObjectUrl(target, { enabled: Boolean(target) });

  if (!target) {
    return (
      <a
        href={src}
        onClick={(event) => {
          if (!src || !openUrlPreviewFromClick(event.nativeEvent, src, label)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        rel="noreferrer"
        target="_blank"
        title={title}
      >
        {label}
      </a>
    );
  }

  return (
    <button
      aria-label={label}
      className="thread-markdown-image"
      onClick={() => dispatchPreviewTargetOpen({ presentation: 'reader', target })}
      title={title || label}
      type="button"
    >
      {preview.src ? (
        <img alt={label} loading="lazy" src={preview.src} />
      ) : (
        <span className="thread-markdown-image-placeholder">
          {preview.error ? t.agent.message.imageUnavailable : t.common.loading}
        </span>
      )}
    </button>
  );
}

const MemoizedMarkdownBlock = memo(function MemoizedMarkdownBlock({
  index,
  markdown,
  onNodeReferenceOpen,
}: {
  readonly index: DocumentIndex | undefined;
  readonly markdown: string;
  readonly onNodeReferenceOpen: ThreadNodeReferenceOpenHandler | undefined;
}) {
  const components = useMarkdownComponents(index, onNodeReferenceOpen);
  return (
    <Markdown components={components} remarkPlugins={REMARK_PLUGINS} urlTransform={threadMarkdownUrlTransform}>
      {markdown}
    </Markdown>
  );
});

function markdownLocalImageFromSrc(src: string | undefined): { path: string; label: string } | null {
  const fileRef = localFileReferenceFromHref(src);
  if (fileRef?.entryKind === 'file') {
    return { path: fileRef.path, label: basenameForPath(fileRef.path) || fileRef.path };
  }
  const trimmed = src?.trim();
  if (!trimmed?.startsWith('/')) return null;
  return { path: trimmed, label: basenameForPath(trimmed) || trimmed };
}

function threadMarkdownUrlTransform(value: string): string {
  return localFileReferenceFromHref(value) || threadNodeIdFromReferenceHref(value)
    ? value
    : defaultUrlTransform(value);
}

function reactNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  return '';
}

function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [''];
  try {
    return Lexer.lex(text).map((token) => token.raw);
  } catch {
    return [text];
  }
}

function useStreamingMarkdownText(text: string, streaming: boolean): string {
  const [visibleText, setVisibleText] = useState(text);
  const latestTextRef = useRef(text);
  const lastCommitRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestTextRef.current = text;
    if (!streaming) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setVisibleText(text);
      return undefined;
    }
    const commit = () => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setVisibleText(latestTextRef.current);
    };
    const wait = STREAMING_MARKDOWN_THROTTLE_MS - (Date.now() - lastCommitRef.current);
    if (wait <= 0) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      commit();
    } else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(commit, wait);
    }
    return undefined;
  }, [streaming, text]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return streaming ? visibleText : text;
}
