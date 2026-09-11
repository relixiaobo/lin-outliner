/** Presentation only: never used as a configured or provider model identifier. */
export function compactModelName(name: string): string {
  return name
    .replace(/^(?:Anthropic[\s/:]+)?Claude\s+(?=(?:Sonnet|Opus|Haiku)\b)/iu, '')
    .replace(/^OpenAI[\s/:]+(?=(?:GPT(?:[-\s]|\d)|o\d)\b)/iu, '')
    .replace(/^Google[\s/:]+(?=Gemini\b)/iu, '');
}

export function distinctCompactModelName(name: string, id: string, models: readonly { id: string; name: string }[]): string {
  const compact = compactModelName(name);
  const collisions = models.filter((model) => model.id !== id && compactModelName(model.name) === compact);
  if (!collisions.length) return compact;
  return collisions.some((model) => model.name === name) ? `${name} (${id})` : name;
}

export function compactEffortLabel(label: string, copy: {
  minimal: string; low: string; medium: string; high: string; xhigh: string; max: string;
}): string {
  switch (label.toLowerCase()) {
    case 'minimal': return copy.minimal;
    case 'low': return copy.low;
    case 'medium': return copy.medium;
    case 'high': return copy.high;
    case 'xhigh': case 'extra high': return copy.xhigh;
    case 'max': return copy.max;
    default: return label;
  }
}
