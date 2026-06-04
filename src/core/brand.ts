// The product name, in one place so main, preload, and renderer all agree (it had
// been a literal in several spots). A brand name, NOT a translatable string — i18n
// messages take it as the `app` interpolation param and never translate it. The
// packaged build's productName/CFBundleName lives in electron-builder config; keep
// this in sync with it.
export const APP_NAME = 'Tenon';
