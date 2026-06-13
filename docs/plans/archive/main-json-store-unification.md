# Main-process JSON persistence unification: one store primitive

**Shape: (a) ONE complete feature in one PR.** A pure structural refactor —
zero on-disk format change, zero behavior change — that collapses the
main process's hand-rolled JSON persistence into one shared primitive.
**PM-ratified 2026-06-10** (from the systematic pre-release architecture
sweep). Same disease #152 cured on the ledger side ("one `AppendOnlySeqLog`,
never a copy-pasted parallel impl per family"), now cured on the JSON side.

## The fragmentation (verified `file:line`, 2026-06-10)

The same job — "atomically persist a small JSON file" — has **three
independent atomic-write implementations plus two synchronous outliers**:

| Caller | Impl | Lock | Mode | Tmp-name entropy |
|---|---|---|---|---|
| `agentSettings.ts:685-696` | own `atomicWrite` | ✅ `withFileLock` per path | ✅ param | pid + counter |
| `documentService.ts:841-845` | own `atomicWrite` | ❌ | ❌ | pid + Date.now + random |
| `assetService.ts:133` | own tmp-rename | ❌ | ❌ | pid + Date.now |
| `agentToolPermissionStore.ts` | own (chmod 0600) | ❌ | ✅ | — |
| `appPreferences.ts` | **sync** `readFileSync`/`writeFileSync`, errors swallowed | ❌ | ❌ | none (no tmp) |
| `windowState.ts` | **sync** read, best-effort write | ❌ | ❌ | none (no tmp) |

Consequences today: only `agentSettings` serializes concurrent writes; asset
ingest writes two files per asset (`<id>.<ext>` + `<id>.meta.json`) with no
joint completion guarantee; `assetService`'s in-memory `metaCache` is not
invalidated on delete; `appPreferences`/`windowState` writes are neither
atomic nor surfaced on failure. None of these is a live bug — serial IPC
masks the races — but the absence of a shared primitive is the data-loss
vector waiting for the first concurrent writer.

## Goal

One module owns "atomic JSON file" for the main process; every caller above
consumes it. After this PR, `rg "\.tmp\`" src/main` finds exactly one
tmp-rename implementation.

## Design (build order within the one PR)

1. **The primitive** — new `src/main/jsonFileStore.ts`:
   `atomicWriteFile(path, data, {mode?})` (tmp + rename, per-path write
   serialization lock, optional chmod — the union of the three existing
   impls, seeded from `agentSettings.ts`'s, which is the most complete) +
   `readJsonOrDefault<T>(path, parse)` (parse-or-default with explicit
   validation hook). A thin `JsonFileStore<T>` wrapper is optional sugar —
   add it only if it removes code at ≥2 call sites.
2. **Adopt** — `agentSettings`, `documentService`, `assetService`,
   `agentToolPermissionStore` (keeps 0600 via the mode param),
   `appPreferences`, `windowState`. Boot-time constraint honored:
   `appPreferences`' synchronous **read** at app start (theme before first
   window) stays a sync read; only the write path moves onto the primitive.
3. **Asset coupling fixes** (the two adjacent holes, same files):
   `ingest()` awaits BOTH binary + `.meta.json` writes before returning;
   `delete()` invalidates `metaCache`.
4. **Pin zero format change:** every file name, path, and JSON shape stays
   byte-identical. This PR must be invisible on disk.

## Non-goals (boundary — 钉死)

- NOT the agent ledger engine (`AppendOnlySeqLog` is already the unified
  primitive on the event-log side; this is the JSON-file side only).
- NO new dependency (no electron-store); NO file renames/moves; NO schema
  changes; NOT Windows ACL hardening (`agent-secrets-windows-acl`, separate).
- NOT renderer localStorage (separate fast-track, same sweep).

## Acceptance

- [ ] Exactly one tmp-rename implementation under `src/main/` (grep).
- [ ] Secrets/permissions files still land 0600 (existing tests + one mode
      assertion through the new primitive).
- [ ] Concurrent-write serialization test on the primitive (two interleaved
      writes → last-writer-wins intact file, no torn read).
- [ ] Asset ingest returns only after both files exist; delete invalidates
      the meta cache (unit tests).
- [ ] On-disk fixtures byte-identical before/after (no format drift).
- [ ] `bun run typecheck` + `bun run test:core` green vs known baselines.

## Collision self-check (2026-06-10, plan time)

Touches `agentSettings.ts` + `documentService.ts` — **queues behind PR #180**
(`agent-storage-clean-cut`, in gate) which renames identifiers in the same
files; re-verify every `file:line` anchor at claim time. No protocol-surface
change (`commands.ts`/`types.ts` untouched). Independent of M3-A/run-unification
otherwise — any clone can take it after #180 merges.
