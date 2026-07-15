import { describe, expect, test } from 'bun:test';
import { parseLinOutline } from '../../src/main/agentOutlineParser';

describe('agent outline parser', () => {
  test('parses top-level field lines as document fields', () => {
    const parsed = parseLinOutline([
      '- xmlUrl:: https://example.com/feed.xml',
      '- Status::',
      '  - Active',
      '  - Paused',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots).toEqual([]);
    expect(parsed.document.fields).toEqual([
      {
        name: 'xmlUrl',
        values: [{ text: 'https://example.com/feed.xml' }],
        clear: false,
      },
      {
        name: 'Status',
        values: [{ text: 'Active' }, { text: 'Paused' }],
        clear: false,
      },
    ]);
  });

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
      '- Palette #中文 [[#tag]] #[[multi word]] #[[needs \\] bracket]] #[[C:\\path]] #fff #fffff #fff-bug #office',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'Palette #fff',
      tags: ['中文', 'tag', 'multi word', 'needs ] bracket', String.raw`C:\path`, 'fffff', 'fff-bug', 'office'],
    });
  });

  test('keeps escaped control syntax literal and search operand tags as values', () => {
    const parsed = parseLinOutline([
      String.raw`- Literal \#tag Status\:: value \[x] \%%search%%`,
      '- STRING_MATCH',
      '  - value:: #project',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: String.raw`Literal \#tag Status\:: value \[x] \%%search%%`,
      tags: [],
      search: false,
    });
    expect(parsed.document.roots[1]?.fields[0]?.values).toEqual([{ text: '#project' }]);
  });

  test('decodes canonical escapes in descriptions and field names', () => {
    const parsed = parseLinOutline([
      String.raw`- Title - Literal \#tag \%\%search\%\%`,
      String.raw`  - Status\:\: label:: Open`,
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]?.description).toBe('Literal #tag %%search%%');
    expect(parsed.document.roots[0]?.tags).toEqual([]);
    expect(parsed.document.roots[0]?.search).toBe(false);
    expect(parsed.document.roots[0]?.fields[0]).toMatchObject({
      name: 'Status:: label',
      values: [{ text: 'Open' }],
    });
  });

  test('requires checkbox markers to be separated from body text', () => {
    const parsed = parseLinOutline([
      '- [x] shipped',
      '- [ ]',
      '- [x]pending',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'shipped',
      checked: true,
    });
    expect(parsed.document.roots[1]).toMatchObject({
      title: '(untitled)',
      checked: false,
    });
    expect(parsed.document.roots[2]?.title).toBe('[x]pending');
    expect(parsed.document.roots[2]?.checked).toBeUndefined();
  });

  test('rejects unclosed code fences', () => {
    const parsed = parseLinOutline([
      '- ```ts',
      'const x = 1',
      '- Next node',
    ].join('\n'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('unclosed_code_fence');
    expect(parsed.error.line).toBe(1);
    expect(parsed.error.message).toContain('closing ``` fence');
  });

  test('supports longer code fences when the body contains shorter fences', () => {
    const parsed = parseLinOutline([
      '- ````ts',
      '```literal',
      '````',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      codeBlock: true,
      codeLanguage: 'typescript',
      title: '```literal',
    });
  });
});
