import type { AgentMemoryEntry, AgentPrincipal } from '../core/agentEventLog';
import { principalKey, samePrincipal } from '../core/agentEventLog';
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
// by which pool each entry belongs to (`entry.principal`) relative to the reader:
//   - the reader's own pool (`samePrincipal(entry.principal, reader)`)  -> `<self>`, second
//     person ("You verify …");
//   - any co-member principal's pool                                    -> `<principal name>`,
//     third person ("The user prefers …"). Visibility is decided upstream by conversation
//     membership ([[agent-data-model]] §4); render just projects whatever pools it is given.
//
// The subject-elided contract is enforced at the Dream layer (the single enforcement point),
// not here: render faithfully prepends the subject and must never delete leading words, which
// would change a fact's meaning.

// Resident `[3]` budget: how many active memory entries the briefing renders (newest first).
export const MEMORY_BRIEFING_MAX_ENTRIES = 12;

export interface MemoryBriefingOptions {
  /** The principal whose context the briefing is injected into; its own pool renders as `<self>`. */
  reader: AgentPrincipal;
  /** Human-facing name for a non-reader principal pool; defaults to a principal-derived label. */
  principalNameFor?: (principal: AgentPrincipal) => string;
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
  // Preserve first-seen order of principal pools for a stable render; key by principalKey so a
  // pool's entries group together regardless of object identity.
  const principalPools = new Map<string, { principal: AgentPrincipal; facts: string[] }>();

  for (const entry of active) {
    if (samePrincipal(entry.principal, options.reader)) {
      selfFacts.push(entry.fact);
      continue;
    }
    const key = principalKey(entry.principal);
    const bucket = principalPools.get(key);
    if (bucket) bucket.facts.push(entry.fact);
    else principalPools.set(key, { principal: entry.principal, facts: [entry.fact] });
  }

  const zones: string[] = [];
  // Principal zones first, then self — matches the §2 example ordering (what you know about
  // others, then about yourself).
  for (const { principal, facts } of principalPools.values()) {
    const name = options.principalNameFor?.(principal) ?? defaultPrincipalName(principal);
    const zone = renderZone('principal', facts, name);
    if (zone) zones.push(zone);
  }
  const selfZone = renderZone('self', selfFacts, null);
  if (selfZone) zones.push(selfZone);

  if (zones.length === 0) return null;
  return ['<memory>', ...zones, '</memory>'].join('\n');
}

function defaultPrincipalName(principal: AgentPrincipal): string {
  return principal.type === 'user' ? 'The user' : principal.agentId;
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
