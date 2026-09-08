import type { TSchema } from 'typebox';
import {
  APPLICATION_DESTINATIONS,
  APPLICATION_INSPECT_SCHEMA,
  APPLICATION_MANAGE_SCHEMA,
  DIAGNOSTICS_INSPECT_SCHEMA,
  DIAGNOSTICS_MANAGE_SCHEMA,
  type ApplicationDestination,
  type ApplicationInfoResult,
  type ApplicationInspectResult,
  type ApplicationManageRequest,
  type ApplicationManageResult,
  type ApplicationOperation,
  type ApplicationOperationCaller,
  type DiagnosticsManageResult,
  type DiagnosticsStatusResult,
} from '../../core/applicationOperations';
export type { ApplicationOperation, ApplicationOperationCaller } from '../../core/applicationOperations';
import type { AppInfo, DiagnosticsActionResult } from '../../core/errorObservability';
import type { AppUpdateService } from '../appUpdateService';
import type { DiagnosticLogStore } from '../diagnosticLog';
import { AgentToolFailure } from '../agent/AgentToolFailure';
import { compileToolParameters } from '../agent/runtime/kernel/exactToolArguments';

export interface ApplicationOperationsOptions {
  readonly updates: Pick<AppUpdateService, 'view' | 'checkExplicitly' | 'openAvailableUpdate'>;
  readonly appInfo: () => Promise<AppInfo>;
  readonly diagnostics: Pick<DiagnosticLogStore, 'readRecords'>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly revealDiagnostics: () => Promise<DiagnosticsActionResult>;
  readonly exportDiagnostics: (caller: ApplicationOperationCaller) => Promise<DiagnosticsActionResult>;
}

export function createApplicationOperations(options: ApplicationOperationsOptions): ApplicationOperation {
  async function authorize(caller: ApplicationOperationCaller, name: string, value: unknown): Promise<void> {
    caller.signal?.throwIfAborted();
    await caller.authorize(name, value, caller.signal);
  }

  async function inspect(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationInspectResult> {
    if (!compileToolParameters(APPLICATION_INSPECT_SCHEMA as TSchema).Check(value)) throw failure('invalid_request', 'The application inspection does not match its schema.');
    await authorize(caller, 'application_inspect', value);
    const operation = (value as { request: { operation: 'info' | 'updates' | 'destinations' } }).request.operation;
    if (operation === 'info') return { operation, app: await options.appInfo() } satisfies ApplicationInfoResult;
    if (operation === 'updates') return { operation, updates: await options.updates.view() };
    return { operation, destinations: APPLICATION_DESTINATIONS };
  }

  async function manage(value: unknown, caller: ApplicationOperationCaller): Promise<ApplicationManageResult> {
    if (!compileToolParameters(APPLICATION_MANAGE_SCHEMA as TSchema).Check(value)) throw failure('invalid_request', 'The application operation does not match its schema.');
    await authorize(caller, 'application_manage', value);
    const request = (value as ApplicationManageRequest).request;
    if (request.operation === 'check_updates') return { operation: request.operation, updates: await options.updates.checkExplicitly() };
    if (request.operation === 'open_update') return { operation: request.operation, result: await options.updates.openAvailableUpdate() };
    const destination = request.destination;
    if (!destination) throw failure('invalid_request', 'A fixed application destination is required.');
    if (destination === 'help' || destination === 'issues' || destination === 'license') {
      await options.openExternal(APPLICATION_DESTINATIONS[destination]);
      return { operation: request.operation, opened: destination };
    }
    const result = await options.updates.openAvailableUpdate({ destination });
    return { operation: request.operation, opened: result.ok ? destination : undefined, result };
  }

  async function diagnosticsInspect(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsStatusResult> {
    if (!compileToolParameters(DIAGNOSTICS_INSPECT_SCHEMA as TSchema).Check(value)) throw failure('invalid_request', 'The diagnostics inspection does not match its schema.');
    await authorize(caller, 'diagnostics_inspect', value);
    const records = await options.diagnostics.readRecords();
    const severityCounts = { warn: 0, error: 0, fatal: 0 };
    for (const record of records) if (record.severity in severityCounts) severityCounts[record.severity as keyof typeof severityCounts] += 1;
    return {
      operation: 'status', hasRecords: records.length > 0,
      recordCount: records.length, latestAt: records.reduce<number | null>((latest, record) => latest === null || record.lastAt > latest ? record.lastAt : latest, null),
      severityCounts,
    };
  }

  async function diagnosticsManage(value: unknown, caller: ApplicationOperationCaller): Promise<DiagnosticsManageResult> {
    if (!compileToolParameters(DIAGNOSTICS_MANAGE_SCHEMA as TSchema).Check(value)) throw failure('invalid_request', 'The diagnostics operation does not match its schema.');
    await authorize(caller, 'diagnostics_manage', value);
    const operation = (value as { request: { operation: 'reveal' | 'export' } }).request.operation;
    if (operation === 'reveal') {
      const result = await options.revealDiagnostics();
      return { operation, ...result };
    }
    const result = await options.exportDiagnostics(caller);
    return { operation, ...result };
  }

  return {
    inspect,
    manage,
    diagnosticsInspect,
    diagnosticsManage,
    openDestination: async (destination) => options.openExternal(APPLICATION_DESTINATIONS[destination]),
  };
}

function failure(code: string, message: string): AgentToolFailure {
  return new AgentToolFailure(code, message, 'Inspect the current application or diagnostics state before retrying.');
}
