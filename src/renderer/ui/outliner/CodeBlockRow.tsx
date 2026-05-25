import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  CursorPlacement,
  FocusRequest,
  FocusTarget,
  PendingInputChar,
} from '../../state/document';
import { focusTargetMatches } from '../focus/focusModel';
import { CheckIcon, CopyIcon, ICON_SIZE } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import {
  CODE_LANGUAGE_OPTIONS,
  codeLanguageLabel,
  highlightCode,
  normalizeCodeLanguage,
  plainCodeHtml,
} from '../editor/shikiHighlighter';

const INDENT = '  ';

type PendingSelection = number | [number, number];

interface CodeBlockRowProps {
  nodeId: string;
  text: string;
  language?: string;
  readOnly?: boolean;
  onFocus: () => void;
  onTextChange: (text: string) => void;
  onCommit: (text: string) => void;
  onSetLanguage: (language: string) => void;
  onExitToNewRow: () => void;
  onBackspaceAtStart: () => void;
  onArrowUpAtStart: () => void;
  onArrowDownAtEnd: () => void;
  onShiftArrow: (direction: 'up' | 'down') => void;
  onEscape: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  focusTarget?: FocusTarget;
  focusRequest?: FocusRequest | null;
  pendingInput?: PendingInputChar | null;
  onFocusRequestConsumed?: (request: FocusRequest) => void;
  onPendingInputConsumed?: (input: PendingInputChar) => void;
}

function caretForPlacement(placement: CursorPlacement, length: number): PendingSelection {
  if (placement.kind === 'start') return 0;
  if (placement.kind === 'all') return [0, length];
  if (placement.kind === 'text-offset') return Math.max(0, Math.min(placement.offset, length));
  // 'end' and 'preserve' both resolve to the end for a freshly focused block.
  return length;
}

export function CodeBlockRow(props: CodeBlockRowProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  const composingRef = useRef(false);
  const pendingSelectionRef = useRef<PendingSelection | null>(null);
  const [value, setValue] = useState(props.text);
  const [highlightedHtml, setHighlightedHtml] = useState(() => plainCodeHtml(props.text));
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  propsRef.current = props;
  const language = normalizeCodeLanguage(props.language);

  // Keep the editable value in sync with external document updates (undo,
  // agent edits). Skip mid-composition; normal typing keeps them equal so this
  // never clobbers the caret.
  useEffect(() => {
    if (composingRef.current) return;
    setValue((prev) => (prev === props.text ? prev : props.text));
  }, [props.text]);

  useEffect(() => {
    let cancelled = false;
    void highlightCode(value, language).then((html) => {
      if (!cancelled) setHighlightedHtml(html);
    });
    return () => {
      cancelled = true;
    };
  }, [value, language]);

  // Apply a programmatic caret/selection after a value-driven re-render so the
  // controlled textarea does not reset it to the end.
  useLayoutEffect(() => {
    const selection = pendingSelectionRef.current;
    if (selection === null) return;
    pendingSelectionRef.current = null;
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (Array.isArray(selection)) textarea.setSelectionRange(selection[0], selection[1]);
    else textarea.setSelectionRange(selection, selection);
  }, [value]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
  }, []);

  const commitValue = useCallback((next: string, selection?: PendingSelection) => {
    if (selection !== undefined) pendingSelectionRef.current = selection;
    setValue(next);
    propsRef.current.onTextChange(next);
  }, []);

  useEffect(() => {
    const textarea = textareaRef.current;
    const request = props.focusRequest;
    const target = props.focusTarget;
    if (!textarea || !request || !target) return;
    if (!focusTargetMatches(request.target, target)) return;
    textarea.focus({ preventScroll: true });
    const selection = caretForPlacement(request.placement, textarea.value.length);
    if (Array.isArray(selection)) textarea.setSelectionRange(selection[0], selection[1]);
    else textarea.setSelectionRange(selection, selection);
    props.onFocusRequestConsumed?.(request);
  }, [props.focusRequest, props.focusTarget, props.onFocusRequestConsumed]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const input = props.pendingInput;
    const target = props.focusTarget;
    if (!textarea || !input || !target || props.readOnly) return;
    if (!focusTargetMatches(input.target, target)) return;
    textarea.focus({ preventScroll: true });
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = textarea.value.slice(0, start) + input.char + textarea.value.slice(end);
    commitValue(next, start + input.char.length);
    props.onPendingInputConsumed?.(input);
  }, [props.pendingInput, props.focusTarget, props.readOnly, props.onPendingInputConsumed, commitValue]);

  const handleChange = (event: { currentTarget: HTMLTextAreaElement }) => {
    const next = event.currentTarget.value;
    setValue(next);
    if (!composingRef.current) propsRef.current.onTextChange(next);
  };

  const indentRange = (textarea: HTMLTextAreaElement, outdent: boolean) => {
    const v = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const firstLineStart = v.lastIndexOf('\n', start - 1) + 1;
    const lines = v.slice(firstLineStart, end).split('\n');
    let removedFirst = 0;
    let removedTotal = 0;
    const transformed = lines.map((line, index) => {
      if (!outdent) {
        if (index === 0) removedFirst = -INDENT.length;
        removedTotal += -INDENT.length;
        return INDENT + line;
      }
      const match = line.match(/^( {1,2}|\t)/);
      const removed = match ? match[0].length : 0;
      if (index === 0) removedFirst = removed;
      removedTotal += removed;
      return line.slice(removed);
    });
    const next = v.slice(0, firstLineStart) + transformed.join('\n') + v.slice(end);
    const nextStart = Math.max(firstLineStart, start - removedFirst);
    const nextEnd = end - removedTotal;
    commitValue(next, [nextStart, nextEnd]);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const mod = event.metaKey || event.ctrlKey;
    const v = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const collapsed = start === end;

    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) propsRef.current.onRedo?.();
      else propsRef.current.onUndo?.();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      propsRef.current.onRedo?.();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      propsRef.current.onEscape();
      return;
    }

    if (event.key === 'Enter') {
      if (mod) {
        event.preventDefault();
        propsRef.current.onExitToNewRow();
        return;
      }
      if (event.shiftKey) return;
      event.preventDefault();
      const lineStart = v.lastIndexOf('\n', start - 1) + 1;
      const indent = (v.slice(lineStart, start).match(/^[ \t]*/) ?? [''])[0];
      const insert = `\n${indent}`;
      commitValue(v.slice(0, start) + insert + v.slice(end), start + insert.length);
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      if (!event.shiftKey && collapsed) {
        commitValue(v.slice(0, start) + INDENT + v.slice(end), start + INDENT.length);
      } else {
        indentRange(textarea, event.shiftKey);
      }
      return;
    }

    if (event.key === 'Backspace' && collapsed && start === 0 && v.length === 0) {
      event.preventDefault();
      propsRef.current.onBackspaceAtStart();
      return;
    }

    // Shift+Arrow extends the textarea selection within the block, but at the
    // top/bottom edge it exits into the outliner's row (block) selection so a
    // selection can span the code block and neighbouring rows.
    if (event.shiftKey && !mod && event.key === 'ArrowUp') {
      if (v.lastIndexOf('\n', start - 1) === -1) {
        event.preventDefault();
        propsRef.current.onShiftArrow('up');
      }
      return;
    }

    if (event.shiftKey && !mod && event.key === 'ArrowDown') {
      if (v.indexOf('\n', end) === -1) {
        event.preventDefault();
        propsRef.current.onShiftArrow('down');
      }
      return;
    }

    if (event.key === 'ArrowUp' && collapsed && !event.shiftKey) {
      if (v.lastIndexOf('\n', start - 1) === -1) {
        event.preventDefault();
        propsRef.current.onArrowUpAtStart();
      }
      return;
    }

    if (event.key === 'ArrowDown' && collapsed && !event.shiftKey) {
      if (v.indexOf('\n', start) === -1) {
        event.preventDefault();
        propsRef.current.onArrowDownAtEnd();
      }
    }
  };

  const copyCode = useCallback(() => {
    const code = textareaRef.current?.value ?? '';
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1200);
    });
  }, []);

  // Keep the highlight layer aligned with the textarea as it scrolls long
  // lines horizontally (the layers don't wrap).
  const syncScroll = (event: { currentTarget: HTMLTextAreaElement }) => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    highlight.scrollLeft = event.currentTarget.scrollLeft;
    highlight.scrollTop = event.currentTarget.scrollTop;
  };

  const knownLanguage = CODE_LANGUAGE_OPTIONS.some((option) => option.id === language);
  const CopyStateIcon = copied ? CheckIcon : CopyIcon;

  return (
    <div className="code-block" data-language={language || 'text'}>
      <div className="code-block-chrome" contentEditable={false}>
        <select
          aria-label="Code language"
          className="code-block-language"
          disabled={props.readOnly}
          value={language}
          onChange={(event) => props.onSetLanguage(event.currentTarget.value)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {!knownLanguage && language && (
            <option value={language}>{codeLanguageLabel(language)}</option>
          )}
          {CODE_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.id || 'plain'} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <ButtonControl
          aria-label="Copy code"
          className="code-block-copy"
          disabled={!value}
          onClick={copyCode}
        >
          <CopyStateIcon size={ICON_SIZE.menu} />
        </ButtonControl>
      </div>
      <div className="code-block-editor">
        <pre className="code-block-sizer" aria-hidden="true">{`${value}\n`}</pre>
        <div
          ref={highlightRef}
          className="code-block-highlight"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
        <textarea
          ref={textareaRef}
          className="code-block-textarea"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          readOnly={props.readOnly}
          value={value}
          onFocus={() => props.onFocus()}
          onBlur={() => propsRef.current.onCommit(textareaRef.current?.value ?? value)}
          onChange={handleChange}
          onScroll={syncScroll}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const next = event.currentTarget.value;
            setValue(next);
            propsRef.current.onTextChange(next);
          }}
        />
      </div>
    </div>
  );
}
