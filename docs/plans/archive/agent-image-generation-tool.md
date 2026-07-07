# Agent Image Generation Tool

This plan adds a first-party `generate_image` agent tool and cleans up provider
capability handling so language models and image-generation models no longer
share one undifferentiated model surface.

This is shape **(b): a set of independent complete features**:

1. **pi 0.80.3 maintenance PR.** Upgrade `@earendil-works/pi-ai` and
   `@earendil-works/pi-agent-core` from `0.80.2` to `0.80.3`, then sync the
   pi-mono spec. This is useful and shippable by itself.
2. **Image generation feature PR.** Add image capability discovery,
   first-party image providers, the `generate_image` tool, and the matching
   provider/settings UI changes. This PR must ship as a complete usable feature;
   do not land a capability-only scaffold that a later PR makes useful.

## Goal

Let Neva generate or edit images through a Tenon-owned `generate_image` tool
while reusing the user's existing provider credentials.

The user should not have to enter an OpenAI key twice to use OpenAI chat models
and `gpt-image-2`, or enter a Gemini key twice to use Gemini language models and
Nano Banana image models. Provider setup remains a connection/capability
surface; model defaults live in the surfaces that use models.

## Objective, Constraints, And Options

- **OBJ-1:** Users can ask Neva to generate or edit images without leaving the
  agent conversation or configuring a second credential for the same provider.
- **Minimum acceptable outcome:** One enabled first-party OpenAI or Gemini
  provider can run `generate_image`, generated images appear in the transcript
  as image payloads, and image models do not appear in the language model picker.
- **Selected target:** Build a Tenon-owned image tool backed by pi-ai
  `ImagesModels` plus local first-party image providers.
- **Rejected target:** Expose only pi-ai's built-in OpenRouter image provider.
  It is technically simpler, but it violates the credential reuse requirement
  for users who already configured OpenAI or Gemini directly.
- **Revisit trigger:** If pi-ai ships first-party OpenAI/Gemini image providers,
  replace Tenon's local adapters with pi built-ins behind the same
  `piImageModels.ts` boundary.

### Constraints

- **CON-1 hard:** Renderer-facing provider/settings IPC must not return raw API
  keys outside the existing sender-checked provider config child-window path.
- **CON-2 hard:** Disabled providers are unavailable for both language model
  routing and image-generation routing.
- **CON-3 hard:** Provider records do not own default models.
- **CON-4 legacy:** The current provider settings DTO exposes `models` as the
  language model list. The image feature should preserve that field as
  language-only unless a coordinated DTO rename is approved.
- **CON-5 resolvable:** pi-ai currently has only OpenRouter built-in image
  providers. Tenon can supply local first-party providers now and delete them
  later if pi-ai adds built-ins.

## Non-goals

- Do not expose pi-ai's image generation API directly as the product surface.
  The agent calls Tenon's `generate_image` tool; Tenon may use pi-ai
  `ImagesModels` internally.
- Do not put image-generation models in the agent language model picker.
- Do not add a provider-owned default model. A provider is a connection record,
  not a routing preference.
- Do not require an OpenRouter key to use OpenAI or Gemini image generation when
  the user already configured OpenAI or Gemini directly.
- Do not add image insertion into the outline as a side effect of generation.
  The tool returns generated image outputs; the agent can use existing document
  or file tools when the user explicitly wants to save or insert them.
- Do not add video generation, audio generation, or a generic media-generation
  meta-tool in this change.

## Source Notes

Current project state:

- Tenon pins `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` at
  `0.80.2`.
- npm latest for both packages is `0.80.3` as of 2026-07-07.
- `pi-agent-core@0.80.3` depends on `@earendil-works/pi-ai@^0.80.3`.
- `docs/spec/agent-pi-mono-implementation.md` still documents `0.74.0`, so the
  spec is stale and must be corrected with the dependency bump.

pi-mono image surface:

- pi-ai separates chat `Models` from image `ImagesModels`.
- Image generation is a one-shot `generateImages()` API, not a chat stream.
- Image models do not participate in tool calling.
- Built-in pi-ai image generation currently registers only the OpenRouter image
  provider. pi-ai `0.80.3` includes OpenRouter catalog entries such as
  `openai/gpt-image-2` and Nano Banana variants, but those require OpenRouter
  credentials and should not be Tenon's primary solution for users who already
  configured first-party OpenAI or Gemini keys.

External provider docs checked:

- OpenAI's image generation guide and model page list `gpt-image-2` as a GPT
  Image model that supports text and image input with image output.
- Google's Gemini API image generation docs describe Nano Banana as Gemini's
  native image generation and editing capability, with multiple API models
  including `gemini-3.1-flash-lite-image`, `gemini-3.1-flash-image`,
  `gemini-3-pro-image`, and legacy `gemini-2.5-flash-image`.

## Product Decisions

### DEC-1: Provider Configuration Owns Connections, Not Defaults

Provider settings must describe whether a provider is configured, enabled,
credentialed, reachable, and what capabilities were discovered. It must not
store an image default model, just as it must not store a language default
model.

### DEC-2: Capability Catalogs Are Typed

Provider capability data is typed by use case:

```ts
type AgentProviderCapabilityKind =
  | 'language'
  | 'image_generation';
```

Language-capable models feed the agent profile and composer model picker.
Image-generation models feed the `generate_image` tool and any future image
generation settings surface. Disabled providers are excluded from both runtime
routing surfaces.

### DEC-3: Image Defaults Live With Image Generation

If the user wants a persistent image model preference, it belongs to an image
generation setting, not the provider record. The default state should be `auto`,
not an eagerly materialized model such as Nano Banana just because Gemini is
configured.

When the tool receives no explicit model, runtime resolves:

1. an explicit image-generation default if the user set one;
2. otherwise `auto`, which selects the best currently enabled image-capable
   provider/model by deterministic ranking;
3. if no image-capable provider is enabled, the tool returns a setup error with
   the exact provider actions needed.

### DEC-4: First-party Keys Win

OpenAI image generation should use the existing OpenAI credential path. Gemini
image generation should use the existing Gemini credential path. OpenRouter image
generation can be supported as an additional capability when the user configures
OpenRouter, but it is not the only route for `gpt-image-2` or Nano Banana.

### DEC-5: Tool Results Are First-class Image Payloads

Generated images must be stored through the existing agent event-log payload
path and returned to the model as image content when useful for the next step.
A result that only says "saved to /tmp/foo.png" is not acceptable.

## Requirements

- **FR-1:** Provider settings expose typed capability summaries for language and
  image generation without leaking secrets to the renderer.
- **FR-2:** The composer/agent model picker reads language models only and
  excludes disabled providers.
- **FR-3:** `generate_image` resolves an enabled, credentialed image model from
  an explicit provider-qualified model, an unambiguous model id, or `auto`.
- **FR-4:** `generate_image` supports text-to-image and image-reference inputs
  when the selected model metadata allows image input.
- **FR-5:** Generated images are persisted as agent payloads and rendered in the
  transcript as image outputs.
- **FR-6:** Provider detail surfaces connection state, test/validate, refresh,
  and capability sections without storing any default model choice.
- **NFR-1:** Image bytes are not duplicated into debug text, logs, or model
  visible JSON when payload refs and image content blocks are available.
- **NFR-2:** Provider-specific API options are normalized and rejected before a
  provider call when unsupported combinations are known.

## Flows And Failure States

- **FLOW-1 provider setup:** User opens Providers, configures OpenAI or Gemini
  once, validates the connection, and sees separate language and image
  generation capability sections. No default image model is stored on the
  provider.
- **FLOW-2 agent generation:** User asks Neva to create an image. The model
  calls `generate_image` with `model: "auto"` or a provider-qualified model.
  Runtime picks an enabled image-capable provider, dispatches through the
  provider adapter, persists output payloads, and returns image content to the
  transcript.
- **FLOW-3 image edit/reference:** User supplies or references an existing
  image. The tool validates that the selected image model accepts image input,
  sends the prompt plus image refs, and returns generated images as payloads.
- **FLOW-4 unavailable setup:** If no enabled image provider exists, the tool
  returns a setup error naming the providers that can satisfy the request and
  whether each is missing configuration, credentials, enablement, or reachability.
- **FLOW-5 unsupported option:** If the prompt requests a size, count,
  background, or input image that the selected model does not support, the tool
  fails before dispatch with a concrete correction path.

## Design

### pi 0.80.3 Maintenance

Upgrade both pi packages exactly:

```json
{
  "@earendil-works/pi-agent-core": "0.80.3",
  "@earendil-works/pi-ai": "0.80.3"
}
```

The maintenance PR should also update
`docs/spec/agent-pi-mono-implementation.md` so Package Usage names `0.80.3`
instead of the stale `0.74.0`.

Relevant upstream changes for Tenon:

- pi-ai `0.80.3` improves provider HTTP error bodies, retry classification,
  OpenAI Responses reasoning replay, context-aware token caps, Azure OpenAI
  modern endpoint support, and generated model metadata.
- pi-agent-core `0.80.3` fixes `Agent.prepareNextTurn` abort-signal handling
  and adds `prepareNextTurnWithContext`.
- pi-ai `0.80.3` refreshes image model metadata, including OpenRouter entries
  for `gpt-image-2` and Nano Banana variants. This is useful catalog context,
  but Tenon still needs first-party image provider adapters to reuse existing
  OpenAI and Gemini credentials.

### Image Model Adapter

Add a main-process image adapter next to `piModels.ts`, for example
`src/main/piImageModels.ts`.

Responsibilities:

- create a singleton `ImagesModels` collection with the same Tenon credential
  store used by chat models;
- register Tenon-owned first-party image providers:
  - `openai-images` using the existing OpenAI credential resolver;
  - `google-images` using the existing Gemini credential resolver;
  - optional `openrouter-images` when OpenRouter is configured;
- expose catalog helpers:
  - `piImageProviders()`;
  - `piImageModelsForProvider(providerId)`;
  - `piFindImageModel(providerId, modelId)`;
  - `piGenerateImages(model, context, options)`;
- keep provider ids renderer-facing and stable, while internal pi provider ids
  may be namespaced if needed to avoid collisions.

Use pi-ai's `createImagesModels()` and `createImagesProvider()` rather than the
compat global image API. For first-party providers, Tenon supplies custom image
provider implementations until pi-ai ships built-in OpenAI/Gemini image
providers. The implementation should be shaped so those local adapters can be
deleted later in favor of pi-ai built-ins.

### First-party Provider Support

OpenAI:

- Initial target model: `gpt-image-2`.
- Support text-to-image and image-edit/reference-image input because
  `gpt-image-2` supports text and image input.
- Normalize tool options into OpenAI image API options, including output format,
  size/aspect ratio, quality, background, and count where supported.
- Implementation must verify exact SDK/API parameters against current official
  OpenAI docs at build time.

Gemini / Nano Banana:

- Initial target family: Nano Banana image generation/editing through the Gemini
  API.
- Support text prompt plus optional image references.
- Preserve model metadata as a capability list because Google exposes multiple
  Nano Banana variants over time.
- Implementation must verify exact model ids and request shape against current
  Google Gemini API docs at build time.

OpenRouter:

- Register OpenRouter image capabilities only when the OpenRouter provider is
  configured and enabled.
- Do not let OpenRouter shadow first-party OpenAI or Gemini credentials in the
  default route.

CC Switch:

- CC Switch remains a local gateway provider for language models. It may expose
  model names that look like image models, but Tenon should not treat them as
  image-generation-capable unless a real image API path is detected and
  implemented.
- If CC Switch later exposes an OpenAI-compatible image endpoint, add it as an
  image capability behind the same typed capability contract instead of mixing
  it into the language model picker.

### Capability View Contract

Extend the provider settings view so renderer code can render capability groups
without guessing from model ids.

Candidate shape:

```ts
interface AgentProviderCapabilitySummary {
  kind: 'language' | 'image_generation';
  models: AgentCapabilityModelOption[];
  refreshable?: boolean;
  lastRefreshError?: string;
}

interface AgentCapabilityModelOption {
  id: string;
  name: string;
  input: ImageCapabilityIO[];
  output: ImageCapabilityIO[];
  providerId: string;
}

type ImageCapabilityIO = 'text' | 'image';

interface AgentProviderOption {
  providerId: string;
  authKind: AgentProviderAuthKind;
  credentialed?: boolean;
  detected?: boolean;
  hasEnvApiKey: boolean;
  envKeyNames: string[];
  defaultBaseUrl?: string;
  models: AgentModelOption[]; // language only, kept for compatibility
  capabilities?: AgentProviderCapabilitySummary[];
}
```

`models` remains language-only for existing renderer consumers. New code reads
`capabilities` for image generation.

If this evolves into a larger contract cleanup, rename `models` to
`languageModels` in a coordinated protocol change. Do not do a partial rename in
one renderer path while keeping ambiguous naming elsewhere.

### Provider Settings Surface

The Providers settings page should group rows by configuration state, not by the
old "Connected" vs "Available" split:

- **Configured**: user-added, detected, or locally available provider
  connections. Each row has an enabled toggle. Disabled providers stay visible
  here but are excluded from runtime model/tool routing.
- **Add Providers**: providers that can be configured but are not currently
  configured or detected.

The provider detail window should show:

- connection state: configured, credentialed, enabled, reachable;
- credential controls: set/replace key, reveal/copy stored key only through the
  sender-checked child-window IPC, OAuth sign in/out where applicable;
- base URL only for providers where the endpoint is user-editable;
- Validate/Test connection;
- Refresh models/capabilities when the provider supports refresh;
- capability sections:
  - Language models;
  - Image generation models;
  - future capability sections as needed.

The detail window should not ask the user to choose a default model. A test
button may test a selected capability, but that selection is transient and does
not become provider state.

### Agent Model Picker

The composer/agent model picker must only include language-capable models from
enabled providers. A provider with an API key but `enabled: false` must not
appear in the picker.

Image-generation models appear only in:

- the provider capability section;
- a future image-generation setting/control if exposed to the user;
- the `generate_image` tool's runtime model resolution.

This avoids the current class of bugs where drawing models, image-edit models,
or non-tool-call models appear as if they could run the agent.

### `generate_image` Tool Contract

Add a P1 agent tool named `generate_image`.

The tool should generate or edit images using enabled image-generation
providers. It does not analyze images for conversation context; image analysis
still belongs to normal multimodal chat/file-read flows.

Candidate input:

```ts
interface GenerateImageInput {
  prompt: string;
  model?: string; // "auto", "providerId:modelId", or a model id when unambiguous
  image_refs?: GenerateImageRef[];
  count?: number; // default 1, provider-capped
  size?: string; // "auto" or WIDTHxHEIGHT when supported
  aspect_ratio?: string; // e.g. "1:1", "16:9", "9:16"; ignored when size is explicit
  quality?: 'auto' | 'low' | 'medium' | 'high';
  background?: 'auto' | 'transparent' | 'opaque';
  output_format?: 'png' | 'jpeg' | 'webp';
}

type GenerateImageRef =
  | { path: string }
  | { payload_id: string };
```

Validation rules:

- `prompt` is required and non-empty.
- `count` defaults to 1 and is capped by the selected provider/model.
- `image_refs` are optional; if present, the selected model must support image
  input.
- `size` and `aspect_ratio` are normalized before dispatch; unsupported
  combinations fail before provider call when the metadata is known.
- `model` defaults to `auto`. If an unqualified model id is ambiguous, return a
  model-selection error that lists matching provider-qualified ids.
- Disabled or uncredentialed providers are never selected.

Result shape:

```ts
interface GenerateImageResult {
  ok: boolean;
  providerId: string;
  modelId: string;
  images: Array<{
    payload: AgentPayloadRef;
    mimeType: string;
    width?: number;
    height?: number;
    revisedPrompt?: string;
  }>;
  text?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    imageCount?: number;
  };
}
```

The model-visible result should include a compact summary plus image content
blocks for generated images. Full details live in the tool envelope and event
payloads.

### Storage And Preview

Generated images should be persisted through the existing agent payload path,
not through ad hoc temp files. The payload metadata should record:

- provider id;
- model id;
- MIME type;
- byte size;
- prompt hash or redacted prompt summary when useful for debugging;
- dimensions when known;
- source tool call id.

The transcript can render the payload through the existing agent payload/image
projection. Saving to a user-visible file or inserting an image node remains a
separate explicit agent action.

### Permissions And Safety

`generate_image` is a network/model-generation tool. It should be separately
toggleable in the agent tool catalog.

Default approval policy should match current model/tool expectations:

- no document mutation by itself;
- no local file writes by itself;
- uses user-configured provider credentials;
- may consume paid provider quota;
- may send prompt text and referenced images to the selected provider.

The approval copy should make quota and image-reference upload clear when the
tool uses local files or payload refs as inputs.

Provider errors should surface as actionable setup or retry messages:

- no enabled image provider;
- provider configured but disabled;
- provider enabled but not credentialed;
- model does not support image input;
- provider rejected size/quality/count;
- provider quota/billing/organization verification required;
- transient provider/network failure.

## Implementation Areas

Expected file areas:

- `package.json`, `bun.lock` for the pi `0.80.3` maintenance PR.
- `docs/spec/agent-pi-mono-implementation.md` for pi version/spec sync.
- `docs/spec/agent-tool-design.md` for the `generate_image` tool contract.
- `src/main/piModels.ts` and new `src/main/piImageModels.ts` for pi integration.
- `src/main/agentSettings.ts` for provider capability discovery and refresh.
- `src/core/types.ts` for provider capability view DTOs.
- `src/core/commands.ts`, `src/main/main.ts`, and `src/preload/index.ts` only if
  a new renderer-facing image/capability refresh command is required.
- `src/main/agentTools.ts`, new `src/main/agentImageGenerationTool.ts`, and
  `src/core/agentToolCatalog.ts` for the tool.
- `src/main/agentToolEnvelope.ts`, `src/main/agentRuntimeContext.ts`, and
  event-log payload helpers if generated images need additional payload metadata.
- `src/renderer/ui/agent/AgentComposerModelControl.tsx` for language-only model
  filtering.
- `src/renderer/ui/agent/AgentSettingsView.tsx`,
  `src/renderer/ui/agent/ProviderConfigWindow.tsx`,
  `src/renderer/ui/agent/ProviderConfigForm.tsx`, and provider settings CSS for
  capability display.

`package.json`, `bun.lock`, `src/core/types.ts`, and `src/core/commands.ts` are
shared/infrastructure surfaces. The implementation branch must open a Draft PR
claim before editing them and keep the protocol changes narrow.

## Risks

- **Provider credential leakage.** Do not expose raw API keys to generic
  renderer IPC. Reuse the existing sender-checked provider-config-window path
  for reveal/copy only.
- **Catalog ambiguity.** pi-ai has OpenRouter image catalog entries for OpenAI
  and Google-branded models. Tenon must not present those as first-party OpenAI
  or Gemini unless the route really uses the first-party credential.
- **Model menu pollution.** Adding image catalogs must not leak image-only
  models into the language model picker.
- **Provider-specific option mismatch.** OpenAI and Gemini image APIs do not
  support identical size, quality, edit, and output controls. Normalize the
  common controls and reject unsupported combinations with provider-specific
  guidance.
- **Payload bloat.** Generated images can be large. Store payloads once, redact
  base64 in debug views, and avoid duplicating image bytes in logs.
- **Billing surprise.** Image generation consumes paid quota. Tool permission
  copy and result details should make the selected provider/model visible.

## Verification

pi maintenance PR:

- `bun run typecheck`
- `bun run test:core`
- `bun run docs:check`

Image generation feature PR:

- `bun run typecheck`
- `bun run test:core`
- `bun run test:renderer`
- `bun run docs:check`
- focused tests for:
  - disabled providers excluded from language picker and image routing;
  - image models excluded from language picker;
  - OpenAI/Gemini credentials reused for image providers;
  - unconfigured image tool returns setup guidance;
  - generated image payloads are persisted and projected as image content;
  - ambiguous unqualified image model ids produce provider-qualified choices;
  - provider config reveal/copy still rejects non-child-window senders.
- manual UI verification in light and dark:
  - provider list grouping;
  - provider detail capability sections;
  - composer model picker after disabling a credentialed provider;
  - generated image transcript rendering.

## Acceptance Criteria

- **AC-1:** With only OpenAI configured and enabled, `generate_image` can use
  the existing OpenAI credential to call `gpt-image-2`; no second OpenAI key
  prompt appears.
- **AC-2:** With only Gemini configured and enabled, `generate_image` can use
  the existing Gemini credential to call a Nano Banana image model; no second
  Gemini key prompt appears.
- **AC-3:** With OpenAI or Gemini disabled, their language models disappear from
  the composer model picker and their image models are not eligible for
  `generate_image` routing.
- **AC-4:** Image-generation-only models never appear in the agent language
  model picker.
- **AC-5:** Provider detail shows language and image generation capabilities as
  capability sections, not as provider-owned defaults.
- **AC-6:** Generated images are visible in the transcript as image payloads and
  can be inspected through the existing payload preview path.
- **AC-7:** A missing provider credential, disabled provider, unsupported image
  input, unsupported size/count, or provider error returns actionable tool
  guidance rather than a generic failure.
- **AC-8:** `docs/spec/agent-pi-mono-implementation.md` names the updated pi
  package version and documents that image generation uses a separate
  `ImagesModels` surface.

## Collision Result

- GitHub open PR list was empty when this plan was drafted.
- `docs/TASKS.md` is main-agent-owned and was read only. It still contains an
  older snapshot with historical open-PR references, but no live GitHub open PR
  claim was found.
- This plan overlaps conceptually with the shipped
  `provider-config-cleanup` and `pi-ai-0.80-upgrade` designs. It preserves their
  core decisions: providers are deliberate connection rows, and pi integration
  stays behind Tenon-owned main-process adapters.
- The future implementation touches shared/infrastructure files. Open a Draft PR
  claim before editing and coordinate if another agent claims provider settings,
  pi package updates, or `src/core` DTOs first.

## Open Questions

- **OQ-1:** Should the user-facing image-generation default live in a new
  Settings section now, or should `auto` be the only v1 setting and explicit
  model choice happen only inside agent/tool calls?
- **OQ-2:** Should OpenRouter image generation ship in the same feature PR as
  first-party OpenAI/Gemini, or wait until after first-party routes are verified?
- **OQ-3:** Should generated images be retained forever with the conversation
  payloads, or should image payloads get a shorter retention policy than text
  payloads?

## Checklist

- [ ] Bump pi packages to `0.80.3` and update lockfile.
- [ ] Update pi-mono spec package usage and image-surface notes.
- [ ] Add Tenon image `ImagesModels` adapter.
- [ ] Add first-party OpenAI image provider for `gpt-image-2`.
- [ ] Add first-party Gemini/Nano Banana image provider.
- [ ] Add typed provider capability DTOs.
- [ ] Keep language model picker language-only and enabled-provider-only.
- [ ] Redesign provider detail around connection, test, refresh, and capability
      sections.
- [ ] Add `generate_image` tool and permission/tool-catalog entry.
- [ ] Persist generated images as agent payloads and render them in transcript.
- [ ] Add tests and run verification.
