import type { AppInfo, DiagnosticsActionResult } from './errorObservability';
import type { AppUpdateOpenResult, AppUpdateView } from './appUpdate';

export const LIN_APP_OPEN_DESTINATION_CHANNEL = 'lin:application/open-destination';

export const APPLICATION_DESTINATIONS = {
  help: 'https://github.com/relixiaobo/lin-outliner',
  issues: 'https://github.com/relixiaobo/lin-outliner/issues',
  license: 'https://github.com/relixiaobo/lin-outliner/blob/main/LICENSE',
} as const;

export type ApplicationDestination = keyof typeof APPLICATION_DESTINATIONS | 'release' | 'download';

export type ApplicationInspectRequest = {
  readonly request: { readonly operation: 'info' | 'updates' | 'destinations' };
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

export interface ApplicationUpdatesResult {
  readonly operation: 'updates';
  readonly updates: AppUpdateView;
}

export interface ApplicationDestinationsResult {
  readonly operation: 'destinations';
  readonly destinations: Readonly<Record<keyof typeof APPLICATION_DESTINATIONS, string>>;
}

export type ApplicationInspectResult = ApplicationInfoResult | ApplicationUpdatesResult | ApplicationDestinationsResult;

export interface ApplicationManageResult {
  readonly operation: ApplicationManageRequest['request']['operation'];
  readonly updates?: AppUpdateView;
  readonly opened?: 'help' | 'issues' | 'license' | 'release' | 'download';
  readonly result?: AppUpdateOpenResult;
}

export interface DiagnosticsStatusResult {
  readonly operation: 'status';
  readonly hasRecords: boolean;
  readonly recordCount: number;
  readonly latestAt: number | null;
  readonly severityCounts: Readonly<Record<'warn' | 'error' | 'fatal', number>>;
}

export interface DiagnosticsManageResult extends DiagnosticsActionResult {
  readonly operation: 'reveal' | 'export';
  readonly recordCount?: number;
}

export const APPLICATION_INSPECT_SCHEMA = {
  type: 'object', properties: {
    request: { type: 'object', properties: {
      operation: { type: 'string', enum: ['info', 'updates', 'destinations'] },
    }, required: ['operation'], additionalProperties: false },
  }, required: ['request'], additionalProperties: false,
} as const;

export const APPLICATION_MANAGE_SCHEMA = {
  type: 'object', properties: {
    request: { type: 'object', properties: {
      operation: { type: 'string', enum: ['check_updates', 'open_update', 'open_destination'] },
      destination: { type: 'string', enum: ['help', 'issues', 'license', 'release', 'download'] },
    }, required: ['operation'], additionalProperties: false },
  }, required: ['request'], additionalProperties: false,
} as const;

export const DIAGNOSTICS_INSPECT_SCHEMA = {
  type: 'object', properties: {
    request: { type: 'object', properties: { operation: { type: 'string', enum: ['status'] } }, required: ['operation'], additionalProperties: false },
  }, required: ['request'], additionalProperties: false,
} as const;

export const DIAGNOSTICS_MANAGE_SCHEMA = {
  type: 'object', properties: {
    request: { type: 'object', properties: { operation: { type: 'string', enum: ['reveal', 'export'] } }, required: ['operation'], additionalProperties: false },
  }, required: ['request'], additionalProperties: false,
} as const;

export type ApplicationOperation = {
  inspect(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationInspectResult>;
  manage(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationManageResult>;
  diagnosticsInspect(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsStatusResult>;
  diagnosticsManage(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsManageResult>;
  openDestination(destination: Exclude<ApplicationDestination, 'release' | 'download'>): Promise<void>;
};

export interface ApplicationOperationCaller {
  readonly origin: { readonly kind: 'window'; readonly windowId: number } | { readonly kind: 'agent'; readonly threadId: string; readonly turnId: string; readonly itemId: string };
  readonly authorize: (name: string, input: unknown, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}
