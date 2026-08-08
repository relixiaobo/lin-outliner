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
    });

    let result: Awaited<ReturnType<CommandRunner>> | null = null;
    await act(async () => {
      result = await run(
        async () => commandRunnerNoop(),
        { beforeApply: () => calls.push('beforeApply') },
      );
    });

    expect(result).toBe(commandRunnerNoop());
    // Nothing, not `setError:null`. The error slot is the app-wide notice, and
    // a no-op here has no standing to erase a failure some other surface
    // raised and the user may still be reading.
    expect(calls).toEqual([]);
  });

  test('aborts without clearing an error set by a nested runner', async () => {
    const calls: string[] = [];
    const { run } = renderCommandRunner({
      applyProjectionUpdate: () => calls.push('applyProjectionUpdate'),
      setFocus: () => calls.push('setFocus'),
      setError: (message) => calls.push(`setError:${message ?? 'null'}`),
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
    expect(calls).toEqual(['setError:stale command']);
  });

  test('does not clear the notice when a command succeeds', async () => {
    // Commands run on ordinary keystrokes. Clearing on success would delete a
    // report the user is mid-read the moment they carry on typing — and the
    // report almost never belongs to the command that would be clearing it.
    const calls: string[] = [];
    const { run } = renderCommandRunner({
      applyProjectionUpdate: () => calls.push('applyProjectionUpdate'),
      setFocus: () => calls.push('setFocus'),
      setError: (message) => calls.push(`setError:${message ?? 'null'}`),
    });

    await act(async () => {
      await run(async () => ({ update: { kind: 'full', revision: 1, projection: {} } } as never));
    });

    expect(calls).toEqual(['applyProjectionUpdate', 'setFocus']);
  });
});
