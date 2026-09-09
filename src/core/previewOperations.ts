import type { ObjectJsonSchema } from './agent/tools';
import { TRANSLATION_LANGUAGES, type TranslationLanguage } from './translationLanguage';

export const PREVIEW_CONTEXT_CHANNEL = 'lin:preview-context';
export const PREVIEW_ACTION_CHANNEL = 'lin:preview-action';
export const PREVIEW_ACTION_ACK_CHANNEL = 'lin:preview-action-ack';
export const PREVIEW_OPERATIONS_CHANNEL = 'lin:preview-operations';
export const DATA_CHANGED_CHANNEL = 'lin:preview-data-changed';

export interface PreviewControls {
  language: TranslationLanguage | null;
  model: string | null;
  automatic: boolean;
  display: 'automatic' | 'translated' | 'original';
}
export interface PreviewObservation {
  paneId: string;
  revision: number;
  kind: 'page' | 'document' | 'unavailable';
  sourceId: string | null;
  controls: PreviewControls;
  effectiveLanguage: TranslationLanguage;
  status: 'off' | 'starting' | 'on' | 'idle' | 'error';
}
export interface PreviewView extends Omit<PreviewObservation, 'sourceId'> {
  previewId: string;
  cacheAvailable: boolean;
}
export type PreviewManageRequest =
  | {
      operation: 'configure';
      previewId?: string;
      expectedRevision: number;
      changes: Partial<PreviewControls>;
    }
  | { operation: 'clear_cache'; previewId?: string; expectedRevision: number };
export interface PreviewAction {
  actionId: string;
  previewId: string;
  expectedRevision: number;
  changes: Partial<PreviewControls>;
}
export interface PreviewActionAck {
  actionId: string;
  previewId: string;
  state: 'applied' | 'unavailable';
  observation: PreviewObservation;
}
export interface PreviewControlResult {
  state: 'applied' | 'unavailable' | 'unknown';
  preview: PreviewView;
}
export type DataScope = 'content' | 'translations' | 'websites';
export interface DataOperationView {
  operationId: string;
  scope: DataScope;
  state: 'confirming' | 'running' | 'cleared' | 'failed' | 'canceled';
  liveDisplays: 'retained' | 'reload_requested' | 'reload_failed';
  steps: { name: string; state: 'completed' | 'failed' }[];
}
export interface PreviewDataStatus {
  translations: {
    entries: { page: number; caption: number; document: number };
    logicalBytes: number;
    maxBytes: number;
    maxEntries: number;
  };
  websites: { available: boolean; cacheBytes: number | null; activeGuests: number };
  operations: DataOperationView[];
}
export type PreviewOperationName =
  'preview_inspect' | 'preview_manage' | 'data_inspect' | 'data_manage';
export type PreviewOperationResult =
  { previews: PreviewView[] } | PreviewControlResult | DataOperationView | PreviewDataStatus;

const id = { type: 'string', minLength: 1, maxLength: 256 };
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: values });
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): ObjectJsonSchema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const language = enumeration(TRANSLATION_LANGUAGES.map((entry) => entry.code));
const controls = {
  language: nullable(language),
  model: nullable({ type: 'string', minLength: 1, maxLength: 512 }),
  automatic: { type: 'boolean' },
  display: enumeration(['automatic', 'translated', 'original']),
};
const observation = {
  paneId: id,
  revision: count,
  kind: enumeration(['page', 'document', 'unavailable']),
  controls: object(controls),
  effectiveLanguage: language,
  status: enumeration(['off', 'starting', 'on', 'idle', 'error']),
};
export const PREVIEW_OBSERVATION_SCHEMA = object({
  ...observation,
  sourceId: nullable({ type: 'string', minLength: 1, maxLength: 2048 }),
});
export const PREVIEW_INSPECT_SCHEMA = object({ request: object({ previewId: id }, []) });
export const PREVIEW_MANAGE_SCHEMA = object({
  request: {
    anyOf: [
      object(
        {
          operation: { const: 'configure', type: 'string' },
          previewId: id,
          expectedRevision: count,
          changes: { ...object(controls, []), minProperties: 1 },
        },
        ['operation', 'expectedRevision', 'changes'],
      ),
      object(
        {
          operation: { const: 'clear_cache', type: 'string' },
          previewId: id,
          expectedRevision: count,
        },
        ['operation', 'expectedRevision'],
      ),
    ],
  },
});
export const DATA_INSPECT_SCHEMA = object({ request: object({}) });
export const DATA_MANAGE_SCHEMA = object({
  request: object({ scope: enumeration(['translations', 'websites']) }),
});
