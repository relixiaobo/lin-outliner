import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';
import type { CodeDecoration } from '../../ui/editor/shikiHighlighter';
import { dispatchPreviewTargetOpen } from '../../ui/preview/previewEvents';
import { wantsNewPaneFromClick } from '../../ui/shared';

export interface ToolPathRange {
  readonly end: number;
  readonly path: string;
  readonly start: number;
  readonly text: string;
}

interface ToolCodeBlockProps {
  readonly code: string;
  readonly copyLabel: string;
  readonly cwd: string;
  readonly language: string;
}

const JSON_STRING_PATTERN = /"(?:\\.|[^"\\])*"/gu;
const PLAIN_PATH_PATTERN = /(?:[A-Za-z]:\\[^\s"'`<>{}\[\],]+|(?:~|\.{0,2})\/(?:[^\s"'`<>{}\[\],]+)|[A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)+)/gu;
const PATH_LINE_SUFFIX = /:(\d+)(?::\d+)?$/u;

export function ToolCodeBlock({ code, copyLabel, cwd, language }: ToolCodeBlockProps) {
  const paths = useMemo(() => toolPathRanges(code, language, cwd), [code, cwd, language]);
  const decorations = useMemo(() => pathDecorations(paths), [paths]);
  const blockRef = usePrimaryModifierClass(paths.length > 0);

  const openPath = (index: number, newPane: boolean) => {
    const target = paths[index];
    if (!target) return;
    dispatchPreviewTargetOpen({
      newPane,
      target: {
        kind: 'local-file',
        path: target.path,
        entryKind: target.path.endsWith('/') ? 'directory' : 'file',
        label: target.text,
      },
    });
  };

  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const index = toolPathIndexFromTarget(event.target);
    if (index === null || !wantsNewPaneFromClick(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openPath(index, wantsNewPaneFromClick(event));
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    const index = toolPathIndexFromTarget(event.target);
    if (index === null) return;
    event.preventDefault();
    event.stopPropagation();
    openPath(index, wantsNewPaneFromClick(event));
  };

  return (
    <div
      className="thread-tool-code-block"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      ref={blockRef}
    >
      <ReadOnlyCodeBlock
        code={code}
        copyLabel={copyLabel}
        decorations={decorations}
        language={language}
      />
    </div>
  );
}

export function toolPathRanges(code: string, language: string, cwd: string): ToolPathRange[] {
  return language === 'json' ? jsonToolPathRanges(code, cwd) : plainToolPathRanges(code, cwd);
}

function jsonToolPathRanges(code: string, cwd: string): ToolPathRange[] {
  const ranges: ToolPathRange[] = [];
  let cursor = 0;
  let pathField = false;
  for (const match of code.matchAll(JSON_STRING_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start > cursor) appendPlainPathRanges(ranges, code.slice(cursor, start), cwd, cursor);
    const value = decodeJsonString(raw);
    const isKey = /^\s*:/u.test(code.slice(start + raw.length));
    if (isKey) {
      pathField = isPathField(value);
    } else {
      const path = resolveToolPath(value, cwd, pathField);
      if (path) ranges.push({ start: start + 1, end: start + raw.length - 1, path, text: value });
    }
    cursor = start + raw.length;
  }
  if (cursor < code.length) appendPlainPathRanges(ranges, code.slice(cursor), cwd, cursor);
  return ranges;
}

function plainToolPathRanges(code: string, cwd: string): ToolPathRange[] {
  const ranges: ToolPathRange[] = [];
  appendPlainPathRanges(ranges, code, cwd, 0);
  return ranges;
}

function appendPlainPathRanges(
  ranges: ToolPathRange[],
  text: string,
  cwd: string,
  offset: number,
): void {
  for (const match of text.matchAll(PLAIN_PATH_PATTERN)) {
    const raw = trimTrailingSentencePunctuation(match[0]);
    const start = match.index;
    if (isUrlPathMatch(text, start)) continue;
    const path = resolveToolPath(raw, cwd, false);
    if (!path) continue;
    ranges.push({ start: offset + start, end: offset + start + raw.length, path, text: raw });
  }
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?;]+$/u, '');
}

function resolveToolPath(value: string, cwd: string, pathField: boolean): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.includes('\n') || looksLikeUrl(candidate) || looksLikeGlob(candidate)) return null;
  const withoutLocation = candidate.replace(PATH_LINE_SUFFIX, '');
  if (isAbsolutePath(withoutLocation)) return withoutLocation;
  if (withoutLocation.startsWith('~/')) {
    const home = homeFromCwd(cwd);
    return home ? normalizePosixPath(`${home}/${withoutLocation.slice(2)}`) : null;
  }
  if (!pathField && !looksLikeRelativePath(withoutLocation)) return null;
  if (!cwd.startsWith('/')) return null;
  return normalizePosixPath(`${cwd}/${withoutLocation.replace(/^\.\//u, '')}`);
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value);
}

function looksLikeRelativePath(value: string): boolean {
  if (value.startsWith('./') || value.startsWith('../')) return true;
  if (!value.includes('/') && !value.includes('\\')) return false;
  return /(?:^|[/\\])[^/\\]+\.[A-Za-z0-9]{1,12}$/u.test(value);
}

function isPathField(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, '_');
  return normalized === 'cwd'
    || normalized === 'file'
    || normalized === 'files'
    || normalized === 'directory'
    || normalized === 'directories'
    || normalized === 'root'
    || normalized === 'roots'
    || normalized === 'path'
    || normalized === 'paths'
    || normalized.endsWith('_file')
    || normalized.endsWith('_files')
    || normalized.endsWith('_path')
    || normalized.endsWith('_paths');
}

function normalizePosixPath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`;
}

function homeFromCwd(cwd: string): string | null {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+)/u.exec(cwd);
  return match?.[1] ?? null;
}

function isUrlPathMatch(text: string, start: number): boolean {
  const prefix = text.slice(Math.max(0, start - 8), start).toLowerCase();
  return prefix.endsWith('http:') || prefix.endsWith('https:') || prefix.endsWith('file:');
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(value);
}

function looksLikeGlob(value: string): boolean {
  return /[*?[\]{}]/u.test(value);
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function pathDecorations(paths: readonly ToolPathRange[]): CodeDecoration[] {
  return paths.map((path, index) => ({
    start: path.start,
    end: path.end,
    alwaysWrap: true,
    properties: {
      'aria-label': path.text,
      'className': ['thread-tool-path-reference'],
      'data-tool-path': path.path,
      'data-tool-path-index': String(index),
      'role': 'link',
      'tabIndex': 0,
    },
  }));
}

function toolPathIndexFromTarget(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[data-tool-path-index]');
  if (!element) return null;
  const index = Number(element.dataset.toolPathIndex);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function usePrimaryModifierClass(enabled: boolean) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const setPressed = (pressed: boolean) => {
      blockRef.current?.classList.toggle('is-primary-modifier-pressed', pressed);
    };
    const sync = (event: KeyboardEvent) => setPressed(event.metaKey || event.ctrlKey);
    const reset = () => setPressed(false);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', reset);
    return () => {
      setPressed(false);
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', reset);
    };
  }, [enabled]);
  return blockRef;
}
