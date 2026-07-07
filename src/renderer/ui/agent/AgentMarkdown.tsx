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
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remend from 'remend';
import { basenameForPath, parseReferenceMarkers } from '../../../core/referenceMarkup';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { useT } from '../../i18n/I18nProvider';
import { InlineFileReference } from '../editor/InlineFileReference';
import {
  localFileReferenceFromHref,
  localFileReferenceHref,
} from '../editor/inlineFilePreviewData';
import {
  NODE_REFERENCE_LINK_PREFIX,
  chatSourceFromReferenceHref,
  chatSourceReferenceHref,
  nodeReferenceDisplayLabel,
  nodeReferenceOpenOptionsFromClick,
  nodeReferenceStyle,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';
import { AgentChatSourceReference } from './AgentChatSourceReference';
import { ReadOnlyCodeBlock } from '../editor/CodeBlockSurface';
import { openUrlPreviewFromClick } from '../preview/urlPreviewRouting';
import { dispatchPreviewTargetOpen } from '../preview/previewEvents';
import { usePreviewObjectUrl } from '../preview/usePreviewObjectUrl';

interface AgentMarkdownProps {
  index?: DocumentIndex;
  keyPrefix: string;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  streaming?: boolean;
  text: string;
}

interface MarkdownAstNode {
  alt?: string;
  children?: MarkdownAstNode[];
  title?: string | null;
  type?: string;
  url?: string;
  value?: string;
}

const REMARK_PLUGINS = [remarkGfm, remarkNodeReferences];
const STREAMING_MARKDOWN_THROTTLE_MS = 80;

function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [''];
  try {
    return Lexer.lex(text).map((token) => token.raw);
  } catch {
    return [text];
  }
}

function remarkNodeReferences() {
  return (tree: MarkdownAstNode) => {
    transformNodeReferenceText(tree);
  };
}

function transformNodeReferenceText(node: MarkdownAstNode): void {
  if (!node.children || node.type === 'code' || node.type === 'inlineCode') return;
  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && node.type !== 'link') {
      nextChildren.push(...referenceMarkdownNodes(child.value));
      continue;
    }
    transformNodeReferenceText(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function referenceMarkdownNodes(text: string): MarkdownAstNode[] {
  const markers = parseReferenceMarkers(text);
  if (markers.length === 0) return [{ type: 'text', value: text }];

  const nodes: MarkdownAstNode[] = [];
  let cursor = 0;
  for (const marker of markers) {
    const imageStart = marker.target.kind === 'local-file' && text[marker.start - 1] === '!'
      ? marker.start - 1
      : marker.start;
    if (imageStart < cursor) continue;
    if (imageStart > cursor) nodes.push({ type: 'text', value: text.slice(cursor, imageStart) });
    if (marker.target.kind === 'local-file') {
      const label = marker.label || basenameForPath(marker.target.path) || marker.target.path;
      if (imageStart === marker.start - 1) {
        nodes.push({
          alt: label,
          title: marker.target.entryKind,
          type: 'image',
          url: localFileReferenceHref(marker.target.path, marker.target.entryKind),
        });
      } else {
        nodes.push({
          children: [{ type: 'text', value: label }],
          title: marker.target.entryKind,
          type: 'link',
          url: localFileReferenceHref(marker.target.path, marker.target.entryKind),
        });
      }
      cursor = marker.end;
      continue;
    }
    if (marker.target.kind === 'chat-source') {
      nodes.push({
        children: [{ type: 'text', value: marker.label || marker.raw }],
        title: null,
        type: 'link',
        url: chatSourceReferenceHref(marker.raw),
      });
      cursor = marker.end;
      continue;
    }
    nodes.push({
      children: [{ type: 'text', value: marker.label }],
      title: null,
      type: 'link',
      url: `#${NODE_REFERENCE_LINK_PREFIX}${encodeURIComponent(marker.target.nodeId)}`,
    });
    cursor = marker.end;
  }
  if (cursor < text.length) nodes.push({ type: 'text', value: text.slice(cursor) });
  return nodes;
}

function nodeIdFromReferenceHref(href: string | undefined): NodeId | null {
  const normalizedHref = href?.startsWith('#') ? href.slice(1) : href;
  if (!normalizedHref?.startsWith(NODE_REFERENCE_LINK_PREFIX)) return null;
  const encodedNodeId = normalizedHref.slice(NODE_REFERENCE_LINK_PREFIX.length);
  try {
    return decodeURIComponent(encodedNodeId);
  } catch {
    return encodedNodeId;
  }
}

function reactNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  return '';
}

function markdownLocalImageFromSrc(src: string | undefined): { path: string; label: string } | null {
  const fileRef = localFileReferenceFromHref(src);
  if (fileRef?.entryKind === 'file') {
    return { path: fileRef.path, label: basenameForPath(fileRef.path) || fileRef.path };
  }
  const trimmed = src?.trim();
  if (!trimmed || !trimmed.startsWith('/')) return null;
  return { path: trimmed, label: basenameForPath(trimmed) || trimmed };
}

function AgentMarkdownImage({ alt, src, title }: ComponentPropsWithoutRef<'img'>) {
  const t = useT();
  const localImage = markdownLocalImageFromSrc(src);
  const localPath = localImage?.path ?? null;
  const localLabel = localImage?.label ?? null;
  const label = alt || localLabel || src || t.agent.toolCall.storedOutput;
  const target = useMemo(() => (
    localPath
      ? {
          kind: 'local-file' as const,
          path: localPath,
          entryKind: 'file' as const,
          label,
        }
      : null
  ), [label, localPath]);
  const preview = usePreviewObjectUrl(target, { enabled: Boolean(target) });

  if (!localImage || !target) {
    return (
      <a
        href={src}
        onClick={(event) => {
          if (!src) return;
          if (!openUrlPreviewFromClick(event.nativeEvent, src, label)) return;
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
      className="agent-markdown-image"
      onClick={() => dispatchPreviewTargetOpen({ target })}
      title={title || label}
      type="button"
    >
      {preview.src ? (
        <img alt={label} loading="lazy" src={preview.src} />
      ) : (
        <span className="agent-markdown-image-placeholder">
          {preview.error ? t.agent.toolCall.imageUnavailable : t.common.loading}
        </span>
      )}
    </button>
  );
}

function useMarkdownComponents(
  index: DocumentIndex | undefined,
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler | undefined,
) {
  const t = useT();
  const referencedNodeLabel = t.agent.message.referencedNode;
  return useMemo(() => ({
    a({ children, href, ...rest }: ComponentPropsWithoutRef<'a'>) {
      const fileRef = localFileReferenceFromHref(href);
      if (fileRef) {
        const label = reactNodeText(children) || basenameForPath(fileRef.path) || fileRef.path;
        return (
          <InlineFileReference
            className="agent-message-inline-ref"
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

      const chatSource = chatSourceFromReferenceHref(href);
      if (chatSource) {
        const label = reactNodeText(children) || 'Referenced chat';
        return (
          <AgentChatSourceReference href={href ?? ''} label={label} target={chatSource} />
        );
      }

      const nodeId = nodeIdFromReferenceHref(href);
      if (nodeId) {
        const style = nodeReferenceStyle(nodeId, index);
        const label = nodeReferenceDisplayLabel(reactNodeText(children), nodeId, index, referencedNodeLabel);
        if (!onNodeReferenceOpen) {
          return (
            <span
              className="inline-ref agent-message-inline-ref"
              data-inline-ref={nodeId}
              style={style}
            >
              {label}
            </span>
          );
        }
        return (
          <a
            className="inline-ref agent-message-inline-ref"
            data-inline-ref={nodeId}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(nodeId, nodeReferenceOpenOptionsFromClick(event));
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
            if (!href) return;
            if (!openUrlPreviewFromClick(event.nativeEvent, href, reactNodeText(children))) return;
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
      const lang = className?.match(/language-(\S+)/)?.[1] ?? '';
      if (lang || rawCode.includes('\n')) {
        return (
          <ReadOnlyCodeBlock
            code={rawCode.replace(/\n$/, '')}
            language={lang}
          />
        );
      }
      return <code className="agent-inline-code">{children}</code>;
    },
    input({ ...rest }: ComponentPropsWithoutRef<'input'>) {
      return <input {...rest} disabled />;
    },
    img(props: ComponentPropsWithoutRef<'img'>) {
      return <AgentMarkdownImage {...props} />;
    },
    pre({ children }: ComponentPropsWithoutRef<'pre'>) {
      return <>{children}</>;
    },
    table({ children, ...rest }: ComponentPropsWithoutRef<'table'>) {
      return (
        <div className="agent-markdown-table-wrap">
          <table {...rest}>{children}</table>
        </div>
      );
    },
  }), [index, onNodeReferenceOpen, referencedNodeLabel]);
}

const MemoizedMarkdownBlock = memo(
  function MemoizedMarkdownBlock({
    index,
    markdown,
    onNodeReferenceOpen,
  }: {
    index?: DocumentIndex;
    markdown: string;
    onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  }) {
    const components = useMarkdownComponents(index, onNodeReferenceOpen);
    return (
      <Markdown components={components} remarkPlugins={REMARK_PLUGINS}>
        {markdown}
      </Markdown>
    );
  },
  (prev, next) => (
    prev.markdown === next.markdown
    && prev.index === next.index
    && prev.onNodeReferenceOpen === next.onNodeReferenceOpen
  ),
);

function useStreamingMarkdownText(text: string, streaming: boolean): string {
  const [visibleText, setVisibleText] = useState(text);
  const latestTextRef = useRef(text);
  const lastCommitRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    latestTextRef.current = text;
    if (!streaming) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastCommitRef.current = Date.now();
      setVisibleText(text);
      return undefined;
    }

    const commit = () => {
      timerRef.current = null;
      lastCommitRef.current = Date.now();
      setVisibleText(latestTextRef.current);
    };
    const elapsed = Date.now() - lastCommitRef.current;
    if (elapsed >= STREAMING_MARKDOWN_THROTTLE_MS) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      commit();
      return undefined;
    }
    if (timerRef.current === null) {
      timerRef.current = window.setTimeout(commit, STREAMING_MARKDOWN_THROTTLE_MS - elapsed);
    }
    return undefined;
  }, [streaming, text]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return streaming ? visibleText : text;
}

export function AgentMarkdown({
  index: documentIndex,
  keyPrefix,
  onNodeReferenceOpen,
  streaming = false,
  text,
}: AgentMarkdownProps) {
  const renderText = useStreamingMarkdownText(text, streaming);
  const mended = useMemo(() => (streaming ? remend(renderText) : renderText), [streaming, renderText]);
  const blocks = useMemo(() => splitMarkdownBlocks(mended), [mended]);
  const components = useMarkdownComponents(documentIndex, onNodeReferenceOpen);

  return (
    // The file-chip open behavior (workspace reader vs normal workspace preview) is decided by
    // location, NOT here: a `[data-agent-transcript-chips]` ancestor (set once on the
    // live transcript message frame — see AgentMessageFrame) routes chip clicks to
    // the file-only reader. This markdown renders in both the live transcript and meta
    // surfaces (compaction/sub-run summaries, the PoV inspector), so it stays neutral.
    <div className="agent-markdown">
      {blocks.map((block, blockIndex) => {
        const blockKey = `${keyPrefix}-block-${blockIndex}`;
        if (streaming && blockIndex === blocks.length - 1) {
          return (
            <Markdown components={components} key={blockKey} remarkPlugins={REMARK_PLUGINS}>
              {block}
            </Markdown>
          );
        }
        return (
          <MemoizedMarkdownBlock
            index={documentIndex}
            key={blockKey}
            markdown={block}
            onNodeReferenceOpen={onNodeReferenceOpen}
          />
        );
      })}
    </div>
  );
}
