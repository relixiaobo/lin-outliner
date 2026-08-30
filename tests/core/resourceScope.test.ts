import { describe, expect, test } from 'bun:test';
import { ResourceDisposalError, ResourceScope } from '../../src/main/resourceScope';

describe('ResourceScope', () => {
  test('disposes in reverse order exactly once across concurrent callers', async () => {
    const events: string[] = [];
    const scope = new ResourceScope('desktop');
    scope.defer('first', () => { events.push('first'); });
    scope.defer('second', async () => { events.push('second'); });

    const first = scope.dispose();
    const second = scope.dispose();

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(events).toEqual(['second', 'first']);
  });

  test('allows a child to release early and remain idempotent under its parent', async () => {
    const events: string[] = [];
    const parent = new ResourceScope('desktop');
    const child = parent.child('transport');
    child.defer('ipc', () => { events.push('ipc'); });

    await child.dispose();
    await parent.dispose();

    expect(events).toEqual(['ipc']);
  });

  test('continues after failures and reports ownership context', async () => {
    const events: string[] = [];
    const scope = new ResourceScope('desktop');
    scope.defer('survivor', () => { events.push('survivor'); });
    scope.defer('broken', () => { throw new Error('release failed'); });

    const error = await scope.dispose().catch((caught) => caught);

    expect(events).toEqual(['survivor']);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors[0]).toBeInstanceOf(ResourceDisposalError);
    expect(error.errors[0].message).toContain('broken');
    expect(error.errors[0].message).toContain('desktop');
  });

  test('rejects registrations after disposal begins', async () => {
    const scope = new ResourceScope('desktop');
    const disposal = scope.dispose();
    expect(() => scope.defer('late', () => undefined)).toThrow('already disposing');
    await disposal;
  });
});
