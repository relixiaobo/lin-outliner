import { homedir } from 'node:os';
import path from 'node:path';

const DEV_USER_DATA_DIR_NAME = '.lin-outliner-dev';
const PRODUCT_NAME = 'Tenon';

export interface OutlineRuntimeRootOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
}

export function resolveOutlineRuntimeRoot(options: OutlineRuntimeRootOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.TENON_OUTLINE_RUNTIME_ROOT) return path.resolve(env.TENON_OUTLINE_RUNTIME_ROOT);
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const userData = env.ELECTRON_USER_DATA_DIR
    ?? (env.TENON_OUTLINE_PACKAGED === '1'
      ? packagedUserDataRoot(home, platform, env)
      : path.join(home, DEV_USER_DATA_DIR_NAME));
  return path.join(userData, 'outline-runtime');
}

function packagedUserDataRoot(
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', PRODUCT_NAME);
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), PRODUCT_NAME);
}
