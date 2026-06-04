import {
  memo,
  useCallback,
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
import { basenameForPath, splitReferenceMarkers } from '../../../core/referenceMarkup';
import type { NodeId } from '../../api/types';
import type { DocumentIndex } from '../../state/document';
import { CheckIcon, CopyIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { useT } from '../../i18n/I18nProvider';
import { highlightCode, plainCodeHtml } from '../editor/shikiHighlighter';
import {
  nodeReferenceDisplayLabel,
  nodeReferenceOpenOptionsFromClick,
  nodeReferenceStyle,
  type AgentNodeReferenceOpenHandler,
} from './AgentInlineReferenceText';

interface AgentMarkdownProps {
  index?: DocumentIndex;
  keyPrefix: string;
  onNodeReferenceOpen?: AgentNodeReferenceOpenHandler;
  streaming?: boolean;
  text: string;
}

interface MarkdownAstNode {
  children?: MarkdownAstNode[];
  title?: string | null;
  type?: string;
  url?: string;
  value?: string;
}

const NODE_REFERENCE_LINK_PREFIX = 'lin-node:';
const REMARK_PLUGINS = [remarkGfm, remarkNodeReferences];

function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [''];
  try {
    return Lexer.lex(text).map((token) => token.raw);
  } catch {
    return [text];
  }
}

function AgentCodeBlock({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const [html, setHtml] = useState(() => plainCodeHtml(code));
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  useEffect(() => {
    let cancelled = false;
    void highlightCode(code, lang).then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copyCode = useCallback(() => {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1200);
    });
  }, [code]);

  return (
    <div className="agent-code-block">
      <div className="agent-code-header">
        <span>{lang || t.agent.markdown.codeLanguageFallback}</span>
        <ButtonControl
          aria-label={t.agent.markdown.copyCode}
          className="agent-code-copy"
          disabled={!code}
          onClick={copyCode}
        >
          <CopyStateIcon size={ICON_SIZE.menu} />
        </ButtonControl>
      </div>
      <div className="agent-code-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
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
  return splitReferenceMarkers(text).map((segment) => {
    if (segment.type === 'text') return { type: 'text', value: segment.text };
    if (segment.target.kind === 'local-file') {
      return {
        type: 'text',
        value: segment.label || basenameForPath(segment.target.path) || segment.target.path,
      };
    }
    return {
      children: [{ type: 'text', value: segment.label }],
      title: null,
      type: 'link',
      url: `#${NODE_REFERENCE_LINK_PREFIX}${encodeURIComponent(segment.target.nodeId)}`,
    };
  });
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

function useMarkdownComponents(
  index: DocumentIndex | undefined,
  onNodeReferenceOpen: AgentNodeReferenceOpenHandler | undefined,
) {
  const t = useT();
  const referencedNodeLabel = t.agent.message.referencedNode;
  return useMemo(() => ({
    a({ children, href, ...rest }: ComponentPropsWithoutRef<'a'>) {
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
          <button
            className="inline-ref agent-message-inline-ref"
            data-inline-ref={nodeId}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onNodeReferenceOpen(nodeId, nodeReferenceOpenOptionsFromClick(event));
            }}
            style={style}
            type="button"
          >
            {label}
          </button>
        );
      }
      return (
        <a href={href} rel="noreferrer" target="_blank" {...rest}>
          {children}
        </a>
      );
    },
    code({ children, className }: ComponentPropsWithoutRef<'code'>) {
      const rawCode = String(children);
      const lang = className?.match(/language-(\S+)/)?.[1] ?? '';
      if (lang || rawCode.includes('\n')) {
        return (
          <AgentCodeBlock
            code={rawCode.replace(/\n$/, '')}
            lang={lang}
          />
        );
      }
      return <code className="agent-inline-code">{children}</code>;
    },
    input({ ...rest }: ComponentPropsWithoutRef<'input'>) {
      return <input {...rest} disabled />;
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

export function AgentMarkdown({
  index: documentIndex,
  keyPrefix,
  onNodeReferenceOpen,
  streaming = false,
  text,
}: AgentMarkdownProps) {
  const mended = useMemo(() => (streaming ? remend(text) : text), [streaming, text]);
  const blocks = useMemo(() => splitMarkdownBlocks(mended), [mended]);
  const components = useMarkdownComponents(documentIndex, onNodeReferenceOpen);

  return (
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
