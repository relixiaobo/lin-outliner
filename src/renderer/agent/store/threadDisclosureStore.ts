type ThreadDisclosureOverrides = Readonly<Record<string, boolean>>;

const STORAGE_PREFIX = 'tenon:thread-disclosure:v1:';
const EMPTY_OVERRIDES: ThreadDisclosureOverrides = Object.freeze({});

const memory = new Map<string, ThreadDisclosureOverrides>();
const listeners = new Map<string, Set<() => void>>();

export function threadDisclosureSnapshot(threadId: string): ThreadDisclosureOverrides {
  return load(threadId);
}

export function setThreadDisclosureOverride(
  threadId: string,
  disclosureId: string,
  expanded: boolean,
): void {
  const current = load(threadId);
  if (current[disclosureId] === expanded) return;
  const next = Object.freeze({ ...current, [disclosureId]: expanded });
  memory.set(threadId, next);
  persist(threadId, next);
  listeners.get(threadId)?.forEach((listener) => listener());
}

export function subscribeThreadDisclosure(threadId: string, listener: () => void): () => void {
  let threadListeners = listeners.get(threadId);
  if (!threadListeners) {
    threadListeners = new Set();
    listeners.set(threadId, threadListeners);
  }
  threadListeners.add(listener);
  return () => {
    threadListeners?.delete(listener);
    if (threadListeners?.size === 0) listeners.delete(threadId);
  };
}

export function resetThreadDisclosureStore(): void {
  memory.clear();
  listeners.clear();
  try {
    const storage = globalThis.window?.localStorage;
    if (!storage) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // Disclosure persistence is best-effort and must never block transcript UI.
  }
}

function load(threadId: string): ThreadDisclosureOverrides {
  const cached = memory.get(threadId);
  if (cached) return cached;
  let overrides = EMPTY_OVERRIDES;
  try {
    const raw = globalThis.window?.localStorage?.getItem(storageKey(threadId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const validated: Record<string, boolean> = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'boolean') validated[id] = value;
        }
        overrides = Object.freeze(validated);
      }
    }
  } catch {
    // Corrupt or unavailable storage starts with the canonical defaults.
  }
  memory.set(threadId, overrides);
  return overrides;
}

function persist(threadId: string, overrides: ThreadDisclosureOverrides): void {
  try {
    globalThis.window?.localStorage?.setItem(storageKey(threadId), JSON.stringify(overrides));
  } catch {
    // A full or unavailable store only makes this browser session non-persistent.
  }
}

function storageKey(threadId: string): string {
  return `${STORAGE_PREFIX}${threadId}`;
}
