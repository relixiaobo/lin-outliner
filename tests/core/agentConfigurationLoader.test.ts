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
      .toContain('Your final response is a concise handoff for the caller');
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
          tools: ['file_grep', 'file_read'],
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
          overrides: { tools: ['file_grep'] },
        },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      profiles: {
        coding: {
          developerInstructions: 'Follow the project configuration.',
          model: 'project-model',
          tools: ['file_grep'],
        },
      },
      roles: {
        reviewer: {
          description: 'Review this project.',
          developerInstructions: 'Use the project review policy.',
          presentation: { persona: 'Noether', color: 'pink' },
          overrides: {
            tools: ['file_grep'],
          },
        },
      },
      agentExecution: {
        reviewer: {
          modelProvider: 'openai',
          model: 'openai/review-model',
          reasoningEffort: 'xhigh',
        },
      },
    });

    const loader = new AgentConfigurationLoader(userData);
    expect(loader.resolveProfile(undefined, cwd)).toEqual({
      profileName: 'coding',
      developerInstructions: ['Follow the project configuration.'],
      model: 'project-model',
      reasoningEffort: 'medium',
      tools: ['file_grep'],
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
        tools: ['file_grep'],
      },
    });
    expect(loader.resolveAgentExecution('reviewer', cwd)).toEqual({
      modelProvider: 'openai',
      model: 'openai/review-model',
      reasoningEffort: 'xhigh',
    });
    const roleCatalog = loader.buildRoleCatalogSnapshot(cwd);
    expect(roleCatalog.entries.find((entry) => entry.name === 'reviewer')).toMatchObject({
      source: 'project',
      identity: 'project:reviewer',
      description: 'Review this project.',
    });
    expect(roleCatalog.entries.find((entry) => entry.name === 'reviewer')?.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('layers Agent execution rows as whole entries and keeps both stored layers editable', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        auditor: { description: 'Audits.', developerInstructions: 'Inspect the change.' },
      },
      agentExecution: {
        explore: {
          modelProvider: 'anthropic',
          model: 'anthropic/claude-opus-5',
          reasoningEffort: 'medium',
        },
        auditor: { reasoningEffort: 'high' },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      agentExecution: { explore: { reasoningEffort: 'xhigh' } },
    });
    const loader = new AgentConfigurationLoader(userData);

    // Project replaces the row. It does not inherit the user row's model pair.
    expect(loader.resolveAgentExecution('explore', cwd)).toEqual({ reasoningEffort: 'xhigh' });
    expect(loader.resolveAgentExecution('auditor', cwd)).toEqual({ reasoningEffort: 'high' });
    expect(loader.listAgentExecutionSelections(cwd)).toEqual(expect.arrayContaining([
      {
        agentType: 'explore',
        layer: 'user',
        modelProvider: 'anthropic',
        model: 'anthropic/claude-opus-5',
        reasoningEffort: 'medium',
      },
      {
        agentType: 'explore',
        layer: 'project',
        modelProvider: null,
        model: null,
        reasoningEffort: 'xhigh',
      },
    ]));
  });

  test('resolves a custom Agent execution row only from the winning Role layer', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        auditor: { description: 'User auditor.', developerInstructions: 'Use the user workflow.' },
      },
      agentExecution: {
        auditor: {
          modelProvider: 'openai',
          model: 'openai/user-model',
          reasoningEffort: 'high',
        },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      roles: {
        auditor: { description: 'Project auditor.', developerInstructions: 'Use the project workflow.' },
      },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(loader.resolveRole('auditor', cwd)).toMatchObject({
      source: 'project',
      description: 'Project auditor.',
    });
    expect(loader.resolveAgentExecution('auditor', cwd)).toBeNull();
    expect(loader.listAgentExecutionSelections(cwd)).toContainEqual({
      agentType: 'auditor',
      layer: 'user',
      modelProvider: 'openai',
      model: 'openai/user-model',
      reasoningEffort: 'high',
    });
  });

  test('rejects Role execution fields and malformed execution rows at the decode boundary', async () => {
    const { userData, cwd } = await fixturePaths();
    const path = userConfigurationPath(userData);
    await writeJson(path, {
      roles: {
        legacy: {
          description: 'Legacy.',
          developerInstructions: 'Use a retired field.',
          overrides: { model: 'gpt-5' },
        },
      },
    });
    const loader = new AgentConfigurationLoader(userData);
    expect(() => loader.resolveRole('legacy', cwd)).toThrow('unknown field: model');

    await writeJson(path, {
      roles: {
        legacy: {
          description: 'Legacy.',
          developerInstructions: 'Use a retired field.',
          overrides: { reasoningEffort: 'high' },
        },
      },
    });
    expect(() => loader.resolveRole('legacy', cwd)).toThrow('unknown field: reasoningEffort');

    await writeJson(path, {
      agentExecution: { explore: { modelProvider: 'openai' } },
    });
    expect(() => loader.resolveAgentExecution('explore', cwd)).toThrow('must be set together');

    await writeJson(path, {
      agentExecution: {
        explore: { modelProvider: 'openai', model: 'anthropic/claude-opus-5' },
      },
    });
    expect(() => loader.resolveAgentExecution('explore', cwd)).toThrow("qualified by modelProvider 'openai'");

    await writeJson(path, { agentExecution: { explore: {} } });
    expect(() => loader.resolveAgentExecution('explore', cwd)).toThrow('must not be empty');
  });

  test('requires a custom Agent execution row and its Role to live in the same layer', async () => {
    const { userData, cwd } = await fixturePaths();
    await writeJson(userConfigurationPath(userData), {
      roles: {
        auditor: { description: 'Audits.', developerInstructions: 'Inspect the change.' },
      },
    });
    await writeJson(projectConfigurationPath(cwd), {
      agentExecution: { auditor: { reasoningEffort: 'high' } },
    });
    const loader = new AgentConfigurationLoader(userData);

    expect(() => loader.resolveAgentExecution('auditor', cwd)).toThrow(
      'requires a Role in the same layer',
    );
  });

  test('bounds custom Agent type names to the Settings deep-link limit', async () => {
    const { userData, cwd } = await fixturePaths();
    const path = userConfigurationPath(userData);
    const validName = `a${'b'.repeat(63)}`;
    await writeJson(path, {
      roles: {
        [validName]: { description: 'Valid.', developerInstructions: 'Use the bounded name.' },
      },
    });
    const loader = new AgentConfigurationLoader(userData);
    expect(loader.resolveRole(validName, cwd).name).toBe(validName);

    const invalidName = `a${'b'.repeat(64)}`;
    await writeJson(path, {
      roles: {
        [invalidName]: { description: 'Too long.', developerInstructions: 'Reject this name.' },
      },
    });
    expect(() => loader.resolveRole(invalidName, cwd)).toThrow('at most 64');
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

    await writeJson(userConfigurationPath(userData), {
      agentExecution: {
        explore: { modelProvider: 'openai', model: 'openai/gpt-5.6', reasoningEffort: 'high' },
      },
      roles: {
        reviewer: { description: 'Review it.', developerInstructions: 'Review it well.' },
      },
    });
    expect(loader.buildRoleCatalogSnapshot(cwd)).toEqual(before);
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
