import type { OAuthLoginEvent } from '../../api/types';

// Pure flow logic for the interactive OAuth sign-in, kept off the component so it
// can be unit-tested without a renderer. The reducer folds the main→renderer
// `OAuthLoginEvent` stream into a single render state; the formatters turn raw
// timestamps/seconds into the strings the form shows. No IPC, no React here.

/** The reply-needed events — the renderer must answer these via `agent_oauth_respond`. */
export type OAuthReplyEvent = Extract<OAuthLoginEvent, { kind: 'prompt' | 'select' | 'manual-code' }>;

export interface OAuthFlowState {
  status: 'idle' | 'running' | 'error';
  /** Latest progress line ("Waiting for authorization…"). */
  progress?: string;
  /** Loopback sign-in: the URL to open in the browser. */
  auth?: { url: string; instructions?: string };
  /** Device-code sign-in: the code to type at `verificationUri`. */
  deviceCode?: { userCode: string; verificationUri: string; expiresInSeconds?: number };
  /** The current reply-needed step, if main is awaiting an answer. */
  pending?: OAuthReplyEvent;
  /** Set when the sign-in failed (never on user-initiated cancel — that resets). */
  error?: string;
}

export const INITIAL_OAUTH_FLOW: OAuthFlowState = { status: 'idle' };

export type OAuthFlowAction =
  | { type: 'start' }
  | { type: 'event'; event: OAuthLoginEvent }
  | { type: 'responded' }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function oauthFlowReducer(state: OAuthFlowState, action: OAuthFlowAction): OAuthFlowState {
  switch (action.type) {
    case 'start':
      return { status: 'running' };
    case 'event':
      return applyOAuthEvent(state, action.event);
    case 'responded':
      // The renderer answered the pending step; clear it while we await main's next event.
      return { ...state, pending: undefined };
    case 'done':
    case 'reset':
      return INITIAL_OAUTH_FLOW;
    case 'error':
      return { status: 'error', error: action.message };
  }
}

/**
 * Fold one login event into the flow state. A reply-needed event (`prompt` /
 * `select` / `manual-code`) becomes the `pending` step; any informational event
 * clears `pending` (main has moved on) while keeping the auth/device-code/progress
 * context visible so the user can still see the code or link.
 */
export function applyOAuthEvent(state: OAuthFlowState, event: OAuthLoginEvent): OAuthFlowState {
  const base: OAuthFlowState = { ...state, status: 'running', error: undefined };
  switch (event.kind) {
    case 'auth':
      return { ...base, pending: undefined, auth: { url: event.url, instructions: event.instructions } };
    case 'device-code':
      return {
        ...base,
        pending: undefined,
        deviceCode: {
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresInSeconds: event.expiresInSeconds,
        },
      };
    case 'progress':
      return { ...base, pending: undefined, progress: event.message };
    case 'prompt':
    case 'select':
    case 'manual-code':
      return { ...base, pending: event };
  }
}

/**
 * "in 3 days" / "in 2 hours" / "in 5 minutes" / "in under a minute" / "expired"
 * for the connected-state expiry hint. `nowMs` is injected so this is pure/testable.
 */
export function formatRelativeExpiry(expiresAtMs: number, nowMs: number): string {
  const deltaMs = expiresAtMs - nowMs;
  if (deltaMs <= 0) return 'expired';
  if (deltaMs < 60_000) return 'in under a minute';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/** "M:SS" countdown for a device-code TTL. Clamps negatives to "0:00". */
export function formatCountdown(secondsRemaining: number): string {
  const total = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
