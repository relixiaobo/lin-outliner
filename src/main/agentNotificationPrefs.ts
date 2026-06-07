import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NOTIFICATION_PREFS_FILE = 'notification-prefs.json';

export interface AgentNotificationPrefs {
  /**
   * Opt-in OS (Electron) notifications for off-floor task delivery. Default OFF —
   * the durable in-app delivery (unread badge + in-stream post) is always on; the
   * OS banner is the user-enabled escalation layer (A3-respecting).
   */
  osNotificationsEnabled: boolean;
}

const DEFAULT_PREFS: AgentNotificationPrefs = {
  osNotificationsEnabled: false,
};

let cached: AgentNotificationPrefs | null = null;

function prefsPath(): string {
  return join(app.getPath('userData'), NOTIFICATION_PREFS_FILE);
}

function normalize(input: Partial<AgentNotificationPrefs> | null | undefined): AgentNotificationPrefs {
  return { osNotificationsEnabled: input?.osNotificationsEnabled === true };
}

export async function getNotificationPrefs(): Promise<AgentNotificationPrefs> {
  if (cached) return cached;
  try {
    cached = normalize(JSON.parse(await readFile(prefsPath(), 'utf8')) as Partial<AgentNotificationPrefs>);
  } catch {
    cached = { ...DEFAULT_PREFS };
  }
  return cached;
}

export async function setNotificationPrefs(
  input: Partial<AgentNotificationPrefs>,
): Promise<AgentNotificationPrefs> {
  const current = await getNotificationPrefs();
  const next = normalize({
    osNotificationsEnabled:
      typeof input.osNotificationsEnabled === 'boolean'
        ? input.osNotificationsEnabled
        : current.osNotificationsEnabled,
  });
  cached = next;
  const path = prefsPath();
  await mkdir(app.getPath('userData'), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path);
  return next;
}

/**
 * Synchronous cached read for the hot notification path. Returns the default
 * (OS off) until {@link getNotificationPrefs} has loaded the persisted value.
 */
export function getCachedNotificationPrefs(): AgentNotificationPrefs {
  return cached ?? DEFAULT_PREFS;
}
