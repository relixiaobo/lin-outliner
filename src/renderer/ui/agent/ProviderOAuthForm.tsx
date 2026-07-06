import { useCallback, useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import type { AgentProviderSettingsView } from '../../api/types';
import { api } from '../../api/client';
import { CheckIcon, ICON_SIZE, LoaderIcon, OpenIcon } from '../icons';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../primitives/Button';
import { ButtonControl } from '../primitives/ButtonControl';
import { ErrorState } from '../primitives/FeedbackState';
import { Input } from '../primitives/Input';
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
    setBusy(true);
    dispatch({ type: 'start' });
    api.agentOAuthLogin(providerId)
      .then((settings) => { if (!mountedRef.current) return; dispatch({ type: 'done' }); onSettingsChanged(settings); })
      .catch((caught) => {
        if (!mountedRef.current) return;
        // A user-initiated cancel rejects the login too — fold it back to idle, not an error.
        if (cancelledRef.current) dispatch({ type: 'reset' });
        else dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) });
      })
      .finally(() => { runningRef.current = false; if (mountedRef.current) setBusy(false); });
  }, [providerId, onSettingsChanged]);

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
    void api.agentOAuthCancel(providerId);
  }, [providerId]);

  const signOut = useCallback(() => {
    setBusy(true);
    api.agentOAuthLogout(providerId)
      .then((settings) => { if (mountedRef.current) onSettingsChanged(settings); })
      .catch((caught) => { if (mountedRef.current) dispatch({ type: 'error', message: caught instanceof Error ? caught.message : String(caught) }); })
      .finally(() => { if (mountedRef.current) setBusy(false); });
  }, [providerId, onSettingsChanged]);

  return { flow, busy, signIn, respond, cancel, signOut };
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
          className="settings-sheet-row-input"
          id={fieldId}
          label={label}
          onChange={(event) => setValue(event.target.value)}
          placeholder={placeholder}
          value={value}
          variant="bare"
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
  const t = useT();
  const { flow, busy, signIn, respond, cancel, signOut } = useOAuthLogin(providerId, onSettingsChanged);
  const running = flow.status === 'running';
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
            {isActive ? <span className="settings-chip">{t.providerOAuth.activeChip}</span> : null}
          </h2>
          <p className="settings-sheet-subtitle">{description}</p>
        </div>
      </header>

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
          </div>
        ) : running ? (
          <div className="settings-sheet-oauth-running" role="group">
            {flow.deviceCode ? (
              <div className="settings-sheet-oauth-code-block">
                <p className="settings-sheet-oauth-step-label">{t.providerOAuth.enterCodeAtSignIn}</p>
                <p className="settings-sheet-oauth-code">{flow.deviceCode.userCode}</p>
                <ButtonControl
                  className="agent-settings-doc-link"
                  onClick={() => onOpenExternal(flow.deviceCode!.verificationUri)}
                >
                  <span>{flow.deviceCode.verificationUri}</span>
                  <OpenIcon size={ICON_SIZE.tiny} />
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
                <ButtonControl className="agent-settings-doc-link" onClick={() => onOpenExternal(flow.auth!.url)}>
                  <span>{t.providerOAuth.openSignInPage}</span>
                  <OpenIcon size={ICON_SIZE.tiny} />
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
              <ButtonControl className="agent-settings-doc-link" onClick={() => onOpenExternal(docsUrl)}>
                <span>{docsLabel ?? t.providerOAuth.learnMore}</span>
                <OpenIcon size={ICON_SIZE.tiny} />
              </ButtonControl>
            ) : null}
          </div>
        )}

        {flow.status === 'error' && flow.error ? (
          <ErrorState
            className="settings-sheet-result"
            message={flow.error}
            size="inline"
          />
        ) : null}
      </div>

      <div className="settings-sheet-actions">
        <div className="settings-sheet-actions-left">
          {connected && !running ? (
            <Button disabled={busy} onClick={signOut} variant="danger">
              {t.providerOAuth.signOut}
            </Button>
          ) : null}
          {connected && !running && onSetActive && !isActive ? (
            <Button disabled={busy} onClick={onSetActive} variant="secondary">
              {t.providerOAuth.setActive}
            </Button>
          ) : null}
          {onUseApiKey && !running ? (
            <Button disabled={busy} onClick={onUseApiKey} variant="secondary">
              {t.providerOAuth.useApiKeyInstead}
            </Button>
          ) : null}
        </div>
        <div className="settings-sheet-actions-right">
          {running ? (
            <Button onClick={cancel} variant="ghost">
              {t.providerOAuth.cancelSignIn}
            </Button>
          ) : connected ? (
            // Connected: finishing is the main action, so Done is the (rightmost)
            // primary; re-authenticating is a rare maintenance action and steps back
            // to secondary. Without this the strong-neutral primary sat on
            // Re-authenticate, reading as "you must sign in again".
            <>
              <Button disabled={busy} onClick={signIn} variant="secondary">
                {t.providerOAuth.reauthenticate}
              </Button>
              <Button disabled={busy} onClick={onClose} variant="primary">
                {t.providerOAuth.done}
              </Button>
            </>
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
