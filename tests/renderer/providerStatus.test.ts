import { describe, expect, test } from 'bun:test';
import { getMessages } from '../../src/core/i18n';
import { providerStatusLabel, type ProviderChoice } from '../../src/renderer/ui/agent/settingsProviderModel';
import { resolveProviderStatus, providerStatusSentence } from '../../src/renderer/ui/agent/providerStatus';

/**
 * The old-label → new-state mapping table.
 *
 * `providerStatusLabel` was a nine-branch ladder returning display strings, with
 * no direct test of any kind. Pinning those branches immediately before
 * replacing them would have proved only that the old code did what it did; this
 * table instead states, for every input shape the ladder could distinguish, the
 * label it used to produce AND the state the typed model now produces.
 *
 * Both halves are asserted while both implementations exist, which is what makes
 * the table evidence rather than a claim: it proves no state silently changed
 * meaning across the replacement. The legacy half is deleted in the same commit
 * that deletes `providerStatusLabel`, leaving the new half as the model's
 * regression test.
 *
 * Two collapses are deliberate and visible here as two rows sharing one state:
 *   - `Add key` (no row yet) and `Needs key` (row exists) → `needs-credential`.
 *     The difference is whether a config row has been materialized, which is not
 *     a fact about the user's situation.
 *   - `Proxy required` / `Unsupported` / `Not detected` / `Unavailable` →
 *     `unavailable` + a reason. All four mean "not usable on this machine"; the
 *     reason carries the only part that differs, and the sentence still says it.
 */

const en = getMessages('en');

function choice(overrides: Partial<ProviderChoice>): ProviderChoice {
  return {
    providerId: 'openai',
    configured: true,
    active: false,
    enabled: true,
    hasCredential: true,
    ...overrides,
  };
}

interface Case {
  name: string;
  input: ProviderChoice;
  legacyLabel: string;
  expected: ReturnType<typeof resolveProviderStatus>;
}

const CASES: Case[] = [
  {
    name: 'proxy-required beats everything else about the row',
    input: choice({ connectionStatus: 'proxy-required' }),
    legacyLabel: 'Proxy required',
    expected: { state: 'unavailable', reason: 'proxy-required' },
  },
  {
    name: 'unsupported provider',
    input: choice({ connectionStatus: 'unsupported' }),
    legacyLabel: 'Unsupported',
    expected: { state: 'unavailable', reason: 'unsupported' },
  },
  {
    name: 'external provider not present on this machine',
    input: choice({ connectionStatus: 'not-detected' }),
    legacyLabel: 'Not detected',
    expected: { state: 'unavailable', reason: 'not-detected' },
  },
  {
    name: 'detected but not configured here',
    input: choice({ configured: false, detected: true, hasCredential: false }),
    legacyLabel: 'Detected',
    expected: { state: 'detected' },
  },
  {
    name: 'catalog row with an ambient credential',
    input: choice({ configured: false, hasCredential: true }),
    legacyLabel: 'Ready',
    expected: { state: 'ready' },
  },
  {
    name: 'catalog row with no credential — was Add key',
    input: choice({ configured: false, hasCredential: false }),
    legacyLabel: 'Add key',
    expected: { state: 'needs-credential' },
  },
  {
    name: 'configured row switched off',
    input: choice({ enabled: false }),
    legacyLabel: 'Disabled',
    expected: { state: 'disabled' },
  },
  {
    name: 'first-party local gateway that main could not reach',
    input: choice({ providerId: 'cc-switch', hasCredential: false }),
    legacyLabel: 'Unavailable',
    expected: { state: 'unavailable', reason: 'gateway-unreachable' },
  },
  {
    name: 'configured row with no credential — was Needs key',
    input: choice({ hasCredential: false }),
    legacyLabel: 'Needs key',
    expected: { state: 'needs-credential' },
  },
  {
    name: 'usable, not the active connection',
    input: choice({}),
    legacyLabel: 'Ready',
    expected: { state: 'ready' },
  },
  {
    name: 'the active connection',
    input: choice({ active: true }),
    legacyLabel: 'Active',
    expected: { state: 'active' },
  },
];

describe('provider status — the legacy ladder said what this table claims', () => {
  // Deleted together with `providerStatusLabel`; until then it is the half that
  // makes the mapping checkable rather than asserted.
  for (const testCase of CASES) {
    test(testCase.name, () => {
      expect(providerStatusLabel(testCase.input, en)).toBe(testCase.legacyLabel);
    });
  }
});

describe('provider status — the typed model', () => {
  for (const testCase of CASES) {
    test(testCase.name, () => {
      expect(resolveProviderStatus(testCase.input)).toEqual(testCase.expected);
    });
  }
});

describe('provider status — verdicts the legacy ladder could not express', () => {
  test('a refused credential is its own state, not "Ready"', () => {
    const status = resolveProviderStatus(choice({ connectionCheck: { outcome: 'rejected', at: 1 } }));
    expect(status).toEqual({ state: 'key-rejected' });
  });

  test('an unreachable probe qualifies the state instead of demoting it', () => {
    const status = resolveProviderStatus(choice({ active: true, connectionCheck: { outcome: 'unreachable', at: 1 } }));
    expect(status).toEqual({ state: 'active', uncheckable: true });
    expect(providerStatusSentence(status, en)).toBe("Active, couldn't check");
  });

  test('a successful probe reads exactly as an unprobed connection does', () => {
    expect(resolveProviderStatus(choice({ connectionCheck: { outcome: 'ok', at: 1 } })))
      .toEqual(resolveProviderStatus(choice({})));
  });
});
