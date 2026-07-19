import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  commandRunnerAbort,
  commandRunnerNoop,
  useCommandRunner,
  type CommandRunner,
} from '../../src/renderer/ui/shared';

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

function renderCommandRunner(spies: {
  applyProjectionUpdate: () => void;
  setFocus: () => void;
  setError: (message: string | null) => void;
  onLocalCommandStart: () => void;
  onLocalCommandSettled: () => void;
}): { run: CommandRunner } {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { document, window, HTMLElement: window.HTMLElement, Node: window.Node });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let run: CommandRunner | null = null;
  const Probe = () => {
    run = useCommandRunner(
      spies.applyProjectionUpdate,
      spies.setFocus,
      spies.setError,
      {
        onLocalCommandStart: spies.onLocalCommandStart,
        onLocalCommandSettled: spies.onLocalCommandSettled,
      },
    );
    return null;
  };

  const root = createRoot(document.getElementById('root')!);
  act(() => root.render(<Probe />));
  mounted.push(() => act(() => root.unmount()));

  if (!run) throw new Error('Command runner did not mount');
  return { run };
}

describe('useCommandRunner no-op outcome', () => {
  test('does not apply projection, focus, or pre-apply work', async () => {
    const calls: string[] = [];
    const { run } = renderCommandRunner({
      applyProjectionUpdate: () => calls.push('applyProjectionUpdate'),
      setFocus: () => calls.push('setFocus'),
      setError: (message) => calls.push(`setError:${message ?? 'null'}`),
      onLocalCommandStart: () => calls.push('start'),
      onLocalCommandSettled: () => calls.push('settled'),
    });

    let result: Awaited<ReturnType<CommandRunner>> | null = null;
    await act(async () => {
      result = await run(
        async () => commandRunnerNoop(),
        { beforeApply: () => calls.push('beforeApply') },
      );
    });

    expect(result).toBe(commandRunnerNoop());
    expect(calls).toEqual(['start', 'setError:null', 'settled']);
  });

  test('aborts without clearing an error set by a nested runner', async () => {
    const calls: string[] = [];
    const { run } = renderCommandRunner({
      applyProjectionUpdate: () => calls.push('applyProjectionUpdate'),
      setFocus: () => calls.push('setFocus'),
      setError: (message) => calls.push(`setError:${message ?? 'null'}`),
      onLocalCommandStart: () => calls.push('start'),
      onLocalCommandSettled: () => calls.push('settled'),
    });

    let result: Awaited<ReturnType<CommandRunner>> | null = commandRunnerNoop();
    await act(async () => {
      result = await run(async () => {
        const inner = await run(async () => {
          throw new Error('stale command');
        });
        return inner === null ? commandRunnerAbort() : commandRunnerNoop();
      });
    });

    expect(result).toBe(null);
    expect(calls).toEqual([
      'start',
      'start',
      'setError:stale command',
      'settled',
      'settled',
    ]);
  });
});
