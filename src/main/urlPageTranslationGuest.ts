import { webContents } from 'electron';
import type { WebContents } from 'electron';
import { normalizePreviewHttpUrl } from '../core/preview';
import { isTranslationLanguage } from '../core/translationLanguage';
import {
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS,
  type UrlPageTranslationItem,
} from '../core/urlPageTranslation';
import {
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  type UrlPageTranslationGuestActiveBatch,
  type UrlPageTranslationGuestBatchOptions,
  type UrlPageTranslationGuestCommand,
} from '../core/urlPageTranslationGuest';

const URL_PAGE_TRANSLATION_WORLD_ID = 1_001;
const URL_PAGE_TRANSLATION_MAX_RUNTIME_SOURCE_CHARS = 64_000;
const URL_PAGE_TRANSLATION_MAX_ACTIVE_BATCHES = 3;
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,96}$/;

export async function executeUrlPageTranslationGuestCommand(
  sender: WebContents,
  raw: unknown,
): Promise<unknown> {
  const request = validateRequest(raw);
  const guest = webContents.fromId(request.webContentsId);
  if (
    !guest
    || guest.isDestroyed()
    || guest.getType() !== 'webview'
    || guest.hostWebContents !== sender
    || !normalizePreviewHttpUrl(guest.getURL())
  ) {
    throw new Error('Invalid URL page translation guest.');
  }

  return await guest.executeJavaScriptInIsolatedWorld(
    URL_PAGE_TRANSLATION_WORLD_ID,
    [{
      code: commandSource(request.command),
      url: 'tenon://url-page-translation-guest',
    }],
  );
}

function validateRequest(raw: unknown): { webContentsId: number; command: UrlPageTranslationGuestCommand } {
  if (!isRecord(raw)) throw new Error('Invalid URL page translation guest request.');
  const webContentsId = raw.webContentsId;
  if (!Number.isSafeInteger(webContentsId) || (webContentsId as number) <= 0) {
    throw new Error('Invalid URL page translation guest id.');
  }
  return {
    webContentsId: webContentsId as number,
    command: validateCommand(raw.command),
  };
}

function validateCommand(raw: unknown): UrlPageTranslationGuestCommand {
  if (!isRecord(raw) || typeof raw.operation !== 'string') {
    throw new Error('Invalid URL page translation guest command.');
  }
  switch (raw.operation) {
    case 'document-language':
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
  return { activeBatches, maxBlocks, maxChars, retryOnly: raw.retryOnly, visibleOnly: raw.visibleOnly };
}

function validateBoundedInteger(value: unknown, maximum: number, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`Invalid URL page translation ${label}.`);
  }
  return value as number;
}

function validateIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > URL_PAGE_TRANSLATION_MAX_BLOCKS) {
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
  if (!Array.isArray(raw) || raw.length > URL_PAGE_TRANSLATION_MAX_BLOCKS) {
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

function commandSource(command: UrlPageTranslationGuestCommand): string {
  switch (command.operation) {
    case 'document-language':
      return 'document.documentElement?.getAttribute("lang") ?? null';
    case 'initialize':
      return `(${command.runtimeSource})(window, ${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}, ${JSON.stringify(command.targetLanguage)}, ${JSON.stringify(command.labels)})`;
    case 'set-enabled':
      return runtimeMethodSource('setEnabled', [command.enabled, command.targetLanguage]);
    case 'next-batch': {
      const maxBlocks = command.options.maxBlocks ?? URL_PAGE_TRANSLATION_MAX_BLOCKS;
      const maxChars = command.options.maxChars ?? URL_PAGE_TRANSLATION_MAX_BATCH_CHARS;
      return runtimeMethodSource('nextBatch', [
        maxBlocks,
        maxChars,
        Math.min(URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS, maxChars),
        command.options.retryOnly ?? false,
        command.options.visibleOnly ?? false,
        command.options.activeBatches ?? [],
      ]);
    }
    case 'release':
      return runtimeMethodSource('release', [command.ids]);
    case 'apply':
      return runtimeMethodSource('apply', [command.translations]);
    case 'fail':
      return runtimeMethodSource('fail', [command.ids]);
    case 'destroy':
      return runtimeMethodSource('destroy', []);
  }
}

function runtimeMethodSource(method: string, args: readonly unknown[]): string {
  return `(() => {
    const runtime = window[${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}];
    if (!runtime || runtime.version !== 1 || typeof runtime[${JSON.stringify(method)}] !== 'function') return null;
    return runtime[${JSON.stringify(method)}](...${JSON.stringify(args)});
  })()`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
