import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationLanguage } from '../../../core/translationLanguage';
import type { UrlPageTranslationFailureCode } from '../../../core/urlPageTranslation';
import { EpubTranslationController } from './epubTranslationController';
import type { EpubTranslationDomAdapter } from './epubTranslationDom';
import { subscribeUrlPageTranslationShortcut } from './urlPageTranslationShortcut';
import type { UrlPageTranslationStatus } from './urlPageTranslationController';

interface UseEpubTranslationOptions {
  active: boolean;
  autoTranslate: boolean;
  model: string | null;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
  shortcutActive: boolean;
  targetLanguage: TranslationLanguage;
}

export function useEpubTranslation({
  active,
  autoTranslate,
  model,
  onError,
  shortcutActive,
  targetLanguage,
}: UseEpubTranslationOptions): {
  attachSurface: (surface: EpubTranslationDomAdapter | null) => void;
  completed: boolean;
  status: UrlPageTranslationStatus;
  toggle: () => void;
} {
  const [completed, setCompleted] = useState(false);
  const [status, setStatus] = useState<UrlPageTranslationStatus>('off');
  const activeRef = useRef(active);
  const autoTranslateRef = useRef(autoTranslate);
  const controllerRef = useRef<EpubTranslationController | null>(null);
  const modelRef = useRef(model);
  const onErrorRef = useRef(onError);
  const pendingEnableRef = useRef(false);
  const shortcutActiveRef = useRef(shortcutActive);
  const surfaceRef = useRef<EpubTranslationDomAdapter | null>(null);
  const targetLanguageRef = useRef(targetLanguage);
  activeRef.current = active;
  autoTranslateRef.current = autoTranslate;
  modelRef.current = model;
  onErrorRef.current = onError;
  shortcutActiveRef.current = shortcutActive;
  targetLanguageRef.current = targetLanguage;

  const installController = useCallback((surface: EpubTranslationDomAdapter) => {
    const controller = new EpubTranslationController(surface, {
      autoTranslate: autoTranslateRef.current,
      model: modelRef.current,
      targetLanguage: targetLanguageRef.current,
      onCompletionChange: setCompleted,
      onError: (error) => onErrorRef.current(error),
      onStatusChange: (nextStatus) => {
        pendingEnableRef.current = nextStatus !== 'off';
        setStatus(nextStatus);
      },
    });
    surface.setShortcutHandler(() => {
      if (!activeRef.current || !shortcutActiveRef.current) return false;
      controller.toggle();
      return true;
    });
    controllerRef.current = controller;
    if (pendingEnableRef.current && controller.currentStatus === 'off') controller.enable();
  }, []);

  const attachSurface = useCallback((surface: EpubTranslationDomAdapter | null) => {
    if (surfaceRef.current === surface) return;
    const previousSurface = surfaceRef.current;
    controllerRef.current?.destroy();
    controllerRef.current = null;
    previousSurface?.setShortcutHandler(() => false);
    surfaceRef.current = surface;
    if (!surface || previousSurface) {
      pendingEnableRef.current = false;
      setCompleted(false);
      setStatus('off');
    }
    if (activeRef.current && surface) installController(surface);
  }, [installController]);

  useEffect(() => {
    if (active) {
      if (!controllerRef.current && surfaceRef.current) installController(surfaceRef.current);
      return;
    }
    pendingEnableRef.current = false;
    controllerRef.current?.destroy();
    controllerRef.current = null;
    setCompleted(false);
    setStatus('off');
  }, [active, installController]);

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
    surfaceRef.current?.setShortcutHandler(() => false);
  }, []);

  const toggle = useCallback(() => {
    const controller = controllerRef.current;
    if (controller) {
      controller.toggle();
      return;
    }
    if (!activeRef.current) return;
    pendingEnableRef.current = !pendingEnableRef.current;
    setStatus(pendingEnableRef.current ? 'starting' : 'off');
  }, []);

  useEffect(() => {
    if (!active) return;
    return subscribeUrlPageTranslationShortcut((webContentsId) => {
      if (
        webContentsId !== null
        || !activeRef.current
        || !shortcutActiveRef.current
      ) return false;
      const controller = controllerRef.current;
      if (!controller) return false;
      controller.toggle();
      return true;
    });
  }, [active]);

  return { attachSurface, completed, status, toggle };
}
