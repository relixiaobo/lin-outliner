import { describe, expect, test } from 'bun:test';
import { getMessages } from '../../src/core/i18n';
import type { ProviderChoice } from '../../src/renderer/ui/agent/settingsProviderModel';
import {
  providerCheckedAtText,
  providerStatusSentence,
  resolveProviderStatus,
} from '../../src/renderer/ui/agent/providerStatus';

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

// The legacy half of this table asserted `providerStatusLabel(input) === legacyLabel`
// for every row, and ran green in the commit that introduced the typed model
// alongside it. It is gone with that function; `legacyLabel` stays as the record
// of what each row used to say, which is what makes a future reader able to
// check that no state quietly changed meaning here.

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

/**
 * A probe timestamp is in the PAST. Routing it through the OAuth expiry formatter,
 * whose non-positive branch means "this token has run out", made every recorded
 * verdict announce itself as "Checked expired" — a connection verified seconds ago
 * reading as stale, and in zh-Hans as the English word "expired" inside a Chinese
 * sentence.
 */
describe('provider checked-at', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const zh = getMessages('zh-Hans');

  test('reads as an age, never as an expiry', () => {
    expect(providerCheckedAtText(now - 5_000, now, en)).toBe('Checked just now');
    expect(providerCheckedAtText(now - 60_000, now, en)).toBe('Checked 1 minute ago');
    expect(providerCheckedAtText(now - 5 * 60_000, now, en)).toBe('Checked 5 minutes ago');
    expect(providerCheckedAtText(now - 3 * 3_600_000, now, en)).toBe('Checked 3 hours ago');
    expect(providerCheckedAtText(now - 2 * 86_400_000, now, en)).toBe('Checked 2 days ago');
  });

  test('is one localized sentence rather than an English fragment in a frame', () => {
    expect(providerCheckedAtText(now - 5 * 60_000, now, zh)).toBe('5 分钟前检查过');
  });

  test('a clock that moved backwards still reads as recent, not as a negative age', () => {
    expect(providerCheckedAtText(now + 10_000, now, en)).toBe('Checked just now');
  });
});
