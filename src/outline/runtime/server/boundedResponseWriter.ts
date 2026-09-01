import type { Writable } from 'node:stream';

type ResponseWritable = Pick<
  Writable,
  'destroyed' | 'writableEnded' | 'write' | 'once' | 'off' | 'end' | 'destroy'
>;

export interface BoundedResponseWriterOptions {
  readonly maxBufferedRecords: number;
  readonly maxBufferedBytes: number;
  readonly onOverflow: (discardedRecords: number) => readonly string[];
  readonly onFailure: (error: Error) => void;
}

interface BufferedRecord {
  readonly value: string;
  readonly bytes: number;
}

export class BoundedResponseWriter {
  private records: BufferedRecord[] = [];
  private bufferedBytes = 0;
  private draining = false;
  private ending = false;
  private stopped = false;

  constructor(
    private readonly response: ResponseWritable,
    private readonly options: BoundedResponseWriterOptions,
  ) {
    if (options.maxBufferedRecords < 1 || options.maxBufferedBytes < 1) {
      throw new RangeError('Bounded response writer limits must be positive.');
    }
  }

  enqueue(value: string): void {
    if (this.ending || this.stopped) return;
    const record = bufferedRecord(value);
    if (
      this.records.length >= this.options.maxBufferedRecords
      || this.bufferedBytes + record.bytes > this.options.maxBufferedBytes
    ) {
      try {
        const discardedRecords = this.records.length + 1;
        this.ending = true;
        this.records = this.options.onOverflow(discardedRecords).map(bufferedRecord);
        this.bufferedBytes = this.records.reduce((total, entry) => total + entry.bytes, 0);
        this.flush();
      } catch (error) {
        this.fail(error);
      }
      return;
    }
    this.records.push(record);
    this.bufferedBytes += record.bytes;
    this.flush();
  }

  end(values: readonly string[]): void {
    if (this.ending || this.stopped) return;
    this.ending = true;
    const terminal = values.map(bufferedRecord);
    this.records.push(...terminal);
    this.bufferedBytes += terminal.reduce((total, record) => total + record.bytes, 0);
    this.flush();
  }

  cancel(): void {
    this.stopped = true;
    this.records = [];
    this.bufferedBytes = 0;
  }

  private flush(): void {
    if (this.draining || this.stopped) return;
    try {
      while (this.records.length > 0) {
        const record = this.records.shift()!;
        this.bufferedBytes -= record.bytes;
        assertResponseOpen(this.response);
        if (!this.response.write(record.value)) {
          this.draining = true;
          void waitForDrain(this.response).then(() => {
            this.draining = false;
            this.flush();
          }, (error: unknown) => {
            this.draining = false;
            this.fail(error);
          });
          return;
        }
      }
      if (this.ending && !this.response.destroyed && !this.response.writableEnded) {
        this.response.end();
        this.stopped = true;
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stopped = true;
    this.records = [];
    this.bufferedBytes = 0;
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      this.options.onFailure(failure);
    } finally {
      this.response.destroy(failure);
    }
  }
}

export async function writeWithBackpressure(response: ResponseWritable, chunk: string): Promise<void> {
  assertResponseOpen(response);
  if (response.write(chunk)) return;
  await waitForDrain(response);
}

function assertResponseOpen(response: ResponseWritable): void {
  if (response.destroyed || response.writableEnded) {
    throw new Error('Outline Runtime response closed during streaming.');
  }
}

function waitForDrain(response: ResponseWritable): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Outline Runtime response closed during streaming.'));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function bufferedRecord(value: string): BufferedRecord {
  return { value, bytes: Buffer.byteLength(value) };
}
