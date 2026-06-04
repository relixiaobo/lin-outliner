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
  // Cross-surface shared atoms — declared once so the same word has one key and one
  // translation everywhere (avoids divergent 'Untitled' / 'Loading…' per surface).
  common: {
    untitled: 'Untitled',
    loading: 'Loading…',
  },
  // The always-visible app shell: window chrome, sidebar, workspace canvas, panels,
  // and the agent dock frame (B1 migration).
  shell: {
    startupError: ({ error }: { error: string }) => `Startup failed: ${error}`,
    errorDismiss: 'Dismiss error',
    sidebar: {
      ariaLabel: 'Primary navigation',
      primaryNav: {
        today: 'Today',
        library: 'Library',
        recents: 'Recents',
        schema: 'Schema',
      },
      collapseNode: ({ label }: { label: string }) => `Collapse ${label}`,
      expandNode: ({ label }: { label: string }) => `Expand ${label}`,
      pinnedSection: 'Pinned',
      noPinnedHint: 'Drag to pin nodes',
      pinnedNodesAriaLabel: 'Pinned nodes',
      openRoot: ({ rootLabel }: { rootLabel: string }) => `Open ${rootLabel}`,
      workspaceRootTreeAriaLabel: 'Workspace root tree',
      settings: 'Settings',
      resizeLabel: 'Resize sidebar',
      resizeTitle: 'Resize sidebar (double-click to reset)',
      missingReference: 'Missing reference',
    },
    chrome: {
      collapseSidebar: 'Collapse sidebar',
      expandSidebar: 'Expand sidebar',
      collapseAgent: 'Collapse agent',
      expandAgent: 'Expand agent',
    },
    workspace: {
      canvasAriaLabel: 'Workspace canvas',
      resizePanelsLabel: 'Resize panels',
      resizePanelsTitle: 'Resize panels (double-click to reset)',
    },
    panel: {
      closeLabel: 'Close panel',
    },
    agentDock: {
      ariaLabel: 'Agent',
      resizeLabel: 'Resize agent',
      resizeTitle: 'Resize agent (double-click to reset)',
    },
  },
};

export type Messages = typeof en;
