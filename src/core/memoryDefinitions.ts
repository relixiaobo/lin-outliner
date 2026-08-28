export const MEMORY_DOCUMENT_NAMESPACE = 'agent.memory' as const;

export const MEMORY_TAG_DEFINITIONS = Object.freeze([
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:d-memory', name: 'd-memory', category: 'memory' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:d-episode', name: 'd-episode', category: 'episode' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:d-belief', name: 'd-belief', category: 'belief' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:d-question', name: 'd-question', category: 'question' },
  { namespace: MEMORY_DOCUMENT_NAMESPACE, tagId: 'tag:d-guidance', name: 'd-guidance', category: 'guidance' },
] as const);

export type MemoryCategory = typeof MEMORY_TAG_DEFINITIONS[number]['category'];

export function memoryTagDefinitionForId(tagId: string): typeof MEMORY_TAG_DEFINITIONS[number] | undefined {
  return MEMORY_TAG_DEFINITIONS.find((definition) => definition.tagId === tagId);
}
