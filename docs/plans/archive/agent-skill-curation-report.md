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

Deterministic findings cover broken or root-escaping Markdown resource
references, exact `SKILL.md` content duplicates, and stale canonical tool names.
Load and parse failures remain the responsibility of the existing Skill
diagnostics. The runtime has no complete invocation telemetry, so the report
does not infer unused Skills or produce semantic duplicate suggestions. Each
row carries canonical Skill identity, current bundle hash, findings, and an
exclusion reason when it is outside the report scope.

The report itself cannot mutate and currently has no apply path. Any future
foreground action must recheck current identity and hash; stale reports fail.

### Dependencies and collisions

`agent-skill-authoring-foundation` and `desktop-host-cutover` must merge first.
The plan owns its Settings/Host report surface and must not overlap another Skill
Library claim.

### Verification

Tests cover inclusion/exclusion for every source/provenance state, deterministic
findings, hash staleness, and inability to mutate through the analyzer. The
Settings surface has focused DOM coverage; the report state remains transient.

### Acceptance criteria

- The analyzer runs only after explicit user/root action and performs no write.
- Every included/excluded row explains its evidence and current hash.
- Deterministic findings are visibly tied to the included row, while excluded
  rows explain their provenance or source boundary.
- Missing invocation evidence does not produce an `unused` finding.
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
