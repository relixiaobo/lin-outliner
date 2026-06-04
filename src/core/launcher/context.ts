// Launcher context primitives shared across processes.
//
// These are the stable, serializable enums/shapes the capture pipeline agrees
// on: provider ids, permission requirements, capture warnings, and the live
// "what is the user looking at right now" contract (ExternalContext). Capture is
// basic-info-only today (app + tab + classification); richer in-page extraction
// is deferred to a future unified extension/CDP backend (A7).
//
// Plan: docs/plans/lazy-like-global-launcher.md.

import type { SourceDraft } from './sources';

/**
 * Which provider produced a captured context. `unknown-app` is the fallback.
 *
 * Produced today (see `selectSiteProvider` in contextCapture.ts): `generic-webpage`,
 * `youtube`, `x-twitter`, `github`, `substack`, and `unknown-app`. The rest
 * (`gmail`, `superhuman`, `apple-mail`, `mimestream`, `linkedin`, `slack`,
 * `whatsapp`, `loom`, `spotify`, `messages`, `pdf`, `circle`, `notion-public`) are
 * the TARGET registry — declared so the contract is stable (A7), each lit up by
 * its provider in launcher-provider-expansion.md. Not yet emitted.
 */
export type ContextProviderId =
  | 'generic-webpage'
  | 'youtube'
  | 'x-twitter'
  | 'gmail'
  | 'superhuman'
  | 'apple-mail'
  | 'mimestream'
  | 'linkedin'
  | 'slack'
  | 'whatsapp'
  | 'loom'
  | 'spotify'
  | 'messages'
  | 'pdf'
  | 'github'
  | 'circle'
  | 'substack'
  | 'notion-public'
  | 'unknown-app';

/** OS/integration capabilities a provider may require to capture fully. */
export type PermissionRequirement =
  | 'macos-accessibility'
  | 'macos-automation'
  | 'browser-automation'
  | 'apple-mail-automation'
  | 'screen-recording'
  | 'local-file-access'
  | 'notion-oauth'
  | 'ai-provider-key';

/**
 * A non-fatal problem surfaced during capture (partial provider result, missing
 * permission, stale selector, etc.). Stored on the capture so the UI can show a
 * degraded-but-saved state rather than failing.
 */
export interface ContextWarning {
  /** Machine-readable, e.g. 'provider-partial' | 'permission-missing'. */
  code: string;
  /** Human-readable explanation for remediation UI. */
  message: string;
  providerId?: ContextProviderId;
  permission?: PermissionRequirement;
}

/**
 * The live "what is the user looking at right now" snapshot produced by the
 * context-capture service. Built best-effort — the launcher shows first and
 * folds this in when it arrives. `confidence` reflects how sure the provider is
 * about the match.
 *
 * Capture is basic-info-only today: app + browser tab (URL/title) +
 * provider classification. In-page content/selection/media extraction was
 * intentionally removed in favor of a future unified extension/CDP backend —
 * see docs/plans/browser-extension-integration.md.
 */
export interface ExternalContext {
  id: string;
  capturedAt: string;
  captureOrigin: 'global-hotkey' | 'manual-refresh' | 'deep-link' | 'test';
  app: {
    name: string;
    bundleId?: string;
    windowTitle?: string;
  };
  browser?: {
    name: string;
    tabTitle?: string;
    url?: string;
    hostname?: string;
  };
  providerId: ContextProviderId;
  confidence: 'exact' | 'probable' | 'fallback';
  source?: SourceDraft;
  warnings: ContextWarning[];
  permissions: PermissionRequirement[];
}
