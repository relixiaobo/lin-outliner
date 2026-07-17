import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions } from 'electron';
import type { ClearPreviewTranslationCacheResult } from '../core/urlPageTranslation';

export interface PreviewTranslationCacheClearLabels {
  translationDataClearConfirmAction: string;
  translationDataClearConfirmDetail: string;
  translationDataClearConfirmMessage: string;
  translationDataClearConfirmTitle: string;
  translationDataCancelAction: string;
}

interface PreviewTranslationCacheClearDependencies {
  cache: { clear: () => Promise<void> };
  getSettingsWindow: () => BrowserWindow | null;
  labels: () => PreviewTranslationCacheClearLabels;
  showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<{ response: number }>;
}

export async function clearPreviewTranslationCacheFromSettings(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  dependencies: PreviewTranslationCacheClearDependencies,
): Promise<ClearPreviewTranslationCacheResult> {
  const window = dependencies.getSettingsWindow();
  if (!window || event.sender !== window.webContents) {
    return { status: 'failed', error: 'unavailable' };
  }

  const labels = dependencies.labels();
  const confirmation = await dependencies.showMessageBox(window, {
    type: 'warning',
    title: labels.translationDataClearConfirmTitle,
    message: labels.translationDataClearConfirmMessage,
    detail: labels.translationDataClearConfirmDetail,
    buttons: [
      labels.translationDataClearConfirmAction,
      labels.translationDataCancelAction,
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return { status: 'canceled' };

  try {
    await dependencies.cache.clear();
    return { status: 'cleared' };
  } catch {
    return { status: 'failed', error: 'clear-failed' };
  }
}
