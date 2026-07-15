import { isTranslationLanguage, type TranslationLanguage } from './translationLanguage';
import {
  URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
  URL_CAPTION_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS,
  type UrlPageTranslationItem,
} from './urlPageTranslation';

export const LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL = 'lin:url-page-translation-guest';
export const URL_PAGE_TRANSLATION_RUNTIME_KEY = '__tenonBilingualTranslationV1__';
export const URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS = 64_000;
const URL_PAGE_TRANSLATION_MAX_ACTIVE_BATCHES = 3;
const URL_PAGE_TRANSLATION_MAX_RESULT_ITEMS = Math.max(
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  URL_CAPTION_TRANSLATION_MAX_BLOCKS,
);
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;

export interface UrlPageTranslationGuestLabels {
  retry: string;
  translating: string;
}

export interface UrlPageTranslationGuestActiveBatch {
  ids: readonly string[];
  requestId: string;
}

export interface UrlPageTranslationGuestBatchOptions {
  activeBatches?: readonly UrlPageTranslationGuestActiveBatch[];
  captionMaxBlocks?: number;
  captionMaxChars?: number;
  maxBlocks?: number;
  maxChars?: number;
  retryOnly?: boolean;
  visibleOnly?: boolean;
}

export type UrlPageTranslationGuestCommand =
  | { operation: 'document-language' }
  | { operation: 'caption-language' }
  | {
      operation: 'initialize';
      labels: UrlPageTranslationGuestLabels;
      runtimeSource: string;
      targetLanguage: TranslationLanguage;
    }
  | { operation: 'set-enabled'; enabled: boolean; targetLanguage: TranslationLanguage }
  | { operation: 'next-batch'; options: UrlPageTranslationGuestBatchOptions }
  | { operation: 'release'; ids: readonly string[] }
  | { operation: 'apply'; translations: readonly UrlPageTranslationItem[] }
  | { operation: 'fail'; ids: readonly string[] }
  | { operation: 'destroy' };

export interface UrlPageTranslationGuestRequest {
  webContentsId: number;
  command: UrlPageTranslationGuestCommand;
}

export function validateUrlPageTranslationGuestCommand(raw: unknown): UrlPageTranslationGuestCommand {
  if (!isRecord(raw) || typeof raw.operation !== 'string') {
    throw new Error('Invalid URL page translation guest command.');
  }
  switch (raw.operation) {
    case 'document-language':
    case 'caption-language':
    case 'destroy':
      return { operation: raw.operation };
    case 'initialize': {
      if (
        typeof raw.runtimeSource !== 'string'
        || !raw.runtimeSource
        || raw.runtimeSource.length > URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS
        || !isTranslationLanguage(raw.targetLanguage)
        || !isRecord(raw.labels)
      ) {
        throw new Error('Invalid URL page translation guest initialization.');
      }
      const retry = validateLabel(raw.labels.retry);
      const translating = validateLabel(raw.labels.translating);
      return {
        operation: 'initialize',
        runtimeSource: raw.runtimeSource,
        targetLanguage: raw.targetLanguage,
        labels: { retry, translating },
      };
    }
    case 'set-enabled':
      if (typeof raw.enabled !== 'boolean' || !isTranslationLanguage(raw.targetLanguage)) {
        throw new Error('Invalid URL page translation enabled state.');
      }
      return { operation: 'set-enabled', enabled: raw.enabled, targetLanguage: raw.targetLanguage };
    case 'next-batch':
      return { operation: 'next-batch', options: validateBatchOptions(raw.options) };
    case 'release':
    case 'fail':
      return { operation: raw.operation, ids: validateIds(raw.ids) };
    case 'apply':
      return { operation: 'apply', translations: validateTranslations(raw.translations) };
    default:
      throw new Error('Unknown URL page translation guest command.');
  }
}

function validateBatchOptions(raw: unknown): Required<UrlPageTranslationGuestBatchOptions> {
  if (!isRecord(raw)) throw new Error('Invalid URL page translation batch options.');
  const maxBlocks = validateBoundedInteger(raw.maxBlocks, URL_PAGE_TRANSLATION_MAX_BLOCKS, 'block count');
  const maxChars = validateBoundedInteger(raw.maxChars, URL_PAGE_TRANSLATION_MAX_BATCH_CHARS, 'character count');
  const captionMaxBlocks = validateBoundedInteger(
    raw.captionMaxBlocks,
    URL_CAPTION_TRANSLATION_MAX_BLOCKS,
    'caption block count',
  );
  const captionMaxChars = validateBoundedInteger(
    raw.captionMaxChars,
    URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
    'caption character count',
  );
  if (typeof raw.retryOnly !== 'boolean' || typeof raw.visibleOnly !== 'boolean') {
    throw new Error('Invalid URL page translation batch mode.');
  }
  if (!Array.isArray(raw.activeBatches) || raw.activeBatches.length > URL_PAGE_TRANSLATION_MAX_ACTIVE_BATCHES) {
    throw new Error('Invalid active URL page translation batches.');
  }
  const activeBatches = raw.activeBatches.map((entry): UrlPageTranslationGuestActiveBatch => {
    if (!isRecord(entry) || typeof entry.requestId !== 'string' || !ID_PATTERN.test(entry.requestId)) {
      throw new Error('Invalid active URL page translation batch.');
    }
    return { requestId: entry.requestId, ids: validateIds(entry.ids) };
  });
  return {
    activeBatches,
    captionMaxBlocks,
    captionMaxChars,
    maxBlocks,
    maxChars,
    retryOnly: raw.retryOnly,
    visibleOnly: raw.visibleOnly,
  };
}

function validateBoundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`Invalid URL page translation ${label}.`);
  }
  return value as number;
}

function validateIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > URL_PAGE_TRANSLATION_MAX_RESULT_ITEMS) {
    throw new Error('Invalid URL page translation block ids.');
  }
  const ids = raw.map((id) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error('Invalid URL page translation block id.');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate URL page translation block id.');
  return ids;
}

function validateTranslations(raw: unknown): UrlPageTranslationItem[] {
  if (!Array.isArray(raw) || raw.length > URL_PAGE_TRANSLATION_MAX_RESULT_ITEMS) {
    throw new Error('Invalid URL page translations.');
  }
  const ids = new Set<string>();
  return raw.map((entry): UrlPageTranslationItem => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || ids.has(entry.id)) {
      throw new Error('Invalid URL page translation result id.');
    }
    if (
      typeof entry.translation !== 'string'
      || !entry.translation.trim()
      || entry.translation.length > URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS
    ) {
      throw new Error('Invalid URL page translation result.');
    }
    ids.add(entry.id);
    return { id: entry.id, translation: entry.translation };
  });
}

function validateLabel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 240) {
    throw new Error('Invalid URL page translation guest label.');
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
