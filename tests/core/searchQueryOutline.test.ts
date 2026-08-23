import { describe, expect, test } from 'bun:test';
import { Core } from '../../src/core/core';
import { formatNodeReferenceMarker } from '../../src/core/referenceMarkup';
import { parseSearchQueryOutline } from '../../src/core/searchQueryOutline';

describe('shared search query outline parser', () => {
  test('parses nested groups with typed definition and literal operands', () => {
    const core = Core.new();
    const tagId = requiredFocus(core.createTag('Work'));
    const fieldId = requiredFocus(core.createFieldDefinition('Status', 'plain'));

    const result = parseSearchQueryOutline(core.projection(), [
      '- AND',
      '  - HAS_TAG',
      `    - tag:: ${formatNodeReferenceMarker('#Work', tagId)}`,
      '  - FIELD_IS',
      `    - field:: ${formatNodeReferenceMarker('Status', fieldId)}`,
      '    - value:: In progress',
    ].join('\n'));

    expect(result).toEqual({
      ok: true,
      query: {
        kind: 'group',
        logic: 'AND',
        children: [
          { kind: 'rule', op: 'HAS_TAG', tagDefId: tagId },
          {
            kind: 'rule',
            op: 'FIELD_IS',
            fieldDefId: fieldId,
            text: 'In progress',
            operands: [{ text: 'In progress' }],
          },
        ],
      },
    });
  });

  test('rejects directives, wrong reference types, and incomplete rules', () => {
    const core = Core.new();
    const ordinaryId = requiredFocus(core.createNode(core.projection().todayId, null, 'Ordinary'));

    expect(parseSearchQueryOutline(core.projection(), '- %%search%% Nested')).toMatchObject({
      ok: false,
      message: expect.stringContaining('cannot contain directives'),
    });
    expect(parseSearchQueryOutline(core.projection(), [
      '- HAS_TAG',
      `  - tag:: ${formatNodeReferenceMarker('Ordinary', ordinaryId)}`,
    ].join('\n'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('tagDef'),
    });
    expect(parseSearchQueryOutline(core.projection(), '- STRING_MATCH')).toMatchObject({
      ok: false,
      message: expect.stringContaining('requires value::'),
    });
  });
});

function requiredFocus(outcome: { focus?: { nodeId: string } }): string {
  if (!outcome.focus) throw new Error('Expected a focused Node.');
  return outcome.focus.nodeId;
}
