import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import { Lexer } from 'marked';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remend from 'remend';
import { CheckIcon, CopyIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';

interface AgentMarkdownProps {
  keyPrefix: string;
  streaming?: boolean;
  text: string;
}

const REMARK_PLUGINS = [remarkGfm];

function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [''];
  try {
    return Lexer.lex(text).map((token) => token.raw);
  } catch {
    return [text];
  }
}

function AgentCodeBlock({
  className,
  code,
  lang,
}: {
  className?: string;
  code: string;
  lang: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

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
        <span>{lang || 'text'}</span>
        <ButtonControl
          aria-label="Copy code"
          className="agent-code-copy"
          disabled={!code}
          onClick={copyCode}
        >
          <CopyStateIcon size={ICON_SIZE.menu} />
        </ButtonControl>
      </div>
      <pre><code className={className}>{code}</code></pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  a({ children, href, ...rest }: ComponentPropsWithoutRef<'a'>) {
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
          className={className}
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
};

const MemoizedMarkdownBlock = memo(
  function MemoizedMarkdownBlock({ markdown }: { markdown: string }) {
    return (
      <Markdown components={MARKDOWN_COMPONENTS} remarkPlugins={REMARK_PLUGINS}>
        {markdown}
      </Markdown>
    );
  },
  (prev, next) => prev.markdown === next.markdown,
);

export function AgentMarkdown({ keyPrefix, streaming = false, text }: AgentMarkdownProps) {
  const mended = useMemo(() => (streaming ? remend(text) : text), [streaming, text]);
  const blocks = useMemo(() => splitMarkdownBlocks(mended), [mended]);

  return (
    <div className="agent-markdown">
      {blocks.map((block, index) => {
        const blockKey = `${keyPrefix}-block-${index}`;
        if (streaming && index === blocks.length - 1) {
          return (
            <Markdown components={MARKDOWN_COMPONENTS} key={blockKey} remarkPlugins={REMARK_PLUGINS}>
              {block}
            </Markdown>
          );
        }
        return <MemoizedMarkdownBlock key={blockKey} markdown={block} />;
      })}
    </div>
  );
}
