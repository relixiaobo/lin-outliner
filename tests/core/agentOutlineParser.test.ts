import { describe, expect, test } from 'bun:test';
import { markdownReferenceMarkupToRichText, richTextToMarkdownReferenceMarkup } from '../../src/core/markdownRichText';
import { escapeSemanticText } from '../../src/core/semanticIngest/inlineScanner';
import { parseLinOutline } from '../../src/main/agent/capabilities/agentOutlineParser';

const NODE_ALPHA_ID = 'node:11111111-1111-4111-8111-111111111111';
const NODE_ALPHA_MARKER = '[[node://11111111-1111-4111-8111-111111111111]]';
const NODE_BETA_ID = 'node:22222222-2222-4222-8222-222222222222';
const NODE_BETA_MARKER = '[[node://22222222-2222-4222-8222-222222222222]]';

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

  test('parses full-line Node references with adjacent or resolved display names', () => {
    const parsed = parseLinOutline([
      `- Alpha: ${NODE_ALPHA_MARKER}`,
      `- ${NODE_BETA_MARKER}`,
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots).toEqual([
      expect.objectContaining({
        referenceTargetId: NODE_ALPHA_ID,
        title: 'Alpha',
      }),
      expect.objectContaining({
        referenceTargetId: NODE_BETA_ID,
        title: NODE_BETA_ID,
      }),
    ]);
  });

  test('does not promote mixed file and Node inline references to a tree reference', () => {
    const parsed = parseLinOutline(
      '- Compare [[file:///tmp/left.txt]]: [[node://11111111-1111-4111-8111-111111111111]]',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const root = parsed.document.roots[0]!;
    expect(root.referenceTargetId).toBeUndefined();
    expect(root.title)
      .toBe('Compare [[file:///tmp/left.txt]]: [[node://11111111-1111-4111-8111-111111111111]]');
  });

  test('does not extract tags from reference URI paths', () => {
    const parsed = parseLinOutline([
      `- Task: ${NODE_ALPHA_MARKER}`,
      `- Work ${NODE_BETA_MARKER} #todo`,
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      referenceTargetId: NODE_ALPHA_ID,
      title: 'Task',
      tags: [],
    });
    expect(parsed.document.roots[1]).toMatchObject({
      title: `Work ${NODE_BETA_MARKER}`,
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

  test('keeps strict structure syntax literal inside shared protected ranges', () => {
    const linked = '[Foo:: Bar - details %%node:literal%% %%search%% %%view:table%%](https://example.com)';
    const parsed = parseLinOutline([
      '- `Status:: open`',
      '- `%%search%% %%view:table%%`',
      `- ${linked}`,
      `- ${NODE_ALPHA_MARKER}`,
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.fields).toEqual([]);
    expect(parsed.document.roots[0]).toMatchObject({
      title: '`Status:: open`',
      description: null,
      search: false,
    });
    expect(parsed.document.roots[1]).toMatchObject({
      title: '`%%search%% %%view:table%%`',
      search: false,
      view: undefined,
    });
    expect(parsed.document.roots[2]).toMatchObject({
      title: linked,
      description: null,
      search: false,
      view: undefined,
    });
    expect(parsed.document.roots[3]).toMatchObject({
      title: NODE_ALPHA_ID,
      referenceTargetId: NODE_ALPHA_ID,
    });
  });

  test('parses a view directive on an ordinary node owner', () => {
    const parsed = parseLinOutline([
      '- %%view:table%% Projects',
      '  - Alpha',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'Projects',
      search: false,
      view: 'table',
      children: [expect.objectContaining({ title: 'Alpha' })],
    });
  });

  test('extracts typed view configuration lines without consuming document children', () => {
    const parsed = parseLinOutline([
      '- %%view:table%% Projects',
      '  - %%node:sort-a%% %%view-sort%%',
      '    - field:: sys:updatedAt',
      '    - direction:: desc',
      '  - %%view-filter%%',
      '    - field:: field:11111111-1111-4111-8111-111111111111',
      '    - operator:: is',
      '    - logic:: any',
      '    - value:: Active',
      '  - %%view-group%%',
      '    - field:: field:11111111-1111-4111-8111-111111111111',
      '  - %%node:display-a%% %%view-display%%',
      '    - field:: field:11111111-1111-4111-8111-111111111111',
      '    - label:: State',
      '    - width:: 180',
      '    - visible:: true',
      '    - order:: 0',
      '  - Record',
    ].join('\n'), { annotations: 'allow' });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const filterConfig = parsed.document.roots[0]!.viewConfig!
      .find((config) => config.kind === 'filter');
    expect(filterConfig?.fields).toEqual([
      expect.objectContaining({ name: 'field', values: [{ text: 'field:11111111-1111-4111-8111-111111111111' }] }),
      expect.objectContaining({ name: 'operator', values: [{ text: 'is' }] }),
      expect.objectContaining({ name: 'logic', values: [{ text: 'any' }] }),
      expect.objectContaining({ name: 'value', values: [{ text: 'Active' }] }),
    ]);
    expect(parsed.document.roots[0]).toMatchObject({
      title: 'Projects',
      view: 'table',
      children: [expect.objectContaining({ title: 'Record' })],
      viewConfig: [
        expect.objectContaining({ nodeId: 'sort-a', directive: '%%view-sort%%', kind: 'sort' }),
        expect.objectContaining({ directive: '%%view-filter%%', kind: 'filter' }),
        expect.objectContaining({ directive: '%%view-group%%', kind: 'group' }),
        expect.objectContaining({ nodeId: 'display-a', directive: '%%view-display%%', kind: 'display' }),
      ],
    });
  });

  test('retains unsupported view configuration header syntax for fail-closed validation', () => {
    const parsed = parseLinOutline([
      '- Board',
      '  - [x] %%view-sort%% #workflow - accidental metadata',
      '    - field:: sys:updatedAt',
    ].join('\n'));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.roots[0]!.viewConfig).toEqual([
      expect.objectContaining({
        directive: '%%view-sort%%',
        kind: 'sort',
        hasUnsupportedHeaderSyntax: true,
      }),
    ]);
  });

  test('canonical escaping round-trips generated field and description boundaries', () => {
    const alphabet = ['A', ':', '-', '#', '%', '\\', '[', ']', '*'];
    const fieldNames = [
      ...alphabet,
      ...alphabet.flatMap((left) => alphabet.map((right) => `${left}${right}`)),
    ];
    for (const name of fieldNames) {
      const parsed = parseLinOutline(`- ${escapeSemanticText(name, { suffix: '::' })}:: value`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.document.fields[0]?.name).toBe(name);
      expect(parsed.document.fields[0]?.values[0]?.text).toBe('value');
    }

    const titles = ['Ends -', 'A::', '#tag', '%%search%%', '[x]', String.raw`C:\path`];
    for (const title of titles) {
      const source = richTextToMarkdownReferenceMarkup({
        text: title,
        marks: [],
        inlineRefs: [],
      }, { suffix: ' - ' });
      const parsed = parseLinOutline(`- ${source} - details`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const root = parsed.document.roots[0]!;
      expect(markdownReferenceMarkupToRichText(root.title).text).toBe(title);
      expect(root.description).toBe('details');
      expect(root.tags).toEqual([]);
      expect(root.search).toBe(false);
    }
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
