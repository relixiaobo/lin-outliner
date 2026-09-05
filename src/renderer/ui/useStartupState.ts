import { useCallback, useEffect, useState } from 'react';
import type { StartupState } from '../../core/startup';

export function useStartupState() {
  const [state, setState] = useState<StartupState>(() => (
    window.lin?.startup ? { status: 'starting' } : { status: 'ready' }
  ));
  const [projectionAttempt, setProjectionAttempt] = useState(0);
  const [projectionFailure, setProjectionFailure] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const startup = window.lin?.startup;
    if (!startup) return;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = startup.onChanged((next) => {
      receivedEvent = true;
      if (active) setState(next);
    });
    void startup.get().then((next) => {
      if (active && !receivedEvent) setState(next);
    }).catch((error: unknown) => {
      if (active && !receivedEvent) setState({
        status: 'failed', step: 'startup', message: String(error),
      });
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const retry = useCallback(async () => {
    setRetrying(true);
    setProjectionFailure(null);
    try {
      const next = await window.lin?.startup?.retry();
      if (next) setState(next);
      setProjectionAttempt((attempt) => attempt + 1);
    } catch (error) {
      setState({ status: 'failed', step: 'startup', message: String(error) });
    } finally {
      setRetrying(false);
    }
  }, []);

  const quit = useCallback(() => {
    void window.lin?.startup?.quit().catch((error: unknown) => {
      setState({ status: 'failed', step: 'startup', message: String(error) });
    });
  }, []);

  return {
    state,
    failure: state.status === 'failed' ? state : projectionFailure
      ? { status: 'failed' as const, step: 'outline-documents', message: projectionFailure }
      : null,
    projectionAttempt,
    setProjectionFailure,
    retrying,
    retry,
    quit,
  };
}
