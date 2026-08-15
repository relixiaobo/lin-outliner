import { describe, expect, test } from 'bun:test';
import remend from 'remend';
import { repairStreamingMarkdown } from '../../src/renderer/agent/streamingMarkdownRepair';

describe('streaming Markdown repair', () => {
  test('matches canonical repair across emphasis boundaries and staged whitespace', () => {
    const cases = [
      'A *stray marker across\n\na second paragraph.',
      '**Bold start with _nested italic',
      '__Double underscore half close_',
      '_Single underscore before **nested bold',
      '_Single underscore before **nested bold**\n\n',
      '`code with *literal emphasis*` and _open italic',
      '$5 leaves *emphasis* in alternating math context and _opens here',
      'Identifiers such as read_only_flag and cached_entry_name stay literal.',
      'Arithmetic such as 2*3 and w*h stays literal without a dollar sign.',
      'Text before an incomplete image ![partial alt',
      '`code before an incomplete image ![partial alt',
      'Text before an incomplete image with a space ![partial alt',
      '***Nested emphasis remains open',
      'Four markers stay literal: ****',
    ];

    for (const source of cases) {
      expect(repairStreamingMarkdown(source)).toBe(remend(source));
    }
  });

  test('matches canonical repair across a disjoint deterministic append corpus', () => {
    const fragments = [
      'plain', ' word', '.', ':', '1', ' alpha',
      '\n', '\n\n', '\n\n\n', '  ', '\t', '\r\n',
      '# ', '## heading', '---', '==',
      '- item', '* item', '1. item', '> quote', '- [ ] task',
      '`', '``', '```', '```ts', '\n```', '~~~', '~~~js',
      '*', '**', '***', '_', '__', '~~', '$$', '$5',
      '[', ']', '](', ')', '[ref]', '[ref]: https://example.test',
      '![alt', '![alt](path', '[^n]', '[^n]: note',
      '<div>', '</div>', '<span', '<!-- note -->', '<https://example.test>',
      '| a | b |', '| --- | --- |',
      '\\*', '\\`', '\\(', '\\$', '\u4e2d\u6587', '\u00e9',
    ] as const;
    let compared = 0;
    let canonicalRepairs = 0;
    let italicSensitiveRepairs = 0;

    for (let seed = 1; seed <= 500; seed += 1) {
      const next = deterministicRandom(seed);
      let source = '';
      for (let append = 0; append < 60; append += 1) {
        source += fragments[Math.floor(next() * fragments.length)]!;
        const canonical = remend(source);
        const withoutItalic = remend(source, { italic: false });
        const repaired = repairStreamingMarkdown(source);
        if (repaired !== canonical) {
          throw new Error(`Repair divergence: ${JSON.stringify({ append, seed, source })}`);
        }
        if (canonical !== source) canonicalRepairs += 1;
        if (canonical !== withoutItalic) italicSensitiveRepairs += 1;
        compared += 1;
      }
    }

    expect(compared).toBe(30_000);
    expect(canonicalRepairs).toBeGreaterThan(5_000);
    expect(italicSensitiveRepairs).toBeGreaterThan(250);
  }, 15_000);
});

function deterministicRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 4_294_967_296;
  };
}
