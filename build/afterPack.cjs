// electron-builder afterPack hook.
//
// We ship an unsigned build (`mac.identity: null`), which makes electron-builder
// skip bundle code signing entirely. On Apple Silicon an unsigned .app bundle
// fails `codesign --verify` (the bundle is not sealed) and macOS refuses to
// launch it. Deep ad-hoc signing the packaged bundle here seals it with the
// correct CFBundleIdentifier so the locally installed app launches without a
// paid Developer ID. Runs before the DMG target is assembled, so the dmg
// contains the signed app.
const { execFileSync } = require('node:child_process');
const { chmodSync, existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const ripgrepRoot = path.join(appPath, 'Contents', 'Resources', 'ripgrep');
  if (existsSync(ripgrepRoot)) {
    for (const entry of readdirSync(ripgrepRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rgPath = path.join(ripgrepRoot, entry.name, 'rg');
      if (existsSync(rgPath)) chmodSync(rgPath, 0o755);
    }
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
