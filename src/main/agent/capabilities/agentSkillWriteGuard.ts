import { canonicalPathPreservingSuffixAsync } from './agentAttachmentMaterialization';

const tails = new Map<string, Promise<void>>();

/** Serializes cooperating Tenon writers by physical target, including aliases. */
export async function acquireSkillWriteGuard(filePath: string): Promise<() => void> {
  const key = await canonicalPathPreservingSuffixAsync(filePath);
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous;
  return () => {
    if (tails.get(key) === current) tails.delete(key);
    release();
  };
}
