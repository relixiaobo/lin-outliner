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

- Do not decode, replay, or follow Google's opaque `/goto` tokens.
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

Keep Google as the first web provider because its ranking is useful, but treat a
page with organic result headings and zero recoverable external URLs as an
extraction failure rather than a valid empty result. Google `/goto` tokens are
opaque, session-bound redirect capabilities; Tenon must not invent a URL from
the visible citation or visit every result solely to discover its target.

Keep DuckDuckGo HTML as the second provider. Add Bing Web as the third provider,
using its server-rendered `li.b_algo h2 a` rows. Bing's `ck/a` redirect carries
the target in the URL-safe base64 `u` parameter with an `a1` prefix; decode and
validate that target as HTTP(S), while continuing to accept direct external
links. Skip sponsored rows, internal Bing links, malformed redirect payloads,
duplicates, and entries without a title.

Run each fallback only when the preceding engine is blocked, empty, or failed
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

Add pure DOM fixtures for Google opaque links, Bing direct and encoded targets,
malformed redirects, ads, and empty/candidate-miss distinctions. Add decision
tests for the three-provider chain's outcome precedence.

Strengthen the real Electron probe with a current-information query and require
at least one result from the provider chain. Provider challenges remain an
explicit skip only when the tool returns a challenge hint; silent successful
empty output is a failure. Repair the probe build command by externalizing the
Vite-owned secret-scan worker import so the probe actually reaches Electron.

Document the provider chain and the distinction between a genuine empty SERP
and extraction failure in `docs/spec/agent-tool-design.md`.

## Files

- `src/main/agent/capabilities/agentWebSearchSerp.ts`
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
- Bing redirect decoding must fail closed. Only a successfully decoded HTTP(S)
  target is returned; opaque or malformed values are skipped.
- A three-engine failure path can be slower. Providers remain sequential and
  bounded, retries stay limited to transient navigation faults, and successful
  earlier engines avoid later work.
- Public providers can challenge automated browsing. Challenges stay visible as
  hints/errors and are never collapsed into an authoritative empty result.

## Open questions

None. The PM ratified the provider recovery and truthful-empty direction on
2026-09-02.

## Verification

- `bun run typecheck`
- `bun test tests/core/agentWebSearchSerp.test.ts tests/core/agentWebTools.test.ts`
- `bun run probe:web-tools`
- `bun run docs:check`
- `git diff --check`
