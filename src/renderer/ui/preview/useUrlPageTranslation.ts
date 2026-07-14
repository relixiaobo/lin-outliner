import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '../../../core/locale';
import type { UrlPageTranslationFailureCode } from '../../../core/urlPageTranslation';
import {
  UrlPageTranslationController,
  type UrlPageTranslationStatus,
} from './urlPageTranslationController';

interface UseUrlPageTranslationOptions {
  active: boolean;
  targetLocale: Locale;
  onError: (error: Exclude<UrlPageTranslationFailureCode, 'cancelled'>) => void;
}

export function useUrlPageTranslation({
  active,
  targetLocale,
  onError,
}: UseUrlPageTranslationOptions): {
  attachWebview: (webview: Electron.WebviewTag | null) => void;
  status: UrlPageTranslationStatus;
  toggle: () => void;
} {
  const [status, setStatus] = useState<UrlPageTranslationStatus>('off');
  const controllerRef = useRef<UrlPageTranslationController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const attachWebview = useCallback((webview: Electron.WebviewTag | null) => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
    setStatus('off');
    if (!active || !webview) return;
    controllerRef.current = new UrlPageTranslationController(webview, {
      targetLocale,
      onError: (error) => onErrorRef.current(error),
      onStatusChange: setStatus,
    });
  }, [active, targetLocale]);

  useEffect(() => () => {
    controllerRef.current?.destroy();
    controllerRef.current = null;
  }, []);

  const toggle = useCallback(() => {
    controllerRef.current?.toggle();
  }, []);

  return { attachWebview, status, toggle };
}
