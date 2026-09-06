import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  AgentSkillCurationFinding,
  AgentSkillCurationReport,
  AgentSkillCurationRow,
  SkillDefinition,
} from '../../../core/types';

/** The small snapshot the analyzer needs; previous-version bytes never leave the runtime. */
export interface AgentSkillCurationCandidate {
  readonly skill: SkillDefinition;
  readonly agentHash?: string;
}

const STALE_TOOL_NAMES: Readonly<Record<string, string>> = {
  read_file: 'file_read',
  write_file: 'file_write',
  edit_file: 'file_edit',
  delete_file: 'file_delete',
  search_files: 'file_glob',
  fetch_url: 'web_fetch',
  run_shell: 'bash',
};

/**
 * Analyze the current loaded Skill snapshot without changing files, provenance,
 * settings, or the registry. The report is deliberately hash-bound so a later
 * foreground action can reject a stale suggestion before it writes anything.
 */
export async function analyzeAgentSkills(
  candidates: readonly AgentSkillCurationCandidate[],
  generatedAt = Date.now(),
): Promise<AgentSkillCurationReport> {
  const ordered = [...candidates].sort(compareCandidates);
  const eligible = ordered.filter((candidate) => eligibleCandidate(candidate));
  const duplicateNames = new Map<string, string[]>();
  for (const candidate of eligible) {
    const hash = candidate.skill.contentHash;
    if (!hash) continue;
    const names = duplicateNames.get(hash) ?? [];
    names.push(candidate.skill.name);
    duplicateNames.set(hash, names);
  }

  const rows = await Promise.all(ordered.map(async (candidate) => {
    const exclusionReason = exclusionFor(candidate);
    if (exclusionReason) {
      return rowFor(candidate, false, exclusionReason, []);
    }
    const findings = [
      ...(await brokenResourceFindings(candidate.skill)),
      ...duplicateFindings(candidate.skill, duplicateNames),
      ...staleToolFindings(candidate.skill),
    ];
    return rowFor(candidate, true, null, findings);
  }));
  const registryFingerprint = fingerprint(ordered);
  const findingCount = rows.reduce((total, row) => total + row.findings.length, 0);
  return {
    schemaVersion: 1,
    generatedAt,
    registryFingerprint,
    rows,
    includedCount: rows.filter((row) => row.included).length,
    excludedCount: rows.filter((row) => !row.included).length,
    findingCount,
  };
}

export function agentSkillRegistryFingerprint(candidates: readonly AgentSkillCurationCandidate[]): string {
  return fingerprint([...candidates].sort(compareCandidates));
}

export function assertAgentSkillCurationReportCurrent(
  report: AgentSkillCurationReport,
  candidates: readonly AgentSkillCurationCandidate[],
): void {
  if (report.registryFingerprint !== agentSkillRegistryFingerprint(candidates)) {
    throw new Error('Skill curation report is stale; generate a new report before applying a suggestion.');
  }
}

function eligibleCandidate(candidate: AgentSkillCurationCandidate): boolean {
  return candidate.skill.source === 'user'
    || candidate.skill.source === 'project'
    ? Boolean(candidate.skill.contentHash && candidate.agentHash === candidate.skill.contentHash)
    : false;
}

function exclusionFor(candidate: AgentSkillCurationCandidate): string | null {
  if (candidate.skill.source === 'managed') return 'Managed Skill content is pinned and excluded from curation.';
  if (candidate.skill.source === 'built-in') return 'Built-in Skill content is product-owned and excluded from curation.';
  if (!candidate.skill.contentHash) return 'Current Skill bytes have no content hash.';
  if (!candidate.agentHash) return 'No reliable Agent-write provenance is recorded.';
  if (candidate.agentHash !== candidate.skill.contentHash) return 'Skill bytes changed after the recorded Agent write.';
  return null;
}

function rowFor(
  candidate: AgentSkillCurationCandidate,
  included: boolean,
  exclusionReason: string | null,
  findings: readonly AgentSkillCurationFinding[],
): AgentSkillCurationRow {
  return {
    name: candidate.skill.name,
    identity: candidate.skill.identity ?? null,
    source: candidate.skill.source,
    rootDir: candidate.skill.rootDir,
    currentHash: candidate.skill.contentHash ?? null,
    included,
    exclusionReason,
    findings,
  };
}

function duplicateFindings(
  skill: SkillDefinition,
  duplicateNames: ReadonlyMap<string, readonly string[]>,
): AgentSkillCurationFinding[] {
  if (!skill.contentHash) return [];
  const names = duplicateNames.get(skill.contentHash);
  if (!names || names.length < 2) return [];
  const peers = names.filter((name) => name !== skill.name).join(', ');
  return [{
    kind: 'exact_duplicate',
    severity: 'warning',
    message: `Skill has the same SKILL.md content hash as ${peers}.`,
    evidence: `sha256:${skill.contentHash}`,
  }];
}

async function brokenResourceFindings(skill: SkillDefinition): Promise<AgentSkillCurationFinding[]> {
  const findings: AgentSkillCurationFinding[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  for (const match of skill.body.matchAll(pattern)) {
    const reference = match[1]?.trim();
    if (!reference || reference.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(reference)) continue;
    const target = reference.split('#', 1)[0]?.trim().replace(/^<|>$/g, '');
    if (!target) continue;
    const resolvedTarget = resolve(skill.rootDir, target);
    const relativeTarget = relative(skill.rootDir, resolvedTarget);
    if (isAbsolute(relativeTarget) || relativeTarget === '..' || relativeTarget.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      findings.push({
        kind: 'broken_resource',
        severity: 'error',
        message: `Resource reference escapes the Skill root: ${reference}.`,
        evidence: reference,
      });
      continue;
    }
    try {
      await stat(resolvedTarget);
    } catch {
      findings.push({
        kind: 'broken_resource',
        severity: 'error',
        message: `Resource reference does not exist: ${reference}.`,
        evidence: reference,
      });
    }
  }
  return findings;
}

function staleToolFindings(skill: SkillDefinition): AgentSkillCurationFinding[] {
  const findings: AgentSkillCurationFinding[] = [];
  const seen = new Set<string>();
  const pattern = /`([a-z][a-z0-9_-]*)`/gi;
  for (const match of skill.body.matchAll(pattern)) {
    const stale = match[1] ? STALE_TOOL_NAMES[match[1]] : undefined;
    if (!stale || seen.has(match[1]!)) continue;
    seen.add(match[1]!);
    findings.push({
      kind: 'stale_tool',
      severity: 'warning',
      message: `Skill names retired tool \`${match[1]}\`; use \`${stale}\` instead.`,
      evidence: match[1]!,
    });
  }
  return findings;
}

function fingerprint(candidates: readonly AgentSkillCurationCandidate[]): string {
  const value = candidates.map((candidate) => ({
    identity: candidate.skill.identity ?? candidate.skill.skillFile,
    name: candidate.skill.name,
    source: candidate.skill.source,
    contentHash: candidate.skill.contentHash ?? null,
    agentHash: candidate.agentHash ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareCandidates(left: AgentSkillCurationCandidate, right: AgentSkillCurationCandidate): number {
  return compareText(left.skill.name, right.skill.name)
    || compareText(left.skill.identity ?? left.skill.skillFile, right.skill.identity ?? right.skill.skillFile)
    || compareText(left.skill.source, right.skill.source)
    || compareText(left.skill.contentHash ?? '', right.skill.contentHash ?? '')
    || compareText(left.agentHash ?? '', right.agentHash ?? '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
