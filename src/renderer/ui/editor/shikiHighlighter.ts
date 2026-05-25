import {
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// The app ships a single light theme today (see styles.css `:root`). When a
// dark theme lands, switch this to a dual-theme setup with CSS variables.
const THEME = 'github-light';
const PLAIN = 'text';

// Loaded eagerly so the most common blocks highlight without a flash. Other
// bundled languages load lazily on first use via `highlightCode`.
const DEFAULT_LANGS: BundledLanguage[] = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'json',
  'markdown',
  'bash',
  'css',
  'html',
];

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

// Common shorthands users (and slash shortcuts) may type, mapped to the
// canonical Shiki bundle id.
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

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>(DEFAULT_LANGS);
const failedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: DEFAULT_LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Fallback markup matching Shiki's structure so the overlay metrics stay
// identical before/while a grammar loads (or for unsupported languages).
export function plainCodeHtml(code: string): string {
  return `<pre class="shiki" tabindex="-1"><code>${escapeHtml(code) || '​'}</code></pre>`;
}

export async function highlightCode(code: string, language: string | undefined | null): Promise<string> {
  const id = normalizeCodeLanguage(language);
  if (!id || id === PLAIN) return plainCodeHtml(code);

  const highlighter = await getHighlighter();
  if (!loadedLangs.has(id) && !failedLangs.has(id)) {
    try {
      await highlighter.loadLanguage(id as BundledLanguage);
      loadedLangs.add(id);
    } catch {
      failedLangs.add(id);
    }
  }
  if (!loadedLangs.has(id)) return plainCodeHtml(code);

  return highlighter.codeToHtml(code, { lang: id, theme: THEME });
}
