import type { Locale } from './locale';

export const URL_PAGE_TRANSLATE_COMMAND = 'url_page_translate_blocks';
export const URL_PAGE_TRANSLATION_CANCEL_COMMAND = 'url_page_translation_cancel';

export const URL_PAGE_TRANSLATION_MAX_ACTIVE_SESSIONS = 8;
export const URL_PAGE_TRANSLATION_MAX_BLOCKS = 12;
export const URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS = 6_000;
export const URL_PAGE_TRANSLATION_MAX_BATCH_CHARS = 12_000;
export const URL_PAGE_TRANSLATION_MAX_OUTPUT_CHARS = 64_000;
export const URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS = 12_000;

export type UrlPageTranslationCommand =
  | typeof URL_PAGE_TRANSLATE_COMMAND
  | typeof URL_PAGE_TRANSLATION_CANCEL_COMMAND;

export interface UrlPageTranslationBlock {
  id: string;
  text: string;
}

export interface UrlPageTranslationRequest {
  sessionId: string;
  requestId: string;
  targetLocale: Locale;
  blocks: UrlPageTranslationBlock[];
}

export interface UrlPageTranslationCancelRequest {
  sessionId: string;
}

export interface UrlPageTranslationItem {
  id: string;
  translation: string;
}

export type UrlPageTranslationFailureCode =
  | 'cancelled'
  | 'invalid-response'
  | 'not-configured'
  | 'provider-error';

export type UrlPageTranslationResponse =
  | {
      ok: true;
      requestId: string;
      translations: UrlPageTranslationItem[];
    }
  | {
      ok: false;
      requestId: string;
      error: UrlPageTranslationFailureCode;
    };

export interface UrlPageTranslationCancelResponse {
  cancelled: boolean;
}

export function isUrlPageTranslationCommand(command: string): command is UrlPageTranslationCommand {
  return command === URL_PAGE_TRANSLATE_COMMAND || command === URL_PAGE_TRANSLATION_CANCEL_COMMAND;
}
