import { serializeUnknownError } from '../../../core/errorObservability';

export function reportPreviewPreferenceWriteError(preference: string, error: unknown): void {
  window.lin?.reportRendererError?.({
    domain: 'persistence',
    severity: 'error',
    code: 'preview-preference-write-failed',
    message: 'Failed to persist a preview preference.',
    context: { preference },
    error: serializeUnknownError(error),
  });
}
