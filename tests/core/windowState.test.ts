import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let userData = '';

mock.module('electron', () => ({
  app: { getPath: () => userData },
}));

const {
  loadWindowState,
  setWindowStateDisplayWorkAreasForTests,
  trackWindowState,
} = await import('../../src/main/windowState');

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'tenon-window-state-'));
  setWindowStateDisplayWorkAreasForTests(() => [{ x: 0, y: 0, width: 1920, height: 1080 }]);
});

afterEach(async () => {
  setWindowStateDisplayWorkAreasForTests(null);
  await rm(userData, { recursive: true, force: true });
});

describe('window state persistence', () => {
  test('writes compact JSON synchronously and restores visible bounds', async () => {
    const window = new FakeWindow();
    trackWindowState(window as never);
    window.emit('close');

    const raw = await readFile(path.join(userData, 'window-state.json'), 'utf8');
    expect(raw).toBe('{"bounds":{"x":20,"y":30,"width":900,"height":700},"maximized":true}');
    expect(loadWindowState()).toEqual({
      bounds: { x: 20, y: 30, width: 900, height: 700 },
      maximized: true,
    });
  });

  test('ignores off-screen bounds', async () => {
    await writeFile(path.join(userData, 'window-state.json'), JSON.stringify({
      bounds: { x: 5000, y: 5000, width: 900, height: 700 },
      maximized: true,
    }));

    expect(loadWindowState()).toEqual({ maximized: false });
  });
});

class FakeWindow extends EventEmitter {
  isDestroyed(): boolean {
    return false;
  }

  getNormalBounds() {
    return { x: 20, y: 30, width: 900, height: 700 };
  }

  isMaximized(): boolean {
    return true;
  }
}
