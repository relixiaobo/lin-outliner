import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSessionMeta } from '../core/types';
import type { AgentChatSession } from '../core/agentChatTree';

const CHAT_SESSIONS_FILE = 'agent-chat-sessions.json';

interface AgentChatStoreFile {
  sessions: Record<string, AgentChatSession>;
}

let writeQueue: Promise<void> = Promise.resolve();

export async function getChatSession(sessionId: string): Promise<AgentChatSession | null> {
  const file = await readStoreFile();
  return file.sessions[sessionId] ?? null;
}

export async function getLatestChatSession(): Promise<AgentChatSession | null> {
  const file = await readStoreFile();
  return Object.values(file.sessions)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

export async function listChatSessions(): Promise<AgentSessionMeta[]> {
  const file = await readStoreFile();
  return Object.values(file.sessions)
    .map(toMeta)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function saveChatSession(session: AgentChatSession): Promise<AgentChatSession> {
  return enqueueWrite(async () => {
    const file = await readStoreFile();
    session.updatedAt = Date.now();
    file.sessions[session.id] = session;
    await writeStoreFile(file);
    return session;
  });
}

export async function renameChatSession(sessionId: string, title: string | null): Promise<AgentSessionMeta | null> {
  return enqueueWrite(async () => {
    const file = await readStoreFile();
    const session = file.sessions[sessionId];
    if (!session) return null;
    session.title = title?.trim() || 'Untitled';
    session.updatedAt = Date.now();
    await writeStoreFile(file);
    return toMeta(session);
  });
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await enqueueWrite(async () => {
    const file = await readStoreFile();
    delete file.sessions[sessionId];
    await writeStoreFile(file);
  });
}

async function readStoreFile(): Promise<AgentChatStoreFile> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), 'utf8')) as Partial<AgentChatStoreFile>;
    return {
      sessions: parsed.sessions ?? {},
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { sessions: {} };
    }
    throw error;
  }
}

async function writeStoreFile(file: AgentChatStoreFile) {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
  await rename(tmp, path);
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

function toMeta(session: AgentChatSession): AgentSessionMeta {
  return {
    id: session.id,
    title: session.title ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Object.values(session.mapping).filter((node) => node.message !== null).length,
  };
}

function storePath() {
  return join(app.getPath('userData'), CHAT_SESSIONS_FILE);
}
