import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializeAgentMarkdown } from '../../src/core/agentMarkdown';
import type { AgentAuthoringInput } from '../../src/core/agentTypes';
import type { AgentDefinition } from '../../src/core/types';

mock.module('electron', () => ({
  app: {
    getPath: () => '/tmp',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  session: {
    fromPartition: () => ({
      clearStorageData: async () => undefined,
    }),
  },
}));

type AgentAuthoringModule = typeof import('../../src/main/agentAuthoring');
type AgentDelegationModule = typeof import('../../src/main/agentDelegation');

let createAgentDefinitionFile: AgentAuthoringModule['createAgentDefinitionFile'];
let deleteAgentDefinitionFile: AgentAuthoringModule['deleteAgentDefinitionFile'];
let duplicateAgentDefinitionFile: AgentAuthoringModule['duplicateAgentDefinitionFile'];
let isAgentDefinitionWritable: AgentAuthoringModule['isAgentDefinitionWritable'];
let normalizeAgentSlug: AgentAuthoringModule['normalizeAgentSlug'];
let updateAgentDefinitionFile: AgentAuthoringModule['updateAgentDefinitionFile'];
let createAgentDefinition: AgentDelegationModule['createAgentDefinition'];
let parseAgentMarkdown: AgentDelegationModule['parseAgentMarkdown'];

const SAMPLE: AgentAuthoringInput = {
  name: 'My Helper',
  description: 'Helps with research tasks',
  body: 'You are helpful.\nDo the task and report back.',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'restricted',
  maxTurns: 12,
  tools: ['file_read', 'file_grep'],
  skills: ['research'],
  background: true,
};

beforeAll(async () => {
  const [authoring, delegation] = await Promise.all([
    import('../../src/main/agentAuthoring'),
    import('../../src/main/agentDelegation'),
  ]);
  createAgentDefinitionFile = authoring.createAgentDefinitionFile;
  deleteAgentDefinitionFile = authoring.deleteAgentDefinitionFile;
  duplicateAgentDefinitionFile = authoring.duplicateAgentDefinitionFile;
  isAgentDefinitionWritable = authoring.isAgentDefinitionWritable;
  normalizeAgentSlug = authoring.normalizeAgentSlug;
  updateAgentDefinitionFile = authoring.updateAgentDefinitionFile;
  createAgentDefinition = delegation.createAgentDefinition;
  parseAgentMarkdown = delegation.parseAgentMarkdown;
});

// Round-trip helper: parse a written AGENT.md into a definition the way the
// registry loader does.
function definitionFromRaw(raw: string, source: AgentDefinition['source'] = 'project'): AgentDefinition {
  const parsed = parseAgentMarkdown(raw);
  return createAgentDefinition({
    name: 'folder-name',
    rootDir: '/tmp/x',
    agentFile: '/tmp/x/AGENT.md',
    source,
    body: parsed.body,
    frontmatter: parsed.frontmatter,
  });
}

describe('agent authoring serialization', () => {
  test('serialize → parse → createAgentDefinition round-trips every field', () => {
    const definition = definitionFromRaw(serializeAgentMarkdown(SAMPLE), 'user');
    expect(definition.description).toBe('Helps with research tasks');
    expect(definition.model).toBe('claude-opus-4-8');
    expect(definition.effort).toBe('high');
    expect(definition.permissionMode).toBe('restricted');
    expect(definition.maxTurns).toBe(12);
    expect(definition.tools).toEqual(['file_read', 'file_grep']);
    expect(definition.skills).toEqual(['research']);
    expect(definition.background).toBe(true);
    expect(definition.body).toBe('You are helpful.\nDo the task and report back.');
    // The frontmatter `name` overrides the folder name (whitespace → dash).
    expect(definition.name).toBe('My-Helper');
  });

  test('omits unset optional fields and never emits inherit/empty', () => {
    const md = serializeAgentMarkdown({ name: 'minimal', description: '', body: 'Body.', model: 'inherit' });
    expect(md).not.toContain('model:');
    expect(md).not.toContain('permission-mode:');
    expect(md).not.toContain('max-turns:');
    expect(md).not.toContain('tools:');
    expect(md).not.toContain('background:');
    expect(md.startsWith('---\n')).toBe(true);
  });
});

describe('normalizeAgentSlug', () => {
  test('produces a filesystem-safe slug', () => {
    expect(normalizeAgentSlug('  My Agent!! ')).toBe('my-agent');
    expect(normalizeAgentSlug('Research_Bot-2')).toBe('research_bot-2');
  });

  test('rejects traversal and empty names', () => {
    expect(normalizeAgentSlug('..')).toBe('');
    expect(normalizeAgentSlug('   ')).toBe('');
    expect(normalizeAgentSlug('.')).toBe('');
    // A traversal attempt collapses to a single safe segment.
    expect(normalizeAgentSlug('../escape')).toBe('escape');
  });
});

describe('agent authoring file operations', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agent-authoring-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('createAgentDefinitionFile writes under the workspace agents dir', async () => {
    const { rootDir, agentFile } = await createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root });
    expect(rootDir).toBe(path.join(root, '.agents', 'agents', 'my-helper'));
    expect(agentFile).toBe(path.join(rootDir, 'AGENT.md'));
    const raw = await readFile(agentFile, 'utf8');
    expect(definitionFromRaw(raw).model).toBe('claude-opus-4-8');
  });

  test('createAgentDefinitionFile rejects a duplicate name', async () => {
    await createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root });
    await expect(createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root }))
      .rejects.toThrow(/already exists/);
  });

  test('createAgentDefinitionFile rejects an unusable name', async () => {
    await expect(createAgentDefinitionFile({ input: { ...SAMPLE, name: '..' }, storage: 'project', localRoot: root }))
      .rejects.toThrow(/empty or contains no usable/);
  });

  test('updateAgentDefinitionFile overwrites in place', async () => {
    const created = await createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root });
    const existing: AgentDefinition = {
      name: 'my-helper', source: 'project', rootDir: created.rootDir, agentFile: created.agentFile,
      description: SAMPLE.description, body: SAMPLE.body,
    };
    await updateAgentDefinitionFile({ existing, input: { ...SAMPLE, description: 'Updated purpose' }, localRoot: root });
    const raw = await readFile(created.agentFile, 'utf8');
    expect(definitionFromRaw(raw).description).toBe('Updated purpose');
  });

  test('deleteAgentDefinitionFile removes the agent directory', async () => {
    const created = await createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root });
    const existing: AgentDefinition = {
      name: 'my-helper', source: 'project', rootDir: created.rootDir, agentFile: created.agentFile,
      description: SAMPLE.description, body: SAMPLE.body,
    };
    await deleteAgentDefinitionFile({ existing, localRoot: root });
    await expect(stat(created.rootDir)).rejects.toThrow();
  });

  test('isAgentDefinitionWritable mirrors the authoring containment boundary', async () => {
    const created = await createAgentDefinitionFile({ input: SAMPLE, storage: 'project', localRoot: root });
    const writable: AgentDefinition = {
      name: 'my-helper', source: 'project', rootDir: created.rootDir, agentFile: created.agentFile,
      description: SAMPLE.description, body: SAMPLE.body,
    };
    const external: AgentDefinition = {
      ...writable,
      source: 'user',
      rootDir: path.join(root, '..', 'shared-agents', 'external-reviewer'),
      agentFile: path.join(root, '..', 'shared-agents', 'external-reviewer', 'AGENT.md'),
    };
    expect(isAgentDefinitionWritable(writable, root)).toBe(true);
    expect(isAgentDefinitionWritable(external, root)).toBe(false);
  });

  test('duplicateAgentDefinitionFile copies a built-in into an editable user copy', async () => {
    const builtIn: AgentDefinition = {
      name: 'assistant', displayName: 'Neva', source: 'built-in', rootDir: 'built-in', agentFile: 'built-in/assistant',
      description: 'Default Tenon assistant profile', body: 'You are Neva.',
    };
    const { agentFile } = await duplicateAgentDefinitionFile({ source: builtIn, newName: 'assistant-copy', storage: 'project', localRoot: root });
    const raw = await readFile(agentFile, 'utf8');
    expect(definitionFromRaw(raw).body).toBe('You are Neva.');
  });

  test('refuses to edit or delete a built-in agent', async () => {
    const builtIn: AgentDefinition = {
      name: 'assistant', displayName: 'Neva', source: 'built-in', rootDir: 'built-in', agentFile: 'built-in/assistant',
      description: 'x', body: '',
    };
    await expect(updateAgentDefinitionFile({ existing: builtIn, input: SAMPLE, localRoot: root })).rejects.toThrow(/Built-in/);
    await expect(deleteAgentDefinitionFile({ existing: builtIn, localRoot: root })).rejects.toThrow(/Built-in/);
  });

  test('refuses to write outside the agents directories (traversal guard)', async () => {
    const outside: AgentDefinition = {
      name: 'evil', source: 'project', rootDir: path.join(root, 'evil'), agentFile: path.join(root, 'evil', 'AGENT.md'),
      description: 'x', body: '',
    };
    await expect(updateAgentDefinitionFile({ existing: outside, input: SAMPLE, localRoot: root }))
      .rejects.toThrow(/outside the agents directories/);
    await expect(deleteAgentDefinitionFile({ existing: outside, localRoot: root }))
      .rejects.toThrow(/outside the agents directories/);
  });

  test('refuses to follow a symlink inside the agents dir that escapes the root', async () => {
    // A hostile project workspace can commit `.agents/agents/escape -> /outside`.
    // Lexically `escape` is a child of the agents dir, so containment MUST resolve
    // symlinks (realpath) or the write/delete lands at the symlink target.
    const agentsDir = path.join(root, '.agents', 'agents');
    await mkdir(agentsDir, { recursive: true });
    const outsideTarget = await mkdtemp(path.join(tmpdir(), 'agent-authoring-escape-'));
    const link = path.join(agentsDir, 'escape');
    await symlink(outsideTarget, link, 'dir');
    const escaped: AgentDefinition = {
      name: 'escape', source: 'project', rootDir: link, agentFile: path.join(link, 'AGENT.md'),
      description: 'x', body: '',
    };
    await expect(updateAgentDefinitionFile({ existing: escaped, input: SAMPLE, localRoot: root }))
      .rejects.toThrow(/outside the agents directories/);
    await expect(deleteAgentDefinitionFile({ existing: escaped, localRoot: root }))
      .rejects.toThrow(/outside the agents directories/);
    // The escape target must be untouched.
    await expect(stat(path.join(outsideTarget, 'AGENT.md'))).rejects.toThrow();
    await rm(outsideTarget, { recursive: true, force: true });
  });
});
