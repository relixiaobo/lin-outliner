import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userData = '';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const { createAgentSkillProvenanceStore } = await import('../../src/main/agentSkillProvenanceStore');

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-skill-provenance-'));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('agent skill provenance store', () => {
  test('serializes concurrent saves from separate store instances', async () => {
    const first = createAgentSkillProvenanceStore();
    const second = createAgentSkillProvenanceStore();

    await Promise.all([
      first.save('/workspace/.agents/skills/a/SKILL.md', { agentHash: 'agent-a' }),
      second.save('/workspace/.agents/skills/b/SKILL.md', { acceptedHash: 'accepted-b' }),
    ]);

    expect(await createAgentSkillProvenanceStore().load()).toEqual({
      '/workspace/.agents/skills/a/SKILL.md': { agentHash: 'agent-a' },
      '/workspace/.agents/skills/b/SKILL.md': { acceptedHash: 'accepted-b' },
    });
  });

  test('writes the provenance file with private permissions on POSIX', async () => {
    const store = createAgentSkillProvenanceStore();
    await store.save('/workspace/.agents/skills/a/SKILL.md', { agentHash: 'agent-a' });

    const filePath = path.join(userData, 'agent-skill-provenance.json');
    if (process.platform !== 'win32') {
      expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });
});
