import { describe, expect, test } from 'bun:test';
import {
  hasTranscriptContentBelow,
  isTranscriptFollowing,
  transcriptNeedsSendAnchor,
} from '../../src/renderer/agent/threadScrollFollow';

describe('thread scroll follow', () => {
  test('anchors sends only after real transcript content exceeds one viewport', () => {
    expect(transcriptNeedsSendAnchor({ clientHeight: 600, scrollHeight: 600 })).toBe(false);
    expect(transcriptNeedsSendAnchor({ clientHeight: 600, scrollHeight: 601 })).toBe(false);
    expect(transcriptNeedsSendAnchor({ clientHeight: 600, scrollHeight: 602 })).toBe(true);
  });

  test('derives follow only from the current distance to the bottom', () => {
    expect(isTranscriptFollowing({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 544 })).toBe(true);
    expect(isTranscriptFollowing({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 543 })).toBe(false);
    expect(hasTranscriptContentBelow({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 599 })).toBe(false);
    expect(hasTranscriptContentBelow({ clientHeight: 400, scrollHeight: 1_000, scrollTop: 598 })).toBe(true);
  });
});
