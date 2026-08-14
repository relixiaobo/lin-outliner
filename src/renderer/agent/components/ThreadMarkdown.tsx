import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Lexer, type Token } from 'marked';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remend from 'remend';
import remarkGfm from 'remark-gfm';
import {
  transformMarkdownReferenceTextNodes,
  type MarkdownReferenceAstNode,
} from '../../../core/markdownReferenceAst';
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

const REMARK_PLUGINS = [remarkGfm, remarkThreadReferences];
const STREAMING_MARKDOWN_THROTTLE_MS = 80;

export function ThreadMarkdown({
  index,
  onNodeReferenceOpen,
  streaming = false,
  text,
}: ThreadMarkdownProps) {
  const visibleText = useStreamingMarkdownText(text, streaming);
  const blockParserRef = useRef<StreamingMarkdownBlockParser | null>(null);
  if (blockParserRef.current === null) blockParserRef.current = createStreamingMarkdownBlockParser();
  const blocks = useMemo(() => {
    if (streaming) return blockParserRef.current!.parse(visibleText);
    blockParserRef.current!.reset();
    return splitMarkdownBlocks(visibleText);
  }, [streaming, visibleText]);
  return (
    <div className={`thread-markdown${streaming ? ' is-streaming' : ''}`}>
      {blocks.map((block, indexValue) => {
        const key = `markdown-block-${indexValue}`;
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
  return (tree: MarkdownReferenceAstNode) => {
    transformMarkdownReferenceTextNodes(tree, referenceMarkdownNodes);
  };
}

function referenceMarkdownNodes(text: string): MarkdownReferenceAstNode[] {
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

export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [''];
  try {
    return blocksFromTokens(Lexer.lex(text));
  } catch {
    return [text];
  }
}

interface StreamingMarkdownBlockState {
  readonly blocks: readonly string[];
  readonly definitions: string;
  readonly definitionsBeforeTail: string;
  readonly prefixBlocks: readonly string[];
  readonly tailStart: number;
  readonly text: string;
}

export interface StreamingMarkdownBlockParser {
  parse(text: string): readonly string[];
  reset(): void;
}

export function createStreamingMarkdownBlockParser(): StreamingMarkdownBlockParser {
  let previous: StreamingMarkdownBlockState | null = null;
  return {
    parse(text) {
      if (previous?.text === text) return previous.blocks;
      previous = previous && text.startsWith(previous.text)
        ? appendStreamingMarkdown(previous, text)
        : parseFullStreamingMarkdown(text);
      return previous.blocks;
    },
    reset() {
      previous = null;
    },
  };
}

function appendStreamingMarkdown(
  previous: StreamingMarkdownBlockState,
  text: string,
): StreamingMarkdownBlockState {
  const repaired = remend(text);
  if (
    previous.tailStart > repaired.length
    || repaired.slice(0, previous.tailStart) !== text.slice(0, previous.tailStart)
  ) {
    return parseFullStreamingMarkdown(text, repaired);
  }
  const tailText = text.slice(previous.tailStart);
  const repairedTail = repaired.slice(previous.tailStart);
  let tokens: readonly Token[];
  try {
    tokens = Lexer.lex(repairedTail);
  } catch {
    return parseFullStreamingMarkdown(text, repaired);
  }

  const definitions = previous.definitionsBeforeTail + definitionsFromTokens(tokens);
  if (definitions !== previous.definitions) return parseFullStreamingMarkdown(text, repaired);

  const tailBlocks = blocksFromTokens(tokens, definitions);
  const visibleTailBlocks = hasVisibleTokens(tokens) ? tailBlocks : [];
  const blocks = [...previous.prefixBlocks, ...visibleTailBlocks];
  const normalizedBlocks = blocks.length > 0 ? blocks : [''];
  const boundary = nextTailBoundary(tokens, repairedTail, tailText);
  if (!boundary) {
    return {
      blocks: normalizedBlocks,
      definitions,
      definitionsBeforeTail: '',
      prefixBlocks: [],
      tailStart: 0,
      text,
    };
  }
  return {
    blocks: normalizedBlocks,
    definitions,
    definitionsBeforeTail: previous.definitionsBeforeTail + boundary.definitionsBeforeTail,
    prefixBlocks: [...previous.prefixBlocks, ...boundary.prefixBlocks.map((block) => (
      withDefinitions(block, definitions)
    ))],
    tailStart: previous.tailStart + boundary.tailStart,
    text,
  };
}

function parseFullStreamingMarkdown(
  text: string,
  repaired = remend(text),
): StreamingMarkdownBlockState {
  let tokens: readonly Token[];
  try {
    tokens = Lexer.lex(repaired);
  } catch {
    return {
      blocks: [repaired],
      definitions: '',
      definitionsBeforeTail: '',
      prefixBlocks: [],
      tailStart: 0,
      text,
    };
  }
  const definitions = definitionsFromTokens(tokens);
  const boundary = nextTailBoundary(tokens, repaired, text);
  return {
    blocks: blocksFromTokens(tokens, definitions),
    definitions,
    definitionsBeforeTail: boundary?.definitionsBeforeTail ?? '',
    prefixBlocks: boundary?.prefixBlocks.map((block) => withDefinitions(block, definitions)) ?? [],
    tailStart: boundary?.tailStart ?? 0,
    text,
  };
}

function nextTailBoundary(
  tokens: readonly Token[],
  repaired: string,
  source: string,
): {
  readonly definitionsBeforeTail: string;
  readonly prefixBlocks: readonly string[];
  readonly tailStart: number;
} | null {
  let coveredLength = 0;
  for (const token of tokens) {
    if (!repaired.startsWith(token.raw, coveredLength)) return null;
    coveredLength += token.raw.length;
  }
  // Marked can omit ignored duplicate definitions from token.raw. Offsets are
  // safe only when the token stream accounts for every repaired source byte.
  if (coveredLength !== repaired.length) return null;

  // A repair suffix can look like a separate final block. Keeping two substantive
  // content tokens prevents that temporary block from hiding an extendable
  // list, HTML block, or indented code block immediately before it.
  let tailContentIndex = -1;
  let contentCount = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]?.type !== 'def' && tokens[index]?.type !== 'space') {
      contentCount += 1;
      if (contentCount === 2) {
        tailContentIndex = index;
        break;
      }
    }
  }
  if (tailContentIndex < 0) return null;

  let tailIndex = 0;
  let tokenEnd = 0;
  // Trailing source whitespace can still be absorbed by the preceding token.
  const sourceContentEnd = source.trimEnd().length;
  for (let index = 0; index < tailContentIndex; index += 1) {
    tokenEnd += tokens[index]!.raw.length;
    if (tokenEnd <= sourceContentEnd && endsWithBlankLine(repaired, tokenEnd)) {
      tailIndex = index + 1;
    }
  }
  const beforeTail = tokens.slice(0, tailIndex);
  const tailStart = beforeTail.reduce((length, token) => length + token.raw.length, 0);
  if (
    tailStart > source.length
    || repaired.slice(0, tailStart) !== source.slice(0, tailStart)
    || hasOpenSquareBracket(source, tailStart)
  ) return null;
  return {
    definitionsBeforeTail: definitionsFromTokens(beforeTail),
    prefixBlocks: beforeTail.filter((token) => token.type !== 'def').map((token) => token.raw),
    tailStart,
  };
}

function hasOpenSquareBracket(text: string, end: number): boolean {
  // Marked can reinterpret a label opened in the prefix as a definition when
  // a matching `]:` arrives later, changing every block's attached definitions.
  let depth = 0;
  for (let index = 0; index < end; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === '[') {
      depth += 1;
    } else if (text[index] === ']' && depth > 0) {
      depth -= 1;
    }
  }
  return depth > 0;
}

function endsWithBlankLine(text: string, end: number): boolean {
  if (text[end - 1] !== '\n') return false;
  let index = end - 2;
  while (index >= 0 && (text[index] === ' ' || text[index] === '\t' || text[index] === '\r')) index -= 1;
  return text[index] === '\n';
}

function blocksFromTokens(tokens: readonly Token[], definitions = definitionsFromTokens(tokens)): string[] {
  const visibleBlocks = tokens
    .filter((token) => token.type !== 'def')
    .map((token) => withDefinitions(token.raw, definitions));
  return visibleBlocks.length > 0 ? visibleBlocks : [''];
}

function definitionsFromTokens(tokens: readonly Token[]): string {
  return tokens
    .filter((token) => token.type === 'def')
    .map((token) => token.raw)
    .join('');
}

function hasVisibleTokens(tokens: readonly Token[]): boolean {
  return tokens.some((token) => token.type !== 'def');
}

function withDefinitions(block: string, definitions: string): string {
  return definitions
    ? `${block}${block.endsWith('\n') ? '\n' : '\n\n'}${definitions}`
    : block;
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
