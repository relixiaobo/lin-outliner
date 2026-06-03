import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { CheckIcon, ICON_SIZE, LoaderIcon, OpenIcon } from '../icons';
import { ButtonControl } from '../primitives/ButtonControl';
import { TextInputControl } from '../primitives/TextInputControl';
import {
  formatCountdown,
  formatRelativeExpiry,
  INITIAL_OAUTH_FLOW,
  oauthFlowReducer,
  type OAuthReplyEvent,
} from './oauthLoginFlow';

// The OAuth sign-in surface, rendered in place of the API-key form for providers
// whose `authKind` is `oauth` (Anthropic / GitHub Copilot / OpenAI Codex). It owns
// only presentation + the interactive reply steps; main runs the real sign-in and
// holds every secret. Layout/classNames mirror ProviderConfigForm so the two read
// as one dialog family. Selection/focus stay neutral (B3/B4); the primary button is
// neutral-strong, never a system accent.

interface ProviderOAuthFormProps {
  providerId: string;
  providerName: string;
  description: string;
  avatar: ReactNode;
  titleId: string;
  isActive: boolean;
  connected: boolean;
  /** Absolute ms expiry of the stored credential, when connected. */
  expiresAt?: number;
  signInHint?: string;
  docsUrl?: string;
  docsLabel?: string;
  /** When set, offer "Use an API key instead" (Anthropic accepts a console key too). */
  onUseApiKey?: () => void;
  onSetActive?: () => void;
  onOpenExternal: (url: string) => void;
  /** Settings after a successful sign-in / sign-out — the window re-renders from these. */
  onSettingsChanged: (settings: AgentProviderSettingsView) => void;
  onClose: () => void;
}

// Drive a single sign-in from the renderer: subscribe to the main→renderer event
// stream (filtered to this provider), reduce it into render state, and answer the
// reply-needed steps. The login promise resolves with fresh settings on success.
function useOAuthLogin(
  providerId: string,
  onSettingsChanged: (settings: AgentProviderSettingsView) => void,
) {
  const [flow, dispatch] = useReducer(oauthFlowReducer, INITIAL_OAUTH_FLOW);
  const [busy, setBusy] = useState(false);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);

  const signIn = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;
    setBusy(true);
    dispatch({ type: 'start' });
    const unsubscribe = window.lin?.onAgentOAuthEvent((envelope) => {
      if (envelope.providerId === providerId) dispatch({ type: 'event', event: envelope.event });
    });
    api.agentOAuthLogin(providerId)
      .then((settings) => { dispatch({ type: 'done' }); onSettingsChanged(settings); })
      .catch((caught) => {
        // A user-initiated cancel rejects the login too — fold it back to idle, not an error.
        if (cancelledRef.current) dispatch({ type: 'reset' });
        else dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) });
      })
      .finally(() => { runningRef.current = false; setBusy(false); unsubscribe?.(); });
  }, [providerId, onSettingsChanged]);

  const respond = useCallback((requestId: string, value: string | undefined) => {
    dispatch({ type: 'responded' });
    void api.agentOAuthRespond(requestId, value);
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    void api.agentOAuthCancel(providerId);
  }, [providerId]);

  const signOut = useCallback(() => {
    setBusy(true);
    api.agentOAuthLogout(providerId)
      .then(onSettingsChanged)
      .catch((caught) => dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) }))
      .finally(() => setBusy(false));
  }, [providerId, onSettingsChanged]);

  return { flow, busy, signIn, respond, cancel, signOut };
}

// A live "expires in M:SS" countdown for the device-code TTL. Returns null once
// it lapses (the user has presumably finished, or it is genuinely stale).
function useCountdown(expiresInSeconds: number | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(expiresInSeconds ?? null);
  const startedRef = useRef<number>(0);
  useEffect(() => {
    if (expiresInSeconds === undefined) { setRemaining(null); return; }
    startedRef.current = performance.now();
    setRemaining(expiresInSeconds);
    const tick = window.setInterval(() => {
      const elapsed = (performance.now() - startedRef.current) / 1000;
      const left = expiresInSeconds - elapsed;
      setRemaining(left > 0 ? left : 0);
      if (left <= 0) window.clearInterval(tick);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [expiresInSeconds]);
  return remaining;
}

function ReplyStep({ pending, onRespond }: {
  pending: OAuthReplyEvent;
  onRespond: (value: string | undefined) => void;
}) {
  const [value, setValue] = useState('');
  const fieldId = useId();
  // Reset the field whenever a new reply step arrives.
  useEffect(() => { setValue(''); }, [pending.requestId]);

  // A reply step is answerable while the login is in flight — answering it IS the
  // next step — so it is never gated on the form's `busy` flag. Responding clears
  // `pending`, which unmounts this step, so there is no double-submit to guard.
  if (pending.kind === 'select') {
    return (
      <div className="settings-sheet-oauth-step" role="group">
        <p className="settings-sheet-oauth-step-label">{pending.message}</p>
        <div className="settings-sheet-oauth-options">
          {pending.options.map((option) => (
            <ButtonControl
              className="settings-sheet-secondary"
              key={option.id}
              onClick={() => onRespond(option.id)}
            >
              {option.label}
            </ButtonControl>
          ))}
        </div>
      </div>
    );
  }

  const label = pending.kind === 'prompt' ? pending.message : 'Paste the code from your browser';
  const placeholder = pending.kind === 'prompt' ? pending.placeholder : 'Authorization code';
  return (
    <form
      className="settings-sheet-oauth-step"
      onSubmit={(event) => { event.preventDefault(); if (value.trim()) onRespond(value.trim()); }}
    >
      <label className="settings-sheet-oauth-step-label" htmlFor={fieldId}>{label}</label>
      <div className="settings-sheet-oauth-reply">
        <TextInputControl
          autoFocus
          className="settings-sheet-row-input"
          id={fieldId}
          label={label}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
        <ButtonControl className="settings-sheet-primary" disabled={!value.trim()} type="submit">
          Continue
        </ButtonControl>
      </div>
    </form>
  );
}

export function ProviderOAuthForm({
  providerId,
  providerName,
  description,
  avatar,
  titleId,
  isActive,
  connected,
  expiresAt,
  signInHint,
  docsUrl,
  docsLabel,
  onUseApiKey,
  onSetActive,
  onOpenExternal,
  onSettingsChanged,
  onClose,
}: ProviderOAuthFormProps) {
  const { flow, busy, signIn, respond, cancel, signOut } = useOAuthLogin(providerId, onSettingsChanged);
  const running = flow.status === 'running';
  const countdown = useCountdown(running ? flow.deviceCode?.expiresInSeconds : undefined);

  // Auto-open the loopback URL once when it arrives (the user can re-open it below).
  const openedAuthRef = useRef<string | null>(null);
  useEffect(() => {
    const url = flow.auth?.url;
    if (running && url && openedAuthRef.current !== url) {
      openedAuthRef.current = url;
      onOpenExternal(url);
    }
    if (!running) openedAuthRef.current = null;
  }, [running, flow.auth?.url, onOpenExternal]);

  return (
    <>
      <header className="settings-sheet-head">
        <span aria-hidden="true" className="settings-sheet-avatar">{avatar}</span>
        <div className="settings-sheet-head-text">
          <h2 className="settings-sheet-title" id={titleId}>
            {providerName}
            {isActive ? <span className="settings-provider-badge is-active">Active</span> : null}
          </h2>
          <p className="settings-sheet-subtitle">{description}</p>
        </div>
      </header>

      <div className="settings-sheet-body">
        {connected && !running ? (
          <div className="settings-sheet-oauth-connected" role="group">
            <span className="settings-sheet-oauth-connected-mark"><CheckIcon size={ICON_SIZE.menu} /></span>
            <div className="settings-sheet-oauth-connected-text">
              <p className="settings-sheet-oauth-connected-title">Connected</p>
              {expiresAt ? (
                <p className="settings-sheet-oauth-connected-sub">Access renews {formatRelativeExpiry(expiresAt, Date.now())}</p>
              ) : null}
            </div>
          </div>
        ) : running ? (
          <div className="settings-sheet-oauth-running" role="group">
            {flow.deviceCode ? (
              <div className="settings-sheet-oauth-code-block">
                <p className="settings-sheet-oauth-step-label">Enter this code at the sign-in page:</p>
                <p className="settings-sheet-oauth-code">{flow.deviceCode.userCode}</p>
                <button
                  className="agent-settings-doc-link"
                  onClick={() => onOpenExternal(flow.deviceCode!.verificationUri)}
                  type="button"
                >
                  <span>{flow.deviceCode.verificationUri}</span>
                  <OpenIcon size={ICON_SIZE.tiny} />
                </button>
                {countdown !== null ? (
                  <p className="settings-sheet-oauth-countdown">Expires in {formatCountdown(countdown)}</p>
                ) : null}
              </div>
            ) : null}

            {flow.auth ? (
              <div className="settings-sheet-oauth-code-block">
                <p className="settings-sheet-oauth-step-label">
                  {flow.auth.instructions ?? 'Continue in your browser to finish signing in.'}
                </p>
                <button className="agent-settings-doc-link" onClick={() => onOpenExternal(flow.auth!.url)} type="button">
                  <span>Open the sign-in page</span>
                  <OpenIcon size={ICON_SIZE.tiny} />
                </button>
              </div>
            ) : null}

            {flow.pending ? (
              <ReplyStep
                onRespond={(value) => respond(flow.pending!.requestId, value)}
                pending={flow.pending}
              />
            ) : (
              <div className="settings-sheet-oauth-progress" role="status">
                <LoaderIcon className="settings-sheet-spinner" size={ICON_SIZE.menu} />
                <span>{flow.progress ?? 'Waiting for authorization…'}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="settings-sheet-oauth-intro">
            {signInHint ? <p className="settings-sheet-oauth-hint">{signInHint}</p> : null}
            {docsUrl ? (
              <button className="agent-settings-doc-link" onClick={() => onOpenExternal(docsUrl)} type="button">
                <span>{docsLabel ?? 'Learn more'}</span>
                <OpenIcon size={ICON_SIZE.tiny} />
              </button>
            ) : null}
          </div>
        )}

        {flow.status === 'error' && flow.error ? (
          <div className="settings-sheet-result is-error" role="status">
            <span className="settings-sheet-result-text">✗ {flow.error}</span>
          </div>
        ) : null}
      </div>

      <div className="settings-sheet-actions">
        <div className="settings-sheet-actions-left">
          {connected && !running ? (
            <ButtonControl className="settings-sheet-danger" disabled={busy} onClick={signOut}>
              Sign out
            </ButtonControl>
          ) : null}
          {connected && !running && onSetActive && !isActive ? (
            <ButtonControl className="settings-sheet-secondary" disabled={busy} onClick={onSetActive}>
              Set as Active
            </ButtonControl>
          ) : null}
          {onUseApiKey && !running ? (
            <ButtonControl className="settings-sheet-secondary" disabled={busy} onClick={onUseApiKey}>
              Use an API key instead
            </ButtonControl>
          ) : null}
        </div>
        <div className="settings-sheet-actions-right">
          {running ? (
            <ButtonControl className="settings-sheet-secondary" onClick={cancel}>
              Cancel sign-in
            </ButtonControl>
          ) : (
            <ButtonControl className="settings-sheet-secondary" disabled={busy} onClick={onClose}>
              {connected ? 'Done' : 'Cancel'}
            </ButtonControl>
          )}
          {!running ? (
            <ButtonControl className="settings-sheet-primary" disabled={busy} onClick={signIn}>
              {connected ? 'Re-authenticate' : `Sign in to ${providerName}`}
            </ButtonControl>
          ) : null}
        </div>
      </div>
    </>
  );
}
