import { webContents } from 'electron';
import type { WebContents } from 'electron';
import { normalizePreviewHttpUrl } from '../core/preview';
import {
  URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS,
  URL_CAPTION_TRANSLATION_MAX_BLOCKS,
  URL_PAGE_TRANSLATION_MAX_BATCH_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
  URL_PAGE_TRANSLATION_MAX_BLOCKS,
} from '../core/urlPageTranslation';
import {
  URL_PAGE_TRANSLATION_RUNTIME_KEY,
  validateUrlPageTranslationGuestCommand,
  type UrlPageTranslationGuestCommand,
} from '../core/urlPageTranslationGuest';

const URL_PAGE_TRANSLATION_WORLD_ID = 1_001;

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
    command: validateUrlPageTranslationGuestCommand(raw.command),
  };
}

function commandSource(command: UrlPageTranslationGuestCommand): string {
  switch (command.operation) {
    case 'document-language':
      return 'document.documentElement?.getAttribute("lang") ?? null';
    case 'caption-language':
      return runtimeMethodSource('captionLanguage', []);
    case 'initialize':
      return `(${command.runtimeSource})(window, ${JSON.stringify(URL_PAGE_TRANSLATION_RUNTIME_KEY)}, ${JSON.stringify(command.targetLanguage)}, ${JSON.stringify(command.labels)})`;
    case 'set-enabled':
      return runtimeMethodSource('setEnabled', [command.enabled, command.targetLanguage]);
    case 'next-batch': {
      const maxBlocks = command.options.maxBlocks ?? URL_PAGE_TRANSLATION_MAX_BLOCKS;
      const maxChars = command.options.maxChars ?? URL_PAGE_TRANSLATION_MAX_BATCH_CHARS;
      const captionMaxBlocks = command.options.captionMaxBlocks ?? URL_CAPTION_TRANSLATION_MAX_BLOCKS;
      const captionMaxChars = command.options.captionMaxChars ?? URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS;
      return runtimeMethodSource('nextBatch', [
        maxBlocks,
        maxChars,
        URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS,
        command.options.retryOnly ?? false,
        command.options.visibleOnly ?? false,
        command.options.activeBatches ?? [],
        captionMaxBlocks,
        captionMaxChars,
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
