// The launcher capability boundary (step 6 / D1b).
//
// The negative fixtures are the point: `lin:invoke('get_projection')` and
// `lin:invoke('delete_node', …)` from the real launcher sender must be rejected
// before dispatch, without reading or changing the document. The minimal
// preload is least privilege; THIS is the gate that keeps holding if that
// bundle is ever widened by accident.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  APP_RENDERER_CAPABILITIES,
  LAUNCHER_RENDERER_CAPABILITIES,
  RENDERER_CAPABILITIES,
  registerRendererCapabilities,
  rendererHasCapability,
  resetRendererCapabilities,
  type RendererCapability,
} from '../../src/main/rendererCapabilities';

afterEach(() => resetRendererCapabilities());

/** The parts of `WebContents` the registry touches. */
function fakeContents(id: number) {
  const listeners: Array<() => void> = [];
  return {
    contents: {
      id,
      once: (event: string, listener: () => void) => {
        if (event === 'destroyed') listeners.push(listener);
      },
    } as never,
    destroy: () => listeners.forEach((listener) => listener()),
  };
}

describe('the launcher capability boundary', () => {
  test('the launcher may NOT invoke application commands', () => {
    const launcher = fakeContents(7);
    registerRendererCapabilities(launcher.contents, LAUNCHER_RENDERER_CAPABILITIES);
    // `lin:invoke` is gated on this one capability, so `get_projection` and
    // `delete_node` are both refused by the same check.
    expect(rendererHasCapability(7, 'appCommands')).toBe(false);
  });

  test('the launcher may NOT attest invocation context', () => {
    const launcher = fakeContents(7);
    registerRendererCapabilities(launcher.contents, LAUNCHER_RENDERER_CAPABILITIES);
    // `view` / `workspace` facts are the main renderer's to attest; a launcher
    // attempt is rejected rather than merged.
    expect(rendererHasCapability(7, 'actionAttestation')).toBe(false);
  });

  test('the launcher CAN name actions and query their parameters', () => {
    const launcher = fakeContents(7);
    registerRendererCapabilities(launcher.contents, LAUNCHER_RENDERER_CAPABILITIES);
    expect(rendererHasCapability(7, 'actionRequests')).toBe(true);
    expect(rendererHasCapability(7, 'launcher')).toBe(true);
  });

  test('an app renderer keeps its command surface and loses the launcher bridge', () => {
    const app = fakeContents(1);
    registerRendererCapabilities(app.contents, APP_RENDERER_CAPABILITIES);
    expect(rendererHasCapability(1, 'appCommands')).toBe(true);
    expect(rendererHasCapability(1, 'actionAttestation')).toBe(true);
    // `launcher:*` is the launcher's own bridge; a non-launcher sender is
    // refused rather than served.
    expect(rendererHasCapability(1, 'launcher')).toBe(false);
  });

  test('an unregistered renderer fails CLOSED', () => {
    for (const capability of RENDERER_CAPABILITIES) {
      expect(rendererHasCapability(999, capability)).toBe(false);
    }
  });

  test('a destroyed webContents cannot leave its rights behind for a reused id', () => {
    const launcher = fakeContents(7);
    registerRendererCapabilities(launcher.contents, LAUNCHER_RENDERER_CAPABILITIES);
    expect(rendererHasCapability(7, 'launcher')).toBe(true);
    launcher.destroy();
    expect(rendererHasCapability(7, 'launcher')).toBe(false);
  });

  test('the two capability sets are disjoint exactly where the threat model says', () => {
    const app = new Set<RendererCapability>(APP_RENDERER_CAPABILITIES);
    const launcher = new Set<RendererCapability>(LAUNCHER_RENDERER_CAPABILITIES);
    // The only capability both hold is the one whose whole safety argument is
    // that main re-evaluates the named tuple itself.
    const shared = [...app].filter((capability) => launcher.has(capability));
    expect(shared).toEqual(['actionRequests']);
  });
});
