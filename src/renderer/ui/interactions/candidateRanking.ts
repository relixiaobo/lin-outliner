export function textMatchRank(label: string, query: string): number | null {
  if (!query) return 0;
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.split(/[\s._/-]+/).some((part) => part.startsWith(query))) return 2;
  if (label.includes(query)) return 3;
  return null;
}
