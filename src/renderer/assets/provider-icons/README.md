# Provider brand icons

Brand logos for the agent provider settings, one SVG per provider id
(`<providerId>.svg`). They are resolved at build time by
`src/renderer/ui/agent/providerIcon.ts`; providers without a file here fall
back to a monogram avatar.

## Source

Vendored from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons)
(MIT). We copy the brand-color variant (`<brand>-color.svg`) when one exists,
otherwise the monochrome mark (inherently single-color brands such as OpenAI,
Vercel, Grok, Moonshot, GitHub Copilot, Groq, OpenRouter). The package itself
is not a dependency — only these files are checked in.

## Updating

To add or refresh an icon, copy the matching SVG out of that package and
rename it to the pi-ai provider id. The brand names there differ from the
provider ids (e.g. `anthropic` ← `claude-color`, `google` ← `gemini-color`,
`amazon-bedrock` ← `bedrock-color`, `xai` ← `grok`, `xiaomi` ← `xiaomimimo`
— that provider serves Xiaomi's MiMo models).

## Aliases

Regional / plan variants of one brand reuse its mark instead of shipping a
near-identical copy per id. The mapping lives in `providerIcon.ts`
(`ICON_ALIASES`): e.g. `xiaomi-token-plan-{cn,ams,sgp}` → `xiaomi`.
