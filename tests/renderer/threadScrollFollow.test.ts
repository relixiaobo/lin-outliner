import { describe, expect, test } from 'bun:test';
import {
  hasTranscriptContentBelow,
  isTranscriptFollowing,
} from '../../src/renderer/agent/threadScrollFollow';

describe('thread scroll follow', () => {
  test('derives follow only from the current distance to the bottom', () => {
    expect(isTranscriptFollowing({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 544 })).toBe(true);
    expect(isTranscriptFollowing({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 543 })).toBe(false);
    expect(hasTranscriptContentBelow({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 599 })).toBe(false);
    expect(hasTranscriptContentBelow({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 598 })).toBe(true);
  });
});
