import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export interface NormalizedTextCharacter {
  readonly character: string;
  readonly source: string;
}

/** Emit CRLF and CR as LF, keeping their original characters for byte accounting. */
export class TextFileNewlines {
  private pendingCarriageReturn = false;

  *write(text: string): Iterable<NormalizedTextCharacter> {
    for (const character of text) {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false;
        yield { character: '\n', source: character === '\n' ? '\r\n' : '\r' };
        if (character === '\n') continue;
      }
      if (character === '\r') this.pendingCarriageReturn = true;
      else yield { character, source: character };
    }
  }

  *end(): Iterable<NormalizedTextCharacter> {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      yield { character: '\n', source: '\r' };
    }
  }
}

export type CursorEncoding = 'utf8' | 'utf16le';
export interface TextFileCursor {
  readonly version: 1;
  readonly source: string;
  readonly generation: string;
  readonly encoding: CursorEncoding;
  readonly nextByte: number;
  readonly line: number;
  readonly end: number;
}
export class TextFileCursorError extends Error {
  constructor(
    readonly code: 'source_changed' | 'invalid_cursor',
    message: string,
  ) {
    super(message);
  }
}
export async function textFileGeneration(filePath: string): Promise<{ generation: string; size: number }> {
  const value = await stat(filePath, { bigint: true });
  return {
    generation: createHash('sha256')
      .update([value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':'))
      .digest('hex'),
    size: Number(value.size),
  };
}
const sourceIdentity = (filePath: string) => createHash('sha256').update(filePath).digest('hex');
export function encodeTextFileCursor(
  filePath: string,
  input: Omit<TextFileCursor, 'version' | 'source'>,
): string {
  return Buffer.from(JSON.stringify({ version: 1, source: sourceIdentity(filePath), ...input })).toString(
    'base64url',
  );
}
export function decodeTextFileCursor(filePath: string, value: string): TextFileCursor {
  try {
    if (value.length > 2048) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as TextFileCursor;
    if (
      cursor.version !== 1 ||
      cursor.source !== sourceIdentity(filePath) ||
      !['utf8', 'utf16le'].includes(cursor.encoding) ||
      !Number.isSafeInteger(cursor.nextByte) ||
      cursor.nextByte < 0 ||
      !Number.isSafeInteger(cursor.end) ||
      cursor.nextByte > cursor.end ||
      !Number.isSafeInteger(cursor.line) ||
      cursor.line < 1 ||
      !/^[0-9a-f]{64}$/.test(cursor.generation)
    )
      throw new Error();
    return cursor;
  } catch {
    throw new TextFileCursorError(
      'invalid_cursor',
      'Invalid file continuation. Read the file again without a cursor.',
    );
  }
}
/** Byte positions refer to the original encoding; decoded code points are never split. */
export async function readTextFileContinuation(
  filePath: string,
  value: string,
  maxChars: number,
  maxLines: number,
  signal?: AbortSignal,
) {
  const cursor = decodeTextFileCursor(filePath, value);
  const before = await textFileGeneration(filePath);
  if (before.generation !== cursor.generation || before.size !== cursor.end)
    throw new TextFileCursorError(
      'source_changed',
      'The file changed. Search or read again without the old cursor.',
    );
  signal?.throwIfAborted();
  const handle = await open(filePath, 'r');
  let content = '';
  let nextByte = cursor.nextByte;
  let line = cursor.line;
  let stopped = false;
  try {
    const decoder = new StringDecoder(cursor.encoding);
    const newlines = new TextFileNewlines();
    const consume = (characters: Iterable<NormalizedTextCharacter>) => {
      for (const { character, source } of characters) {
        if (content.length + character.length > maxChars || line - cursor.line >= maxLines) {
          stopped = true;
          return;
        }
        content += character;
        nextByte += Buffer.byteLength(source, cursor.encoding);
        if (character === '\n') line++;
      }
    };
    const buffer = Buffer.alloc(16 * 1024);
    let position = cursor.nextByte;
    while (position < cursor.end && !stopped) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, cursor.end - position),
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      const decoded =
        decoder.write(buffer.subarray(0, bytesRead)) + (position === cursor.end ? decoder.end() : '');
      consume(newlines.write(decoded));
    }
    if (!stopped) consume(newlines.end());
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
  if ((await textFileGeneration(filePath)).generation !== cursor.generation)
    throw new TextFileCursorError(
      'source_changed',
      'The file changed during reading. Read it again without a cursor.',
    );
  const hasMore = nextByte < cursor.end;
  return {
    content,
    startLine: cursor.line,
    numLines: content ? content.split('\n').length - (content.endsWith('\n') ? 1 : 0) : 0,
    totalLines: hasMore ? null : line - (content.endsWith('\n') ? 1 : 0),
    hasMore,
    generation: cursor.generation,
    encoding: cursor.encoding,
    nextCursor: hasMore ? encodeTextFileCursor(filePath, { ...cursor, nextByte, line }) : null,
  };
}
