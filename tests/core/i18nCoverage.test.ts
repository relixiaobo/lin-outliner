import { describe, expect, test } from 'bun:test';
import { en, getMessages, LOCALE_OVERRIDES } from '../../src/core/i18n';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '../../src/core/locale';

// Guards the typed-i18n contract: every locale file is a strict subset of the
// canonical English tree (no typo'd / stale keys, leaf types match), and the
// resolved tree always fills every English key (fallback). It also LOGS per-locale
// coverage so partial translations are visible without failing the build — a new
// language can ship at 40% and fill in over time. See docs/plans/i18n-multi-language.md.

type LeafKind = 'string' | 'function';

// Collect every leaf path in a message tree. Strings and interpolation functions
// are leaves; only plain objects recurse (mirrors the resolver's deepMerge).
function leafPaths(tree: unknown, prefix = ''): Map<string, LeafKind> {
  const out = new Map<string, LeafKind>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [p, kind] of leafPaths(value, path)) out.set(p, kind);
    } else {
      out.set(path, typeof value === 'function' ? 'function' : 'string');
    }
  }
  return out;
}

const ENGLISH_LEAVES = leafPaths(en);
const overrideLocales = Object.keys(LOCALE_OVERRIDES) as Locale[];

describe('i18n message coverage', () => {
  test('English defines a non-trivial canonical tree', () => {
    expect(ENGLISH_LEAVES.size).toBeGreaterThan(0);
  });

  test('every locale override registered under a supported, non-default locale', () => {
    const supported = new Set(SUPPORTED_LOCALES.map((entry) => entry.code));
    for (const locale of overrideLocales) {
      expect(supported.has(locale)).toBe(true);
      expect(locale).not.toBe(DEFAULT_LOCALE); // English is the base, never an override
    }
  });

  for (const locale of overrideLocales) {
    describe(locale, () => {
      const leaves = leafPaths(LOCALE_OVERRIDES[locale]);

      test('has no keys absent from English (catches typos / stale keys)', () => {
        const unknown = [...leaves.keys()].filter((path) => !ENGLISH_LEAVES.has(path));
        expect(unknown).toEqual([]);
      });

      test('leaf kinds match English (string vs interpolation function)', () => {
        const mismatched = [...leaves.entries()]
          .filter(([path, kind]) => ENGLISH_LEAVES.has(path) && ENGLISH_LEAVES.get(path) !== kind)
          .map(([path]) => path);
        expect(mismatched).toEqual([]);
      });
    });
  }

  test('resolved tree fills every English key for all supported locales (fallback)', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const resolved = leafPaths(getMessages(code));
      const missing = [...ENGLISH_LEAVES.keys()].filter((path) => !resolved.has(path));
      expect(missing).toEqual([]);
    }
  });

  test('interpolation functions resolve in an override locale', () => {
    // zh-Hans translates the menu; the brand name is passed in, never translated.
    expect(getMessages('zh-Hans').menu.about({ app: 'Tenon' })).toBe('关于 Tenon');
    expect(getMessages('zh-Hans').menu.settings).toBe('设置…');
  });

  test('reports translation coverage per locale', () => {
    const lines = SUPPORTED_LOCALES.map(({ code }) => {
      if (code === DEFAULT_LOCALE) return `  ${code}: canonical (${ENGLISH_LEAVES.size} keys)`;
      const translated = leafPaths(LOCALE_OVERRIDES[code]).size;
      const pct = Math.round((translated / ENGLISH_LEAVES.size) * 100);
      return `  ${code}: ${translated}/${ENGLISH_LEAVES.size} (${pct}%)`;
    });
    console.log(`i18n coverage:\n${lines.join('\n')}`);
    expect(lines.length).toBe(SUPPORTED_LOCALES.length);
  });
});
