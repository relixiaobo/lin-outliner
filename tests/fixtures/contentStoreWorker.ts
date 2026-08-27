import { ContentStore } from '../../src/content';

const [action, root, value, namespace, anchorId] = process.argv.slice(2);

if (!action || !root) throw new Error('ContentStore worker requires an action and root.');

const store = await ContentStore.open(root);
try {
  if (action === 'admit') {
    const lease = await store.admitBytes(Buffer.from(value ?? '', 'utf8'));
    process.stdout.write(`${JSON.stringify(lease)}\n`);
  } else if (action === 'hold-before-claim') {
    const byteLength = Number(value);
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
      throw new Error('hold-before-claim requires a positive byte length.');
    }
    await store.admit((async function* () {
      yield Buffer.alloc(byteLength, 0x61);
      process.stdout.write(`${JSON.stringify({ ready: true, byteLength })}\n`);
      await new Promise<never>(() => undefined);
    })());
  } else if (action === 'retain') {
    if (!namespace || !anchorId) throw new Error('retain requires namespace and anchor id.');
    const lease = await store.admitBytes(Buffer.from(value ?? '', 'utf8'));
    const anchor = await store.createAnchor(lease.leaseId, namespace, anchorId, anchorId);
    process.stdout.write(`${JSON.stringify({ lease, anchor })}\n`);
  } else if (action === 'clone') {
    if (!value || !namespace || !anchorId) throw new Error('clone requires source anchor, namespace, and anchor id.');
    process.stdout.write(`${JSON.stringify(await store.cloneAnchor(value, namespace, anchorId, anchorId))}\n`);
  } else if (action === 'release') {
    if (!value) throw new Error('release requires an anchor id.');
    process.stdout.write(`${JSON.stringify(await store.releaseAnchor(value))}\n`);
  } else if (action === 'gc') {
    process.stdout.write(`${JSON.stringify(await store.collectGarbage())}\n`);
  } else {
    throw new Error(`Unsupported ContentStore worker action: ${action}`);
  }
} finally {
  store.close();
}
