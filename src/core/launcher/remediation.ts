// The capture-degraded-but-saved hint, derived in MAIN.
//
// The launcher renderer no longer receives the raw `ExternalContext` — it has no
// business holding one — so main derives this small serializable view from the
// capture warnings and pushes only that. The banner itself is unchanged: it is
// the one first-run surface the command surface keeps.

import type { Messages } from '../i18n';
import type { ExternalContext } from './context';

/**
 * A capture-degraded-but-saved hint with the fix the user can act on. Surfaced as
 * a quiet banner so a partial capture (link only) explains how to unlock the full
 * one — the equivalent of Lazy's "noJXA" prompt. Capture still succeeds regardless.
 */
export interface LauncherRemediation {
  kind: 'automation';
  title: string;
  detail: string;
}

/**
 * Derive the single relevant remediation from a captured context's warnings, or
 * null when capture was clean. Keyed on warning codes (not free text) so it stays
 * stable. Basic-info capture has one actionable failure: it couldn't read the
 * active tab at all (no AX, no Automation) → guide the user to grant Automation.
 * (The in-page-script toggle / multi-window / multi-instance hints went away with
 * the in-page extraction path; rich capture returns via the browser extension —
 * docs/plans/browser-extension-integration.md.)
 */
export function remediationForContext(context: ExternalContext | null, t: Messages, app: string): LauncherRemediation | null {
  if (!context) return null;
  const codes = new Set(context.warnings.map((w) => w.code));
  const browser = context.browser?.name ?? context.app.name ?? t.launcher.remediation.fallbackBrowser;

  // Couldn't read the active tab at all → Automation access is denied.
  if (codes.has('browser-tab-unavailable')) {
    return {
      kind: 'automation',
      title: t.launcher.remediation.cannotReadTitle({ browser }),
      detail: t.launcher.remediation.cannotReadDetail({ app, browser }),
    };
  }
  return null;
}
