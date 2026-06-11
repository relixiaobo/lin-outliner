export const LIN_REPORT_RENDERER_ERROR_CHANNEL = 'lin:report-renderer-error';
export const LIN_REVEAL_DIAGNOSTICS_LOG_CHANNEL = 'lin:reveal-diagnostics-log';
export const LIN_EXPORT_DIAGNOSTICS_CHANNEL = 'lin:export-diagnostics';

export type ErrorSeverity = 'warn' | 'error' | 'fatal';

export type ErrorDomain =
  | 'agent-tool'
  | 'command'
  | 'dream'
  | 'persistence'
  | 'provider'
  | 'render'
  | 'uncaught'
  | string;

export type ErrorReportContextValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type ErrorReportContext = Record<string, ErrorReportContextValue>;

export interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
}

export interface ErrorReport {
  domain: ErrorDomain;
  severity: ErrorSeverity;
  code?: string;
  message: string;
  context?: ErrorReportContext;
  error?: SerializedError | Error | unknown;
}

export interface DiagnosticLogRecord {
  v: 1;
  seq: number;
  eventId: string;
  ts: number;
  firstAt: number;
  lastAt: number;
  count: number;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  code?: string;
  fingerprint: string;
  message: string;
  context?: ErrorReportContext;
}

export interface DiagnosticEnvironment {
  appVersion: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  providerId: string | null;
}

export interface DiagnosticExportArtifact {
  v: 1;
  exportedAt: number;
  environment: DiagnosticEnvironment;
  records: DiagnosticLogRecord[];
}

export interface DiagnosticsActionResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}
