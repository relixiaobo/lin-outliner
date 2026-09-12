import { describe, expect, test } from 'bun:test';
import { formatFileReferenceMarker, formatNodeReferenceMarker } from '../../src/core/referenceMarkup';
import { scheduledBriefMaterials, scheduledInlineMaterials } from '../../src/core/agent/scheduledBrief';
import { scheduledBriefContent, scheduledBriefText } from '../../src/renderer/agent/automations/scheduledBriefEditor';
import { freshNodeId } from '../../src/core/nodeId';

describe('Scheduled brief shared reference representation', () => {
  test('keeps repeated source positions and roles across title changes and plain URLs', () => {
    const node = freshNodeId();
    const note = formatNodeReferenceMarker(node);
    const file = formatFileReferenceMarker('/tmp/Proposal final.md');
    const prompt = `Compare ${note} with ${file}.\nUpdate ${file}; consult https://example.com/research.`;
    const initial = scheduledBriefContent(prompt, () => 'Requirements');
    expect(scheduledBriefText(initial)).toBe(prompt);
    const renamed = scheduledBriefContent(prompt, () => 'Renamed requirements');
    expect(scheduledBriefText(renamed)).toBe(prompt);
    expect(renamed.filter((part) => part.type === 'fileReference')).toHaveLength(2);
    expect(scheduledInlineMaterials(prompt)).toHaveLength(2);
  });
  test('preserves detached context and one policy per distinct inline source', () => {
    const file = formatFileReferenceMarker('/tmp/a.md');
    expect(scheduledBriefMaterials(`${file} ${file}`, [
      { kind: 'file', reference: '/tmp/a.md', required: false },
      { kind: 'url', reference: 'https://example.com/a', required: true },
    ])).toEqual([
      { kind: 'file', reference: '/tmp/a.md', required: false },
      { kind: 'url', reference: 'https://example.com/a', required: true },
    ]);
  });
  test('literal mentions and escaped markers stay literal and do not require sources', () => {
    const prompt = `Email name@example.com. \\${formatFileReferenceMarker('/missing')} @Requirements`;
    expect(scheduledBriefText(scheduledBriefContent(prompt, () => 'Unused'))).toBe(prompt);
    expect(scheduledInlineMaterials(prompt)).toEqual([]);
  });
  test('refuses transient conversation attachments rather than silently dropping them', () => {
    expect(() => scheduledBriefText([{ type: 'pendingFileReference', reference: { requestId: 'pending', name: 'clip' } }])).toThrow();
    expect(() => scheduledBriefText([{ type: 'nodeReference', reference: { nodeId: 'not-a-public-node', title: 'Title' } }])).toThrow();
  });
  test('enforces the combined limit at the shared source boundary', () => {
    const prompt = Array.from({ length: 33 }, (_, n) => formatFileReferenceMarker(`/tmp/${n}`)).join(' ');
    expect(() => scheduledBriefMaterials(prompt, [])).toThrow('32');
  });
  test('file whitespace survives both markup and material admission', () => {
    const path = '/tmp/source with trailing space ';
    const prompt = `Read ${formatFileReferenceMarker(path)}`;
    expect(scheduledBriefText(scheduledBriefContent(prompt, () => 'Unused'))).toBe(prompt);
    expect(scheduledBriefMaterials(prompt, [])).toEqual([{ kind: 'file', reference: path, required: true }]);
  });
});
