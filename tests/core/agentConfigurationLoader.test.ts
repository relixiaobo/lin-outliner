import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentConfigurationLoader', () => {
  test('resolves the built-in default Profile and Roles without configuration files', async () => {
    const { userData, cwd } = await fixturePaths();
    const loader = new AgentConfigurationLoader(userData);

    expect(loader.resolveProfile(undefined, cwd)).toMatchObject({
      profileName: 'default',
      model: 'inherit',
      reasoningEffort: 'medium',
    });
    expect(loader.resolveProfile(undefined, cwd).tools).toContain('collaboration.spawn_agent');
    expect(loader.resolveRole('worker', cwd)).toMatchObject({
      name: 'worker',
      source: 'builtIn',
    });
  });

  test('loads user Profiles and lets project Profiles and Roles take precedence', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      defaultProfile: 'coding',
      profiles: {
        coding: {
          developerInstructions: 'Follow the user configuration.',
          model: 'user-model',
          reasoningEffort: 'high',
          tools: ['node_read', 'file_read'],
          skills: ['user-skill'],
          plugins: ['github'],
          mcpServers: ['docs'],
        },
      },
      roles: {
        reviewer: {
          description: 'Review the implementation.',
          developerInstructions: 'Find concrete correctness issues.',
          nicknameCandidates: ['Ada'],
          overrides: { tools: ['node_read'] },
        },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      profiles: {
        coding: {
          developerInstructions: 'Follow the project configuration.',
          model: 'project-model',
          tools: ['node_read'],
        },
      },
      roles: {
        reviewer: {
          description: 'Review this project.',
          developerInstructions: 'Use the project review policy.',
          nicknameCandidates: ['Noether'],
          overrides: {
            model: 'review-model',
            reasoningEffort: 'xhigh',
            tools: ['node_read'],
          },
        },
      },
    });

    const loader = new AgentConfigurationLoader(userData);
    expect(loader.resolveProfile(undefined, cwd)).toEqual({
      profileName: 'coding',
      developerInstructions: ['Follow the project configuration.'],
      model: 'project-model',
      reasoningEffort: 'medium',
      tools: ['node_read'],
      skills: [],
      plugins: [],
      mcpServers: [],
    });
    expect(loader.resolveRole('reviewer', cwd)).toEqual({
      name: 'reviewer',
      source: 'project',
      description: 'Review this project.',
      developerInstructions: 'Use the project review policy.',
      nicknameCandidates: ['Noether'],
      overrides: {
        model: 'review-model',
        reasoningEffort: 'xhigh',
        tools: ['node_read'],
      },
    });
  });

  test('fails closed on unknown fields and unavailable selections', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      profiles: { broken: { permissionProfile: 'full-access' } },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(() => loader.resolveProfile('broken', cwd)).toThrow('unknown field: permissionProfile');
    await writeJson(userConfigurationPath(userData), {});
    expect(() => loader.resolveProfile('missing', cwd)).toThrow('Unknown Configuration Profile');
    expect(() => loader.resolveRole('missing', cwd)).toThrow('Unknown Agent Role');
  });
});

async function fixturePaths(): Promise<{ userData: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-agent-configuration-'));
  roots.push(root);
  const userData = join(root, 'user-data');
  const cwd = join(root, 'project');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(cwd, { recursive: true })]);
  return { userData, cwd };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
