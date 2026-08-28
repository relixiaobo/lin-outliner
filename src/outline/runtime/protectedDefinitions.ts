import { memoryTagDefinitionForId } from '../../core/memoryDefinitions';
import type { CoreTransactionPatch } from '../../core/core';
import { SCHEMA_ID, type Node } from '../../core/types';
import { canonicalSha256 } from '../contract/canonical';
import { OutlineContractError, outlineError } from '../contract/errors';

export function assertProtectedMemoryDefinitionPatch(patch: CoreTransactionPatch): void {
  for (const entry of patch.nodes) {
    const definition = memoryTagDefinitionForId(entry.id);
    if (!definition) continue;
    const beforeValid = isProtectedMemoryDefinition(entry.before, definition);
    const afterValid = isProtectedMemoryDefinition(entry.after, definition);
    if (afterValid && !beforeValid) continue;
    if (canonicalSha256(entry.before) === canonicalSha256(entry.after)) continue;
    throw new OutlineContractError(outlineError(
      'precondition_failed',
      'conflict',
      `Protected Memory tag definition cannot be changed: ${entry.id}`,
    ));
  }
}

function isProtectedMemoryDefinition(
  node: Readonly<Node> | null,
  definition: NonNullable<ReturnType<typeof memoryTagDefinitionForId>>,
): boolean {
  return node !== null
    && node.id === definition.tagId
    && node.type === 'tagDef'
    && node.parentId === SCHEMA_ID
    && node.content.text === definition.name
    && node.locked;
}
