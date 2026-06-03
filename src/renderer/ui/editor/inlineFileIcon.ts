// The single source of truth for the inline file-mention icon. A local-file /
// directory / image reference renders the same monochrome glyph everywhere it
// appears — the outliner row editor (`pmSchema`), the agent composer editor, and
// the agent message render — so there is one mention language, not two. Node
// references carry no icon; the icon is what distinguishes a file from a node.
//
// The glyph itself is a CSS `mask-image` keyed on `data-file-icon-kind` (see
// `inline-ref.css`), so the only thing any render site emits is a plain `<span>`
// with this class + a kind. That keeps the emit trivial and identical across
// React and the two ProseMirror `toDOM` callbacks, and `currentColor` masking
// makes it theme-aware by construction (design-system B1/B8).

export type InlineFileIconKind =
  | 'archive'
  | 'audio'
  | 'code'
  | 'database'
  | 'folder'
  | 'image'
  | 'presentation'
  | 'spreadsheet'
  | 'text'
  | 'video';

export const INLINE_FILE_ICON_CLASS = 'inline-ref-file-icon';

export interface InlineFileIconDescriptor {
  entryKind?: 'file' | 'directory';
  mimeType?: string;
  name?: string;
}

export function inlineFileIconKind(file: InlineFileIconDescriptor): InlineFileIconKind {
  if (file.entryKind === 'directory' || file.mimeType === 'inode/directory') return 'folder';
  const mimeType = (file.mimeType ?? '').toLowerCase();
  const extension = (file.name ?? '').match(/\.([a-z0-9]{1,8})$/iu)?.[1]?.toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint') || ['ppt', 'pptx', 'key', 'keynote', 'odp'].includes(extension)) {
    return 'presentation';
  }
  if (mimeType.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'numbers', 'ods'].includes(extension)) return 'spreadsheet';
  if (mimeType.includes('zip') || mimeType.includes('archive') || ['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(extension)) return 'archive';
  if (mimeType.includes('sqlite') || ['db', 'sqlite', 'sqlite3'].includes(extension)) return 'database';
  if ([
    'c',
    'cpp',
    'css',
    'go',
    'h',
    'html',
    'java',
    'js',
    'jsx',
    'json',
    'kt',
    'py',
    'rs',
    'sh',
    'sql',
    'swift',
    'ts',
    'tsx',
    'xml',
    'yaml',
    'yml',
  ].includes(extension)) return 'code';
  return 'text';
}

// ProseMirror `toDOM` spec for the leading icon — used by `pmSchema` (outliner)
// and the agent composer editor. React render sites construct the equivalent
// `<span>` directly from `INLINE_FILE_ICON_CLASS` + `inlineFileIconKind`.
export function inlineFileIconDomSpec(kind: InlineFileIconKind): [string, Record<string, string>] {
  return [
    'span',
    { class: INLINE_FILE_ICON_CLASS, 'data-file-icon-kind': kind, 'aria-hidden': 'true' },
  ];
}
