// The wire format for a Configuration Profile's model selection: a provider-qualified
// `providerId/modelId` string. One parser/composer pair, shared across the process
// seam (the renderer writes it, the main runtime reads it) so the two sides can
// never disagree on how a saved selection splits.
//
// `/` is the canonical separator that `composeProviderQualifiedModel` emits. A `:`
// is ALSO accepted as a legacy / skill-emitted qualifier, but ONLY when the prefix
// is a known provider id — model ids themselves legitimately contain `:` (Bedrock
// `amazon.nova-lite-v1:0`, Vertex inference-profile ids, Ollama `qwen2:7b`), and a
// bare colon-bearing id must NOT be mis-split into a phantom provider/model.

export interface ProviderQualifiedModel {
  providerId: string;
  modelId: string;
}

export function parseProviderQualifiedModel(
  value: string,
  isKnownProvider: (providerId: string) => boolean,
): ProviderQualifiedModel | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Canonical `/` qualifier: split on the FIRST slash; the model id keeps any
  // later slashes (some catalogs use `vendor/model` ids).
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const providerId = trimmed.slice(0, slash).trim();
    const modelId = trimmed.slice(slash + 1).trim();
    if (providerId && modelId) return { providerId, modelId };
    return null;
  }
  // `:` qualifier only when the prefix is a recognized provider — otherwise this is
  // a bare model id that happens to contain a colon.
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const providerId = trimmed.slice(0, colon).trim();
    const modelId = trimmed.slice(colon + 1).trim();
    if (providerId && modelId && isKnownProvider(providerId)) return { providerId, modelId };
  }
  return null;
}

export function composeProviderQualifiedModel(providerId: string, modelId: string): string {
  const id = modelId.trim();
  if (!id) return '';
  return providerId ? `${providerId}/${id}` : id;
}
