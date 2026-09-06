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
        delegation: {
          type: 'object', additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            defaultRunnerId: { type: 'string', minLength: 1 },
            maxConcurrentGlobal: { type: 'integer', minimum: 1 },
            maxConcurrentThread: { type: 'integer', minimum: 1 },
            maxQueuedGlobal: { type: 'integer', minimum: 1 },
            maxQueuedThread: { type: 'integer', minimum: 1 },
            runners: {
              type: 'object', additionalProperties: {
                type: 'object', additionalProperties: false,
                properties: {
                  enabled: { type: 'boolean' },
                  model: { type: ['string', 'null'] },
                  effort: { enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', null] },
                  maximumAccess: { enum: ['read-only', 'workspace-write'] },
                  timeoutMs: { type: 'integer', minimum: 1 },
                  maxConcurrent: { type: 'integer', minimum: 1 },
                  pool: { type: 'string', minLength: 1 },
                  maxConcurrentPool: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
      },
    },
    updates: {
      type: 'object', additionalProperties: false,
      properties: { checkAutomatically: { type: 'boolean' } },
    },
    models: {
      type: 'object', additionalProperties: false,
      properties: {
        connections: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['providerId'],
            properties: {
              providerId: { type: 'string', minLength: 1 },
              baseUrl: { type: ['string', 'null'] },
              enabled: { type: 'boolean' },
              models: { type: 'array', items: { type: 'string', minLength: 1 } },
            },
          },
        },
        default: { type: 'string', minLength: 1 },
        imageDefault: { type: ['string', 'null'] },
      },
    },
  },
});

export function writeFilePreferencesSchema(userDataDir: string): void {
  writeJsonFileSync(join(userDataDir, FILE_PREFERENCES_SCHEMA_RELATIVE_PATH), SETTINGS_SCHEMA, {
    directoryMode: 0o700,
  });
}
