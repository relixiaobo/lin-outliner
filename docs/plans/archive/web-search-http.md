# Web Search over HTTP

## Goal

Make ordinary `web_search` a fast, independent HTTP operation while preserving
its existing parameters, bounded result envelope, and source-discovery role.
This is one complete feature in one PR, including removal of the replaced
Google/DuckDuckGo browser path and live Electron verification.

## Non-goals

No Chrome automation, Google CSE workaround, new runtime dependency, generic MCP
client framework, Settings UI, image-search redesign, or web-fetch refactor.

## Design

Follow OpenCode's built-in search approach: the Host sends a bounded JSON-RPC
`tools/call` HTTP request to a fixed hosted search endpoint. Parallel is the
primary provider; Exa is the fallback. The existing `web_search` contract keeps
`query`, `limit`, `site`, `recency_days`, and the independent image kind.

A small Electron-independent search module owns provider request mapping,
JSON/SSE envelope decoding, result normalization, and the two-provider policy.
`agentTools` supplies a credential-free Electron `Session.fetch` transport so
the app continues to use the system proxy. An optional provider API key is read
from its conventional process environment variable and sent only in a header;
default anonymous calls need no setup. Provider URLs remain fixed, and redirects
are rejected. No browser session, cookies, or remote page scripts are used.

Each eligible provider gets one attempt. A bounded total deadline covers both
requests and response reads; caller cancellation stops the chain. Distinguish
HTTP rate limits, transport/timeout faults, protocol/tool errors, malformed
results, and authoritative empty results. A non-empty result wins; an empty
response must not erase a failure from another attempted provider. Preserve
provider attempt diagnostics in Host details and return actionable bounded
failure instructions without asking the Agent to reformulate a blocked query.

Normalize Parallel's structured results and Exa's search text into existing
title/URL/snippet records. Validate complete HTTP(S) URLs without embedded
credentials, deduplicate URLs, and bound titles, excerpts, and total output.
Retain publication dates where available. Treat site and recency controls
honestly: encode supported hints and disclose any best-effort limitation.

Keep short bounded success caching and provider cooldown state inside the
search client. Equivalent requests can share in-flight work while each caller
retains independent cancellation; cancel the underlying operation when no
caller remains. Scope cache identity to all search-affecting inputs and provider
configuration. Never cache errors or cancelled work.

Remove the superseded Google/DuckDuckGo DOM extractors, redirect resolver,
navigation helpers, and their obsolete tests. Preserve Bing Images extraction,
retry, and browser security behavior. Update the existing web-tool probe to
verify the real HTTP provider, usable records, and zero browser creation for
ordinary search.

### File scope and collision result

- `src/main/agent/capabilities/agentTools.ts`: web-search composition and removal
  of the replaced search-only browser helpers.
- Search implementation and image extractor modules under
  `src/main/agent/capabilities/`; `agentWebTools.ts`, `agentWebConstants.ts`, and
  search guidance only where the search contract needs alignment.
- Relevant Core web-search tests and `scripts/probe-web-tools.ts`.
- This plan and the Web And Image section of `docs/spec/agent-tool-design.md`.

Open PR #661 overlaps on `agentTools.ts`, `agentWebTools.ts`, their web-tool
tests, and `agent-tool-design.md`. Its changes concern `web_fetch` projection
and output budgets; this change owns web search and preserves those functions.
The integration gate must retain both changes when sequencing the PRs. No
infrastructure-owned or Core protocol file is required. The board contains no
other active web-search implementation claim.

### Risks and verification

Hosted anonymous access has rate limits and external availability dependencies.
Exa's text response can drift; decode it explicitly and fail with a provider
error rather than returning arbitrary text as search results. Source excerpts
remain untrusted discovery data and require `web_fetch` for factual evidence.

Verify JSON/SSE responses, malformed and oversized payloads, URL admission,
rate limits and cooldowns, fallback truthfulness, timeout and cancellation,
cache isolation, concurrent callers, and the model-visible result contract.
Run typecheck, relevant Core suites, docs checks, and the real Electron probe
using isolated research userData. Re-run the original Chinese weather query
and an English technical query; record timings and actual provider attribution.

## Open questions

None for this implementation. Provider account provisioning or a public
Settings selector can be a separate complete feature if the anonymous service
capacity proves insufficient.
