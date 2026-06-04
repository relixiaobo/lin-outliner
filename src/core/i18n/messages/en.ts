// English — the CANONICAL message surface. Its shape defines `Messages` (see
// core/i18n/index.ts); every other locale is a deep-partial of this and falls back
// here for any key it has not translated yet. So: add a key HERE first, then fill it
// into the other locales (the coverage test reports what is still missing).
//
// Static strings are plain string values. Strings with runtime values are arrow
// functions taking a typed params object — this keeps interpolation fully
// type-checked at the call site (t.menu.help({ app }) won't compile without `app`).
//
// This is the PR1 foundation slice (native menu + launcher chrome + the settings
// General pane). Subsequent migration PRs grow this tree surface by surface; see
// docs/plans/i18n-multi-language.md.

export const en = {
  // Native application + context menus (main process; rebuilt on language change).
  menu: {
    settings: 'Settings…',
    about: ({ app }: { app: string }) => `About ${app}`,
    hide: ({ app }: { app: string }) => `Hide ${app}`,
    quit: ({ app }: { app: string }) => `Quit ${app}`,
    file: 'File',
    view: 'View',
    help: ({ app }: { app: string }) => `${app} Help`,
    reportIssue: 'Report an Issue…',
    addToDictionary: 'Add to Dictionary',
  },
  // Native window titles (main process).
  window: {
    settingsTitle: ({ app }: { app: string }) => `${app} Settings`,
  },
  // The global launcher's static chrome (placeholder + accessibility labels).
  launcher: {
    placeholder: 'Capture, search, or run a command…',
    queryAriaLabel: 'Launcher query',
    rootAriaLabel: ({ app }: { app: string }) => `${app} Launcher`,
    resultsAriaLabel: 'Results',
  },
  // The settings window: rail chrome, categories, and the General pane.
  settings: {
    railTitle: 'Settings',
    loading: 'Loading…',
    categoriesAriaLabel: 'Settings categories',
    categories: {
      general: { label: 'General', hint: 'Appearance & Theme' },
      providers: { label: 'Providers', hint: 'Connections & API keys' },
      permissions: { label: 'Permissions', hint: 'Tool Allow / Ask Rules' },
      skills: { label: 'Skills', hint: 'Extension Capabilities' },
      agents: { label: 'Agent Profiles', hint: 'Persona Definitions' },
    },
    general: {
      intro: 'Appearance and app-wide preferences.',
      appearanceGroup: 'Appearance',
      themeLabel: 'Theme',
      themeSublabel: 'Match the system appearance, or always use light or dark.',
      themeSystem: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      languageLabel: 'Language',
      languageSublabel: 'Choose the display language for menus and the interface.',
    },
  },
};

export type Messages = typeof en;
