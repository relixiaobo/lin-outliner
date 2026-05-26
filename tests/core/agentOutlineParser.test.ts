import { describe, expect, test } from 'bun:test';
import { parseLinOutline } from '../../src/main/agentOutlineParser';

describe('agent outline parser', () => {
  test('parses full-line node references with and without display names', () => {
    const parsed = parseLinOutline([
      '- [[Alpha^node-alpha]]',
      '- [[^node-beta]]',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots).toEqual([
      expect.objectContaining({
        referenceTargetId: 'node-alpha',
        title: 'Alpha',
      }),
      expect.objectContaining({
        referenceTargetId: 'node-beta',
        title: 'node-beta',
      }),
    ]);
  });
});
