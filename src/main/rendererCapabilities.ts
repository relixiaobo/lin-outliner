// Which inbound IPC seams a given renderer is allowed to use.
//
// The minimal launcher preload is least privilege: it simply does not hand the
// locked-down renderer the full app bridge. THIS is the authoritative defence —
// it keeps holding if that preload is ever widened by accident, and it is the
// only layer that can say "the launcher may not call `lin:invoke`" about a
// renderer that has found some other way to reach the channel.
//
// Capabilities are registered against the real `webContents` at window
// creation and dropped when it is destroyed, so a stale id can never inherit
// another window's rights. See `docs/plans/unified-command-surface.md` D1b.

import type { WebContents } from 'electron';

export const RENDERER_CAPABILITIES = [
  /** The generic document/agent/asset/preview command surface (`lin:invoke`). */
  'appCommands',
  /** The launcher's own bridge (`launcher:*`). */
  'launcher',
  /** Naming an action for a subject object, and querying its parameters. */
  'actionRequests',
  /** Creating an invocation from a seed of attested renderer facts. */
  'actionAttestation',
] as const;

export type RendererCapability = typeof RENDERER_CAPABILITIES[number];

/** The main application window: everything except the launcher's own bridge. */
export const APP_RENDERER_CAPABILITIES: readonly RendererCapability[] = [
  'appCommands',
  'actionRequests',
  'actionAttestation',
];

/**
 * The launcher window. Deliberately NOT `appCommands`: a compromised launcher
 * renderer must not be able to call `get_projection` or `delete_node`, which is
 * the whole reason the action seam re-evaluates every request in main.
 * Deliberately NOT `actionAttestation`: `view` / `workspace` facts are the main
 * renderer's to attest, and a launcher attempt to supply them is rejected
 * rather than merged.
 */
export const LAUNCHER_RENDERER_CAPABILITIES: readonly RendererCapability[] = [
  'launcher',
  'actionRequests',
];

const capabilitiesByWebContentsId = new Map<number, ReadonlySet<RendererCapability>>();

export function registerRendererCapabilities(
  contents: WebContents,
  capabilities: readonly RendererCapability[],
): void {
  capabilitiesByWebContentsId.set(contents.id, new Set(capabilities));
  contents.once('destroyed', () => {
    capabilitiesByWebContentsId.delete(contents.id);
  });
}

/**
 * Unregistered renderers have NO capabilities. A window whose registration was
 * missed fails closed at the seam rather than inheriting the app's rights.
 */
export function rendererHasCapability(
  webContentsId: number,
  capability: RendererCapability,
): boolean {
  return capabilitiesByWebContentsId.get(webContentsId)?.has(capability) === true;
}

/** Test seam: the registry is process-global, so suites must be able to reset it. */
export function resetRendererCapabilities(): void {
  capabilitiesByWebContentsId.clear();
}
