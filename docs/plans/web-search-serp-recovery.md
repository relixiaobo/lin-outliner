# Web Search SERP Recovery

## Goal

Restore truthful, useful `web_search` results after Google changed organic result
links from directly readable URLs to opaque `/goto?url=...` tokens. A search page
that visibly contains results must not be reported as a successful zero-hit
search merely because one extractor can no longer recover its target URLs.

This plan has shape **(a): one complete feature in one PR**. The PR ships the
provider fallback, truthful outcome classification, regression coverage, live
Electron probe, and current-behavior specification together.

## Non-goals

- Do not expose a generic redirect-resolution capability or fetch result-page
  content while searching.
- Do not add a paid search API, API key, dependency, local search index, or
  renderer behavior.
- Do not change `web_search` arguments or the model-visible result schema.
- Do not change image search; Bing Images remains its existing provider.
- Do not clear or migrate the persistent search partition.

## Collision Result

`gh pr list` and `docs/TASKS.md` were checked on 2026-09-02. Draft PRs #611 and
#613 own model-context and tool-result-protocol specifications, respectively;
neither claims the web capability implementation, `agent-tool-design.md`, the
web probe, or `package.json`. No active board item claims web search or SERP
providers.

`package.json` is touched only to make the existing `probe:web-tools` build
externalize the Vite-owned `?nodeWorker` module. There is no dependency or
lockfile change. The Draft PR claim names this infrastructure file explicitly.

## Design

### Provider chain

Keep Google as the first web provider because its ranking is useful. Its
extractor preserves ordered direct links and opaque `/goto` candidates. Resolve
only bounded `https://www.google.com/goto?url=...` candidates in a dedicated
Google-provider window using the same credential-free search session. Intercept
the first main-frame `will-redirect`, call `preventDefault()` before Chromium
requests the target, then admit the redirect URL only when it is external
HTTP(S). Deny popups and permissions; reject timeout, missing redirect, same-host
redirect, invalid protocol, abort, and any second navigation. The resolver is
provider-private and never becomes a general redirect or fetch primitive.

Keep DuckDuckGo HTML as the second and final provider. Its `uddg` links already
carry locally recoverable targets. Do not add Bing Web: a live probe showed that
it returned non-empty but irrelevant results for the reported regression query,
which would replace honest failure with noise.

Run fallback only when Google is blocked, genuinely empty, or failed
recoverably. Retain the existing single transient retry per engine and one
rate-limit slot per tool call. The successful outcome reports the provider that
actually supplied results.

### Empty-result truth

An engine outcome distinguishes:

- non-empty parsed results: authoritative success;
- a normal, parsed SERP with no organic candidates: authoritative empty;
- organic candidates present but none safely recoverable: extraction failure;
- challenge, SPA shell, transport failure, invalid input, or abort: the existing
  hint/error categories.

The chain returns a successful empty result only when every attempted provider
that reached a normal SERP reports a genuine empty result and no provider
produces results. If all providers fail or are blocked, surface the most useful
diagnostic outcome instead of `ok: true` with `results: []`.

### Verification and probe

Add pure DOM fixtures for ordered Google direct/opaque links and
empty/candidate-miss distinctions. Add tests for the resolver's strict input and
target admission plus the two-provider chain's outcome precedence.

Strengthen the real Electron probe with a stable known-source query, require at
least one validated result, then `web_fetch` that returned URL and verify its
content. Record search-partition requests and fail if search requests the
returned target before fetch begins. Provider challenges remain an explicit
skip only when the tool returns a challenge hint; silent successful empty output
is a failure. Repair the probe build command by externalizing the Vite-owned
secret-scan worker import so the probe actually reaches Electron.

Document the provider chain and the distinction between a genuine empty SERP
and extraction failure in `docs/spec/agent-tool-design.md`.

## Files

- `src/main/agent/capabilities/agentWebSearchSerp.ts`
- `src/main/agent/capabilities/agentWebConstants.ts`
- `src/main/agent/capabilities/agentWebTools.ts`
- `src/main/agent/capabilities/agentTools.ts`
- `tests/core/agentWebSearchSerp.test.ts`
- `scripts/probe-web-tools.ts`
- `package.json`
- `docs/spec/agent-tool-design.md`

## Risks

- Search-engine markup can drift again. Pure extractors, explicit candidate
  counts, and the live probe make drift observable without treating it as no
  public information.
- Google redirect resolution must fail closed. Only the first intercepted
  external HTTP(S) redirect is returned, and the target request must never be
  sent during search.
- A two-engine failure path can be slower. Providers remain sequential and
  bounded, retries stay limited to transient navigation faults, and successful
  earlier engines avoid later work.
- Public providers can challenge automated browsing. Challenges stay visible as
  hints/errors and are never collapsed into an authoritative empty result.

## Open questions

None. The PM ratified the provider recovery and truthful-empty direction on
2026-09-02, then ratified the provider-private Google redirect boundary and no
Search API on the same date after the Bing quality probe failed.

## Verification

- `bun run typecheck`
- `bun test tests/core/agentWebSearchSerp.test.ts tests/core/agentWebTools.test.ts`
- `bun run probe:web-tools`
- `bun run docs:check`
- `git diff --check`
