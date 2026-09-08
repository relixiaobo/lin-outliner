import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationLanguage } from '../../../core/translationLanguage';
import type { UrlPageTranslationFailureCode } from '../../../core/urlPageTranslation';
import type { PreviewControls } from '../../../core/previewOperations';
import {
  UrlPageTranslationController,
  type UrlPageTranslationStatus,
} from './urlPageTranslationController';
import type { UrlPageTranslationGuestLabels } from './urlPageTranslationGuest';
import { subscribeUrlPageTranslationShortcut } from './urlPageTranslationShortcut';

interface UseUrlPageTranslationOptions {
  display?: PreviewControls['display'];
  onDisplayToggle?: () => void;
  onSourceChange?: (sourceId: string | undefined) => void;
  active: boolean;
  autoTranslate: boolean;
  labels: UrlPageTranslationGuestLabels;
  model: string | null;
  shortcutActive: boolean;
  targetLanguage: TranslationLanguage;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
}

export function useUrlPageTranslation({
  display = 'automatic', onDisplayToggle, onSourceChange,
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
  applyControls: (controls: PreviewControls, language: TranslationLanguage) => UrlPageTranslationStatus | null;
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
  const displayRef = useRef(display);
  const onDisplayToggleRef = useRef(onDisplayToggle);
  const onSourceChangeRef = useRef(onSourceChange);
  displayRef.current = display;
  onDisplayToggleRef.current = onDisplayToggle;
  onSourceChangeRef.current = onSourceChange;
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
      autoTranslate: autoTranslateRef.current && displayRef.current === 'automatic',
      onSourceChange: (sourceId) => onSourceChangeRef.current?.(sourceId),
      model: modelRef.current,
      targetLanguage: targetLanguageRef.current,
      labels,
      onCompletionChange: setCompleted,
      onError: (error) => onErrorRef.current(error),
      onStatusChange: setStatus,
    });
    controllerRef.current.setDisplayIntent(displayRef.current);
  }, [active, labels.retry, labels.translating]);

  useEffect(() => {
    controllerRef.current?.setTargetLanguage(targetLanguage);
  }, [targetLanguage]);

  useEffect(() => {
    controllerRef.current?.setTranslationModel(model);
  }, [model]);

  useEffect(() => {
    controllerRef.current?.setAutoTranslate(autoTranslate && display === 'automatic');
    controllerRef.current?.setDisplayIntent(display);
  }, [autoTranslate, display]);

  useEffect(() => () => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (onDisplayToggleRef.current) onDisplayToggleRef.current();
    else controller.toggle();
  }, []);

  const applyControls = useCallback((controls: PreviewControls, language: TranslationLanguage): UrlPageTranslationStatus | null => {
    const controller = controllerRef.current;
    if (!controller) return null;
    controller.setAutoTranslate(controls.automatic && controls.display === 'automatic');
    controller.setTargetLanguage(language);
    controller.setTranslationModel(controls.model);
    controller.setDisplayIntent(controls.display);
    return controller.currentStatus;
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
      toggle();
      return true;
    });
  }, [active, toggle]);

  return { attachWebview, completed, status, toggle, applyControls };
}
