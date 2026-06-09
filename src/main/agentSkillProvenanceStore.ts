import { app } from 'electron';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSkillProvenanceStore } from './agentSkills';

const AGENT_SKILL_PROVENANCE_FILE = 'agent-skill-provenance.json';

/**
 * userData-backed store of agent-written SKILL.md content hashes, keyed by resolved
 * skill file path. The skill registry derives ratification from it: a skill whose
 * current content hash matches its record is unratified (agent-authored, not yet
 * accepted). A user hand-edit changes the hash, so the record naturally expires.
 */
export function createAgentSkillProvenanceStore(): AgentSkillProvenanceStore {
  return {
    async load(): Promise<Record<string, string>> {
      const parsed = await readJsonOrDefault<unknown>(provenancePath(), {});
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const entries: Record<string, string> = {};
      for (const [skillFile, hash] of Object.entries(parsed)) {
        if (typeof hash === 'string') entries[skillFile] = hash;
      }
      return entries;
    },
    async record(skillFile: string, contentHash: string): Promise<void> {
      // load→mutate→write is racy across concurrent store instances (subagents share
      // the same userData file and tmp name). Accepted: skill writes are ask-gated and
      // approved serially, and a lost record only narrows to the in-memory guard for
      // that session.
      const entries = await this.load();
      entries[skillFile] = contentHash;
      await writeJsonFile(provenancePath(), entries);
    },
  };
}

async function readJsonOrDefault<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  if (process.platform !== 'win32') await chmod(parent, 0o700);
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  if (process.platform !== 'win32') await chmod(filePath, 0o600);
}

async function atomicWrite(filePath: string, data: string) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

function provenancePath() {
  return join(app.getPath('userData'), AGENT_SKILL_PROVENANCE_FILE);
}
