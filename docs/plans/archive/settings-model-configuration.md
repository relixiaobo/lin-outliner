# Settings Model Configuration

## Goal

Ship the complete Settings control-plane Unit B: model connections and default
model selection are declared in the public `config/settings.jsonc` source, while
credentials, model catalogs, and operational snapshots remain owned by their
existing domain stores. A clean userData tree can configure and verify a model
without restart, and both the human Models surface and the Agent configuration
Skill reach the same source and owner boundaries.

## Non-goals

- No Settings or Configuration CLI, universal Agent setter, or second model
  preference store.
- No credential migration, inline secrets, credential-bearing URLs, or new
  identity namespace for Providers/models.
- No migration or legacy reader for `agent-providers.json`; pre-release test and
  development userData is reset and the old reader is removed.
- No rewrite of existing Threads, Sessions, remembered selections, or in-flight
  model snapshots when defaults or connections change.
- No delegation policy redesign; Runner policy remains the Unit C/Delegation
  owner, with only the shared model resolver contract consumed here.

## Design

### Public source and ownership

Extend the existing JSONC settings decoder/schema with `models.connections`,
`models.default`, and `models.imageDefault`. A connection contains only the
qualified Provider identity, adapter/endpoint, enabled state, and optional
explicit model declarations. An empty declaration list follows the live
provider catalog; a non-empty list is an exact model allow-list, with unknown
IDs reported as unavailable rather than silently replaced. Credentials are
resolved by provider identity from the private credential store; no credential
value or reference is written to the public source. `models.default`
defaults to `auto`; image defaults use the image owner's resolver and never use
root execution history. Preserve comments, ordering, unrelated values, source
digests, last-known-good recovery, and rejected-source behavior from Unit A.

The Models owner remains authoritative for credentials in `agent-secrets.json`,
catalog caches, connection probes, and complete effective snapshots. Remove the
old `agent-providers.json` connection/default reader and writer in this unit;
credential and catalog files remain domain-owned and are not folded into the
public source.

### Selection and application

Use one shared resolver for composer preview and new root Thread admission. The
precedence is: explicit Thread model, selected root Profile pin, explicit
`models.default`, valid remembered root selection in automatic mode, then the
Models owner's automatic runnable candidate. Explicit Provider/model/effort
requests never silently fall through to another Provider or model. Existing
Threads and in-flight work retain their snapshots; changing a default affects
only later unqualified Threads.

Accepted source changes update the Models owner through its application boundary.
Connection replacement is transactional at the snapshot level: endpoint,
adapter, enabled state, model inputs, selection intent, and credential identity
are promoted together only after verification. A failed or stale probe keeps the
previous complete active snapshot and reports the pending/rejected candidate.
Disable/remove prevents future use without deleting credentials or reviving an
older snapshot. Restart restores saved unverified candidates without requiring
credential entry again.

### Human and Agent workflows

The existing native Models/provider-config surfaces remain the human entry point.
They support provider/auth selection, endpoint, API key or OAuth, model choice,
Test Connection, Save, retry, and loading/error/pending states. Save persists a
new credential through the credential owner, then writes the exact non-secret
connection/default definition through the JSONC source editor, then tests that
saved candidate. Test Connection on an unsaved candidate never mutates source.
Sensitive values never cross renderer state or typed Agent results.

The built-in `configuration` Skill edits only declarative model/default fields;
credential login, reveal/copy/delete, connection tests, and catalog refresh are
routed to existing Models operations. Agent-supplied credentials are accepted
only from the current renderer-authored request and use the same credential-plus-
source workflow, never a general settings setter.

### Verification and retirement

Add decoder/schema/default and JSONC preservation tests, connection snapshot and
probe-generation tests, clean-start bootstrap tests, restart recovery tests,
composer/admission precedence tests, and Models UI/Agent reachability coverage.
Exercise stale source writes, concurrent edits, unavailable explicit selections,
credential rotation, disable/remove, failed probes, and crash cleanup. Update
the model runtime, Agent integration, Models surface, and configuration Skill
specs in the same PR. The PR is complete only when the old provider connection
reader/writer and duplicated default fields are absent and typecheck, focused
Core/renderer/E2E tests, docs checks, and visual light/dark verification pass.

## Open questions

None. Provider identity, credential ownership, selection precedence, recovery,
and the no-migration rule are fixed by `docs/plans/archive/settings-control-plane.md`.
