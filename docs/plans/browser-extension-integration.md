---
status: draft
owner: unassigned
branch: (none yet)
related: unified-command-surface.md, launcher-provider-expansion.md
---

# Browser Extension / CDP Integration — One Backend, Two Tiers

**Forward-looking design. RECORD ONLY — do not execute.** Captured from a PM
brainstorm so the decisions survive context compaction. Nothing here is approved
to build; each "PM decision" below is an open gate.

## The core idea

Content **capture** (read-only snapshot of the current tab) and an agent
**browser-control tool** (read + act) are two tiers of the *same* browser backend.
Today capture rides macOS AppleScript + an Accessibility (AX) native addon; both
tiers would instead ride a browser **extension** (or raw **CDP**), which addresses
tabs by `tabId`/`targetId` — eliminating the "wrong window/instance" problem that
the current AppleScript path spends most of its complexity working around.

Design rule that falls out: when we abstract the backend, abstract it as a
`BrowserController` (read **and** act), not a read-only reader. Capture calls its
read subset; the agent tool calls its action surface. One backend, one tab
addressing model, one permission surface.

## Why this is mostly reuse, not new machinery

The current capture pipeline already separates the durable contract/logic from the
swappable IO:

- **Stays (backend-agnostic):** `ExternalContext` / `SourceDraft` /
  `CaptureNodeMetadata` (provenance-only) contract; the `*Raw` metadata shapes;
  `selectSiteProvider` + the per-provider `enrich*Context` pure functions; the
  save pipeline (`buildContextCaptureInput` → `create_capture`).
- **Swaps (well-localized):** the rich-metadata acquisition only — a new backend
  produces the same `*Raw` JSON via the `PageContentExtractor` seam → the normalizer
  + enrichers are untouched. (The AppleScript page-script bodies are already gone;
  the extension reads via the content script / `Runtime.evaluate` instead.)
- **Removed (rebuilt on this backend, not carried):** the offscreen YouTube
  transcript resolver, the resolver runtime + `apply_capture_resolver_result`
  write-back, and the payload-to-file pipeline (`CapturePayloadRef` /
  `CaptureResolverRef` / `CapturedContent` / `CapturedMedia`). Body/transcript/media
  extraction comes back as a first-class capability of this backend, on one path —
  not as a separate offscreen-scrape mechanism kept alive in the meantime.

The read seam now exists: `PageContentExtractor` in `contextCapture.ts`, injected
into `captureExternalContext`. For the agent **control** tool (Tier 2) this should
grow into the fuller `BrowserController` (read **and** act) — capture uses the read
subset:

```ts
interface BrowserController {
  // read — already expressed by PageContentExtractor.extract(...)
  extract(input): Promise<GenericWebpageRaw | null>;
  // act (Tier 2) — navigate / click / type / readDom / readNetwork / evaluate
}
// AppleScript basic-info reader (today) ⇄ ExtensionController / CdpController (later)
```

## Current state (decided 2026-06-04)

All in-app rich-content extraction was **removed** (clean deletion, not a flag), in
two steps: first the AppleScript in-page DOM scrapers, then the offscreen YouTube
transcript resolver and the entire payload/resolver apparatus behind it. Rationale:
the toggle friction + wrong-window fragility (AppleScript) and a parallel
offscreen-scrape mechanism aren't worth carrying when this backend will provide
body/transcript/media on one clean path; dead code behind a flag would just rot
during an open-ended wait. So today capture runs the **Basic tier only** — URL +
title + app + a URL-derived provider classification.

What was deleted: `runPageScript` / `pageScriptCommand` / the page-script bodies
(`GENERIC_WEBPAGE_JS` / `X_TWITTER_JS` / `YOUTUBE_WATCH_JS`); the AX-vs-AppleScript
mismatch + scriptBlocked + multi-instance reconciliation + the dead
warnings/remediation kinds; the offscreen transcript resolver
(`youtubeTranscript.ts` + scrape JS) + `resolverRunner.ts` + `captureStore.ts`; the
`apply_capture_resolver_result` protocol command; and the payload/resolver/content
sidecar schema (`CapturePayloadRef` / `CaptureResolverRef` / `ResolverKind` /
`CapturedContent` / `CapturedMedia` / `deriveCaptureStatus`). The capture sidecar is
now provenance-only.

What was kept (the backend-neutral contract the extension feeds): `selectSiteProvider`
+ the per-provider `enrich*Context` (they run URL classification now), the `*Raw`
metadata types, and the normalizer's raw-consumption path that folds `raw` into the
saved `SourceDraft`. Not built (correctly skipped as throwaway): LinkedIn / Gmail
AppleScript DOM scrapers.

**The seam for the future backend is now explicit:** `PageContentExtractor` in
`src/main/context/contextCapture.ts`. `captureExternalContext(args)` takes an
optional `extractor`; today none is passed (basic info). The extension/CDP backend
implements `extract({ url, family, appName, provider }) → GenericWebpageRaw | null`,
and the orchestrator feeds its output into the existing normalizer + enrichers — no
other change. That single interface is the entire plug-in point.

## Tier 1 — Capability ladder for capture + graceful degradation

The behavior the PM specified ("extension → rich capture; no extension → prompt;
still declined → auto-fall-back to basic info") maps 1:1 onto the **existing**
degradation ladder (`remediationForContext` in `launcherModel.ts` + the
"Saving the link only" floor). Capture always succeeds; a quiet banner explains how
to unlock more.

| Tier | Condition | Yields | On miss |
|---|---|---|---|
| Basic (current floor, always) | no permission | URL, title, canonical, OG/author/published; URL-derived #tweet/#repo/#article shape | — |
| Top (future) | extension installed | in-page Defuddle + per-site extractors + transcript/body/media; correct tab guaranteed | banner: install extension |

(The former AppleScript "middle tier" — body text/selection via the Apple Events
toggle — was removed; capture is now just {Basic floor, future extension Top}.)

What's actually new (small):

1. **Extension presence handshake** — a cheap, **non-blocking** detection (must not
   stall the hotkey→visible path; capture is async by design, A9). Options:
   extension registers a native-messaging host we ping; extension writes a known
   marker; or attempt-connect with a short timeout.
2. **`extension-missing` remediation** — a new `LauncherRemediation['kind']` beside
   `browser-js` / `automation`, reusing the same quiet banner, with an install entry point.
3. **Prompt-once, then stay quiet** — persist the user's "ignore/decline install"
   choice (like `agentToolPermissionStore` persists permission decisions) and
   **silently** use the basic-info floor afterward; only re-surface when the user
   explicitly asks why content is missing. This is the only genuinely new state the
   "still doesn't install → fall back" requirement needs.

The AppleScript middle tier is already gone, so the steady state is simply
{extension, basic}. The *prompt* is only ever "install the extension."

## Tier 2 — Agent browser-control tool

If the extension is present, expose a `browser` / `browser_*` tool family letting the
in-app agent complete tasks that require a browser (things needing a logged-in
session). This plugs into existing agent infrastructure — it's adding a tool, not a
subsystem:

- Implement as a sibling of `src/main/agentWebTools.ts` (e.g. `agentBrowserTools.ts`);
  register in `docs/spec/agent-tool-design.md` Tool Registry.
- Gate via the existing permission stack: `agentPermissions.ts`,
  `agentToolPermissionRules.ts`, `agentPermissionClassifier.ts`,
  `agentPermissionAskResolver.ts`, `agentToolPermissionStore.ts` (web tools are
  already host-scoped + approval-gated — reuse the pattern).
- Audit every action via `agentEventLog`.

**The hard part is the safety model for acting, not the plumbing** (read-only capture
is low risk; an agent clicking/submitting/sending in a logged-in browser is not):

- **Read/write split** — read actions auto-allowed; mutating actions classified for approval.
- **Per-action confirmation for irreversible/outward-facing actions** (send / submit /
  publish / purchase / irreversible clicks). Never a blanket "allow browser" switch.
- **Dedicated tab/window** (browser-pilot's "Pilot window" model) so the agent doesn't
  clobber the user's active tab and blast radius is bounded.
- **Hard prohibitions even with approval** — a list consistent with the app's safety
  stance (financial transfers, entering credentials/passwords, changing access
  controls/settings). Decide the list explicitly.

## Backend options (reference)

| | Raw CDP (browser-pilot model) | Extension (sider-agent model) |
|---|---|---|
| User setup | toggle Chrome 144+ remote-debugging once | install an extension |
| Integration from Electron | connect WS directly (no extension to publish) | extension ↔ Electron via native messaging |
| Extraction quality | `Runtime.evaluate` + AX tree; self-assembled | content script in-page: Defuddle + per-site (most robust) |
| Coverage | any Chromium with debug port on | only browsers we ship the extension for |
| Security surface | any local process can drive Chrome | MV3 `<all_urls>`, scoped to the extension |
| Tab addressing | dedicated Pilot target ids | `tabId` / sidebar window id |

Both eliminate the wrong-window problem. Extension = best extraction + most capable
for *control*; CDP = lightest to integrate. Reference clones:
`~/Coding/browser-pilot` (CDP via `DevToolsActivePort`), `~/Coding/sider-agent`
(MV3 extension + `chrome.debugger`, 17 browser actions, Defuddle).

## PM decisions needed (gates)

1. Build a browser extension at all? Extension vs raw CDP for the backend.
2. Approve the capture capability-ladder + prompt-once degradation (small; extends
   existing remediation) — could ship ahead of any control tool.
3. The agent browser-control tool: its safety/approval model, dedicated-tab policy,
   and the prohibited-even-with-approval list. (Biggest, most directional.)
4. Whether capture and control land as one plan or split (capture-tier first,
   control later) once approved.

## Open questions

- Extension distribution (Chrome Web Store vs unpacked/enterprise) and the
  native-messaging trust handshake.
- Login/age-gated content: acting in the user's real session is the value and the
  risk — privacy review before any authenticated content is stored.
- Transcript/body/media extraction is now a from-scratch capability of this backend
  (the offscreen resolver was removed): decide its storage model (the old
  payload-to-file sidecar is gone — design the replacement here, e.g. agent-context
  attachment vs. a slimmer re-introduced payload ref) when this plan is scheduled.
