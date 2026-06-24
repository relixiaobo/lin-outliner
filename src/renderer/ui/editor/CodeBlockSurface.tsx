import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { CheckIcon, CopyIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { highlightCode, plainCodeHtml } from './shikiHighlighter';

interface ReadOnlyCodeBlockProps {
  className?: string;
  code: string;
  copyLabel?: string;
  language?: string;
  showLanguageLabel?: boolean;
}

export function useCodeBlockCopy(code: string) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

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

  return { copied, copyCode };
}

function ReadOnlyCodeShell({
  children,
  className,
  code,
  copyLabel,
  language,
  showLanguageLabel,
}: ReadOnlyCodeBlockProps & { children: ReactNode }) {
  const t = useT();
  const { copied, copyCode } = useCodeBlockCopy(code);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;
  const resolvedCopyLabel = copyLabel ?? t.agent.markdown.copyCode;
  const languageLabel = language || t.agent.markdown.codeLanguageFallback;
  const blockClassName = className ? `agent-code-block ${className}` : 'agent-code-block';

  return (
    <div className={blockClassName}>
      <div className="agent-code-header">
        {showLanguageLabel ? <span>{languageLabel}</span> : null}
        <ButtonControl
          aria-label={resolvedCopyLabel}
          className="agent-code-copy"
          disabled={!code}
          onClick={copyCode}
          title={resolvedCopyLabel}
        >
          <CopyStateIcon size={ICON_SIZE.menu} />
        </ButtonControl>
      </div>
      <div className="agent-code-body">{children}</div>
    </div>
  );
}

export function ReadOnlyCodeBlock({
  className,
  code,
  copyLabel,
  language = 'text',
  showLanguageLabel = true,
}: ReadOnlyCodeBlockProps) {
  const [html, setHtml] = useState(() => plainCodeHtml(code));

  useEffect(() => {
    let cancelled = false;
    setHtml(plainCodeHtml(code));
    void highlightCode(code, language).then((next) => {
      if (!cancelled) setHtml(next);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return (
    <ReadOnlyCodeShell
      className={className}
      code={code}
      copyLabel={copyLabel}
      language={language}
      showLanguageLabel={showLanguageLabel}
    >
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </ReadOnlyCodeShell>
  );
}

export function PlainReadOnlyCodeBlock({
  children,
  className,
  code,
  copyLabel,
  language = 'text',
  showLanguageLabel = false,
}: ReadOnlyCodeBlockProps & { children: ReactNode }) {
  return (
    <ReadOnlyCodeShell
      className={className}
      code={code}
      copyLabel={copyLabel}
      language={language}
      showLanguageLabel={showLanguageLabel}
    >
      <pre>{children}</pre>
    </ReadOnlyCodeShell>
  );
}
