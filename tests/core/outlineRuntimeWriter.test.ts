import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { BoundedResponseWriter } from '../../src/outline/runtime/server/boundedResponseWriter';

describe('Outline Runtime bounded response writer', () => {
  test('drops a blocked backlog and converges to resync when its record limit is reached', async () => {
    const written: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    let firstWrite = true;
    const response = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        if (firstWrite) {
          firstWrite = false;
          releaseFirstWrite = callback;
        } else {
          callback();
        }
      },
    });
    let overflowCount = 0;
    let discardedRecords = 0;
    let sequence = 0;
    const record = (type: string) => `${JSON.stringify({ sequence: sequence++, type })}\n`;
    const writer = new BoundedResponseWriter(response, {
      maxBufferedRecords: 4,
      maxBufferedBytes: 1024,
      onOverflow: (discarded) => {
        overflowCount += 1;
        discardedRecords = discarded;
        sequence -= discarded;
        return [record('resync.required'), record('end')];
      },
      onFailure: (error) => { throw error; },
    });
    const finished = once(response, 'finish');

    writer.enqueue(record('hello'));
    for (let index = 0; index < 100; index += 1) writer.enqueue(record(`event:${index}`));

    expect(overflowCount).toBe(1);
    expect(discardedRecords).toBe(5);
    expect(written.map((line) => JSON.parse(line))).toEqual([{ sequence: 0, type: 'hello' }]);
    releaseFirstWrite?.();
    await finished;
    expect(written.map((line) => JSON.parse(line))).toEqual([
      { sequence: 0, type: 'hello' },
      { sequence: 1, type: 'resync.required' },
      { sequence: 2, type: 'end' },
    ]);
  });

  test('applies the byte limit even when the record limit has capacity', async () => {
    const written: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    const response = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        if (!releaseFirstWrite) releaseFirstWrite = callback;
        else callback();
      },
    });
    let overflowCount = 0;
    let discardedRecords = 0;
    const writer = new BoundedResponseWriter(response, {
      maxBufferedRecords: 100,
      maxBufferedBytes: 16,
      onOverflow: (discarded) => {
        overflowCount += 1;
        discardedRecords = discarded;
        return ['resync\n', 'end\n'];
      },
      onFailure: (error) => { throw error; },
    });
    const finished = once(response, 'finish');

    writer.enqueue('hello\n');
    writer.enqueue('12345678\n');
    writer.enqueue('overflow\n');

    expect(overflowCount).toBe(1);
    expect(discardedRecords).toBe(2);
    releaseFirstWrite?.();
    await finished;
    expect(written).toEqual(['hello\n', 'resync\n', 'end\n']);
  });

  test('preserves queued records when the producer ends without overflow', async () => {
    const written: string[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    const response = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        written.push(chunk.toString());
        if (!releaseFirstWrite) releaseFirstWrite = callback;
        else callback();
      },
    });
    const writer = new BoundedResponseWriter(response, {
      maxBufferedRecords: 8,
      maxBufferedBytes: 1024,
      onOverflow: () => { throw new Error('Unexpected overflow'); },
      onFailure: (error) => { throw error; },
    });
    const finished = once(response, 'finish');

    writer.enqueue('hello\n');
    writer.enqueue('event:1\n');
    writer.enqueue('event:2\n');
    writer.end(['resync\n', 'end\n']);

    releaseFirstWrite?.();
    await finished;
    expect(written).toEqual(['hello\n', 'event:1\n', 'event:2\n', 'resync\n', 'end\n']);
  });
});
