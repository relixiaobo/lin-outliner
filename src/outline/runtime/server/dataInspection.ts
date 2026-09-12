import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import type { OutlineDataInspection } from '../../contract/dataInspection';
import { describeOutlineStartupFailure } from '../../contract/startupFailure';
import { WorkspaceTransactionLog } from '../storage/workspaceTransactionLog';

export async function inspectOutlineData(root: string): Promise<OutlineDataInspection> {
  try {
    const loaded = await new WorkspaceTransactionLog(join(root, 'workspace')).load();
    if (loaded.inconsistent) throw loaded.inconsistent;
    const log = await lstat(join(root, 'workspace/outline.transactions.jsonl')).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    return { version: 1, exists: loaded.snapshot !== null, hasTransactionLog: !!log?.isFile() && log.size > 0, identity: loaded.snapshot ? {
      workspaceId: loaded.snapshot.shared.workspaceId, documentId: loaded.snapshot.shared.documentId,
    } : null, error: null };
  } catch (error) { return { version: 1, exists: true, hasTransactionLog: false, identity: null, error: describeOutlineStartupFailure(error) }; }
}
