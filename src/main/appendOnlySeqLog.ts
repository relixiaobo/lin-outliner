import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface AppendOnlySeqLogTail {
  seq: number;
  eventId: string | null;
}

export function serializeJsonl(events: readonly unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

export class AppendOnlySeqLog<TEvent extends { seq: number; eventId?: string }> {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly latestSeqByKey = new Map<string, number>();

  constructor(
    private readonly label: string,
    private readonly parse: (raw: string, source: string) => TEvent[],
  ) {}

  enqueue<TResult>(key: string, operation: () => Promise<TResult>): Promise<TResult> {
    const current = this.writeQueues.get(key) ?? Promise.resolve();
    const next = current.then(operation, operation);
    this.writeQueues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  async latestSeq(key: string, paths: (() => Promise<readonly string[]> | readonly string[]) | readonly string[]): Promise<number> {
    const cached = this.latestSeqByKey.get(key);
    if (cached !== undefined) return cached;
    const filePaths = typeof paths === 'function' ? await paths() : paths;
    const tail = await this.latestTailForFiles(filePaths);
    this.latestSeqByKey.set(key, tail.seq);
    return tail.seq;
  }

  setLatestSeq(key: string, seq: number): void {
    this.latestSeqByKey.set(key, Math.max(0, Math.trunc(seq)));
  }

  deleteKey(key: string): void {
    this.latestSeqByKey.delete(key);
    this.writeQueues.delete(key);
  }

  clear(): void {
    this.latestSeqByKey.clear();
    this.writeQueues.clear();
  }

  async append(filePath: string, events: readonly TEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(path.dirname(filePath), { recursive: true });
    await this.repairTornTailBeforeAppend(filePath);
    await appendFile(filePath, serializeJsonl(events), 'utf8');
  }

  async appendForKey(key: string, filePath: string, events: readonly TEvent[]): Promise<void> {
    await this.append(filePath, events);
    this.setLatestSeq(key, events.at(-1)!.seq);
  }

  /**
   * Every intact log ends with '\n' (serializeJsonl and compaction both write it), so a
   * missing trailing newline means the previous append was interrupted mid-line. Appending
   * onto the torn fragment would weld two events into one garbage line. Truncate the
   * fragment first; appends are serialized through the per-key write queue, so the repair
   * cannot race another write. The parse function still owns the torn-tail policy.
   */
  private async repairTornTailBeforeAppend(filePath: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(filePath, 'r+');
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (stats.size === 0) return;
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, stats.size - 1);
      if (lastByte[0] === 0x0a) return;
      const buffer = Buffer.alloc(stats.size);
      await handle.read(buffer, 0, stats.size, 0);
      const lastNewline = buffer.lastIndexOf(0x0a);
      const fragment = buffer.subarray(lastNewline + 1).toString('utf8');
      try {
        // A tear can land between the JSON text and its newline: the final line is then a
        // complete, readable event that must not be destroyed, only its newline was lost.
        JSON.parse(fragment);
        await handle.write('\n', stats.size, 'utf8');
        return;
      } catch {
        // Genuinely torn mid-line; fall through to the truncating repair.
      }
      this.parse(buffer.toString('utf8'), filePath);
      const keep = lastNewline === -1 ? 0 : lastNewline + 1;
      console.warn(`Repairing torn trailing ${this.label} line at ${filePath} (truncating ${stats.size - keep} bytes)`);
      await handle.truncate(keep);
    } finally {
      await handle.close();
    }
  }

  async readIfExists(filePath: string): Promise<TEvent[]> {
    try {
      return this.parse(await readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async readFromOffsetIfExists(filePath: string, byteOffset: number, minSeqExclusive: number): Promise<TEvent[]> {
    try {
      const raw = await this.readFileFromOffset(filePath, byteOffset);
      if (!raw.trim()) return [];
      return this.parse(raw, filePath).filter((event) => event.seq > minSeqExclusive);
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  async latestTailForFiles(filePaths: readonly string[]): Promise<AppendOnlySeqLogTail> {
    const tails = await Promise.all(filePaths.map((filePath) => this.readTail(filePath)));
    return tails.reduce((latest, candidate) => (
      candidate.seq > latest.seq ? candidate : latest
    ), { seq: 0, eventId: null });
  }

  async fileSizeIfExists(filePath: string): Promise<number> {
    try {
      const handle = await open(filePath, 'r');
      try {
        return (await handle.stat()).size;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFoundError(error)) return 0;
      throw error;
    }
  }

  private async readTail(filePath: string): Promise<AppendOnlySeqLogTail> {
    let line: string | null = null;
    try {
      line = await this.readLastNonEmptyLine(filePath);
      if (!line) return { seq: 0, eventId: null };
      const event = JSON.parse(line) as TEvent;
      return {
        seq: typeof event.seq === 'number' ? event.seq : 0,
        eventId: typeof event.eventId === 'string' ? event.eventId : null,
      };
    } catch (error) {
      if (isNotFoundError(error)) return { seq: 0, eventId: null };
      if (line !== null) {
        // The last line may be a torn crash artifact of an interrupted append. The log's
        // parse function owns the torn-tail policy: if it tolerates the tear, the tail is
        // the last intact event; if it throws, this log treats the file as corrupt.
        const events = this.parse(await readFile(filePath, 'utf8'), filePath);
        const last = events.at(-1);
        return { seq: last?.seq ?? 0, eventId: last?.eventId ?? null };
      }
      throw new Error(`Invalid ${this.label} tail at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readFileFromOffset(filePath: string, byteOffset: number): Promise<string> {
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      const offset = Math.max(0, Math.trunc(byteOffset));
      if (offset > stats.size) throw new Error(`${this.label} checkpoint offset ${offset} exceeds ${filePath} size ${stats.size}`);
      if (offset === stats.size) return '';
      const buffer = Buffer.alloc(stats.size - offset);
      await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  private async readLastNonEmptyLine(filePath: string): Promise<string | null> {
    const handle = await open(filePath, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size === 0) return null;
      const chunkSize = 4096;
      let position = stats.size;
      let suffix = '';
      while (position > 0) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buffer = Buffer.alloc(readSize);
        await handle.read(buffer, 0, readSize, position);
        const text = buffer.toString('utf8');
        suffix = text + suffix;
        const lines = suffix.split('\n').filter((line) => line.trim().length > 0);
        if (lines.length > 0 && (position === 0 || text.startsWith('\n'))) return lines.at(-1)!;
        if (lines.length > 1) return lines.at(-1)!;
      }
      const trimmed = suffix.trim();
      return trimmed || null;
    } finally {
      await handle.close();
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
