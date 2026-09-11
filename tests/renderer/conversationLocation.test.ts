import { describe, expect, test } from 'bun:test';
import { conversationLocationLabel } from '../../src/renderer/agent/projects/locationLabel';
import { compactEffortLabel, distinctCompactModelName } from '../../src/renderer/agent/components/composerModelLabel';
import type { ProjectCatalogView } from '../../src/core/agent/project';

const labels = { applicationDefault: 'Application default', unavailable: 'Unavailable', loading: 'Loading' };
function view(project: boolean, path: string | null): ProjectCatalogView {
  return { projects: [{ id: 'p', name: 'Project', folders: path ? [path] : [], primaryFolder: path, revision: 1, createdAt: 1, updatedAt: 1 }],
    memberships: [{ threadId: 'chat', projectId: project ? 'p' : null, revision: 1 }],
    unavailableFolders: [], applicationDefault: { path: '/one/source', available: true } };
}
describe('conversation location presentation', () => {
  test.each([
    [false, null, ''], [true, '/one/source', 'Project'], [true, '/two/worktree', 'Project'],
    [true, null, 'Project · Application default'], [false, '/two/worktree', ''],
  ] as const)('saved settings %s %s render %s', (project, path, text) => {
    expect(conversationLocationLabel('chat', view(project, path), labels).text).toBe(text);
  });
  test('unknown membership and missing paths remain distinguishable from an unbound chat', () => {
    expect(conversationLocationLabel('unknown', view(false, null), labels).text).toBe('Loading');
    expect(conversationLocationLabel('chat', { ...view(true, null), projects: [] }, labels)).toMatchObject({ text: 'Unavailable', detail: 'Unavailable', unavailable: true });
    const selected = view(true, '/one/source');
    expect(conversationLocationLabel('chat', { ...selected, unavailableFolders: ['/one/source'] }, labels)).toMatchObject({ text: 'Project · Unavailable', detail: 'Project · Unavailable\n/one/source' });
  });

});

describe('compact composer model identity', () => {
  test.each([
    ['Claude Sonnet 5', 'Sonnet 5'], ['Anthropic Claude Opus 4.6 Thinking', 'Opus 4.6 Thinking'],
    ['Claude Haiku 4.5 20251001', 'Haiku 4.5 20251001'], ['OpenAI GPT-5.4 Pro', 'GPT-5.4 Pro'],
    ['OpenAI o3-mini', 'o3-mini'], ['Google Gemini 3.1 Flash-Lite Preview', 'Gemini 3.1 Flash-Lite Preview'],
    ['DeepSeek V3.2 Reasoner', 'DeepSeek V3.2 Reasoner'], ['Qwen3 235B Coder Instruct', 'Qwen3 235B Coder Instruct'],
    ['Kimi K2 Thinking', 'Kimi K2 Thinking'], ['GLM 4.7', 'GLM 4.7'], ['Grok 4 Fast', 'Grok 4 Fast'],
    ['MiniMax M2.5', 'MiniMax M2.5'], ['Mistral Small 3.2', 'Mistral Small 3.2'], ['MiMo V2 Flash', 'MiMo V2 Flash'],
    ['My Personal Pro', 'My Personal Pro'], ['vendor/custom-quantized-4bit', 'vendor/custom-quantized-4bit'],
  ])('preserves identity for %s', (name, expected) => {
    expect(distinctCompactModelName(name, 'id', [{ id: 'id', name }])).toBe(expected);
  });
  test('same-connection collisions retain the distinguishing original or ID', () => {
    const models = [{ id: 'one', name: 'Claude Sonnet 5' }, { id: 'two', name: 'Sonnet 5' }];
    expect(distinctCompactModelName(models[0]!.name, 'one', models)).toBe('Claude Sonnet 5');
    expect(distinctCompactModelName('Custom', 'one', [{ id: 'one', name: 'Custom' }, { id: 'two', name: 'Custom' }])).toBe('Custom (one)');
  });
  test('display labels, including provider Max in canonical xhigh, keep distinct effort meanings', () => {
    const copy = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'XH', max: 'Max' };
    expect(['Off', 'Minimal', 'Low', 'Medium', 'High', 'XHigh', 'Max'].map((value) => compactEffortLabel(value, copy)))
      .toEqual(['Off', 'Min', 'Low', 'Med', 'High', 'XH', 'Max']);
    for (const label of ['Adaptive', 'Thinking', 'Ultra', 'Auto', '中', '最高']) expect(compactEffortLabel(label, copy)).toBe(label);
  });
});
