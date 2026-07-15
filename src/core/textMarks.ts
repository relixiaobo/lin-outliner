import type { TextMark } from './types';

export function textMarkIdentity(mark: Pick<TextMark, 'type' | 'attrs'>): string {
  const attrs = Object.entries(mark.attrs ?? {})
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  return JSON.stringify([mark.type, attrs]);
}

export function mergeEquivalentTextMarks(marks: readonly TextMark[]): TextMark[] {
  const grouped = marks.map((mark) => ({ mark, identity: textMarkIdentity(mark) })).sort((left, right) => (
    left.identity.localeCompare(right.identity)
    || left.mark.start - right.mark.start
    || left.mark.end - right.mark.end
  ));
  const merged: TextMark[] = [];
  let previousIdentity: string | undefined;
  for (const { mark, identity } of grouped) {
    const previous = merged[merged.length - 1];
    if (
      previous
      && previousIdentity === identity
      && mark.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, mark.end);
      continue;
    }
    merged.push({
      ...mark,
      ...(mark.attrs ? { attrs: { ...mark.attrs } } : {}),
    });
    previousIdentity = identity;
  }
  return merged;
}
