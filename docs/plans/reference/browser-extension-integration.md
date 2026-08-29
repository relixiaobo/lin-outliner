# URL Preview Rich Capture

## Goal

Allow a future explicit capture action to extract richer read-only content from
an already-visible Tenon URL Preview, such as the page body or current
selection, without introducing an extension or hidden page pipeline.

URL Preview remains an internal quick-preview surface backed by Tenon's
`persist:url-preview` partition. This plan does not provide browser automation
and has no target, session, profile, controller, or lifecycle relationship with
Agent Browser Control.

This is shape (a): one complete future rich-capture feature in one PR.

## Non-goals

- Agent Browser Control, browser task execution, page mutation, upload, eval,
  cookies, dialogs, auth, or network interception.
- Browser Pilot integration or control of Chrome, Edge, Brave, Chromium, or any
  external browser Profile or tab.
- Installing or publishing a browser extension.
- Importing cookies, saved passwords, history, autofill, extensions, or tabs.
- Guaranteeing provider sign-in or bypassing an embedded-user-agent policy.
- Treating external-browser URL/title capture as authenticated rich content.
- Reintroducing offscreen resolvers, AppleScript DOM scrapers, or a parallel
  hidden-page pipeline.

## Design

### Independent Product Boundaries

URL Preview serves quick in-app inspection. Browser Control serves Agent tasks
in the user's own browser. They may receive the same URL, but they do not share
browser state or implementation:

| Concern | URL Preview rich capture | Agent Browser Control |
|---|---|---|
| Source | Visible Tenon Preview guest | User browser through Browser Pilot |
| Access | Explicit read-only capture | Agent browsing and interaction |
| State owner | `persist:url-preview` | User browser Profile / Browser Pilot |
| Backend | Narrow Electron-main Preview reader | Bundled `bp` CLI through `bash` |
| Output | Capture source content | Browser task observations and files |

Neither capability falls back to the other. Browser Control does not attach to
Preview guests, and rich capture does not inspect the user's external browser.

### Preview-Owned Read Path

Electron main may register attached URL Preview guests with their owning
workspace pane and remove them on guest destruction. A narrow read-only
`PreviewContentReader` may expose only the content needed by an explicit capture:

```ts
interface PreviewContentReader {
  read(target: PreviewCaptureTarget): Promise<PreviewCaptureResult>;
}
```

The interface is not a generic browser controller. It exposes no action, target
adoption, external endpoint, debugger handle, cookie access, or reusable Agent
ref. The renderer never receives the Electron Session, credentials, or raw
debugger endpoint.

### Capture Consumer

The existing launcher capture contracts remain backend-neutral:
`ExternalContext`, `SourceDraft`, `CaptureNodeMetadata`, site classification,
normalization, and `create_capture` do not become browser-control APIs.

When the user explicitly captures an already-visible URL Preview, the capture
pipeline may ask the read-only Preview reader for bounded body or selection
content. If no eligible Preview is selected, capture continues through its
existing fallbacks. It does not open a Preview or external browser invisibly.

**This reader is the deferred SECOND rich-extraction source**, behind the
Host-owned static URL reader in
[`url-static-reader`](../url-static-reader.md). It earns its cost only for pages
a static fetch cannot read: JS-rendered pages or pages signed in inside Tenon's
own Preview partition.

The fallback chain is **structured read → URL + title → clipboard → manual entry**
(`unified-command-surface.md` D10). Only the first two exist today; there is no
screenshot tier, and none is planned — it would require a Screen Recording (TCC)
grant for a fallback-of-a-fallback.

### Safety And Data

- The operation is read-only and explicit; it cannot click, type, navigate,
  upload, execute arbitrary script, inspect cookies, or modify requests.
- Extracted content is normalized and bounded before entering capture data.
- Renderer state receives neither browser credentials nor raw website storage.
- Guest identity and read state are ephemeral and discarded when the Preview is
  destroyed.
- Clearing URL Preview website data remains the user's global Settings action.
- Browser Control safety and user-browser authorization lived in
  `agent-browser-control.md`, **superseded 2026-08-03** — Browser Pilot ships
  through the managed-Skill catalog instead, so that authority is the Skill's,
  not Tenon's. Archived at `docs/plans/archive/agent-browser-control.md`.

### Relationship To Current Modules

- `src/main/context/contextCapture.ts` keeps `PageContentExtractor` as an **ambient
  metadata** seam. Explicit reading — including this plan's Preview reader — goes
  through `ExplicitPageReader`, invoked only after the user picks an action; the
  ambient seam runs on every hotkey press and must never touch the network.
- `src/core/preview.ts` remains URL Preview target and navigation authority.
- `docs/spec/workspace-layout.md` remains the authority for the shipped URL
  Preview session and sandbox.
- `docs/plans/archive/agent-browser-control.md` was an independent Browser Pilot
  CLI integration and consumed none of this plan's interfaces; it is superseded
  and this plan never depended on it.
- Current specs change only when this complete feature ships.

## Open Questions

- Should rich extraction be available only for the active Preview pane, or may
  the user explicitly select another visible Preview?
- Should **Open in Preview and capture** be one explicit launcher command, or two
  normal user actions?
- Which normalized read-only fields belong on a durable capture node rather than
  a transient capture preview?

## Subtasks

- Define Preview guest identity and destruction handling in Electron main.
- Define the minimal read-only `PreviewContentReader` contract.
- Ratify the explicit rich-capture UX before implementing `ExplicitPageReader`'s
  Preview-backed variant.
- Add security tests proving the reader cannot mutate a page, address an
  external browser, or expose raw session credentials.
