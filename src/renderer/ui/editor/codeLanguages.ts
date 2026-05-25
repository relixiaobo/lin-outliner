// Pure code-language metadata shared by the Shiki highlighter, the code-block
// picker, and the paste parser. Kept free of any Shiki import so lightweight
// consumers (e.g. the paste parser and its unit tests) don't pull the engine.

// Languages offered in the code-block picker. `id` is the canonical Shiki
// bundle id persisted as `node.codeLanguage`; '' means plain text.
export interface CodeLanguageOption {
  id: string;
  label: string;
}

export const CODE_LANGUAGE_OPTIONS: readonly CodeLanguageOption[] = [
  { id: '', label: 'Plain text' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'tsx', label: 'TSX' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'jsx', label: 'JSX' },
  { id: 'python', label: 'Python' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'bash', label: 'Shell' },
  { id: 'css', label: 'CSS' },
  { id: 'html', label: 'HTML' },
  { id: 'sql', label: 'SQL' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'php', label: 'PHP' },
  { id: 'swift', label: 'Swift' },
  { id: 'toml', label: 'TOML' },
  { id: 'diff', label: 'Diff' },
] as const;

// Common shorthands users (and slash shortcuts / pasted fences) may type,
// mapped to the canonical Shiki bundle id.
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  rs: 'rust',
  rb: 'ruby',
  golang: 'go',
  plaintext: '',
  text: '',
  txt: '',
};

export function normalizeCodeLanguage(language: string | undefined | null): string {
  const trimmed = (language ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  return LANGUAGE_ALIASES[trimmed] ?? trimmed;
}

export function codeLanguageLabel(language: string | undefined | null): string {
  const id = normalizeCodeLanguage(language);
  const known = CODE_LANGUAGE_OPTIONS.find((option) => option.id === id);
  if (known) return known.label;
  return id || 'Plain text';
}
