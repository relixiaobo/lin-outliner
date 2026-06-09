import type { AgentMemoryEntry } from '../core/agentEventLog';
import { escapeXml } from './agentReminderXml';

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
// by reader relationship by prepending the reader-relative subject:
//   - the reading agent's own pool (`entry.agentId === readerAgentId`)  -> `<self>`, second
//     person ("You verify …");
//   - any other principal's subscribed pool                             -> `<principal name>`,
//     third person (a Phase-3 affordance — today's single-agent runtime only ever reads its
//     own pool, so only `<self>` appears; the `<principal>` path lights up once §4
//     user-as-agent sharing ships).
//
// The subject-elided contract is enforced at the Dream layer (the single enforcement point),
// not here: render faithfully prepends the subject and must never delete leading words, which
// would change a fact's meaning.

// Resident `[3]` budget: how many active memory entries the briefing renders (newest first).
export const MEMORY_BRIEFING_MAX_ENTRIES = 12;

export interface MemoryBriefingOptions {
  /** The agent whose context the briefing is injected into; its own pool renders as `<self>`. */
  readerAgentId: string;
  /** Human-facing name for a non-reader principal pool (Phase 3); defaults to the agentId. */
  principalNameFor?: (agentId: string) => string;
  /** Cap on rendered entries (resident `[3]` budget); defaults to MEMORY_BRIEFING_MAX_ENTRIES. */
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
  const maxEntries = options.maxEntries ?? MEMORY_BRIEFING_MAX_ENTRIES;
  // Defensive: the live caller's store already returns active, id-unique entries, but this is
  // a public pure function, so it owns its own input contract (active-only, deduped, capped).
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
  const open = kind === 'self' ? '<self>' : `<principal name="${escapeXml(name ?? '')}">`;
  const close = kind === 'self' ? '</self>' : '</principal>';
  return `${open}\n${escapeXml(prose)}\n${close}`;
}

// Project a person-neutral predicate into a reader-relative sentence by prepending the subject.
// The stored fact is a subject-elided base-form predicate (Dream's contract); base form is
// grammatical for the second-person `<self>` path (the live single-agent path). Internal
// whitespace is collapsed so a single fact can never inject an extra line into the block.
function toSentence(subject: string, fact: string): string {
  const predicate = fact.replace(/\s+/g, ' ').trim();
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
