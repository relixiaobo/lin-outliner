import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AgentConfigurationLoader,
  projectConfigurationPath,
  userConfigurationPath,
} from '../../src/main/agent/AgentConfigurationLoader';
import {
  DERIVED_IDENTITY_COLORS,
  deriveIdentityColor,
} from '../../src/core/agent/configuration';

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
      skills: ['*'],
    });
    expect(loader.resolveProfile(undefined, cwd).tools).toContain('skill');
    expect(loader.resolveRole('plan', cwd)).toMatchObject({
      name: 'plan',
      source: 'builtIn',
    });
    const roleCatalog = loader.buildRoleCatalogSnapshot(cwd);
    expect(roleCatalog).toMatchObject({
      kind: 'roleCatalog',
      mode: 'baseline',
      previousCatalogHash: null,
    });
    expect(roleCatalog.entries.map((entry) => ({
      name: entry.name,
      source: entry.source,
      identity: entry.identity,
    }))).toEqual([
      { name: 'general-purpose', source: 'built-in', identity: 'built-in:general-purpose' },
      { name: 'explore', source: 'built-in', identity: 'built-in:explore' },
      { name: 'plan', source: 'built-in', identity: 'built-in:plan' },
    ]);
  });

  test('resolves canonical built-in and configured Agent types without exposing backing Roles', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(projectConfigurationPath(cwd), {
      roles: {
        worker: {
          description: 'Project worker.',
          developerInstructions: 'Run project work.',
        },
        foo_bar: {
          description: 'Underscore Role.',
          developerInstructions: 'Use underscores.',
        },
        'foo-bar': {
          description: 'Hyphen Role.',
          developerInstructions: 'Use hyphens.',
        },
      },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(loader.resolveAgentType(undefined, cwd)).toMatchObject({
      canonicalType: 'general-purpose',
      kind: 'general-purpose',
      role: { name: 'default' },
    });
    expect(loader.resolveAgentType('GENERAL PURPOSE', cwd)).toMatchObject({
      canonicalType: 'general-purpose',
      role: { name: 'default' },
    });
    expect(loader.resolveAgentType(' Plan ', cwd)).toMatchObject({
      canonicalType: 'plan',
      role: { name: 'plan' },
    });
    expect(loader.resolveAgentType('general-purpose', cwd).role.developerInstructions)
      .toContain('Complete the task fully—don\'t gold-plate, but don\'t leave it half-done.');
    expect(loader.resolveAgentType('explore', cwd).role.developerInstructions)
      .toContain('multiple parallel tool calls for grepping and reading files');
    expect(loader.resolveAgentType('plan', cwd).role.developerInstructions)
      .toContain('### Critical Files for Implementation');
    expect(loader.resolveAgentType('worker', cwd)).toMatchObject({
      canonicalType: 'worker',
      kind: 'role',
      role: { source: 'project' },
    });
    expect(() => loader.resolveAgentType('foo bar', cwd)).toThrow(
      "Agent type 'foo bar' is ambiguous — matches foo-bar, foo_bar. Use the exact name: foo-bar or foo_bar",
    );
    expect(() => loader.resolveAgentType('missing', cwd)).toThrow(
      'Available agents: general-purpose, explore, plan, foo-bar, foo_bar, worker',
    );
    expect(loader.buildAgentTypeCatalogSnapshot(cwd).entries.map((entry) => entry.name)).toEqual([
      'general-purpose',
      'explore',
      'plan',
      'foo-bar',
      'foo_bar',
      'worker',
    ]);
  });

  test('keeps an explicitly configured explorer Role selectable beside the canonical explore type', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(projectConfigurationPath(cwd), {
      roles: {
        explorer: {
          description: 'Project-specific explorer.',
          developerInstructions: 'Use the project exploration workflow.',
        },
      },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(loader.resolveAgentType('explore', cwd)).toMatchObject({
      canonicalType: 'explore',
      kind: 'explore',
      role: { name: 'explorer', source: 'builtIn' },
    });
    expect(loader.resolveAgentType('explorer', cwd)).toMatchObject({
      canonicalType: 'explorer',
      kind: 'role',
      role: {
        name: 'explorer',
        source: 'project',
        description: 'Project-specific explorer.',
      },
    });
    expect(loader.buildAgentTypeCatalogSnapshot(cwd).entries.map((entry) => entry.name)).toEqual([
      'general-purpose',
      'explore',
      'plan',
      'explorer',
    ]);
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
          presentation: { persona: 'Ada' },
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
          presentation: { persona: 'Noether', color: 'pink' },
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
      skills: ['*'],
      preloadedSkills: [],
      plugins: [],
      mcpServers: [],
    });
    expect(loader.resolveRole('reviewer', cwd)).toEqual({
      name: 'reviewer',
      source: 'project',
      description: 'Review this project.',
      developerInstructions: 'Use the project review policy.',
      presentation: { persona: 'Noether', color: 'pink' },
      overrides: {
        model: 'review-model',
        reasoningEffort: 'xhigh',
        tools: ['node_read'],
      },
    });
    const roleCatalog = loader.buildRoleCatalogSnapshot(cwd);
    expect(roleCatalog.entries.find((entry) => entry.name === 'reviewer')).toMatchObject({
      source: 'project',
      identity: 'project:reviewer',
      description: 'Review this project.',
    });
    expect(roleCatalog.entries.find((entry) => entry.name === 'reviewer')?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
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

  test('names every identity from built-in defaults before anything is configured', async () => {
    const { userData, cwd } = await fixturePaths();
    const loader = new AgentConfigurationLoader(userData);

    const catalog = loader.resolveIdentityCatalog(cwd);

    expect(catalog).toEqual([
      { agentType: 'main', persona: 'Aspen', color: 'teal', source: 'built-in' },
      { agentType: 'general-purpose', persona: 'Bruno', color: 'amber', source: 'built-in' },
      { agentType: 'explore', persona: 'Rena', color: 'orange', source: 'built-in' },
      { agentType: 'plan', persona: 'Ada', color: 'blue', source: 'built-in' },
    ]);
  });

  test('layers presentation overrides project over user over the definition', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      presentationOverrides: {
        main: { persona: 'Ash' },
        explore: { persona: 'Scout', color: 'violet' },
      },
      roles: {
        reviewer: {
          description: 'Review the implementation.',
          developerInstructions: 'Find concrete correctness issues.',
          presentation: { persona: 'Ada', color: 'violet' },
        },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      presentationOverrides: { explore: { persona: 'Pathfinder' } },
    });
    const loader = new AgentConfigurationLoader(userData);

    const byType = new Map(loader.resolveIdentityCatalog(cwd).map((entry) => [entry.agentType, entry]));

    // One entry REPLACES another, the way a project Profile or Role replaces a
    // user one — the layering rule is the same everywhere in this file. So the
    // project's persona-only override drops the user's colour back to the
    // built-in default rather than merging with it.
    expect(byType.get('explore')).toEqual({
      agentType: 'explore', persona: 'Pathfinder', color: 'orange', source: 'built-in',
    });
    expect(byType.get('main')).toEqual({
      agentType: 'main', persona: 'Ash', color: 'teal', source: 'built-in',
    });
    // A Role speaks for itself, and is named after itself when it does not.
    expect(byType.get('reviewer')).toEqual({
      agentType: 'reviewer', persona: 'Ada', color: 'violet', source: 'user',
    });
  });

  test('names an unconfigured Role after itself, in a colour derived from its name', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        auditor: { description: 'Audit it.', developerInstructions: 'Audit it carefully.' },
      },
    });
    const loader = new AgentConfigurationLoader(userData);

    const entry = loader.resolveIdentityCatalog(cwd).find((e) => e.agentType === 'auditor');
    expect(entry).toEqual({
      agentType: 'auditor', persona: 'auditor', color: deriveIdentityColor('auditor'), source: 'user',
    });
    // Derived hues stay off the default roster's pinned colours AND off the
    // danger-adjacent red, so a fresh Role can neither impersonate Aspen nor
    // read as an error.
    expect(DERIVED_IDENTITY_COLORS).toEqual(['green', 'violet', 'pink']);
    expect(DERIVED_IDENTITY_COLORS).toContain(entry?.color);
  });

  test('keeps presentation out of the catalog the model is told about', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        reviewer: { description: 'Review it.', developerInstructions: 'Review it well.' },
      },
    });
    const loader = new AgentConfigurationLoader(userData);
    const before = loader.buildRoleCatalogSnapshot(cwd);

    await writeJson(userConfigurationPath(userData), {
      presentationOverrides: { explore: { persona: 'Scout', color: 'violet' } },
      roles: {
        reviewer: {
          description: 'Review it.',
          developerInstructions: 'Review it well.',
          presentation: { persona: 'Ada', color: 'green' },
        },
      },
    });
    const after = loader.buildRoleCatalogSnapshot(cwd);

    // Renaming an Agent on screen tells the model nothing new, so nothing it
    // was told may move — including the hashes that gate re-announcement.
    expect(after).toEqual(before);
  });

  test('refuses a reserved Role name and an unknown portrait', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        main: { description: 'Impostor.', developerInstructions: 'Impersonate the conversation.' },
      },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(() => loader.resolveIdentityCatalog(cwd)).toThrow('reserved');

    await writeJson(userConfigurationPath(userData), {
      presentationOverrides: { explore: { color: 'crimson' } },
    });
    expect(() => loader.resolveIdentityCatalog(cwd)).toThrow('must be one of');
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
