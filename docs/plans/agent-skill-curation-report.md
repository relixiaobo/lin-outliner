# Agent Skill Curation Report

**Shape:** ONE complete read-only maintenance feature in one PR.

## Goal

Provide an explicit, opt-in, hash-bound curation report for eligible model-
authored Skills without silently rewriting, merging, archiving, or deleting
anything.

## Non-goals

- No background model, scheduled cleanup, mutation command, marketplace, or
  managed/built-in Skill editing.
- No claim that absence of telemetry proves a Skill is unused.
- No automatic application of semantic duplicate suggestions.

## Design

A Host-owned analyzer runs only from an explicit Settings action or foreground
root request. It consumes the final Skill identity/provenance contract from
`agent-skill-authoring-foundation`.

Default scope includes unchanged `user` or `project` Skills with reliable model-
write provenance. It visibly excludes built-in, managed, hand-authored, pinned,
changed-after-provenance, and untrusted external-project content.

Deterministic findings include load/format failures, broken resource references,
exact duplicates, stale canonical tool names, and unused evidence only when
canonical invocation data exists. Semantic duplicate suggestions are labeled
separately and never treated as facts. Each row carries canonical Skill identity,
current bundle hash, evidence, suggestion, confidence, and exclusion reason.

The report itself cannot mutate. Applying a suggestion is a separate foreground
file action that rechecks current identity and hash; stale reports fail. Archive
is preferred to delete and merge output is shown before write.

### Dependencies and collisions

`agent-skill-authoring-foundation` and `desktop-host-cutover` must merge first.
The plan owns its Settings/Host report surface and must not overlap another Skill
Library claim.

### Verification

Tests cover inclusion/exclusion for every source/provenance state, deterministic
findings, semantic-label separation, hash staleness, missing telemetry, restart
of transient report state, and inability to mutate through the analyzer.
Settings receives narrow/light/dark/keyboard evidence.

### Acceptance criteria

- The analyzer runs only after explicit user/root action and performs no write.
- Every included/excluded row explains its evidence and current hash.
- Deterministic findings and semantic suggestions are visibly distinct.
- Missing invocation evidence yields `unknown`, never `unused`.
- Any later foreground action refuses a stale report hash.

## Open questions

Keep report state transient and keyed by the registry fingerprint unless
implementation evidence establishes a user need across restart.

## Implementation checklist

- [ ] Build the deterministic Host analyzer over final Skill identity/provenance.
- [ ] Add the explicit Settings/root report surface with exclusions and hashes.
- [ ] Keep application outside the analyzer and enforce stale-hash refusal.
- [ ] Update current Skill/Settings specs and run core, renderer, docs, and
      visual checks.
