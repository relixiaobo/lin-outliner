import { Fragment, useMemo, type ReactNode } from 'react';
import { InlineFileReference } from '../../ui/editor/InlineFileReference';
import { PlainReadOnlyCodeBlock, ReadOnlyCodeBlock } from '../../ui/editor/CodeBlockSurface';

export type ToolTextSegment =
  | { readonly path: string; readonly text: string; readonly type: 'file' }
  | { readonly text: string; readonly type: 'text' };

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
  const segments = useMemo(() => toolTextSegments(code, language, cwd), [code, cwd, language]);
  if (!segments.some((segment) => segment.type === 'file')) {
    return <ReadOnlyCodeBlock code={code} copyLabel={copyLabel} language={language} />;
  }
  return (
    <PlainReadOnlyCodeBlock code={code} copyLabel={copyLabel} language={language} showLanguageLabel>
      <code className={`language-${language}`}>{renderSegments(segments)}</code>
    </PlainReadOnlyCodeBlock>
  );
}

export function toolTextSegments(code: string, language: string, cwd: string): ToolTextSegment[] {
  return language === 'json' ? jsonToolTextSegments(code, cwd) : plainToolTextSegments(code, cwd);
}

function jsonToolTextSegments(code: string, cwd: string): ToolTextSegment[] {
  const segments: ToolTextSegment[] = [];
  let cursor = 0;
  let pathField = false;
  for (const match of code.matchAll(JSON_STRING_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start > cursor) appendPlainSegments(segments, code.slice(cursor, start), cwd);
    const value = decodeJsonString(raw);
    const isKey = /^\s*:/u.test(code.slice(start + raw.length));
    if (isKey) {
      appendText(segments, raw);
      pathField = isPathField(value);
    } else {
      const path = resolveToolPath(value, cwd, pathField);
      if (!path) appendText(segments, raw);
      else {
        appendText(segments, '"');
        segments.push({ type: 'file', text: value, path });
        appendText(segments, '"');
      }
    }
    cursor = start + raw.length;
  }
  if (cursor < code.length) appendPlainSegments(segments, code.slice(cursor), cwd);
  return segments;
}

function plainToolTextSegments(code: string, cwd: string): ToolTextSegment[] {
  const segments: ToolTextSegment[] = [];
  appendPlainSegments(segments, code, cwd);
  return segments;
}

function appendPlainSegments(segments: ToolTextSegment[], text: string, cwd: string): void {
  let cursor = 0;
  for (const match of text.matchAll(PLAIN_PATH_PATTERN)) {
    const raw = trimTrailingSentencePunctuation(match[0]);
    const start = match.index;
    if (isUrlPathMatch(text, start)) continue;
    const path = resolveToolPath(raw, cwd, false);
    if (!path) continue;
    appendText(segments, text.slice(cursor, start));
    segments.push({ type: 'file', text: raw, path });
    cursor = start + raw.length;
  }
  appendText(segments, text.slice(cursor));
}

function trimTrailingSentencePunctuation(value: string): string {
  return value.replace(/[.!?;]+$/u, '');
}

function appendText(segments: ToolTextSegment[], text: string): void {
  if (!text) return;
  const previous = segments.at(-1);
  if (previous?.type === 'text') {
    segments[segments.length - 1] = { type: 'text', text: previous.text + text };
    return;
  }
  segments.push({ type: 'text', text });
}

function resolveToolPath(value: string, cwd: string, pathField: boolean): string | null {
  const candidate = value.trim();
  if (!candidate || candidate.includes('\n') || looksLikeUrl(candidate)) return null;
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

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function renderSegments(segments: readonly ToolTextSegment[]): ReactNode[] {
  return segments.map((segment, index) => {
    if (segment.type === 'text') return <Fragment key={index}>{segment.text}</Fragment>;
    const path = segment.path;
    return (
      <InlineFileReference
        className="thread-tool-path-reference"
        file={{
          entryKind: path.endsWith('/') ? 'directory' : 'file',
          mimeType: 'application/octet-stream',
          name: segment.text,
          path,
          ref: segment.text,
        }}
        key={index}
      />
    );
  });
}
