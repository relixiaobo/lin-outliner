import {
  bundledLanguages,
  bundledLanguagesAlias,
  createHighlighter,
  type BundledLanguage,
  type Highlighter,
} from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { normalizeCodeLanguage } from './codeLanguages';

export {
  CODE_LANGUAGE_OPTIONS,
  codeLanguageLabel,
  normalizeCodeLanguage,
  type CodeLanguageOption,
} from './codeLanguages';

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

// True when Shiki can actually highlight the language (a real bundled grammar
// or alias). Lets callers fall back to Plain text for fence info strings that
// are not languages (e.g. `tool`, `tool-error`) instead of surfacing them as a
// bogus language label, while still preserving real grammars not in the picker
// list (e.g. `kotlin`). Synchronous: it only inspects the bundle's id map, it
// does not load any grammar.
export function isKnownCodeLanguage(language: string | undefined | null): boolean {
  const id = normalizeCodeLanguage(language);
  if (!id) return false;
  return id in bundledLanguages || id in bundledLanguagesAlias;
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
