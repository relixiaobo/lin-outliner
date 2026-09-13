import { join } from 'node:path';
import { DataStoreRegistry } from '../../src/main/dataLifecycle/storeRegistry';
import { DataBackupStore } from '../../src/main/dataLifecycle/BackupStore';
import { DataOperationJournal } from '../../src/main/dataLifecycle/OperationJournal';
import { DataRestoreSession } from '../../src/main/dataLifecycle/RestoreSession';
import { OutlineRuntimeLock, resolveOutlineRuntimePaths } from '../../src/outline/runtimeLock';

const root = process.argv[2]!;
const boundary = process.argv[3]!;
const journal = new DataOperationJournal(root);
const operation = await journal.read();
if (!operation) throw new Error('Crash fixture requires an existing restore intent');
const lock = await OutlineRuntimeLock.acquire(resolveOutlineRuntimePaths(join(root, 'outline-runtime')), {
  pid: process.pid, instanceId: `crash-fixture:${operation.id}`, createdAt: new Date().toISOString(),
});
if (!lock) throw new Error('Crash fixture could not acquire its writer authority');
await new DataRestoreSession(root, new DataBackupStore(root, new DataStoreRegistry()), journal, {
  checkpoint: (name) => { if (name === boundary) process.kill(process.pid, 'SIGKILL'); },
}).run(operation, '0.8.0');
await lock.release();
throw new Error('Crash fixture did not reach its required boundary');
