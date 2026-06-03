import { describe, expect, test } from 'bun:test';
import type { OAuthLoginEvent } from '../../src/core/types';
import {
  applyOAuthEvent,
  formatCountdown,
  formatRelativeExpiry,
  INITIAL_OAUTH_FLOW,
  oauthFlowReducer,
} from '../../src/renderer/ui/agent/oauthLoginFlow';

describe('applyOAuthEvent', () => {
  test('a reply-needed event becomes the pending step', () => {
    const next = applyOAuthEvent(INITIAL_OAUTH_FLOW, {
      kind: 'select',
      requestId: 'r1',
      message: 'Pick one',
      options: [{ id: 'pro', label: 'Claude Pro' }],
    });
    expect(next.status).toBe('running');
    expect(next.pending).toEqual({
      kind: 'select',
      requestId: 'r1',
      message: 'Pick one',
      options: [{ id: 'pro', label: 'Claude Pro' }],
    });
  });

  test('an informational event after a reply clears the pending step', () => {
    const asked = applyOAuthEvent(INITIAL_OAUTH_FLOW, {
      kind: 'prompt',
      requestId: 'r1',
      message: 'Code?',
    });
    const moved = applyOAuthEvent(asked, { kind: 'progress', message: 'Working…' });
    expect(moved.pending).toBeUndefined();
    expect(moved.progress).toBe('Working…');
  });

  test('device-code context survives a following progress event', () => {
    const withCode = applyOAuthEvent(INITIAL_OAUTH_FLOW, {
      kind: 'device-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.test/device',
      expiresInSeconds: 600,
    });
    const waiting = applyOAuthEvent(withCode, { kind: 'progress', message: 'Waiting…' });
    expect(waiting.deviceCode?.userCode).toBe('ABCD-1234');
    expect(waiting.progress).toBe('Waiting…');
  });

  test('auth context survives a following progress event', () => {
    const withAuth = applyOAuthEvent(INITIAL_OAUTH_FLOW, {
      kind: 'auth',
      url: 'https://example.test/authorize',
    });
    const waiting = applyOAuthEvent(withAuth, { kind: 'progress', message: 'Exchanging…' });
    expect(waiting.auth?.url).toBe('https://example.test/authorize');
    expect(waiting.progress).toBe('Exchanging…');
  });
});

describe('oauthFlowReducer', () => {
  test('start → event → done walks idle → running → idle', () => {
    const started = oauthFlowReducer(INITIAL_OAUTH_FLOW, { type: 'start' });
    expect(started.status).toBe('running');
    const event: OAuthLoginEvent = { kind: 'progress', message: 'Hi' };
    const mid = oauthFlowReducer(started, { type: 'event', event });
    expect(mid.progress).toBe('Hi');
    const done = oauthFlowReducer(mid, { type: 'done' });
    expect(done).toEqual(INITIAL_OAUTH_FLOW);
  });

  test('responded clears only the pending step', () => {
    const asked = oauthFlowReducer(
      { status: 'running' },
      { type: 'event', event: { kind: 'prompt', requestId: 'r1', message: 'Code?' } },
    );
    const cleared = oauthFlowReducer(asked, { type: 'responded' });
    expect(cleared.pending).toBeUndefined();
    expect(cleared.status).toBe('running');
  });

  test('error carries the message; reset returns to idle', () => {
    const failed = oauthFlowReducer({ status: 'running' }, { type: 'error', message: 'nope' });
    expect(failed).toEqual({ status: 'error', error: 'nope' });
    expect(oauthFlowReducer(failed, { type: 'reset' })).toEqual(INITIAL_OAUTH_FLOW);
  });
});

describe('formatRelativeExpiry', () => {
  const now = 1_000_000_000_000;
  test('past or now reads as expired', () => {
    expect(formatRelativeExpiry(now, now)).toBe('expired');
    expect(formatRelativeExpiry(now - 5_000, now)).toBe('expired');
  });
  test('minutes, hours, and days pluralize correctly', () => {
    expect(formatRelativeExpiry(now + 30_000, now)).toBe('in under a minute');
    expect(formatRelativeExpiry(now + 60_000, now)).toBe('in 1 minute');
    expect(formatRelativeExpiry(now + 5 * 60_000, now)).toBe('in 5 minutes');
    expect(formatRelativeExpiry(now + 60 * 60_000, now)).toBe('in 1 hour');
    expect(formatRelativeExpiry(now + 3 * 60 * 60_000, now)).toBe('in 3 hours');
    expect(formatRelativeExpiry(now + 24 * 60 * 60_000, now)).toBe('in 1 day');
    expect(formatRelativeExpiry(now + 3 * 24 * 60 * 60_000, now)).toBe('in 3 days');
  });
});

describe('formatCountdown', () => {
  test('zero-pads seconds and clamps negatives', () => {
    expect(formatCountdown(599)).toBe('9:59');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(5)).toBe('0:05');
    expect(formatCountdown(-10)).toBe('0:00');
  });
});
