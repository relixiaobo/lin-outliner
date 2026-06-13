import { describe, expect, test } from 'bun:test';
import { parseLinOutline } from '../../src/main/agentOutlineParser';

describe('agent outline parser', () => {
  test('parses full-line node references with and without display names', () => {
    const parsed = parseLinOutline([
      '- [[node:Alpha^node-alpha]]',
      '- [[node:^node-beta]]',
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

  test('does not extract tags from reference marker labels', () => {
    const parsed = parseLinOutline([
      '- [[node:#task^tag-node]]',
      '- Work [[node:#project^project-node]] #todo',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      referenceTargetId: 'tag-node',
      title: '#task',
      tags: [],
    });
    expect(parsed.document.roots[1]).toMatchObject({
      title: 'Work [[node:#project^project-node]]',
      tags: ['todo'],
    });
  });

  test('uses the shared tag grammar and leaves bare hex colors as title text', () => {
    const parsed = parseLinOutline([
      '- Palette #中文 [[#tag]] #[[multi word]] #[[needs \\] bracket]] #fff #fffff #fff-bug #office',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'Palette #fff',
      tags: ['中文', 'tag', 'multi word', 'needs ] bracket', 'fffff', 'fff-bug', 'office'],
    });
  });

  test('requires checkbox markers to be separated from body text', () => {
    const parsed = parseLinOutline([
      '- [x] shipped',
      '- [x]pending',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'shipped',
      checked: true,
    });
    expect(parsed.document.roots[1]?.title).toBe('[x]pending');
    expect(parsed.document.roots[1]?.checked).toBeUndefined();
  });
});
