import { DEFAULT_LOCALE, type Locale } from '../locale';
import { en } from './messages/en';
import { zhHans } from './messages/zh-Hans';
import type { DeepPartial, Messages, PartialMessages } from './types';

export type { Messages } from './messages/en';

// Per-locale overrides onto the English base. English needs no entry (it IS the
// base). Adding a language is three lock-step edits: extend the `Locale` union and
// SUPPORTED_LOCALES (core/locale.ts), add a core/i18n/messages/<locale>.ts file,
// and register it here.
export const LOCALE_OVERRIDES: Partial<Record<Locale, PartialMessages>> = {
  'zh-Hans': zhHans,
};

// English is exported for the coverage test (it diffs each override's key set
// against this canonical tree); product code should go through getMessages().
export { en };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Merge an override onto the English base. Strings and interpolation functions are
// leaves (replaced wholesale); only plain objects recurse. The result is always a
// complete Messages tree — English fills every key the override omits.
function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override as Record<string, unknown>)) {
    const overrideValue = (override as Record<string, unknown>)[key];
    if (overrideValue === undefined) continue;
    const baseValue = result[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(overrideValue)
      ? deepMerge(baseValue, overrideValue as DeepPartial<typeof baseValue>)
      : overrideValue;
  }
  return result as T;
}

// Resolved trees are immutable per locale, so memoize: a locale is merged once and
// every useT()/getMessages() caller in that process shares the same object.
const cache = new Map<Locale, Messages>();

export function getMessages(locale: Locale): Messages {
  const cached = cache.get(locale);
  if (cached) return cached;
  const override = LOCALE_OVERRIDES[locale];
  const resolved = override ? deepMerge(en, override) : en;
  cache.set(locale, resolved);
  return resolved;
}

export const DEFAULT_MESSAGES = getMessages(DEFAULT_LOCALE);
