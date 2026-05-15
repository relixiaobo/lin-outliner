import { api } from '../api/client';
import { plainText, type DocumentProjection, type NodeId } from '../api/types';

interface SavePrimaryFieldEntryChildTextOptions {
  entryId: NodeId;
  childId?: NodeId;
  currentText: string;
  nextText: string;
}

export async function savePrimaryFieldEntryChildText({
  entryId,
  childId,
  currentText,
  nextText,
}: SavePrimaryFieldEntryChildTextOptions): Promise<DocumentProjection> {
  if (nextText === currentText) return api.getProjection();

  if (childId) {
    if (!nextText.trim()) {
      const outcome = await api.deleteNode(childId);
      return outcome.projection;
    }
    const outcome = await api.replaceNodeText(childId, plainText(nextText));
    return outcome.projection;
  }

  if (!nextText.trim()) return api.getProjection();
  const outcome = await api.createNode(entryId, null, nextText);
  return outcome.projection;
}
