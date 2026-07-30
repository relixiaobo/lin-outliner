interface TranscriptScrollPosition {
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly scrollTop: number;
}

export const TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX = 56;

export function isTranscriptFollowing(position: TranscriptScrollPosition): boolean {
  return position.scrollHeight - position.scrollTop - position.clientHeight
    <= TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD_PX;
}

export function hasTranscriptContentBelow(position: TranscriptScrollPosition): boolean {
  return position.scrollHeight - position.scrollTop - position.clientHeight > 1;
}
