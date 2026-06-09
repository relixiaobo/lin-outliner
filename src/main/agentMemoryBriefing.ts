import type { AgentMemoryEntry } from '../core/agentEventLog';

// The injection projection for distilled memory ([[agent-memory-model]] §2). Storage and
// injection are two different representations: the assembly layer keeps the structured
// `MemoryEntry` fields to select/rank, the model gets coherent prose. This module owns the
// *render* — a pure projection of already-selected entries into the `<memory>` briefing the
// runtime injects. It is a cache, never a source (data-model inv. 14): it hides storage
// scaffolding (`id`, `status`) and never round-trips back into the log.
//
// Person is reader-relative ([[agent-memory-model]] §2 "Person"). Storage stays
// person-neutral: Dream writes subject-elided, base-form predicates ("verify a worktree's
// HEAD before trusting a gate run"), naming third parties explicitly. Render assigns person
// by reader relationship:
//   - the reading agent's own pool (`entry.agentId === readerAgentId`)  -> `<self>`, second
//     person ("You verify …");
//   - any other principal's subscribed pool                             -> `<principal name>`,
//     third person (a Phase-3 affordance — today's single-agent runtime only ever reads its
//     own pool, so only `<self>` appears; the `<principal>` path is exercised by tests and
//     lights up once §4 user-as-agent sharing ships).

const DEFAULT_MAX_ENTRIES = 12;

// Defensive normalization: Dream is asked for subject-elided base-form predicates, but models
// drift. Strip a leaked leading subject so the render's own subject is not doubled
// ("You User prefers…").
const LEADING_SUBJECT = /^(?:you|i|we|the user|user|the agent|agent)\b['’]?s?\s+/i;

export interface MemoryBriefingOptions {
  /** The agent whose context the briefing is injected into; its own pool renders as `<self>`. */
  readerAgentId: string;
  /** Human-facing name for a non-reader principal pool (Phase 3); defaults to the agentId. */
  principalNameFor?: (agentId: string) => string;
  /** Cap on rendered entries (resident `[3]` budget); defaults to 12. */
  maxEntries?: number;
}

/**
 * Render selected `MemoryEntry`s into the `<memory>` briefing. Returns null when there is no
 * active memory to inject (the caller then omits the block entirely).
 */
export function renderAgentMemoryBriefing(
  entries: readonly AgentMemoryEntry[],
  options: MemoryBriefingOptions,
): string | null {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const active = dedupeById(entries.filter((entry) => entry.status === 'active')).slice(0, maxEntries);
  if (active.length === 0) return null;

  const selfFacts: string[] = [];
  // Preserve first-seen order of principal pools for a stable render.
  const principalPools = new Map<string, string[]>();

  for (const entry of active) {
    if (entry.agentId === options.readerAgentId) {
      selfFacts.push(entry.fact);
      continue;
    }
    const bucket = principalPools.get(entry.agentId);
    if (bucket) bucket.push(entry.fact);
    else principalPools.set(entry.agentId, [entry.fact]);
  }

  const zones: string[] = [];
  // Principal zones first, then self — matches the §2 example ordering (what you know about
  // others, then about yourself).
  for (const [agentId, facts] of principalPools) {
    const name = options.principalNameFor?.(agentId) ?? agentId;
    const zone = renderZone('principal', facts, name);
    if (zone) zones.push(zone);
  }
  const selfZone = renderZone('self', selfFacts, null);
  if (selfZone) zones.push(selfZone);

  if (zones.length === 0) return null;
  return ['<memory>', ...zones, '</memory>'].join('\n');
}

function renderZone(kind: 'self' | 'principal', facts: readonly string[], name: string | null): string | null {
  const subject = kind === 'self' ? 'You' : (name ?? '');
  const prose = facts
    .map((fact) => toSentence(subject, fact))
    .filter(Boolean)
    .join(' ');
  if (!prose) return null;
  const open = kind === 'self' ? '<self>' : `<principal name="${escapeAttribute(name ?? '')}">`;
  const close = kind === 'self' ? '</self>' : '</principal>';
  return `${open}\n${escapeBody(prose)}\n${close}`;
}

// Project a person-neutral predicate into a reader-relative sentence. The stored fact is a
// base-form predicate with the subject elided; we prepend the reader-relative subject. Base
// form is grammatical for the second-person `<self>` path (the live single-agent path);
// the third-person `<principal>` path is a Phase-3 affordance whose finer conjugation lands
// with §4.
function toSentence(subject: string, fact: string): string {
  const predicate = fact.replace(LEADING_SUBJECT, '').trim();
  if (!predicate) return '';
  const text = subject ? `${subject} ${predicate}` : predicate;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function dedupeById(entries: readonly AgentMemoryEntry[]): AgentMemoryEntry[] {
  const seen = new Set<string>();
  const result: AgentMemoryEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function escapeBody(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeBody(value).replace(/"/g, '&quot;');
}
