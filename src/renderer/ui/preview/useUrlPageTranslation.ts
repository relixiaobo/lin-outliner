import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationLanguage } from '../../../core/translationLanguage';
import type { UrlPageTranslationFailureCode } from '../../../core/urlPageTranslation';
import {
  UrlPageTranslationController,
  type UrlPageTranslationStatus,
} from './urlPageTranslationController';
import type { UrlPageTranslationGuestLabels } from './urlPageTranslationGuest';
import { subscribeUrlPageTranslationShortcut } from './urlPageTranslationShortcut';

interface UseUrlPageTranslationOptions {
  active: boolean;
  autoTranslate: boolean;
  labels: UrlPageTranslationGuestLabels;
  model: string | null;
  shortcutActive: boolean;
  targetLanguage: TranslationLanguage;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
}

export function useUrlPageTranslation({
  active,
  autoTranslate,
  labels,
  model,
  shortcutActive,
  targetLanguage,
  onError,
}: UseUrlPageTranslationOptions): {
  attachWebview: (webview: Electron.WebviewTag | null) => void;
  completed: boolean;
  status: UrlPageTranslationStatus;
  toggle: () => void;
} {
  const [completed, setCompleted] = useState(false);
  const [status, setStatus] = useState<UrlPageTranslationStatus>('off');
  const controllerRef = useRef<UrlPageTranslationController | null>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const activeRef = useRef(active);
  const autoTranslateRef = useRef(autoTranslate);
  const modelRef = useRef(model);
  const shortcutActiveRef = useRef(shortcutActive);
  const targetLanguageRef = useRef(targetLanguage);
  const onErrorRef = useRef(onError);
  activeRef.current = active;
  autoTranslateRef.current = autoTranslate;
  modelRef.current = model;
  shortcutActiveRef.current = shortcutActive;
  targetLanguageRef.current = targetLanguage;
  onErrorRef.current = onError;

  const attachWebview = useCallback((webview: Electron.WebviewTag | null) => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
    webviewRef.current = webview;
    setCompleted(false);
    setStatus('off');
    if (!active || !webview) return;
    controllerRef.current = new UrlPageTranslationController(webview, {
      autoTranslate: autoTranslateRef.current,
      model: modelRef.current,
      targetLanguage: targetLanguageRef.current,
      labels,
      onCompletionChange: setCompleted,
      onError: (error) => onErrorRef.current(error),
      onStatusChange: setStatus,
    });
  }, [active, labels.retry, labels.translating]);

  useEffect(() => {
    controllerRef.current?.setTargetLanguage(targetLanguage);
  }, [targetLanguage]);

  useEffect(() => {
    controllerRef.current?.setTranslationModel(model);
  }, [model]);

  useEffect(() => {
    controllerRef.current?.setAutoTranslate(autoTranslate);
  }, [autoTranslate]);

  useEffect(() => () => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    controllerRef.current?.toggle();
  }, []);

  useEffect(() => {
    if (!active) return;
    return subscribeUrlPageTranslationShortcut((webContentsId) => {
      if (!activeRef.current || !shortcutActiveRef.current || !controllerRef.current) return false;
      if (webContentsId !== null) {
        const webview = webviewRef.current;
        if (!webview) return false;
        try {
          if (webview.getWebContentsId() !== webContentsId) return false;
        } catch {
          return false;
        }
      }
      controllerRef.current.toggle();
      return true;
    });
  }, [active]);

  return { attachWebview, completed, status, toggle };
}
