import { app } from 'electron';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentSkillPreviousVersion,
  AgentSkillProvenanceRecord,
  AgentSkillProvenanceStore,
} from './agentSkills';

const AGENT_SKILL_PROVENANCE_FILE = 'agent-skill-provenance.json';

/**
 * userData-backed trust store for skills, keyed by resolved skill file path. Each
 * record holds the last agent-written content hash (provenance), the hash the user
 * explicitly accepted (trust), and at most one previous version for single-step undo.
 * The skill registry derives ratification from it; see the derivation in
 * `addLoadedSkill`. Legacy plain-string values (pre-acceptance format) are dropped on
 * load — pre-release, no migration.
 */
export function createAgentSkillProvenanceStore(): AgentSkillProvenanceStore {
  return {
    async load(): Promise<Record<string, AgentSkillProvenanceRecord>> {
      const parsed = await readJsonOrDefault<unknown>(provenancePath(), {});
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
      const entries: Record<string, AgentSkillProvenanceRecord> = {};
      for (const [skillFile, value] of Object.entries(parsed)) {
        const record = parseProvenanceRecord(value);
        if (record) entries[skillFile] = record;
      }
      return entries;
    },
    async save(skillFile: string, record: AgentSkillProvenanceRecord | null): Promise<void> {
      // load→mutate→write is racy across concurrent store instances (subagents share
      // the same userData file and tmp name). Accepted: skill writes are ask-gated and
      // approved serially, acceptance is a user-paced settings action, and a lost
      // record only narrows to the in-memory guard for that session.
      const entries = await this.load();
      if (record === null) {
        delete entries[skillFile];
      } else {
        entries[skillFile] = record;
      }
      await writeJsonFile(provenancePath(), entries);
    },
  };
}

function parseProvenanceRecord(value: unknown): AgentSkillProvenanceRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const record: AgentSkillProvenanceRecord = {};
  if (typeof raw.agentHash === 'string') record.agentHash = raw.agentHash;
  if (typeof raw.acceptedHash === 'string') record.acceptedHash = raw.acceptedHash;
  const previous = parsePreviousVersion(raw.previousVersion);
  if (previous) record.previousVersion = previous;
  return record.agentHash || record.acceptedHash || record.previousVersion ? record : null;
}

function parsePreviousVersion(value: unknown): AgentSkillPreviousVersion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.hash !== 'string' || typeof raw.content !== 'string') return null;
  return {
    hash: raw.hash,
    content: raw.content,
    ...(typeof raw.agentHash === 'string' ? { agentHash: raw.agentHash } : {}),
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
