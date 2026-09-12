export const MEMORY_DOCUMENT_NAMESPACE = 'agent.memory' as const;

export const MEMORY_TAG_DEFINITIONS = Object.freeze([
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:mem-day', name: 'mem-day', category: 'memory' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:mem-episode', name: 'mem-episode', category: 'episode' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:mem-belief', name: 'mem-belief', category: 'belief' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:mem-question', name: 'mem-question', category: 'question' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:mem-guidance', name: 'mem-guidance', category: 'guidance' },
] as const);

export type MemoryCategory = typeof MEMORY_TAG_DEFINITIONS[number]['category'];

export function memoryTagDefinitionForId(tagId: string): typeof MEMORY_TAG_DEFINITIONS[number] | undefined {
  return MEMORY_TAG_DEFINITIONS.find((definition) => definition.tagId === tagId);
}
