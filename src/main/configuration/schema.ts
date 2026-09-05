import { join } from 'node:path';
import { writeJsonFileSync } from '../jsonFileStore';

export const FILE_PREFERENCES_SCHEMA_RELATIVE_PATH = join('config', 'settings.schema.json');

const SETTINGS_SCHEMA = Object.freeze({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Tenon Settings',
  type: 'object',
  additionalProperties: false,
  properties: {
    appearance: {
      type: 'object', additionalProperties: false,
      properties: {
        theme: { enum: ['system', 'light', 'dark'] },
        language: { type: ['string', 'null'] },
      },
    },
    agent: {
      type: 'object', additionalProperties: false,
      properties: {
        memory: { type: 'object', additionalProperties: false, properties: { enabled: { type: 'boolean' } } },
        skills: {
          type: 'object', additionalProperties: false,
          properties: {
            disabled: { type: 'array', items: { type: 'string', minLength: 1 } },
            sources: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
        tools: {
          type: 'object', additionalProperties: false,
          properties: { disabled: { type: 'array', items: { type: 'string', minLength: 1 } } },
        },
        provider: {
          type: 'object', additionalProperties: false,
          properties: {
            timeoutMs: { type: ['integer', 'null'], minimum: 0 },
            maxRetries: { type: ['integer', 'null'], minimum: 0 },
            maxRetryDelayMs: { type: 'integer', minimum: 1 },
            cacheRetention: { enum: ['none', 'short', 'long'] },
          },
        },
      },
    },
    updates: {
      type: 'object', additionalProperties: false,
      properties: { checkAutomatically: { type: 'boolean' } },
    },
  },
});

export function writeFilePreferencesSchema(userDataDir: string): void {
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_SCHEMA_RELATIVE_PATH), SETTINGS_SCHEMA, {
    directoryMode: 0o700,
  });
}
