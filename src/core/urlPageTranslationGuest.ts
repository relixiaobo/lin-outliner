import type { TranslationLanguage } from './translationLanguage';
import type { UrlPageTranslationItem } from './urlPageTranslation';

export const LIN_URL_PAGE_TRANSLATION_GUEST_CHANNEL = 'lin:url-page-translation-guest';
export const URL_PAGE_TRANSLATION_RUNTIME_KEY = '__tenonBilingualTranslationV1__';

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
  maxBlocks?: number;
  maxChars?: number;
  retryOnly?: boolean;
  visibleOnly?: boolean;
}

export type UrlPageTranslationGuestCommand =
  | { operation: 'document-language' }
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
