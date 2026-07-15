# Preview Browser Backend Reuse

## Goal

Keep one browser backend and one user-visible web surface. URL Preview owns the
browser profile, navigation, guest lifecycle, and website state. Future rich
capture and Agent Browser Control may reuse a main-process read/control
interface over those guests; neither capability may introduce an extension,
external browser profile, hidden browser, or second browser UI.

This is shape **(b)**: a set of independently complete future features. Rich
capture from an already-open Tenon Preview and Agent Browser Control can ship
separately. The detailed action/tool design remains in
`agent-browser-control.md`.

## Non-goals

- Installing or publishing a Chrome/Chromium extension.
- Reading `DevToolsActivePort`, asking users to enable remote debugging, or
  attaching to Chrome, Edge, Brave, Chromium, or their profiles.
- Importing cookies, saved passwords, history, autofill, extensions, or tabs.
- Treating an external browser's active tab as a rich capture source. The
  existing basic launcher capture can still record its public URL/title through
  OS integration, but authenticated DOM state stays outside Tenon.
- Reintroducing the deleted offscreen YouTube resolver, AppleScript DOM
  scrapers, payload/resolver sidecar, or any parallel hidden-page pipeline.

## Design

### One Owner

`persist:url-preview` is the only website-data owner. The renderer hosts the
visible guest but never receives its Session, cookies, credentials, or debugger
endpoint. Electron main registers each attached URL Preview guest with its
owning workspace pane and removes the entry on guest destruction.

A future main-process `BrowserController` exposes capabilities over a registered
guest, not over an arbitrary endpoint:

```ts
interface BrowserController {
  listPreviewTargets(): Promise<PreviewBrowserTarget[]>;
  observe(targetId: string, request: BrowserObserveRequest): Promise<BrowserObservation>;
  act(targetId: string, request: BrowserActionRequest): Promise<BrowserActionResult>;
}
```

The concrete implementation uses Electron's debugger/CDP access on the guest
`webContents`. The interface keeps capture and control from duplicating target
identity, frame addressing, snapshot refs, image/payload handling, or lifecycle
cleanup. It is not a plug-in seam for external browsers.

### Capture Consumer

The current launcher capture contract remains backend-neutral:
`ExternalContext`, `SourceDraft`, `CaptureNodeMetadata`, site classification,
normalization, and `create_capture` stay unchanged. `PageContentExtractor` may
consume the read-only `BrowserController.observe` subset only when the selected
source is a registered Tenon Preview target.

An external app/browser capture continues to degrade to the current basic
URL/title/provenance result. Tenon does not prompt for an extension. A future UX
may offer the existing **Open in Preview** route before a rich capture, but that
is a separate product decision and must not happen invisibly.

### Browser Control Consumer

Agent Browser Control uses the same target list and observation results, then
adds action, upload, eval, cookie, dialog, and network operations behind its own
permission classes. It attaches only to visible Tenon Preview panes. Opening a
new target routes through the normal `PreviewTarget` workspace flow so the user
can see where the agent is operating.

### Safety And Data

- Read access, screenshots, cookies, uploads, eval, network inspection, and
  page mutations remain separately classified agent permissions.
- Browser credentials and raw cookie values never enter renderer state.
- Model-visible images use image content; large/raw results use existing payload
  refs and retention instead of ad hoc files.
- Run-scoped snapshots, element refs, debugger attachments, and network rules
  are discarded when the run ends or the guest is destroyed. Clearing website
  data remains the user's global Settings action and is never an agent tool.
- Passkey and unsigned mock-keychain limitations belong to the Preview profile
  itself; capture/control cannot bypass them.

## Relationship To Current Modules

- `src/main/context/contextCapture.ts` keeps the `PageContentExtractor` seam.
- `src/core/preview.ts` remains the URL target/navigation authority.
- The URL Preview session/guest registry is the only browser target source.
- `agent-browser-control.md` owns tool schemas, permissions, actions, result
  envelopes, and its resource-backed skill.
- Current specs change only when one of these complete features ships.

## Open Questions

- Should launcher capture offer rich extraction only when the active workspace
  pane is a URL Preview, or may the user explicitly choose another visible
  Preview pane?
- Should **Open in Preview and capture** be one explicit launcher command, or two
  normal user actions?
- Which read-only observation fields are safe to retain on a capture node versus
  only in an agent event payload?

## Subtasks

- Define Preview guest identity and lifecycle events in main.
- Define the read-only `BrowserController.observe` contract around those guests.
- Adapt `PageContentExtractor` only after the rich-capture UX is ratified.
- Keep the action surface in the independent Agent Browser Control plan.
- Add contract tests proving neither consumer can address an external browser or
  receive raw session credentials.
