// Persisted per-conversation disclosure state for interactive agent transcript
// details such as reasoning rows and tool-activity groups. The top-level
// "Working/Worked for" work divider is intentionally not a disclosure. A user's
// expand/collapse is keyed by conversationId then by disclosure id, and survives
// reload, conversation switch, and row remounts. Absence of an entry means "use
// the caller's default" until the user makes an explicit choice.

type Overrides = Readonly<Record<string, boolean>>;

const STORAGE_PREFIX = 'lin:agent-disclosure:';
const EMPTY: Overrides = Object.freeze({});

const memory = new Map<string, Overrides>();
const listeners = new Map<string, Set<() => void>>();

function storageKey(conversationId: string): string {
  return `${STORAGE_PREFIX}${conversationId}`;
}

// Load (and cache) a conversation's overrides. The cached object reference is
// stable until the next write, so it is safe as a `useSyncExternalStore` snapshot.
function load(conversationId: string): Overrides {
  const cached = memory.get(conversationId);
  if (cached) return cached;
  const parsed: Record<string, boolean> = {};
  try {
    const raw = window.localStorage?.getItem(storageKey(conversationId));
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
          if (typeof value === 'boolean') parsed[id] = value;
        }
      }
    }
  } catch {
    // Corrupt/unavailable storage → start empty (best-effort, never throws).
  }
  const frozen = Object.freeze(parsed);
  memory.set(conversationId, frozen);
  return frozen;
}

function persist(conversationId: string, overrides: Overrides): void {
  try {
    window.localStorage?.setItem(storageKey(conversationId), JSON.stringify(overrides));
  } catch {
    // A full/unavailable localStorage just means this session is non-persisted.
  }
}

export function disclosureSnapshot(conversationId: string): Overrides {
  return load(conversationId);
}

export function setDisclosureOverride(conversationId: string, id: string, expanded: boolean): void {
  const current = load(conversationId);
  if (current[id] === expanded) return;
  const next = Object.freeze({ ...current, [id]: expanded });
  memory.set(conversationId, next);
  persist(conversationId, next);
  listeners.get(conversationId)?.forEach((listener) => listener());
}

export function subscribeDisclosure(conversationId: string, listener: () => void): () => void {
  let set = listeners.get(conversationId);
  if (!set) {
    set = new Set();
    listeners.set(conversationId, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

// Test seam: drop the in-memory cache AND the persisted keys so a suite starts
// from a clean store regardless of a shared localStorage between test files.
export function resetDisclosureStore(): void {
  memory.clear();
  listeners.clear();
  try {
    const ls = window.localStorage;
    if (!ls) return;
    const stale: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) stale.push(key);
    }
    stale.forEach((key) => ls.removeItem(key));
  } catch {
    // ignore — best-effort cleanup.
  }
}
