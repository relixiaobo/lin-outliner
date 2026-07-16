import type { TranslationLanguage } from './translationLanguage';
import { parseProviderQualifiedModel } from './agentModelId';

export const URL_PAGE_TRANSLATE_COMMAND = 'url_page_translate_blocks';
export const URL_PAGE_TRANSLATION_CANCEL_COMMAND = 'url_page_translation_cancel';
export const LIN_URL_PAGE_TRANSLATION_SHORTCUT_CHANNEL = 'lin:url-page-translation-shortcut';
export const LIN_URL_PAGE_TRANSLATION_PREFERENCES_CHANGED_CHANNEL = 'lin:url-page-translation-preferences-changed';

export const URL_PAGE_TRANSLATION_MAX_ACTIVE_SESSIONS = 8;
export const URL_PAGE_TRANSLATION_MAX_BLOCKS = 4;
export const URL_PAGE_TRANSLATION_MAX_BLOCK_CHARS = 4_000;
export const URL_PAGE_TRANSLATION_MAX_BATCH_CHARS = 4_000;
export const URL_CAPTION_TRANSLATION_MAX_BLOCKS = 16;
export const URL_CAPTION_TRANSLATION_MAX_BATCH_CHARS = 4_000;
export const URL_PAGE_TRANSLATION_MAX_OUTPUT_CHARS = 64_000;
export const URL_PAGE_TRANSLATION_MAX_TRANSLATION_CHARS = 12_000;

export type UrlPageTranslationCommand =
  | typeof URL_PAGE_TRANSLATE_COMMAND
  | typeof URL_PAGE_TRANSLATION_CANCEL_COMMAND;

export interface UrlPageTranslationBlock {
  id: string;
  text: string;
}

export type UrlPageTranslationContentKind = 'caption' | 'page';

export interface UrlPageTranslationRequest {
  sessionId: string;
  requestId: string;
  targetLanguage: TranslationLanguage;
  /** Defaults to page for callers created before caption translation. */
  contentKind?: UrlPageTranslationContentKind;
  /** Provider-qualified model id. Omitted means resolve the current Agent model. */
  model?: string;
  blocks: UrlPageTranslationBlock[];
}

export interface UrlPageTranslationPreferences {
  /** Provider-qualified model id. null means dynamically follow the Agent model. */
  translationModel: string | null;
  autoTranslateUrls: boolean;
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

export function isUrlPageTranslationPreferences(value: unknown): value is UrlPageTranslationPreferences {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const model = record.translationModel;
  return (
    (model === null || isUrlPageTranslationModel(model))
    && typeof record.autoTranslateUrls === 'boolean'
  );
}

export function isUrlPageTranslationModel(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length <= 512
    && value.trim() === value
    && parseProviderQualifiedModel(value, () => false) !== null
  );
}
