import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillDefinition } from '../../src/core/types';
import {
  agentSkillRegistryFingerprint,
  analyzeAgentSkills,
  assertAgentSkillCurationReportCurrent,
  type AgentSkillCurationCandidate,
} from '../../src/main/agent/capabilities/agentSkillCuration';
import { skillContentHash } from '../../src/main/agent/capabilities/agentSkills';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function candidate(
  name: string,
  body: string,
  source: 'user' | 'project' | 'managed' | 'built-in' = 'user',
): Promise<AgentSkillCurationCandidate> {
  const root = await mkdtemp(path.join(tmpdir(), 'lin-skill-curation-'));
  roots.push(root);
  const skillFile = path.join(root, 'SKILL.md');
  const content = `---\ndescription: ${name}\n---\n\n${body}\n`;
  await writeFile(skillFile, content, 'utf8');
  const skill: SkillDefinition = {
    name,
    identity: `${skillFile}:identity`,
    source,
    rootDir: root,
    skillFile,
    description: name,
    hasUserSpecifiedDescription: true,
    userInvocable: true,
    modelInvocable: true,
    contentHash: skillContentHash(content),
    argumentNames: [],
    contentLength: body.length,
    body,
  };
  return {
    skill,
    ...(source === 'managed' || source === 'built-in' ? {} : { agentHash: skill.contentHash }),
  };
}

describe('Agent Skill curation analyzer', () => {
  test('includes reliable Agent-authored Skills and reports deterministic findings', async () => {
    const first = await candidate('first', 'Use `run_shell` and see [missing](references/nope.md).');
    const second = await candidate('second', first.skill.body);
    // Exact duplicate means the complete SKILL.md bytes are identical. Keep
    // the second registry name while copying the first bundle hash.
    second.skill.contentHash = first.skill.contentHash;
    second.agentHash = first.skill.contentHash;

    const report = await analyzeAgentSkills([first, second]);
    const firstRow = report.rows.find((row) => row.name === 'first');
    expect(firstRow?.included).toBe(true);
    expect(firstRow?.findings.map((finding) => finding.kind).sort()).toEqual([
      'broken_resource',
      'exact_duplicate',
      'stale_tool',
    ]);
    expect(report.findingCount).toBe(6);
  });

  test('explains excluded provenance and source states', async () => {
    const handAuthored = await candidate('hand-authored', 'Plain instructions.');
    delete (handAuthored as { agentHash?: string }).agentHash;
    const changed = await candidate('changed', 'Changed instructions.');
    changed.agentHash = '0'.repeat(64);
    const managed = await candidate('managed', 'Pinned instructions.', 'managed');
    const builtIn = await candidate('built-in', 'Product instructions.', 'built-in');

    const report = await analyzeAgentSkills([handAuthored, changed, managed, builtIn]);
    expect(report.rows.every((row) => !row.included)).toBe(true);
    expect(report.rows.map((row) => row.exclusionReason)).toEqual([
      'Built-in Skill content is product-owned and excluded from curation.',
      'Skill bytes changed after the recorded Agent write.',
      'No reliable Agent-write provenance is recorded.',
      'Managed Skill content is pinned and excluded from curation.',
    ]);
  });

  test('detects escaping resource links and rejects stale reports', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lin-skill-curation-'));
    roots.push(root);
    const skillFile = path.join(root, 'SKILL.md');
    const content = '---\ndescription: escape\n---\n\n[escape](../outside.txt)\n';
    await writeFile(skillFile, content, 'utf8');
    const skill = await candidate('escape', '[escape](../outside.txt)');
    const report = await analyzeAgentSkills([skill]);
    expect(report.rows[0]?.findings[0]?.kind).toBe('broken_resource');
    expect(() => assertAgentSkillCurationReportCurrent(report, [skill])).not.toThrow();
    const changed = { ...skill, skill: { ...skill.skill, contentHash: 'f'.repeat(64) } };
    expect(() => assertAgentSkillCurationReportCurrent(report, [changed])).toThrow('stale');
    expect(agentSkillRegistryFingerprint([skill])).toBe(report.registryFingerprint);
  });

  test('parses balanced and spaced destinations while ignoring code examples', async () => {
    const skill = await candidate(
      'markdown-links',
      '[balanced](references/file_(v1).md) [spaced](<references/file with spaces.md>)\n\n```md\n[fake](references/missing.md)\n```',
    );
    await mkdir(path.join(skill.skill.rootDir, 'references'), { recursive: true });
    await writeFile(path.join(skill.skill.rootDir, 'references', 'file_(v1).md'), 'ok', 'utf8');
    await writeFile(path.join(skill.skill.rootDir, 'references', 'file with spaces.md'), 'ok', 'utf8');

    const report = await analyzeAgentSkills([skill]);
    expect(report.rows[0]?.findings).toEqual([]);
  });
});
