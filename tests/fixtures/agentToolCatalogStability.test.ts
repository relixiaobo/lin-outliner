import { describe, expect, mock, test } from 'bun:test';
import type { EffectiveThreadConfiguration } from '../../src/core/agent/configuration';
import { MODEL_TOOL_CATALOG, canonicalModelToolKey } from '../../src/core/agent/tools';
import type { ThreadService } from '../../src/main/agent/ThreadService';
import type { AgentImageGenerationRuntime } from '../../src/main/agent/capabilities/agentImageGenerationTool';
import type { OutlinerToolHost } from '../../src/main/agent/capabilities/agentNodeTools';
import type { TurnExecutionContext } from '../../src/main/agent/runtime/types';

mock.module('electron', () => ({
  BrowserWindow: class {},
  session: {
    fromPartition: () => { throw new Error('catalog test does not create Electron sessions'); },
  },
}));

const configuration: EffectiveThreadConfiguration = {
  profileName: 'catalog-stability-test',
  developerInstructions: [],
  model: 'inherit',
  reasoningEffort: 'medium',
  tools: MODEL_TOOL_CATALOG.map((tool) => canonicalModelToolKey(tool.identity)),
  skills: ['*'],
  plugins: [],
  mcpServers: [],
};

const outliner: OutlinerToolHost = {
  getProjection: () => { throw new Error('catalog test does not read the Outliner'); },
  handle: async () => { throw new Error('catalog test does not mutate the Outliner'); },
};

const imageGeneration = {
  listModels: async () => [],
  getActiveProviderId: async () => null,
  readLocalImage: async () => { throw new Error('catalog test does not read images'); },
  writeGeneratedImage: async () => { throw new Error('catalog test does not write images'); },
  preparePromptImage: async () => { throw new Error('catalog test does not prepare images'); },
  generateImages: async () => { throw new Error('catalog test does not generate images'); },
} satisfies AgentImageGenerationRuntime;

const context = {
  thread: {
    id: '00000000-0000-7000-8000-000000000001',
    parentThreadId: null,
    cwd: '/representative/project',
  },
  turn: { id: '00000000-0000-7000-8000-000000000002' },
  configuration,
} as TurnExecutionContext;

describe('canonical provider tool catalog', () => {
  test('keeps names, order, descriptions, and JSON schemas byte-stable', async () => {
    const [
      { AgentSkillRuntime },
      { canonicalizeAgentTools },
      { ToolRuntime },
      { SubagentCollaboration },
    ] = await Promise.all([
      import('../../src/main/agent/capabilities/agentSkills'),
      import('../../src/main/agent/runtime/PiTurnExecutor'),
      import('../../src/main/agent/runtime/ToolRuntime'),
      import('../../src/main/agent/thread/SubagentCollaboration'),
    ]);
    const collaboration = Object.create(SubagentCollaboration.prototype) as SubagentCollaboration;
    const service = {
      extensionToolContributions: async () => [],
      collaborationToolContributions: (turn: { threadId: string; turnId: string }) => (
        collaboration.collaborationToolContributions(turn)
      ),
    } as unknown as ThreadService;
    const skillRuntime = new AgentSkillRuntime({
      localRoot: context.thread.cwd,
      includeUserSkills: false,
      builtInSkillDirectories: [],
      builtInSkills: [],
    });
    const runtime = new ToolRuntime(service, {
      outliner,
      skillRuntime,
      imageGeneration,
      capabilityConfig: { blocks: [] },
    });
    const tools = canonicalizeAgentTools(await runtime.createTools(context));
    const catalog = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const mutation = process.env.TENON_TOOL_CATALOG_TEST_MUTATION;
    if (mutation === 'reorder') {
      const first = catalog[0]!;
      catalog[0] = catalog[1]!;
      catalog[1] = first;
    }
    if (mutation === 'description') catalog[0]!.description += ' Deliberate judge mutation.';

    expect(JSON.stringify(catalog, null, 2)).toMatchSnapshot();
  });
});
