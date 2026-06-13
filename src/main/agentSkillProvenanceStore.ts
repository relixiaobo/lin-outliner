import { app } from 'electron';
import { join } from 'node:path';
import type {
  AgentSkillPreviousVersion,
  AgentSkillProvenanceRecord,
  AgentSkillProvenanceStore,
} from './agentSkills';
import { readJsonOrDefault, updateJsonFile } from './jsonFileStore';

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
      return readJsonOrDefault(provenancePath(), {}, parseProvenanceEntries);
    },
    async save(skillFile: string, record: AgentSkillProvenanceRecord | null): Promise<void> {
      await updateJsonFile(
        provenancePath(),
        {},
        parseProvenanceEntries,
        (entries) => {
          if (record === null) {
            delete entries[skillFile];
          } else {
            entries[skillFile] = record;
          }
        },
        privateJsonFileOptions(),
      );
    },
  };
}

function parseProvenanceEntries(value: unknown): Record<string, AgentSkillProvenanceRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const entries: Record<string, AgentSkillProvenanceRecord> = {};
  for (const [skillFile, raw] of Object.entries(value)) {
    const record = parseProvenanceRecord(raw);
    if (record) entries[skillFile] = record;
  }
  return entries;
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

function privateJsonFileOptions() {
  return process.platform === 'win32' ? {} : { mode: 0o600, directoryMode: 0o700 };
}

function provenancePath() {
  return join(app.getPath('userData'), AGENT_SKILL_PROVENANCE_FILE);
}
