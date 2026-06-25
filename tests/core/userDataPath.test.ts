import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DEV_USER_DATA_DIR_NAME, resolveUserDataDir } from '../../src/main/userDataPath';

const HOME = '/Users/tester';
const APP_DATA = '/Users/tester/Library/Application Support';

describe('resolveUserDataDir', () => {
  test('ELECTRON_USER_DATA_DIR override wins verbatim, even when packaged', () => {
    expect(
      resolveUserDataDir({
        envOverride: '/custom/clone/userData',
        isPackaged: true,
        home: HOME,
        appData: APP_DATA,
        appName: 'Tenon',
      }),
    ).toBe('/custom/clone/userData');
  });

  test('from source (not packaged) falls back to the dev dir under $HOME', () => {
    expect(
      resolveUserDataDir({
        envOverride: undefined,
        isPackaged: false,
        home: HOME,
        appData: APP_DATA,
        appName: 'Tenon',
      }),
    ).toBe(join(HOME, DEV_USER_DATA_DIR_NAME));
  });

  test('packaged pins to <appData>/<appName> — independent of derived app name', () => {
    // Regression guard: the packaged data directory must be derived from the
    // pinned appName, NOT from the bundled package.json `name` ("lin-outliner").
    // A rebuild whose asar package.json lacks `productName` must NOT change which
    // directory the app reads.
    expect(
      resolveUserDataDir({
        envOverride: undefined,
        isPackaged: true,
        home: HOME,
        appData: APP_DATA,
        appName: 'Tenon',
      }),
    ).toBe(join(APP_DATA, 'Tenon'));
  });

  test('packaged result never falls back to the legacy "lin-outliner" directory', () => {
    const resolved = resolveUserDataDir({
      envOverride: undefined,
      isPackaged: true,
      home: HOME,
      appData: APP_DATA,
      appName: 'Tenon',
    });
    expect(resolved.endsWith('/lin-outliner')).toBe(false);
    expect(resolved.endsWith('/Tenon')).toBe(true);
  });
});
