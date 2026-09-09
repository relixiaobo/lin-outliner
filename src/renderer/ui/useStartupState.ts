import { useCallback, useEffect, useRef, useState } from 'react';
import { initialStartupState, type StartupState } from '../../core/startup';

export function useStartupState() {
  const [state, setState] = useState<StartupState>(() => initialStartupState(!window.lin?.startup));
  const latest = useRef(state);
  const mounted = useRef(true);
  const retryPending = useRef(false);
  const [projectionAttempt, setProjectionAttempt] = useState(0);
  const [projectionFailure, setProjectionFailure] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const accept = useCallback((next: StartupState) => {
    if (!mounted.current || next.revision < latest.current.revision) return;
    latest.current = next;
    setState(next);
    setActionError(null);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const startup = window.lin?.startup;
    if (!startup) return;
    let receivedEvent = false;
    const unsubscribe = startup.onChanged((next) => {
      receivedEvent = true;
      accept(next);
    });
    void startup.get().then(accept).catch((error: unknown) => {
      if (mounted.current && !receivedEvent) setActionError(String(error));
    });
    return () => { mounted.current = false; unsubscribe(); };
  }, [accept]);

  const retry = useCallback(async () => {
    if (retryPending.current) return;
    retryPending.current = true;
    setRetrying(true);
    setActionError(null);
    const revision = latest.current.revision;
    const renewProjection = projectionFailure !== null || latest.current.capabilities.outline !== 'ready';
    try {
      const next = await window.lin?.startup?.retry();
      if (next) accept(next);
      if (mounted.current && renewProjection && latest.current.capabilities.outline === 'ready') {
        setProjectionFailure(null);
        setProjectionAttempt((attempt) => attempt + 1);
      }
    } catch (error) {
      if (mounted.current && latest.current.revision === revision) setActionError(String(error));
    } finally {
      retryPending.current = false;
      if (mounted.current) setRetrying(false);
    }
  }, [accept, projectionFailure]);

  const quit = useCallback(() => {
    const revision = latest.current.revision;
    void window.lin?.startup?.quit().catch((error: unknown) => {
      if (mounted.current && latest.current.revision === revision) setActionError(String(error));
    });
  }, []);

  const issue = state.issues[0];
  const failure = projectionFailure ? { step: 'outline-documents', message: projectionFailure }
    : issue ? { step: issue.operation, message: issue.message }
      : state.status === 'failed' ? state
        : actionError ? { step: 'startup', message: actionError } : null;
  return {
    state, issue, failure, actionError,
    workspaceFailure: projectionFailure !== null || state.capabilities.outline === 'unavailable',
    agentReady: state.capabilities.agent === 'ready',
    projectionAttempt, setProjectionFailure, retrying, retry, quit,
  };
}
