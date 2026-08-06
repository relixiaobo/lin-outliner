import type { Messages } from '../../../core/i18n';
import { isLocalGatewayProviderId } from '../../../core/localGatewayProviders';
import type { ProviderChoice } from './settingsProviderModel';

/**
 * One provider status, shared by the settings list row and the per-provider
 * config window.
 *
 * Before this existed the two surfaces each derived their own words: the list
 * computed ten strings, the API-key window showed none of them, and the OAuth
 * window said "Connected" for the state the list called "Ready". A user reading
 * the same connection in two places got two answers.
 *
 * The state says what the user can do about it; `reason` says why, and only
 * exists where the distinction changes the sentence rather than the outcome.
 */
export type ProviderStatusState =
  /** Configured, enabled, credentialed, and the connection new Threads resolve to. */
  | 'active'
  /** Usable, but not the active one. */
  | 'ready'
  /** Reachable in principle; the user has to supply or repair a credential. */
  | 'needs-credential'
  /** The credential was refused by the provider (persisted probe verdict). */
  | 'key-rejected'
  /** Configured but switched off. */
  | 'disabled'
  /** Found on this machine, owned by another app, not connected here yet. */
  | 'detected'
  /** Cannot be used on this machine at all; `reason` carries which wall was hit. */
  | 'unavailable';

export type ProviderStatusReason =
  | 'proxy-required'
  | 'unsupported'
  | 'not-detected'
  | 'gateway-unreachable';

export interface ProviderStatus {
  state: ProviderStatusState;
  reason?: ProviderStatusReason;
  /**
   * True when the last probe could not reach the provider for a reason that says
   * nothing about the credential (offline, timeout, 429, 5xx). It qualifies an
   * otherwise-good state instead of replacing it — "Ready, couldn't check" —
   * because demoting a working connection on a flaky network would be the same
   * libel this model exists to prevent.
   */
  uncheckable?: boolean;
}

/**
 * Derive the status of one provider.
 *
 * Order matters: the walls that make a provider unusable anywhere come first,
 * then the states a user can act on. `active` is last because it is the only one
 * that presumes every other condition already passed.
 */
export function resolveProviderStatus(provider: ProviderChoice): ProviderStatus {
  if (provider.connectionStatus === 'proxy-required') return { state: 'unavailable', reason: 'proxy-required' };
  if (provider.connectionStatus === 'unsupported') return { state: 'unavailable', reason: 'unsupported' };
  if (provider.connectionStatus === 'not-detected') return { state: 'unavailable', reason: 'not-detected' };

  if (!provider.configured) {
    if (provider.detected) return { state: 'detected' };
    return provider.hasCredential ? { state: 'ready' } : { state: 'needs-credential' };
  }

  if (!provider.enabled) return { state: 'disabled' };

  // A first-party local gateway with no credential is not missing a key the user
  // could paste — main probes its reachability — so it reads as a wall, not a task.
  if (isLocalGatewayProviderId(provider.providerId) && !provider.hasCredential) {
    return { state: 'unavailable', reason: 'gateway-unreachable' };
  }
  if (!provider.hasCredential) return { state: 'needs-credential' };

  // A stored credential the provider refused. Only a confidently derived 401/403
  // reaches here (see the connectionCheck mapping in main); anything ambiguous
  // stays `unreachable` and merely qualifies the state below.
  if (provider.connectionCheck?.outcome === 'rejected') return { state: 'key-rejected' };

  const uncheckable = provider.connectionCheck?.outcome === 'unreachable' ? { uncheckable: true } : {};
  return provider.active ? { state: 'active', ...uncheckable } : { state: 'ready', ...uncheckable };
}

// Module-level helper (cannot call useT) — callers pass `t` in.
export function providerStatusText(status: ProviderStatus, t: Messages): string {
  const s = t.settings.providers.status;
  switch (status.state) {
    case 'active': return s.active;
    case 'ready': return s.ready;
    case 'needs-credential': return s.needsKey;
    case 'key-rejected': return s.keyRejected;
    case 'disabled': return s.disabled;
    case 'detected': return s.detected;
    case 'unavailable':
      if (status.reason === 'proxy-required') return s.proxyRequired;
      if (status.reason === 'unsupported') return s.unsupported;
      if (status.reason === 'not-detected') return s.notDetected;
      return s.unavailable;
  }
}

/** The full row sentence, including the "couldn't check" qualifier when it applies. */
export function providerStatusSentence(status: ProviderStatus, t: Messages): string {
  const base = providerStatusText(status, t);
  return status.uncheckable ? t.settings.providers.status.uncheckableSuffix({ status: base }) : base;
}

/**
 * When the stored verdict was recorded — "Checked just now", "Checked 5 minutes
 * ago". `nowMs` is injected so this is pure and testable.
 *
 * A probe timestamp is in the PAST. Routing it through the OAuth expiry formatter,
 * which reads a non-positive delta as a token that has run out, made every
 * recorded verdict read "Checked expired" — a connection verified seconds ago
 * announcing itself as stale. The whole sentence lives in the message rather than
 * a `when` fragment, because a language that puts the verb first cannot assemble
 * one from an English phrase.
 */
export function providerCheckedAtText(checkedAtMs: number, nowMs: number, t: Messages): string {
  const c = t.providerConfig;
  const minutes = Math.floor(Math.max(0, nowMs - checkedAtMs) / 60_000);
  if (minutes < 1) return c.checkedJustNow;
  if (minutes < 60) return c.checkedMinutesAgo({ count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return c.checkedHoursAgo({ count: hours });
  return c.checkedDaysAgo({ count: Math.floor(hours / 24) });
}
