import { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { CheckIcon, ICON_SIZE, LoaderIcon, OpenInBrowserIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { ErrorState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
import type { ProviderFormActivity } from './ProviderConfigForm';
import {
  formatCountdown,
  formatRelativeExpiry,
  INITIAL_OAUTH_FLOW,
  oauthFlowReducer,
  type OAuthReplyEvent,
} from './oauthLoginFlow';

// The OAuth sign-in surface, rendered in place of the API-key form for providers
// whose provider-owned auth exposes OAuth. It owns
// only presentation + the interactive reply steps; main runs the real sign-in and
// holds every secret. Layout/classNames mirror ProviderConfigForm so the two read
// as one dialog family. Selection/focus stay neutral (B3/B4); the primary button is
// neutral-strong, never a system accent.

interface ProviderOAuthFormProps {
  providerId: string;
  providerName: string;
  connected: boolean;
  /** Absolute ms expiry of the stored credential, when connected. */
  expiresAt?: number;
  signInHint?: string;
  docsUrl?: string;
  docsLabel?: string;
  onOpenExternal: (url: string) => Promise<unknown>;
  onBusyChange: (busy: boolean) => void;
  onActivityChange: (activity: ProviderFormActivity) => void;
  /** Settings after a successful sign-in / sign-out — the window re-renders from these. */
  onProviderChange: (settings: AgentProviderSettingsView) => void;
  onClose: () => void;
}

// Drive a single sign-in from the renderer: subscribe to the main→renderer event
// stream (filtered to this provider), reduce it into render state, and answer the
// reply-needed steps. The login promise resolves with fresh settings on success.
function useOAuthLogin(
  providerId: string,
  onProviderChange: (settings: AgentProviderSettingsView) => void,
) {
  const [flow, dispatch] = useReducer(oauthFlowReducer, INITIAL_OAUTH_FLOW);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);

  // Own the event subscription for the component's lifetime and tear it down on
  // unmount — closing the dialog mid-login must not leave a listener dispatching
  // into a discarded reducer. Events only arrive during an active login.
  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = window.lin?.onAgentOAuthEvent((envelope) => {
      if (mountedRef.current && envelope.providerId === providerId) {
        dispatch({ type: 'event', event: envelope.event });
      }
    });
    return () => { mountedRef.current = false; unsubscribe?.(); };
  }, [providerId]);

  const signIn = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    cancelledRef.current = false;
    setSigningIn(true);
    setBusy(true);
    dispatch({ type: 'start' });
    api.agentOAuthLogin(providerId)
      .then((settings) => { if (!mountedRef.current) return; dispatch({ type: 'done' }); onProviderChange(settings); })
      .catch((caught) => {
        if (!mountedRef.current) return;
        // A user-initiated cancel rejects the login too — fold it back to idle, not an error.
        if (cancelledRef.current) dispatch({ type: 'reset' });
        else dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) });
      })
      .finally(() => { runningRef.current = false; if (mountedRef.current) { setBusy(false); setSigningIn(false); } });
  }, [providerId, onProviderChange]);

  const respond = useCallback((requestId: string, value: string | undefined) => {
    dispatch({ type: 'responded' });
    // Surface a failed answer instead of swallowing it — otherwise a rejected
    // respond would leave the form spinning on "Waiting…" with no way forward.
    api.agentOAuthRespond(requestId, value).catch((caught) => {
      if (mountedRef.current) dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) });
    });
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    api.agentOAuthCancel(providerId).catch((caught) => {
      cancelledRef.current = false;
      if (mountedRef.current) dispatch({ type: 'error', message: String(caught instanceof Error ? caught.message : caught) });
    });
  }, [providerId]);

  const signOut = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    dispatch({ type: 'reset' });
    setBusy(true);
    api.agentOAuthLogout(providerId)
      .then((settings) => { if (mountedRef.current) onProviderChange(settings); })
      .catch((caught) => { if (mountedRef.current) dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) }); })
      .finally(() => { runningRef.current = false; if (mountedRef.current) setBusy(false); });
  }, [providerId, onProviderChange]);

  return { flow, busy, signingIn, signIn, respond, cancel, signOut };
}

// A live "expires in M:SS" countdown for the device-code TTL. Returns null once
// it lapses. `nonce` re-arms the interval on each fresh device code even when the
// TTL value is identical (the common case), so the timer restarts from the new
// code rather than draining from the first one's start.
function useCountdown(expiresInSeconds: number | undefined, nonce: number | undefined): number | null {
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
  }, [expiresInSeconds, nonce]);
  return remaining;
}

function ReplyStep({ pending, onRespond }: {
  pending: OAuthReplyEvent;
  onRespond: (value: string | undefined) => void;
}) {
  const t = useT();
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
            <Button
              key={option.id}
              onClick={() => onRespond(option.id)}
              variant="secondary"
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  const label = pending.kind === 'prompt' ? pending.message : t.providerOAuth.pasteCodeLabel;
  const placeholder = pending.kind === 'prompt' ? pending.placeholder : t.providerOAuth.authorizationCodePlaceholder;
  return (
    <form
      className="settings-sheet-oauth-step"
      onSubmit={(event) => { event.preventDefault(); if (value.trim()) onRespond(value.trim()); }}
    >
      <label className="settings-sheet-oauth-step-label" htmlFor={fieldId}>{label}</label>
      <div className="settings-sheet-oauth-reply">
        <Input
          autoFocus
          className="settings-sheet-reply-input"
          id={fieldId}
          label={label}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          value={value}
          variant="boxed"
        />
        <Button disabled={!value.trim()} type="submit" variant="primary">
          {t.providerOAuth.continue}
        </Button>
      </div>
    </form>
  );
}

export function ProviderOAuthForm({
  providerId,
  providerName,
  connected,
  expiresAt,
  signInHint,
  docsUrl,
  docsLabel,
  onOpenExternal,
  onBusyChange,
  onActivityChange,
  onProviderChange,
  onClose,
}: ProviderOAuthFormProps) {
  const t = useT();
  const { flow, busy, signingIn, signIn, respond, cancel, signOut } = useOAuthLogin(providerId, onProviderChange);
  const running = signingIn;
  const [browserError, setBrowserError] = useState('');
  useEffect(() => { setBrowserError(''); }, [running]);
  // Signing out commits immediately; browser sign-in can still be cancelled.
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => { onActivityChange(busy && !running ? 'saving' : 'idle'); }, [busy, running, onActivityChange]);
  const openBrowser = useCallback(async (url: string) => {
    setBrowserError('');
    try { await onOpenExternal(url); }
    catch (caught) { setBrowserError(String(caught instanceof Error ? caught.message : caught)); }
  }, [onOpenExternal]);
  const countdown = useCountdown(
    running ? flow.deviceCode?.expiresInSeconds : undefined,
    running ? flow.deviceCodeNonce : undefined,
  );

  // Auto-open the loopback URL once when it arrives (the user can re-open it below).
  const openedAuthRef = useRef<string | null>(null);
  useEffect(() => {
    const url = flow.auth?.url;
    if (running && url && openedAuthRef.current !== url) {
      openedAuthRef.current = url;
      void openBrowser(url);
    }
    if (!running) openedAuthRef.current = null;
  }, [running, flow.auth?.url, openBrowser]);

  return (
    <>
      <div className="settings-sheet-body">
        {connected && !running ? (
          <div className="settings-sheet-oauth-connected" role="group">
            <span className="settings-sheet-oauth-connected-mark"><CheckIcon size={ICON_SIZE.menu} /></span>
            <div className="settings-sheet-oauth-connected-text">
              <p className="settings-sheet-oauth-connected-title">{t.providerOAuth.connected}</p>
              {expiresAt ? (
                <p className="settings-sheet-oauth-connected-sub">{t.providerOAuth.accessRenews({ when: formatRelativeExpiry(expiresAt, Date.now()) })}</p>
              ) : null}
            </div>
            <div className="settings-sheet-account-actions">
              <Button disabled={busy} onClick={signIn}>{t.providerOAuth.reauthenticate}</Button>
              <Button disabled={busy} onClick={signOut} variant="danger">{t.providerOAuth.signOut}</Button>
            </div>
          </div>
        ) : running ? (
          <div className="settings-sheet-oauth-running" role="group">
            {flow.deviceCode ? (
              <div className="settings-sheet-oauth-code-block">
                <p className="settings-sheet-oauth-step-label">{t.providerOAuth.enterCodeAtSignIn}</p>
                <p className="settings-sheet-oauth-code">{flow.deviceCode.userCode}</p>
                <ButtonControl
                  className="agent-settings-doc-link"
                  onClick={() => void openBrowser(flow.deviceCode!.verificationUri)}
                >
                  <span>{flow.deviceCode.verificationUri}</span>
                  <OpenInBrowserIcon size={ICON_SIZE.tiny} />
                </ButtonControl>
                {countdown !== null ? (
                  <p className="settings-sheet-oauth-countdown">{t.providerOAuth.expiresIn({ time: formatCountdown(countdown) })}</p>
                ) : null}
              </div>
            ) : null}

            {flow.auth ? (
              <div className="settings-sheet-oauth-code-block">
                <p className="settings-sheet-oauth-step-label">
                  {flow.auth.instructions ?? t.providerOAuth.continueInBrowser}
                </p>
                <ButtonControl className="agent-settings-doc-link" onClick={() => void openBrowser(flow.auth!.url)}>
                  <span>{t.providerOAuth.openSignInPage}</span>
                  <OpenInBrowserIcon size={ICON_SIZE.tiny} />
                </ButtonControl>
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
                <span>{flow.progress ?? t.providerOAuth.waitingForAuthorization}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="settings-sheet-oauth-intro">
            {signInHint ? <p className="settings-sheet-oauth-hint">{signInHint}</p> : null}
            {docsUrl ? (
              <ButtonControl className="agent-settings-doc-link" onClick={() => void openBrowser(docsUrl)}>
                <span>{docsLabel ?? t.providerOAuth.learnMore}</span>
                <OpenInBrowserIcon size={ICON_SIZE.tiny} />
              </ButtonControl>
            ) : null}
          </div>
        )}

        {browserError ? <ErrorState message={browserError} size="inline" /> : null}
        {flow.status === 'error' && flow.error ? (
          <ErrorState
            message={flow.error}
            size="inline"
          />
        ) : null}
      </div>

      <div className="settings-sheet-actions">
        <div className="settings-sheet-actions-right">
          {running ? (
            <Button onClick={cancel} variant="ghost">
              {t.providerOAuth.cancelSignIn}
            </Button>
          ) : connected ? (
            <Button disabled={busy} onClick={onClose} variant="primary">{t.providerOAuth.done}</Button>
          ) : (
            // Disconnected: signing in is the main action.
            <>
              <Button disabled={busy} onClick={onClose} variant="ghost">
                {t.providerOAuth.cancel}
              </Button>
              <Button disabled={busy} onClick={signIn} variant="primary">
                {t.providerOAuth.signInTo({ provider: providerName })}
              </Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
