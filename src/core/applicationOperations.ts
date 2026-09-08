import type { ObjectJsonSchema } from './agent/tools';
import type { AppInfo, DiagnosticsActionResult } from './errorObservability';
import type { AppUpdateOpenResult, AppUpdateView } from './appUpdate';

export const LIN_APP_OPEN_DESTINATION_CHANNEL = 'lin:application/open-destination';
export const LIN_APP_RELEASE_CHANNEL = 'lin:application/release';

export const APPLICATION_DESTINATIONS = {
  help: 'https://github.com/relixiaobo/lin-outliner',
  issues: 'https://github.com/relixiaobo/lin-outliner/issues',
  license: 'https://github.com/relixiaobo/lin-outliner/blob/main/LICENSE',
} as const;

export const APPLICATION_RELEASE_NOTE_MAX_LENGTH = 50_000;

export type ApplicationDestination = keyof typeof APPLICATION_DESTINATIONS | 'release' | 'download';

export type ApplicationInspectRequest = {
  readonly request: { readonly operation: 'info' | 'release' | 'updates' | 'destinations' };
};

export type ApplicationManageRequest = {
  readonly request:
    | { readonly operation: 'check_updates' }
    | { readonly operation: 'open_update' }
    | { readonly operation: 'open_destination'; readonly destination: ApplicationDestination };
};

export type DiagnosticsInspectRequest = { readonly request: { readonly operation: 'status' } };
export type DiagnosticsManageRequest = {
  readonly request: { readonly operation: 'reveal' | 'export' };
};

export interface ApplicationInfoResult {
  readonly operation: 'info';
  readonly app: AppInfo;
}

export interface BundledApplicationRelease {
  readonly version: string;
  readonly date: string | null;
  readonly note: string;
  readonly noteTruncated: boolean;
  readonly changelogUrl: string;
}

export interface ApplicationReleaseResult {
  readonly operation: 'release';
  readonly release: BundledApplicationRelease | null;
}

export interface ApplicationUpdatesResult {
  readonly operation: 'updates';
  readonly updates: AppUpdateView;
}

export interface ApplicationDestinationsResult {
  readonly operation: 'destinations';
  readonly destinations: Readonly<Record<keyof typeof APPLICATION_DESTINATIONS, string>>;
}

export type ApplicationInspectResult =
  | ApplicationInfoResult
  | ApplicationReleaseResult
  | ApplicationUpdatesResult
  | ApplicationDestinationsResult;

export type ApplicationManageResult =
  | { readonly operation: 'check_updates'; readonly updates: AppUpdateView }
  | { readonly operation: 'open_update'; readonly result: AppUpdateOpenResult }
  | {
      readonly operation: 'open_destination';
      readonly destination: keyof typeof APPLICATION_DESTINATIONS;
      readonly opened: true;
    }
  | {
      readonly operation: 'open_destination';
      readonly destination: 'release' | 'download';
      readonly result: AppUpdateOpenResult;
    };

export interface DiagnosticsStatusResult {
  readonly operation: 'status';
  readonly hasRecords: boolean;
  readonly recordCount: number;
  readonly latestAt: number | null;
  readonly severityCounts: Readonly<Record<'warn' | 'error' | 'fatal', number>>;
}

export type DiagnosticsManageResult =
  | { readonly operation: 'reveal' | 'export'; readonly ok: true; readonly path: string }
  | { readonly operation: 'export'; readonly ok: false; readonly canceled: true }
  | { readonly operation: 'reveal' | 'export'; readonly ok: false; readonly error: string };

const boundedString = (maxLength: number, minLength = 0) => ({
  type: 'string',
  minLength,
  maxLength,
});
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: values });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): ObjectJsonSchema => ({ type: 'object', properties, required, additionalProperties: false });
const operation = (name: string) => ({ type: 'string', const: name });
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const timestamp = nullable(count);

const appInfoSchema = object({
  name: boundedString(256, 1),
  version: boundedString(128, 1),
  platform: boundedString(128, 1),
  arch: boundedString(128, 1),
  electron: boundedString(128, 1),
  chrome: boundedString(128, 1),
  node: boundedString(128, 1),
});
const bundledReleaseSchema = object({
  version: boundedString(128, 1),
  date: nullable(boundedString(128, 1)),
  note: boundedString(APPLICATION_RELEASE_NOTE_MAX_LENGTH),
  noteTruncated: { type: 'boolean' },
  changelogUrl: boundedString(2_048, 1),
});
const updateReleaseSchema = object({
  version: boundedString(128, 1),
  publishedAt: boundedString(128, 1),
  note: nullable(boundedString(APPLICATION_RELEASE_NOTE_MAX_LENGTH)),
  downloadAvailable: { type: 'boolean' },
});
const updateViewSchema = object({
  currentVersion: boundedString(128, 1),
  automaticChecksEnabled: { type: 'boolean' },
  phase: enumeration(['idle', 'checking']),
  lastSuccessfulCheckAt: timestamp,
  availableRelease: nullable(updateReleaseSchema),
  manualError: nullable(enumeration(['network', 'timeout', 'invalid-response'])),
});
const updateOpenResultSchema = {
  anyOf: [
    object({ ok: { const: true, type: 'boolean' }, destination: enumeration(['download', 'release']) }),
    object({ ok: { const: false, type: 'boolean' }, error: enumeration(['unavailable', 'open-failed']) }),
  ],
};

export const APPLICATION_INSPECT_SCHEMA = object({
  request: object({
    operation: enumeration(['info', 'release', 'updates', 'destinations']),
  }),
});

export const APPLICATION_MANAGE_SCHEMA = object({
  request: {
    anyOf: [
      object({ operation: operation('check_updates') }),
      object({ operation: operation('open_update') }),
      object({
        operation: operation('open_destination'),
        destination: enumeration(['help', 'issues', 'license', 'release', 'download']),
      }),
    ],
  },
});

export const DIAGNOSTICS_INSPECT_SCHEMA = object({
  request: object({ operation: operation('status') }),
});

export const DIAGNOSTICS_MANAGE_SCHEMA = object({
  request: object({ operation: enumeration(['reveal', 'export']) }),
});

export const APPLICATION_INSPECT_OUTPUT_SCHEMA = object({
  result: {
    anyOf: [
      object({ operation: operation('info'), app: appInfoSchema }),
      object({ operation: operation('release'), release: nullable(bundledReleaseSchema) }),
      object({ operation: operation('updates'), updates: updateViewSchema }),
      object({
        operation: operation('destinations'),
        destinations: object({
          help: boundedString(2_048, 1),
          issues: boundedString(2_048, 1),
          license: boundedString(2_048, 1),
        }),
      }),
    ],
  },
});

export const APPLICATION_MANAGE_OUTPUT_SCHEMA = object({
  result: {
    anyOf: [
      object({ operation: operation('check_updates'), updates: updateViewSchema }),
      object({ operation: operation('open_update'), result: updateOpenResultSchema }),
      object({
        operation: operation('open_destination'),
        destination: enumeration(['help', 'issues', 'license']),
        opened: { const: true, type: 'boolean' },
      }),
      object({
        operation: operation('open_destination'),
        destination: enumeration(['release', 'download']),
        result: updateOpenResultSchema,
      }),
    ],
  },
});

export const DIAGNOSTICS_INSPECT_OUTPUT_SCHEMA = object({
  result: object({
    operation: operation('status'),
    hasRecords: { type: 'boolean' },
    recordCount: count,
    latestAt: timestamp,
    severityCounts: object({ warn: count, error: count, fatal: count }),
  }),
});

export const DIAGNOSTICS_MANAGE_OUTPUT_SCHEMA = object({
  result: {
    anyOf: [
      object({
        operation: enumeration(['reveal', 'export']),
        ok: { const: true, type: 'boolean' },
        path: boundedString(4_096, 1),
      }),
      object({
        operation: operation('export'),
        ok: { const: false, type: 'boolean' },
        canceled: { const: true, type: 'boolean' },
      }),
      object({
        operation: enumeration(['reveal', 'export']),
        ok: { const: false, type: 'boolean' },
        error: boundedString(2_048, 1),
      }),
    ],
  },
});

export type ApplicationOperation = {
  inspect(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationInspectResult>;
  manage(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationManageResult>;
  diagnosticsInspect(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsStatusResult>;
  diagnosticsManage(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsManageResult>;
  openDestination(destination: Exclude<ApplicationDestination, 'release' | 'download'>): Promise<void>;
};

export interface ApplicationOperationCaller {
  readonly origin: { readonly kind: 'window'; readonly windowId: number } | {
    readonly kind: 'agent'; readonly threadId: string; readonly turnId: string; readonly itemId: string;
  };
  readonly authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

export function normalizeDiagnosticsManageResult(
  operationName: 'reveal' | 'export',
  result: DiagnosticsActionResult,
): DiagnosticsManageResult {
  if (result.ok && typeof result.path === 'string' && result.path.length > 0) {
    return { operation: operationName, ok: true, path: result.path };
  }
  if (operationName === 'export' && result.canceled) {
    return { operation: operationName, ok: false, canceled: true };
  }
  return {
    operation: operationName,
    ok: false,
    error: typeof result.error === 'string' && result.error.length > 0
      ? result.error.slice(0, 2_048)
      : `The diagnostics ${operationName} operation failed.`,
  };
}
