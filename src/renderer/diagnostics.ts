import {
  diagnosticErrorMessage,
  diagnosticSourceLabel,
  serializeUnknownError,
  type ErrorReport,
} from '../core/errorObservability';

function reportRendererError(report: ErrorReport): void {
  window.lin?.reportRendererError?.(report);
}

export function installRendererDiagnostics(): void {
  window.addEventListener('error', (event) => {
    const source = event.filename ? diagnosticSourceLabel(event.filename) : undefined;
    reportRendererError({
      domain: 'render',
      severity: 'fatal',
      code: 'window-error',
      message: event.message || diagnosticErrorMessage(event.error, 'Renderer error'),
      context: {
        ...(source ? { source } : {}),
        ...(typeof event.lineno === 'number' ? { line: event.lineno } : {}),
        ...(typeof event.colno === 'number' ? { column: event.colno } : {}),
      },
      error: serializeUnknownError(event.error),
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportRendererError({
      domain: 'render',
      severity: 'fatal',
      code: 'window-unhandled-rejection',
      message: diagnosticErrorMessage(event.reason, 'Unhandled renderer promise rejection'),
      context: { operation: 'unhandledRejection' },
      error: serializeUnknownError(event.reason),
    });
  });
}
