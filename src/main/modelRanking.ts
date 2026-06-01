/**
 * Ordering policy for the agent provider model dropdowns.
 *
 * Goal: the NEWEST model leads — regardless of price or tier. A newer but cheaper
 * model (e.g. `gemini-3.5-flash`) must outrank an older premium one
 * (`gemini-2.5-pro`), because newness, not flagship status, is what users want at
 * the top. The first entry of the sorted list is also what the renderer picks as
 * the default model when a provider is first configured, so "newest leads" doubles
 * as "new providers default to the current model".
 *
 * pi-ai's `Model` type carries no release-date, knowledge-cutoff, tier, or rank
 * field — it is routing + billing metadata only. So recency is derived from the
 * version numbers embedded in the model id, which is the one signal that tracks
 * "newness". Price is deliberately NOT used: newer Anthropic models are cheaper
 * than older ones (opus dropped 75 -> 25), and regional pricing skews it further,
 * so "most expensive" is actively anti-correlated with "newest".
 *
 * The only human-maintained input is {@link MODEL_LINES}: which independently
 * versioned product lines a provider has, in priority order. It exists solely so a
 * high-numbered side line (`gemma-4`) cannot outrank the flagship line
 * (`gemini-3.x`). It is version-INDEPENDENT — new model *versions* never require
 * touching it; only a brand-new product line does, and that is caught by
 * {@link findUnknownLineModels} (asserted empty by the guard test) rather than
 * silently burying the new model.
 */

/** Per-provider product lines, highest priority first. Version-independent. */
export const MODEL_LINES: Record<string, readonly string[]> = {
  // gemini is the flagship line; gemma is open-weights. Without this, `gemma-4`
  // would outrank `gemini-3.5` on raw version number.
  google: ['gemini', 'gemma'],
  // gpt-5.x is the current line; the o-series is the legacy reasoning line.
  openai: ['gpt', 'o'],
  // anthropic is intentionally absent: every id shares one `claude` 4.x numbering,
  // so version alone orders opus/sonnet/haiku newest-first across tiers (a future
  // `claude-haiku-5` should lead over `claude-opus-4-8` — it is newer).
};

/** The minimal model shape the ranking needs; satisfied by pi-ai `Model` and by `AgentModelOption`. */
export interface RankableModel {
  id: string;
  reasoning: boolean;
}

const ISO_DATE = /-\d{4}-\d{2}-\d{2}(?=$|[-:])/g; // -2024-11-20
const COMPACT_DATE = /-\d{8}(?=$|[-:])/g; // -20251101
const BEDROCK_TAG = /-v\d+(?::\d+)?$/g; // -v1:0

/** Drop trailing date/snapshot/version-tag noise so it never pollutes the version tuple. */
function stripVersionNoise(id: string): string {
  return id.replace(ISO_DATE, '').replace(COMPACT_DATE, '').replace(BEDROCK_TAG, '');
}

/** True when the id is a pinned dated snapshot (e.g. `...-20251101`) rather than a rolling alias. */
export function isDatedSnapshot(id: string): boolean {
  return /\d{8}|\d{4}-\d{2}-\d{2}/.test(id);
}

/**
 * The model's version as a numeric tuple, e.g. `claude-opus-4-8` -> `[4, 8]`,
 * `gemini-3.5-flash` -> `[3, 5]`. Parses dot- and dash-separated numbers and is
 * numeric (so `4-10` > `4-9`, which a string sort gets wrong). Date noise is
 * stripped first so a snapshot date cannot masquerade as a high version.
 */
export function versionTuple(id: string): number[] {
  const cleaned = stripVersionNoise(id);
  return (cleaned.match(/\d+(?:\.\d+)?/g) ?? []).flatMap((token) => token.split('.').map(Number));
}

/** Compare version tuples newest-first. Missing components rank below present ones. */
export function compareVersionDesc(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Index of the first matching product line for `id`, or `lines.length` (sorts last) if none. */
function lineRank(provider: string, id: string): number {
  const lines = MODEL_LINES[provider] ?? [];
  const index = lines.findIndex((line) => id.startsWith(line));
  return index === -1 ? lines.length : index;
}

/**
 * Recency-first model comparator. Key order (most significant first):
 *  1. product line — only separates independently versioned lines (gemini vs gemma);
 *  2. version — NEWEST first (the core principle);
 *  3. reasoning — modern thinking models above legacy ones at equal version;
 *  4. clean alias before its dated snapshot;
 *  5. id — stable fallback.
 */
export function compareModels(provider: string, a: RankableModel, b: RankableModel): number {
  return (
    lineRank(provider, a.id) - lineRank(provider, b.id) ||
    compareVersionDesc(versionTuple(a.id), versionTuple(b.id)) ||
    (Number(b.reasoning) - Number(a.reasoning)) ||
    (Number(isDatedSnapshot(a.id)) - Number(isDatedSnapshot(b.id))) ||
    a.id.localeCompare(b.id)
  );
}

/** Return a new array of `models` sorted newest-first for `provider`. */
export function rankModels<T extends RankableModel>(provider: string, models: readonly T[]): T[] {
  return [...models].sort((a, b) => compareModels(provider, a, b));
}

/**
 * Staleness tripwire: ids that match no declared product line for a provider that
 * declares lines. Empty = healthy. A non-empty result means pi-ai shipped a model
 * the policy does not recognize (a new product line, or a renamed one) which would
 * otherwise sink to the bottom — the guard test asserts this is empty so the build
 * goes red instead of silently burying it. Providers with no declared lines (e.g.
 * anthropic) are unconstrained and always return empty.
 */
export function findUnknownLineModels(provider: string, models: readonly RankableModel[]): string[] {
  const lines = MODEL_LINES[provider] ?? [];
  if (lines.length === 0) return [];
  return models.filter((model) => lineRank(provider, model.id) === lines.length).map((model) => model.id);
}
